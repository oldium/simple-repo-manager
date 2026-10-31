import osPath from "path";
import type { Database } from "node:sqlite";
import { repoFile } from "./context.ts";
import type { BackendContext } from "./context.ts";
import { transaction } from "./db.ts";
import { publishDebian, reconcileDebian } from "./deb/publisher.ts";
import { GC_GRACE_SECONDS, currentIndexPaths, isPoolRoot } from "./gc.ts";
import { IndexPublisher } from "./index-publish.ts";
import { isTempName, listFiles, removeQuietly, statQuietly } from "./publish-fs.ts";
import { publishRpm, reconcileRpm } from "./rpm/publisher.ts";
import logger from "../lib/logger.ts";
import { toOsPath } from "../lib/safe-path.ts";

/** What the startup reconciliation changed: releases as format/distro/release, index and pool files as repo-relative paths */
export type ReconcileResult = {
    /** Indexes whose stored file was missing, rebuilt in full: "format/distro/release kind [component [architecture]]" */
    rebuilt: string[];
    /** Releases the publishers touched */
    published: string[];
    /** Releases whose canonical names, Release or repomd.xml, or signatures were repaired */
    repaired: string[];
    /** Removed pool files whose grace started over: the indexes dropped them only now */
    restamped: string[];
    /** Superseded index files whose grace started over: the replaced Release or repomd.xml may have named them until now */
    restampedIndexes: string[];
    /** by-hash and repodata files no index names, now superseded */
    superseded: string[];
    /** Shadows of unknown generations, removed */
    shadows: string[];
    /** staged_digests rows whose file is gone, dropped */
    staged: string[];
    /** Temp files past the grace, deleted, as on disk */
    temp: string[];
    /** RPM pool files missing or of another size than their row */
    mismatched: string[];
};

type StoredIndex = { id: number; kind: string; component: string; architecture: string; stored_path: string; format: string; distro: string; name: string };

const REPOMD_NAMES = new Set(["repomd.xml", "repomd.xml.asc"]);

function prepareStatements(db: Database) {
    return {
        storedIndexes: db.prepare(`
            SELECT i.id, i.kind, i.component, i.architecture, i.stored_path, r.format, r.distro, r.name FROM index_files i
                JOIN releases r ON r.id = i.release_id WHERE i.stored_path IS NOT NULL ORDER BY r.format, r.distro, r.name, i.component, i.kind, i.architecture`),
        insertDirtyKey: db.prepare("INSERT OR IGNORE INTO dirty_keys (index_file_id, key) VALUES (?, '')"),
        restampRemoved: db.prepare("UPDATE pool_files SET removed_at = ? WHERE removed_at IS NOT NULL RETURNING path"),
        restampSuperseded: db.prepare("UPDATE superseded_files SET superseded_at = ? RETURNING path"),
        supersededPaths: db.prepare("SELECT path FROM superseded_files"),
        supersede: db.prepare("INSERT OR IGNORE INTO superseded_files (path, superseded_at) VALUES (?, ?)"),
        stagedPaths: db.prepare("SELECT rel_path FROM staged_digests ORDER BY rel_path"),
        deleteStaged: db.prepare("DELETE FROM staged_digests WHERE rel_path = ?"),
        rpmPoolFiles: db.prepare("SELECT path, size FROM pool_files WHERE path LIKE 'rpm/%' AND removed_at IS NULL ORDER BY path"),
    };
}

function indexName(i: StoredIndex): string {
    return `${ i.format }/${ i.distro }/${ i.name } ${ [i.kind, i.component, i.architecture].filter(s => s.length > 0).join(" ") }`;
}

/** A by-hash file below dists, or a metadata file below repodata other than repomd.xml and its signature */
function isIndexFile(rel: string): boolean {
    const segments = rel.split("/");
    if (segments[0] === "deb") {
        return segments[2] === "dists" && segments.includes("by-hash");
    }
    return segments[0] === "rpm" && segments.length === 5 && segments[3] === "repodata" && !REPOMD_NAMES.has(segments[4]);
}

function prefixed(format: string, releases: string[]): string[] {
    return releases.map(release => `${ format }/${ release }`);
}

class Reconciler {
    private readonly ctx: BackendContext;
    private readonly s: ReturnType<typeof prepareStatements>;

    constructor(ctx: BackendContext) {
        this.ctx = ctx;
        this.s = prepareStatements(ctx.db);
    }

    /** Marks every index whose stored file is gone: any dirty key makes it pending, and the missing file forces a full rebuild */
    async markMissing(): Promise<string[]> {
        const missing: StoredIndex[] = [];
        for (const row of this.s.storedIndexes.all() as StoredIndex[]) {
            if (await statQuietly(repoFile(this.ctx, row.stored_path)) === undefined) {
                missing.push(row);
            }
        }
        if (missing.length > 0) {
            transaction(this.ctx.db, () => {
                for (const row of missing) {
                    this.s.insertDirtyKey.run(row.id);
                }
            });
        }
        return missing.map(row => {
            logger.info(`Rebuilding ${ indexName(row) }: ${ row.stored_path } is missing`);
            return indexName(row);
        });
    }

    /** Until this publish the indexes may have listed the removed files, and the grace counts from the publish that drops them */
    restampRemoved(): string[] {
        const restamped = this.s.restampRemoved.all(this.ctx.now()).map(row => row.path as string).sort();
        if (restamped.length > 0) {
            logger.info(`Restarted the grace of ${ restamped.length } removed pool file(s): only now is what dropped them published`);
        }
        return restamped;
    }

    /** A client of the replaced Release or repomd.xml may still fetch the index files it named, and the same GC run would delete them */
    restampSuperseded(): string[] {
        const restamped = this.s.restampSuperseded.all(this.ctx.now()).map(row => row.path as string).sort();
        if (restamped.length > 0) {
            logger.info(`Restarted the grace of ${ restamped.length } superseded index file(s): only now is what replaced them published`);
        }
        return restamped;
    }

    /** Index files below by-hash and repodata that neither a current row nor superseded_files names; superseded now, GC deletes them after the grace */
    supersedeOrphans(files: string[]): string[] {
        const current = currentIndexPaths(this.ctx.db);
        const listed = new Set(this.s.supersededPaths.all().map(row => row.path as string));
        const orphans = files.filter(rel => isIndexFile(rel) && !isTempName(rel) && !current.has(rel) && !listed.has(rel)).sort();
        if (orphans.length > 0) {
            const now = this.ctx.now();
            transaction(this.ctx.db, () => {
                for (const rel of orphans) {
                    this.s.supersede.run(rel, now);
                }
            });
        }
        for (const rel of orphans) {
            logger.info(`Superseded ${ rel }: no index names it`);
        }
        return orphans;
    }

    async sweepShadows(): Promise<string[]> {
        const dir = osPath.join(this.ctx.paths.repoStateDir, "shadow");
        const before = await listFiles(dir);
        await new IndexPublisher(this.ctx).sweepShadows();
        const after = new Set(await listFiles(dir));
        const removed = before.filter(name => !after.has(name));
        for (const name of removed) {
            logger.info(`Removed shadow ${ name }: no index generation names it`);
        }
        return removed;
    }

    /** Rows whose file is neither staged nor in process any more */
    async dropVanishedStaged(): Promise<string[]> {
        const gone: string[] = [];
        for (const row of this.s.stagedPaths.all() as { rel_path: string }[]) {
            const staged = await statQuietly(toOsPath(osPath.join(this.ctx.paths.incomingDir, "staging"), row.rel_path));
            const processed = await statQuietly(toOsPath(osPath.join(this.ctx.paths.incomingDir, "process"), row.rel_path));
            if (staged === undefined && processed === undefined) {
                gone.push(row.rel_path);
            }
        }
        if (gone.length > 0) {
            transaction(this.ctx.db, () => {
                for (const rel of gone) {
                    this.s.deleteStaged.run(rel);
                }
            });
        }
        for (const rel of gone) {
            logger.info(`Dropped the staged digests of ${ rel }: the file is gone`);
        }
        return gone;
    }

    /**
     * Temp files of writes that never finished: those past the grace in the walked files, and everything in repoStateDir/tmp.
     * Only safe under the writer mutex with no publish running: the grace is no protection, a placed link or a copy
     * fallback carries its source's mtime
     */
    async deleteStaleTemp(repoFiles: string[]): Promise<string[]> {
        const cutoff = (this.ctx.now() - GC_GRACE_SECONDS) * 1000;
        const deleted: string[] = [];
        for (const rel of repoFiles.filter(isTempName)) {
            const file = repoFile(this.ctx, rel);
            const stat = await statQuietly(file);
            if (stat !== undefined && stat.mtimeMs <= cutoff) {
                await removeQuietly(file);
                logger.info(`Deleted ${ file }: a temp file older than the grace`);
                deleted.push(file);
            }
        }
        const tmpDir = osPath.join(this.ctx.paths.repoStateDir, "tmp");
        for (const rel of await listFiles(tmpDir)) {
            const file = toOsPath(tmpDir, rel);
            await removeQuietly(file);
            logger.info(`Deleted ${ file }: an index write that never finished`);
            deleted.push(file);
        }
        return deleted.sort();
    }

    /** RPM pool files missing or of another size than their row: a re-upload whose move did not complete */
    async checkRpmPool(): Promise<string[]> {
        const mismatched: string[] = [];
        for (const row of this.s.rpmPoolFiles.all() as { path: string; size: number }[]) {
            const stat = await statQuietly(repoFile(this.ctx, row.path));
            if (stat === undefined) {
                logger.warn(`${ row.path } is missing from the pool`);
            } else if (stat.size !== row.size) {
                logger.warn(`${ row.path } has ${ stat.size } bytes on disk, the catalog records ${ row.size }`);
            } else {
                continue;
            }
            mismatched.push(row.path);
        }
        return mismatched;
    }
}

/**
 * Repairs at startup what a crash left behind, from the database outwards: indexes without their stored file are rebuilt
 * with every other pending index, the publishers repair canonical names, Release/repomd.xml and signatures, a publish or
 * repair restarts the grace of removed pool files and superseded index files, and index files, shadows, staged digests
 * and temp files nothing accounts for are superseded, removed or dropped. RPM pool files that do not match their row are
 * only reported; the facade re-imports what is still in process. Logs each repair; must run under the writer mutex,
 * before the GC starts.
 */
export async function reconcile(ctx: BackendContext): Promise<ReconcileResult> {
    const reconciler = new Reconciler(ctx);
    const rebuilt = await reconciler.markMissing();
    const published = [...prefixed("deb", await publishDebian(ctx)), ...prefixed("rpm", await publishRpm(ctx))];
    const repaired = [...prefixed("deb", await reconcileDebian(ctx)), ...prefixed("rpm", await reconcileRpm(ctx))];
    const wrote = published.length > 0 || repaired.length > 0;
    const restamped = wrote ? reconciler.restampRemoved() : [];
    const restampedIndexes = wrote ? reconciler.restampSuperseded() : [];
    // A start must not cost a directory per source; the import of what is still in process replaces a temp a crashed move left in a pool
    const files = await listFiles(ctx.paths.repoDir, isPoolRoot);
    const superseded = reconciler.supersedeOrphans(files);
    const shadows = await reconciler.sweepShadows();
    const staged = await reconciler.dropVanishedStaged();
    const temp = await reconciler.deleteStaleTemp(files);
    const mismatched = await reconciler.checkRpmPool();
    return { rebuilt, published, repaired, restamped, restampedIndexes, superseded, shadows, staged, temp, mismatched };
}

/**
 * Repairs what a failed publish left, once the publishers ran again; published: they wrote anything, possibly what the
 * failed publish could not. Whatever got written restarts the grace, as at startup. Must run under the writer mutex.
 */
export async function repairPublished(ctx: BackendContext, published: boolean): Promise<void> {
    const repaired = [...await reconcileDebian(ctx), ...await reconcileRpm(ctx)];
    if (published || repaired.length > 0) {
        const reconciler = new Reconciler(ctx);
        reconciler.restampRemoved();
        reconciler.restampSuperseded();
    }
}
