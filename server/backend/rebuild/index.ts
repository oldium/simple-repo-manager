import osPath from "path";
import fs from "fs/promises";
import type { Database } from "node:sqlite";
import { repoFile } from "../context.ts";
import type { BackendContext } from "../context.ts";
import { field, parseControl, parseFileList } from "../control.ts";
import { openDatabase, transaction } from "../db.ts";
import { publishDebian } from "../deb/publisher.ts";
import { currentIndexPaths, readdirQuietly } from "../gc.ts";
import { hashFile } from "../hash.ts";
import { errorCode, listFiles, moveFile, removeQuietly, statQuietly, syncDirectory } from "../publish-fs.ts";
import { RpmCatalog } from "../rpm/catalog.ts";
import { readRpm } from "../rpm/inputs.ts";
import { publishRpm } from "../rpm/publisher.ts";
import { problemText, rebuildDebian } from "./deb.ts";
import { RepoValidationError } from "../../lib/errors.ts";
import logger from "../../lib/logger.ts";

export type RebuildResult = { ok: true } | { ok: false; problems: string[] };

type Move = { from: string; to: string };

/** What tells a file on disk apart from one written over it */
type FileId = { ino: bigint; size: bigint; mtimeNs: bigint };

type ReleaseRef = { distro: string; name: string };

const DATABASE_SUFFIXES = ["", "-wal", "-shm"];

async function removeDatabase(file: string): Promise<void> {
    for (const suffix of DATABASE_SUFFIXES) {
        await removeQuietly(`${ file }${ suffix }`);
    }
}

async function syncFile(file: string): Promise<void> {
    // Windows refuses to flush a read-only handle
    const handle = await fs.open(file, "r+");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function fileId(file: string): Promise<FileId | undefined> {
    try {
        const stat = await fs.lstat(file, { bigint: true });
        return { ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs };
    } catch (err) {
        if (errorCode(err) !== "ENOENT") {
            throw err;
        }
        return undefined;
    }
}

async function subdirectories(dir: string): Promise<string[]> {
    return (await readdirQuietly(dir)).filter(entry => entry.isDirectory()).map(entry => entry.name);
}

/**
 * Keeps the release of every repodata/, with no package too, and catalogs every .rpm below rpm/<distro>/<release> wherever
 * it sits; returns the moves into the Packages/<c>/<source>/ layout
 */
async function rebuildRpm(db: Database, repoDir: string, now: number, problems: string[]): Promise<Move[]> {
    const catalog = new RpmCatalog(db);
    const moves: Move[] = [];
    const seen = new Map<string, string>();
    const root = osPath.join(repoDir, "rpm");
    for (const distro of await subdirectories(root)) {
        for (const release of await subdirectories(osPath.join(root, distro))) {
            if (await statQuietly(osPath.join(root, distro, release, "repodata")) !== undefined) {
                catalog.ensureRelease(distro, release);
            }
        }
    }
    for (const rel of await listFiles(root, dir => dir.split("/")[2] === "repodata")) {
        const segments = rel.split("/");
        if (segments.length < 3 || !rel.endsWith(".rpm")) {
            continue;
        }
        const [distro, release] = segments;
        const name = segments[segments.length - 1];
        const poolPath = `rpm/${ rel }`;
        try {
            // The catalog keys packages by file name within a release, so a namesake elsewhere would silently win
            const other = seen.get(`${ distro }/${ release }/${ name }`);
            if (other !== undefined) {
                throw new RepoValidationError(`a package of the same name is at ${ other }`);
            }
            seen.set(`${ distro }/${ release }/${ name }`, poolPath);
            const location = osPath.join(repoDir, "rpm", ...segments);
            const input = await readRpm(location, name, { distro, release }, await hashFile(location), await fs.stat(location));
            catalog.applyPackage(input, now);
            if (input.file.path !== poolPath) {
                moves.push({ from: poolPath, to: input.file.path });
            }
        } catch (err) {
            problems.push(`${ poolPath }: ${ problemText(err) }`);
        }
    }
    return moves;
}

async function removeEmptyDirectories(dir: string): Promise<void> {
    for (const name of await subdirectories(dir)) {
        await removeEmptyDirectories(osPath.join(dir, name));
    }
    try {
        await fs.rmdir(dir);
    } catch (err) {
        const code = errorCode(err);
        if (code !== "ENOTEMPTY" && code !== "EEXIST") {
            logger.warn(`${ dir } could not be removed`, { err });
        }
    }
}

/** What moves leave behind, also those of an interrupted rebuild, like the upper-case letter directories of the old layout */
async function removeEmptyRpmDirectories(repoDir: string): Promise<void> {
    const root = osPath.join(repoDir, "rpm");
    for (const distro of await subdirectories(root)) {
        for (const release of await subdirectories(osPath.join(root, distro))) {
            for (const name of (await subdirectories(osPath.join(root, distro, release))).filter(dir => dir !== "repodata")) {
                await removeEmptyDirectories(osPath.join(root, distro, release, name));
            }
        }
    }
}

/** Every file below deb/<distro>/dists/<release> and rpm/<distro>/<release>/repodata, before the publish */
async function indexSnapshot(repoDir: string): Promise<Map<string, FileId>> {
    const rels = [
        ...(await listFiles(osPath.join(repoDir, "deb"), dir => dir.split("/")[1] === "pool"))
            .filter(rel => rel.split("/")[1] === "dists" && rel.split("/").length > 3).map(rel => `deb/${ rel }`),
        ...(await listFiles(osPath.join(repoDir, "rpm"), dir => dir.split("/").length > 2 && dir.split("/")[2] !== "repodata"))
            .filter(rel => rel.split("/")[2] === "repodata").map(rel => `rpm/${ rel }`),
    ];
    const snapshot = new Map<string, FileId>();
    for (const rel of rels) {
        const id = await fileId(osPath.join(repoDir, ...rel.split("/")));
        if (id !== undefined) {
            snapshot.set(rel, id);
        }
    }
    return snapshot;
}

/**
 * Every name the published Debian Release files list, as repo-relative paths. repomd.xml lists only stored files, which
 * never count as leftovers.
 */
async function releaseListedPaths(ctx: BackendContext): Promise<Set<string>> {
    const listed = new Set<string>();
    const releases = ctx.db.prepare(`
        SELECT DISTINCT r.distro, r.name FROM releases r JOIN index_files i ON i.release_id = r.id
            WHERE r.format = 'deb' AND i.stored_path IS NOT NULL`).all() as ReleaseRef[];
    for (const r of releases) {
        const dir = `deb/${ r.distro }/dists/${ r.name }`;
        const [stanza] = parseControl(await fs.readFile(repoFile(ctx, `${ dir }/Release`), "utf8"));
        for (const file of parseFileList(field(stanza ?? [], "SHA256") ?? "", false)) {
            listed.add(`${ dir }/${ file.name }`);
        }
    }
    return listed;
}

/**
 * Files of the snapshot the publish left as they were, unless an index names or links them. One at a name the new Release
 * lists, such as reprepro's uncompressed Packages, is deleted at once: the publish never rewrites it, so its content
 * contradicts the signed checksum. The others go to GC after the grace period.
 */
async function retireUntouched(ctx: BackendContext, before: Map<string, FileId>): Promise<void> {
    const current = currentIndexPaths(ctx.db);
    // A canonical name is a hard link to its stored file, so re-linking it to an unchanged one keeps its identity
    const currentInos = new Set<bigint>();
    for (const rel of current) {
        const id = await fileId(repoFile(ctx, rel));
        if (id !== undefined) {
            currentInos.add(id.ino);
        }
    }
    const untouched: string[] = [];
    for (const [rel, was] of before) {
        const now = current.has(rel) ? undefined : await fileId(repoFile(ctx, rel));
        if (now !== undefined && now.ino === was.ino && now.size === was.size && now.mtimeNs === was.mtimeNs && !currentInos.has(now.ino)) {
            untouched.push(rel);
        }
    }
    const listed = await releaseListedPaths(ctx);
    for (const rel of untouched.filter(rel => listed.has(rel))) {
        await removeQuietly(repoFile(ctx, rel));
        logger.info(`Removed ${ rel }: the new Release lists this name with its own checksum`);
    }
    const at = ctx.now();
    const supersede = ctx.db.prepare("INSERT OR REPLACE INTO superseded_files (path, superseded_at) VALUES (?, ?)");
    transaction(ctx.db, () => {
        for (const rel of untouched.filter(rel => !listed.has(rel))) {
            supersede.run(rel, at);
        }
    });
}

/**
 * Builds the database from the published tree into repoStateDir/repo.db.rebuild. Any problem aborts before anything on
 * disk changes: the temporary database is deleted and the problems returned. Otherwise the RPMs move to their pool layout,
 * everything is published from the new database, and it replaces repo.db.
 */
export async function rebuildFromDisk(ctx: Omit<BackendContext, "db">): Promise<RebuildResult> {
    const { repoStateDir, repoDir } = ctx.paths;
    const tempFile = osPath.join(repoStateDir, "repo.db.rebuild");
    await fs.mkdir(repoStateDir, { recursive: true });
    await removeDatabase(tempFile);
    let db: Database | undefined = openDatabase(tempFile);
    try {
        // Nothing relies on this file before the rename: a crash only means rebuilding again
        db.exec("PRAGMA synchronous = OFF");
        const problems: string[] = [];
        const now = ctx.now();
        await rebuildDebian(db, repoDir, now, problems);
        const moves = await rebuildRpm(db, repoDir, now, problems);
        if (problems.length > 0) {
            return { ok: false, problems };
        }
        const full: BackendContext = { ...ctx, db };
        for (const move of moves) {
            await moveFile(repoFile(full, move.from), repoFile(full, move.to));
            logger.info(`Moved ${ move.from } to ${ move.to }`);
        }
        await removeEmptyRpmDirectories(repoDir);
        const before = await indexSnapshot(repoDir);
        await publishDebian(full);
        await publishRpm(full);
        await retireUntouched(full, before);
        // The rename publishes the file, so all of it must be on disk by then
        db.exec("PRAGMA synchronous = FULL");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.close();
        db = undefined;
        // A checkpoint of a WAL already backfilled syncs nothing
        await syncFile(tempFile);
        const file = osPath.join(repoStateDir, "repo.db");
        await removeQuietly(`${ file }-wal`);
        await removeQuietly(`${ file }-shm`);
        await fs.rename(tempFile, file);
        await syncDirectory(repoStateDir);
        return { ok: true };
    } finally {
        if (db !== undefined) {
            db.close();
            await removeDatabase(tempFile);
        }
    }
}
