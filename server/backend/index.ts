import osPath from "path";
import path from "path/posix";
import fs from "fs/promises";
import type { Statement } from "node:sqlite";
import type { BackendContext } from "./context.ts";
import { openDatabase } from "./db.ts";
import { DebCatalog, REFERENCING_TABLES as DEB_TABLES } from "./deb/catalog.ts";
import type { DebReleaseView } from "./deb/catalog.ts";
import { importDebian } from "./deb/importer.ts";
import { publishDebian } from "./deb/publisher.ts";
import { deletePoolFile, startGc } from "./gc.ts";
import type { Digests } from "./hash.ts";
import { MAX_PAGE_SIZE } from "./paging.ts";
import type { Listing, Page } from "./paging.ts";
import { describeSigningKey, loadSigningKey } from "./pgp.ts";
import { isFormat, Pool } from "./pool.ts";
import type { Format } from "./pool.ts";
import { listFiles, statQuietly } from "./publish-fs.ts";
import { rebuildFromDisk } from "./rebuild/index.ts";
import { reconcile, repairPublished } from "./reconcile.ts";
import { closing, opened, opening } from "./registry.ts";
import { RpmCatalog, REFERENCING_TABLES as RPM_TABLES } from "./rpm/catalog.ts";
import type { RpmReleaseView } from "./rpm/catalog.ts";
import { importRpm } from "./rpm/importer.ts";
import { publishRpm } from "./rpm/publisher.ts";
import { RepoValidationError } from "../lib/errors.ts";
import { moveAll } from "../lib/fs.ts";
import lock from "../lib/lock.ts";
import logger from "../lib/logger.ts";
import type {
    ImportResult, ListFilesFilter, RemovalFile, RemovalFilter, RemovalResult, RepoFile, RepositoryFilter, RepositoryRef,
    SourcePackage, SourcePackageFilter,
} from "../lib/repo-service.ts";

export { closeBackends } from "./registry.ts";
export type { Listing, Page } from "./paging.ts";

export type BackendPaths = BackendContext["paths"];

export type OpenOptions = { rebuild?: boolean };

/** A file of a source package; path is repo-relative */
export type PackageFile = RepositoryRef & RepoFile;

const FORMATS: Format[] = ["deb", "rpm"];

/** A listing over both formats continues where its cursor says: "<format>:<that catalog's cursor>" */
function splitCursor(cursor: string | undefined): { format?: Format; cursor?: string } {
    if (cursor === undefined) {
        return {};
    }
    const at = cursor.indexOf(":");
    const format = cursor.slice(0, at);
    if (at < 0 || !isFormat(format)) {
        throw new RepoValidationError("Invalid cursor");
    }
    return at + 1 < cursor.length ? { format, cursor: cursor.slice(at + 1) } : { format };
}

/** Serializes the writers; a run queued behind a failed one still runs */
class Mutex {
    private tail: Promise<unknown> = Promise.resolve();

    run<T>(fn: () => Promise<T>): Promise<T> {
        const result = this.tail.then(fn);
        this.tail = result.catch(() => undefined);
        return result;
    }

    /** Resolves once nothing runs or waits; a run queued while draining is waited for too */
    async drain(): Promise<void> {
        let tail: Promise<unknown>;
        do {
            tail = this.tail;
            await tail;
        } while (tail !== this.tail);
    }
}

/**
 * The repository backend of one data directory. Writers (import, removal, publishing, GC, the startup reconciliation)
 * run one at a time under the mutex; reads take no lock and see the last committed state, since node:sqlite is
 * synchronous and no transaction spans an await.
 */
export class Backend {
    private readonly ctx: BackendContext;
    private readonly mutex = new Mutex();
    private readonly catalogs: { deb: DebCatalog; rpm: RpmCatalog };
    private readonly pools: Record<Format, Pool>;
    private readonly insertStaged: Statement;
    /** Imports accepted but possibly still waiting inside lock.forExecOnce, off the mutex */
    private readonly inFlight = new Set<Promise<unknown>>();
    private gc: { stop(): void } | undefined;
    private keyConfigured = false;
    /** A publish failed, possibly after the indexes committed, and with nothing pending no publish would write Release again */
    private repairDue = false;
    /** close() was called: no new writer is accepted; the accepted ones still run */
    private closed = false;
    /** Every accepted writer is done and the database closes: a writer reaching the mutex now is turned away */
    private sealed = false;
    private closeDone: Promise<void> | undefined;

    constructor(ctx: BackendContext) {
        this.ctx = ctx;
        this.catalogs = { deb: new DebCatalog(ctx.db), rpm: new RpmCatalog(ctx.db) };
        this.pools = { deb: new Pool(ctx.db, "deb", DEB_TABLES), rpm: new Pool(ctx.db, "rpm", RPM_TABLES) };
        this.insertStaged = ctx.db.prepare(`
            INSERT OR REPLACE INTO staged_digests (rel_path, size, mtime_ms, md5, sha1, sha256, sha512) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    }

    /** Under the mutex: reconciles, re-applies what an interrupted import left in incoming/process, then starts the GC */
    async start(keyConfigured: boolean): Promise<void> {
        this.keyConfigured = keyConfigured;
        await this.mutex.run(async () => {
            const result = await reconcile(this.ctx, { keyConfigured });
            const summary = Object.entries(result).filter(([, items]) => items.length > 0).map(([what, items]) => `${ items.length } ${ what }`);
            if (summary.length > 0) {
                logger.info(`Startup reconciliation: ${ summary.join(", ") }`);
            }
            const leftovers = await listFiles(osPath.join(this.ctx.paths.incomingDir, "process"));
            if (leftovers.length > 0) {
                // An interrupted import, or files earlier imports skipped or failed and left there
                logger.info(`Importing ${ leftovers.length } file(s) found in incoming/process`);
                const { files } = await this.importProcess();
                const count = (status: string): number => files.filter(f => f.status === status).length;
                logger.info(`incoming/process: ${ count("ok") } file(s) imported, ${ count("skipped") } skipped, ${ count("failed") } failed`);
            }
        });
        this.gc = startGc(this.ctx, <T>(fn: () => Promise<T>) => this.mutex.run(async () => {
            // A failure here skips the collection: a stale Release still names what it would delete
            if (this.repairDue) {
                await this.publish();
            }
            return fn();
        }));
    }

    /** Moves the staged uploads to process/ and imports them; concurrent calls coalesce and wait for uploads in flight */
    async importStaged(): Promise<ImportResult> {
        this.assertOpen();
        const run = lock.forExecOnce(() => this.mutex.run(async () => {
            this.assertNotSealed();
            await moveAll(osPath.join(this.ctx.paths.incomingDir, "staging"), osPath.join(this.ctx.paths.incomingDir, "process"));
            return this.importProcess();
        }));
        this.inFlight.add(run);
        try {
            return await run;
        } finally {
            this.inFlight.delete(run);
        }
    }

    /** Removes the matching sources of every wanted release and republishes; immediate deletes the freed pool files at once */
    async remove(f: RemovalFilter & { immediate?: boolean }): Promise<RemovalResult> {
        this.assertOpen();
        return this.mutex.run(async () => {
            this.assertNotSealed();
            const now = this.ctx.now();
            const files = new Map<string, RemovalFile>();
            const deleteNow = new Map<string, Format>();
            let touchedTargets = 0;
            for (const format of this.formats(f.format)) {
                const catalog = this.catalogs[format];
                for (const r of catalog.releases(f.distribution, f.release)) {
                    const outcome = catalog.remove({ distro: r.distro, release: r.release, source: f.source, version: f.version }, now, f.immediate ?? false);
                    if (outcome.removed.length > 0) {
                        touchedTargets++;
                    }
                    for (const p of outcome.removed) {
                        files.set(p, { filename: path.basename(p), path: p, status: "ok" });
                    }
                    for (const p of outcome.deleteNow) {
                        deleteNow.set(p, format);
                    }
                }
            }
            await this.publish();
            // Only once the new Release/repomd.xml is on disk: clients of the previous one still find its files until then
            for (const [p, format] of deleteNow) {
                const fileId = this.pools[format].removedRow(p);
                if (fileId === undefined) {
                    continue;
                }
                try {
                    await deletePoolFile(this.ctx, p);
                } catch (err) {
                    // The row keeps removed_at, so GC tries again after the grace
                    logger.error(`Failed to delete ${ p }`, { err });
                    files.get(p)!.status = "failed";
                    continue;
                }
                this.pools[format].forget(fileId);
            }
            return { files: [...files.values()], touchedTargets };
        });
    }

    listRepositories(f: RepositoryFilter = {}): RepositoryRef[] {
        this.assertOpen();
        return this.formats(f.format).flatMap(format =>
            this.catalogs[format].releases(f.distribution, f.release).map(r => ({ format, distribution: r.distro, release: r.release })));
    }

    listSourcePackages(f: SourcePackageFilter, page: Page = {}): Listing<SourcePackage> {
        this.assertOpen();
        return this.pageAcross(f.format, page, (format, p) => {
            const listing = this.catalogs[format].listSources({ distro: f.distribution, release: f.release, source: f.source }, p);
            return {
                ...listing, items: listing.items.map(i => ({ format, distribution: i.distro, release: i.release, source: i.source, version: i.version })),
            };
        });
    }

    listPackageFiles(f: ListFilesFilter, page: Page = {}): Listing<PackageFile> {
        this.assertOpen();
        return this.pageAcross(f.format, page, (format, p) => {
            const listing = this.catalogs[format].listFiles({ distro: f.distribution, release: f.release, source: f.source, version: f.version }, p);
            return {
                ...listing, items: listing.items.map(i => ({ format, distribution: i.distro, release: i.release, path: i.path, filename: path.basename(i.path) })),
            };
        });
    }

    repositoryTree(): { deb: DebReleaseView[]; rpm: RpmReleaseView[] } {
        this.assertOpen();
        return { deb: this.catalogs.deb.releases(), rpm: this.catalogs.rpm.releases() };
    }

    /** The digests the upload handler computed while receiving the file, so the import does not hash it again */
    recordStagedDigest(relPath: string, stat: { size: number; mtimeMs: number }, d: Digests): void {
        this.assertOpen();
        this.insertStaged.run(relPath, stat.size, Math.trunc(stat.mtimeMs), d.md5, d.sha1, d.sha256, d.sha512);
    }

    /** Forgets the backend, stops the GC, lets the accepted writers finish or bounce, then closes the database */
    close(): Promise<void> {
        if (this.closeDone === undefined) {
            const key = osPath.resolve(this.ctx.paths.repoStateDir);
            this.closeDone = this.doClose().finally(() => closing.delete(key));
            closing.set(key, this.closeDone);
        }
        return this.closeDone;
    }

    private async doClose(): Promise<void> {
        this.closed = true;
        const key = osPath.resolve(this.ctx.paths.repoStateDir);
        opened.delete(key);
        opening.delete(key);
        this.gc?.stop();
        // An import may still wait inside lock.forExecOnce and join the mutex later
        while (this.inFlight.size > 0) {
            await Promise.allSettled([...this.inFlight]);
        }
        await this.mutex.drain();
        this.sealed = true;
        this.ctx.db.close();
    }

    private assertOpen(): void {
        if (this.closed) {
            throw new Error(`Backend of ${ this.ctx.paths.repoStateDir } is closed`);
        }
    }

    /** The last guard of a writer: nothing is moved or touched once the database is closing */
    private assertNotSealed(): void {
        if (this.sealed) {
            throw new Error(`Backend of ${ this.ctx.paths.repoStateDir } is closed`);
        }
    }

    private formats(format: Format | undefined): Format[] {
        return FORMATS.filter(f => format === undefined || f === format);
    }

    /** One page over the wanted formats in order; the page goes on in the format the cursor names */
    private pageAcross<T>(format: Format | undefined, page: Page, fetch: (format: Format, page: Page) => Listing<T>): Listing<T> {
        const limit = Math.min(page.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
        const start = splitCursor(page.cursor);
        const formats = this.formats(format).filter(f => start.format === undefined || FORMATS.indexOf(f) >= FORMATS.indexOf(start.format));
        const items: T[] = [];
        for (const [i, f] of formats.entries()) {
            const listing = fetch(f, { limit: limit - items.length, cursor: f === start.format ? start.cursor : undefined });
            items.push(...listing.items);
            if (listing.nextCursor !== undefined) {
                return { items, nextCursor: `${ f }:${ listing.nextCursor }` };
            }
            if (items.length === limit) {
                // A boundary cursor only when a later format has anything, so the page it leads to is never empty
                const next = formats.slice(i + 1).find(later => fetch(later, { limit: 1 }).items.length > 0);
                return next === undefined ? { items } : { items, nextCursor: `${ next }:` };
            }
        }
        return { items };
    }

    /** Imports what incoming/process holds, then publishes */
    private async importProcess(): Promise<ImportResult> {
        const files = [...await importDebian(this.ctx), ...await importRpm(this.ctx)];
        await this.publish();
        return { ok: files.every(f => f.status !== "failed"), files };
    }

    /** Publishes what is pending and repairs what an earlier failure left; until all of it succeeds the repair stays due */
    private async publish(): Promise<void> {
        try {
            const published = [...await publishDebian(this.ctx), ...await publishRpm(this.ctx)];
            if (this.repairDue) {
                await repairPublished(this.ctx, published.length > 0, { keyConfigured: this.keyConfigured });
                this.repairDue = false;
            }
        } catch (err) {
            this.repairDue = true;
            logger.warn("Publishing failed: the next import, removal or garbage collection repairs the published state");
            throw err;
        }
    }
}

async function hasPublishedTree(repoDir: string): Promise<boolean> {
    for (const format of FORMATS) {
        if (await statQuietly(osPath.join(repoDir, format)) !== undefined) {
            return true;
        }
    }
    return false;
}

async function open(paths: BackendPaths, signingKeyFile: string | undefined, options: OpenOptions, key: string): Promise<Backend> {
    const signingKey = await loadSigningKey(signingKeyFile);
    if (signingKeyFile !== undefined && signingKey === undefined) {
        logger.warn(`GPG key file ${ signingKeyFile } does not exist.`);
    }
    if (signingKey !== undefined) {
        logger.info(`Signing repository metadata with ${ await describeSigningKey(signingKey) }`);
    }
    const now = (): number => Math.floor(Date.now() / 1000);
    for (const dir of [paths.repoDir, paths.repoStateDir, osPath.join(paths.incomingDir, "staging"), osPath.join(paths.incomingDir, "process")]) {
        await fs.mkdir(dir, { recursive: true });
    }
    const dbFile = osPath.join(paths.repoStateDir, "repo.db");
    if (options.rebuild === true || (await statQuietly(dbFile) === undefined && await hasPublishedTree(paths.repoDir))) {
        logger.info("Rebuilding the repository database from the published tree");
        const result = await rebuildFromDisk({ paths, signingKey, now });
        if (!result.ok) {
            for (const problem of result.problems) {
                logger.error(`Rebuild: ${ problem }`);
            }
            throw new Error(`Rebuild found ${ result.problems.length } problem(s) in the published tree`);
        }
    }
    const db = openDatabase(dbFile);
    const backend = new Backend({ db, paths, signingKey, now });
    try {
        await backend.start(signingKeyFile !== undefined);
    } catch (err) {
        db.close();
        throw err;
    }
    opened.set(key, backend);
    return backend;
}

/**
 * The backend of the data directory, opened once per repoStateDir. Loads the key, rebuilds the database from the
 * published tree when it is missing (or on request), reconciles, re-applies an interrupted import and starts the GC.
 * A rebuild that finds problems logs each of them and throws.
 */
export function openBackend(paths: BackendPaths, signingKeyFile: string | undefined, options: OpenOptions = {}): Promise<Backend> {
    const key = osPath.resolve(paths.repoStateDir);
    let pending = opening.get(key);
    if (pending === undefined) {
        // The directory's previous backend may still be closing, its writers draining
        const promise = (closing.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => open(paths, signingKeyFile, options, key));
        opening.set(key, promise);
        promise.catch(() => {
            if (opening.get(key) === promise) {
                opening.delete(key);
            }
        });
        pending = promise;
    }
    return pending;
}

/** The open backend of the repoStateDir; throws when none is */
export function getBackend(repoStateDir: string): Backend {
    const backend = opened.get(osPath.resolve(repoStateDir));
    if (backend === undefined) {
        throw new Error(`No backend is open for ${ repoStateDir }`);
    }
    return backend;
}
