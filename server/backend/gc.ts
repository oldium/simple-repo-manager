import fs from "fs/promises";
import type { Dirent } from "fs";
import type { Database } from "node:sqlite";
import { repoFile } from "./context.ts";
import type { BackendContext } from "./context.ts";
import { REFERENCING_TABLES as DEB_TABLES } from "./deb/catalog.ts";
import { debPublishedPaths, md5LinkPath } from "./deb/publisher.ts";
import { Pool } from "./pool.ts";
import type { Format } from "./pool.ts";
import { errorCode, removeEmptyParents, removeQuietly, statQuietly } from "./publish-fs.ts";
import { REFERENCING_TABLES as RPM_TABLES } from "./rpm/catalog.ts";
import { rpmPublishedPaths } from "./rpm/publisher.ts";
import logger from "../lib/logger.ts";

export const GC_INTERVAL_MS = 3600000;
export const GC_GRACE_SECONDS = 86400;

/** Repo-relative paths whose rows were dropped, their files unlinked when still present: pool files, and index files with by-hash links */
export type GcResult = { pool: string[]; index: string[] };

type IndexRow = { format: Format; stored_path: string; md5: string };

type PoolFailure = { path: string; err: unknown };

function prepareStatements(db: Database) {
    return {
        expiredPoolFiles: db.prepare("SELECT id, path FROM pool_files WHERE removed_at IS NOT NULL AND removed_at <= ?"),
        restartGrace: db.prepare("UPDATE pool_files SET removed_at = ? WHERE removed_at IS NOT NULL"),
        publishPending: db.prepare("SELECT EXISTS (SELECT 1 FROM dirty_keys) OR EXISTS (SELECT 1 FROM index_files WHERE generation = 0) AS pending"),
        expiredSuperseded: db.prepare("SELECT path FROM superseded_files WHERE superseded_at <= ?"),
        supersededPaths: db.prepare("SELECT path FROM superseded_files"),
        deleteSuperseded: db.prepare("DELETE FROM superseded_files WHERE path = ?"),
    };
}

function formatOf(poolPath: string): Format {
    const format = poolPath.slice(0, poolPath.indexOf("/"));
    if (format !== "deb" && format !== "rpm") {
        throw new Error(`Pool file ${ poolPath } belongs to no known format`);
    }
    return format;
}

const POOL_ROOTS: Record<string, [number, string]> = { deb: [2, "pool"], rpm: [3, "Packages"] };

/** The release owning a path by its place below dists/ or repodata/ */
function releaseOf(rel: string): { format: Format; distro: string; name: string } | undefined {
    const [format, distro, third, fourth] = rel.split("/");
    if (format === "deb" && third === "dists" && fourth !== undefined) {
        return { format, distro, name: fourth };
    }
    return format === "rpm" && fourth === "repodata" ? { format, distro, name: third } : undefined;
}

/** deb/<distro>/pool or rpm/<distro>/<release>/Packages; undefined for a path outside them */
function poolRoot(poolPath: string): string | undefined {
    const segments = poolPath.split("/");
    const root = Object.hasOwn(POOL_ROOTS, segments[0]) ? POOL_ROOTS[segments[0]] : undefined;
    if (root === undefined || segments[root[0]] !== root[1] || segments.length <= root[0] + 1) {
        return undefined;
    }
    return segments.slice(0, root[0] + 1).join("/");
}

export function isPoolRoot(rel: string): boolean {
    return poolRoot(`${ rel }/file`) === rel;
}

/** Deletes a pool file, then the directories it leaves empty up to its pool root; only the deletion itself can fail */
export async function deletePoolFile(ctx: BackendContext, poolPath: string): Promise<void> {
    const root = poolRoot(poolPath);
    const file = repoFile(ctx, poolPath);
    await removeQuietly(file);
    if (root === undefined) {
        logger.warn(`${ poolPath } is not below a pool directory; its parent directories are kept`);
        return;
    }
    try {
        await removeEmptyParents(file, repoFile(ctx, root));
    } catch (err) {
        logger.warn(`Empty directories above ${ poolPath } could not be removed`, { err });
    }
}

/** The stored files of the current index rows and their MD5Sum twins */
export function currentIndexPaths(db: Database): Set<string> {
    const current = new Set<string>();
    const rows = db.prepare(`
        SELECT r.format, i.stored_path, i.md5 FROM index_files i JOIN releases r ON r.id = i.release_id WHERE i.stored_path IS NOT NULL`).all() as IndexRow[];
    for (const row of rows) {
        current.add(row.stored_path);
        if (row.format === "deb") {
            current.add(md5LinkPath(row.stored_path, row.md5));
        }
    }
    return current;
}

export async function readdirQuietly(dir: string): Promise<Dirent[]> {
    try {
        return await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
        if (errorCode(err) !== "ENOENT") {
            throw err;
        }
        return [];
    }
}

class Collector {
    private readonly ctx: BackendContext;
    private readonly s: ReturnType<typeof prepareStatements>;
    private readonly pools: Record<Format, Pool>;
    private readonly cutoff: number;
    private readonly published = new Map<string, Set<string>>();

    constructor(ctx: BackendContext) {
        this.ctx = ctx;
        this.s = prepareStatements(ctx.db);
        this.pools = { deb: new Pool(ctx.db, "deb", DEB_TABLES), rpm: new Pool(ctx.db, "rpm", RPM_TABLES) };
        this.cutoff = ctx.now() - GC_GRACE_SECONDS;
    }

    /** The published indexes may still list files the database already removed */
    publishPending(): boolean {
        return (this.s.publishPending.get() as { pending: number }).pending !== 0;
    }

    /** The grace counts from the publish that drops a file, which has not happened yet */
    restartGrace(): void {
        this.s.restartGrace.run(this.ctx.now());
    }

    /**
     * Rows past the grace that are still removed and unreferenced, by their own format's rule: the file goes first, then the
     * row, so a file that cannot go keeps its row for the next run
     */
    async collectPool(): Promise<{ deleted: string[]; failures: PoolFailure[] }> {
        const deleted: string[] = [];
        const failures: PoolFailure[] = [];
        for (const candidate of this.s.expiredPoolFiles.all(this.cutoff) as { id: number; path: string }[]) {
            const pool = this.pools[formatOf(candidate.path)];
            if (pool.removedRow(candidate.path) !== candidate.id) {
                continue;
            }
            try {
                await deletePoolFile(this.ctx, candidate.path);
            } catch (err) {
                failures.push({ path: candidate.path, err });
                continue;
            }
            pool.forget(candidate.id);
            deleted.push(candidate.path);
        }
        return { deleted, failures };
    }

    /** Superseded past the grace, unless a current release publishes the path; a row whose file is gone is just dropped */
    async collectSuperseded(): Promise<string[]> {
        const deleted: string[] = [];
        for (const row of this.s.expiredSuperseded.all(this.cutoff) as { path: string }[]) {
            if (this.isPublished(row.path)) {
                continue;
            }
            await removeQuietly(repoFile(this.ctx, row.path));
            this.s.deleteSuperseded.run(row.path);
            deleted.push(row.path);
        }
        return deleted;
    }

    /** MD5Sum links below dists/ that are neither current nor superseded, once older than the grace: a crash left them */
    async collectOrphanLinks(current: Set<string>): Promise<string[]> {
        const listed = new Set(this.s.supersededPaths.all().map(row => row.path as string));
        const deleted: string[] = [];
        for (const distro of await readdirQuietly(repoFile(this.ctx, "deb"))) {
            if (distro.isDirectory()) {
                await this.sweepLinks(`deb/${ distro.name }/dists`, current, listed, deleted);
            }
        }
        return deleted;
    }

    /** Asks only about the releases superseded rows point into, each once */
    private isPublished(rel: string): boolean {
        const release = releaseOf(rel);
        if (release === undefined) {
            return false;
        }
        const key = `${ release.format }/${ release.distro }/${ release.name }`;
        let paths = this.published.get(key);
        if (paths === undefined) {
            const publishedPaths = release.format === "deb" ? debPublishedPaths : rpmPublishedPaths;
            paths = new Set(publishedPaths(this.ctx.db, release.distro, release.name));
            this.published.set(key, paths);
        }
        return paths.has(rel);
    }

    private async sweepLinks(rel: string, current: Set<string>, listed: Set<string>, deleted: string[]): Promise<void> {
        for (const entry of await readdirQuietly(repoFile(this.ctx, rel))) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (entry.name !== "by-hash") {
                await this.sweepLinks(`${ rel }/${ entry.name }`, current, listed, deleted);
                continue;
            }
            const dir = `${ rel }/by-hash/MD5Sum`;
            for (const link of await readdirQuietly(repoFile(this.ctx, dir))) {
                const linkPath = `${ dir }/${ link.name }`;
                if (!link.isFile() || current.has(linkPath) || listed.has(linkPath)) {
                    continue;
                }
                const file = repoFile(this.ctx, linkPath);
                const stat = await statQuietly(file);
                if (stat !== undefined && stat.mtimeMs <= this.cutoff * 1000) {
                    await removeQuietly(file);
                    deleted.push(linkPath);
                }
            }
        }
    }
}

/**
 * Deletes what the grace period has released: pool files removed a day ago and still unreferenced, superseded index files
 * no current release publishes, and by-hash MD5Sum links nothing accounts for. Returns their repo-relative paths, sorted; a
 * listed file may have been gone already. Pool files wait while an index publish is pending, and all removed ones start the
 * grace over; one that cannot be deleted fails the run after the index files are collected. Must run under the backend's
 * writer mutex.
 */
export async function runGc(ctx: BackendContext): Promise<GcResult> {
    const collector = new Collector(ctx);
    let pool: string[] = [];
    let failures: PoolFailure[] = [];
    if (collector.publishPending()) {
        collector.restartGrace();
        logger.info("Garbage collection leaves the pool files to its next run: an index publish is pending");
    } else {
        ({ deleted: pool, failures } = await collector.collectPool());
    }
    const index = [...await collector.collectSuperseded(), ...await collector.collectOrphanLinks(currentIndexPaths(ctx.db))].sort();
    if (pool.length > 0 || index.length > 0) {
        logger.info(`Garbage collection deleted ${ pool.length } pool file(s) and ${ index.length } index file(s)`);
    }
    if (failures.length > 0) {
        // The logger prints the stack of an AggregateError, not its errors, so the reason goes into the message
        const named = failures.map(f => `${ f.path } (${ errorCode(f.err) ?? "unknown" })`);
        throw new AggregateError(failures.map(f => f.err), `Pool file(s) could not be deleted: ${ named.join(", ") }`);
    }
    return { pool: pool.sort(), index };
}

/** Collects every GC_INTERVAL_MS through the backend's writer mutex; the timer never keeps the process alive */
export function startGc(ctx: BackendContext, exclusive: <T>(fn: () => Promise<T>) => Promise<T>): { stop(): void } {
    const timer = setInterval(() => {
        Promise.resolve().then(() => exclusive(() => runGc(ctx)))
            .catch((err: unknown) => logger.error("Garbage collection failed", { err }));
    }, GC_INTERVAL_MS);
    timer.unref();
    return { stop: () => clearInterval(timer) };
}
