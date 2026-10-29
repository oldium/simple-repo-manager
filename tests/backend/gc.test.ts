import { withLocalTmpDir } from "../utils.ts";
import { jest } from "@jest/globals";
import crypto from "crypto";
import osPath from "path";
import path from "path/posix";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import type { Database } from "node:sqlite";
import { openDatabase } from "../../server/backend/db.ts";
import type { BackendContext } from "../../server/backend/context.ts";
import { DebCatalog } from "../../server/backend/deb/catalog.ts";
import { importDebian } from "../../server/backend/deb/importer.ts";
import { md5LinkPath, publishDebian } from "../../server/backend/deb/publisher.ts";
import { deletePoolFile, GC_GRACE_SECONDS, GC_INTERVAL_MS, runGc, startGc } from "../../server/backend/gc.ts";
import type { PoolFile } from "../../server/backend/pool.ts";
import { removeEmptyParents } from "../../server/backend/publish-fs.ts";
import { RpmCatalog, rpmPoolPath } from "../../server/backend/rpm/catalog.ts";
import type { RpmPackageInput } from "../../server/backend/rpm/catalog.ts";
import { publishRpm } from "../../server/backend/rpm/publisher.ts";
import logger from "../../server/lib/logger.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const TRIXIE = osPath.join(FIXTURES, "packages", "deb", "debian", "trixie", "main");
const NOW = 1700000000;
const STALE = NOW - 2 * GC_GRACE_SECONDS;

type Ctx = BackendContext & { clock: { now: number } };

type PoolRow = { path: string; removed_at: number | null };

type SupersededRow = { path: string; superseded_at: number };

type IndexRow = { stored_path: string; md5: string };

function osJoin(...posix: string[]): string {
    return osPath.join(...posix.join("/").split("/"));
}

function withGc(fn: (ctx: Ctx) => Promise<void>) {
    return withLocalTmpDir(async () => {
        await fs.mkdir("state");
        const db = openDatabase(osPath.join("state", "repo.db"));
        const clock = { now: NOW };
        try {
            await fn({ db, paths: { incomingDir: "incoming", repoStateDir: "state", repoDir: "repo" }, signingKey: undefined, now: () => clock.now, clock });
        } finally {
            db.close();
        }
    });
}

/** Stages the trixie bundle and imports it; its seven files land in the pool */
async function importTrixie(ctx: Ctx): Promise<string[]> {
    const dir = osJoin(ctx.paths.incomingDir, "process", "deb/debian/trixie/main");
    await fs.mkdir(dir, { recursive: true });
    for (const name of await fs.readdir(TRIXIE)) {
        await fs.copyFile(osPath.join(TRIXIE, name), osPath.join(dir, name));
    }
    const result = await importDebian(ctx);
    expect(result).toHaveLength(7);
    expect(result.filter(f => f.status !== "ok")).toEqual([]);
    return poolRows(ctx.db).map(r => r.path);
}

function repoFile(ctx: Ctx, rel: string): string {
    return osJoin(ctx.paths.repoDir, rel);
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.stat(file);
        return true;
    } catch {
        return false;
    }
}

/** Those of the repo-relative paths that are on disk */
async function existing(ctx: Ctx, rels: string[]): Promise<string[]> {
    const found: string[] = [];
    for (const rel of rels) {
        if (await exists(repoFile(ctx, rel))) {
            found.push(rel);
        }
    }
    return found;
}

async function writeRepoFile(ctx: Ctx, rel: string, mtime?: number): Promise<void> {
    const file = repoFile(ctx, rel);
    await fs.mkdir(osPath.dirname(file), { recursive: true });
    await fs.writeFile(file, rel);
    if (mtime !== undefined) {
        await fs.utimes(file, mtime, mtime);
    }
}

function poolRows(db: Database): PoolRow[] {
    return db.prepare("SELECT path, removed_at FROM pool_files ORDER BY path").all() as PoolRow[];
}

function insertPoolRow(db: Database, file: PoolFile, removedAt: number): void {
    db.prepare("INSERT INTO pool_files (path, size, md5, sha1, sha256, sha512, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(file.path, file.size, file.md5, file.sha1, file.sha256, file.sha512, removedAt);
}

function superseded(db: Database): SupersededRow[] {
    return db.prepare("SELECT path, superseded_at FROM superseded_files ORDER BY path").all() as SupersededRow[];
}

function supersede(db: Database, path: string, at: number): void {
    db.prepare("INSERT OR REPLACE INTO superseded_files (path, superseded_at) VALUES (?, ?)").run(path, at);
}

function currentIndexes(db: Database): IndexRow[] {
    return db.prepare("SELECT stored_path, md5 FROM index_files WHERE stored_path IS NOT NULL ORDER BY stored_path").all() as IndexRow[];
}

/** Every path a current index owns: its stored file and, for Debian, its MD5Sum twin */
function currentPaths(db: Database): string[] {
    return currentIndexes(db).flatMap(row =>
        row.stored_path.startsWith("deb/") ? [row.stored_path, md5LinkPath(row.stored_path, row.md5)] : [row.stored_path]).sort();
}

function currentPackages(db: Database): IndexRow {
    const found = currentIndexes(db).find(row => row.stored_path.includes("/binary-amd64/"));
    if (found === undefined) {
        throw new Error("No published Packages index");
    }
    return found;
}

function fakeFile(path: string): PoolFile {
    const digest = (name: string): string => crypto.createHash(name).update(path).digest("hex");
    return { path, size: path.length, md5: digest("md5"), sha1: digest("sha1"), sha256: digest("sha256"), sha512: digest("sha512") };
}

function rpmPackage(): RpmPackageInput {
    const filename = "srm-hello-1.0-1.fc42.x86_64.rpm";
    return {
        distro: "fedora", release: "42", filename, name: "srm-hello", epoch: 0, version: "1.0", rel: "1.fc42", arch: "x86_64",
        sourceName: "srm-hello", sourceVersion: "1.0-1.fc42", file: fakeFile(rpmPoolPath("fedora", "42", "srm-hello", filename)),
        primaryXml: "", filelistsXml: "", otherXml: "",
    };
}

/** An rpm release with one published index row, as the RPM publisher leaves it */
function rpmIndex(db: Database): IndexRow {
    const { id } = db.prepare("INSERT INTO releases (format, distro, name) VALUES ('rpm', 'fedora', '42') RETURNING id").get() as { id: number };
    const row = { stored_path: `rpm/fedora/42/repodata/${ "f".repeat(64) }-primary.xml.zst`, md5: "e".repeat(32) };
    db.prepare("INSERT INTO index_files (release_id, kind, generation, stored_path, md5) VALUES (?, 'primary', 1, ?, ?)").run(id, row.stored_path, row.md5);
    return row;
}

describe("Tests for runGc", () => {
    test("Keeps a file removed 86399 s ago and deletes it at 86400 s", withGc(async ctx => {
        const paths = await importTrixie(ctx);
        expect(await existing(ctx, paths)).toEqual(paths);
        expect(new DebCatalog(ctx.db).remove({ source: "srm-hello" }, NOW, false)).toEqual({ removed: paths, deleteNow: [] });
        expect(poolRows(ctx.db).map(r => r.removed_at)).toEqual(Array(7).fill(NOW));
        await publishDebian(ctx);

        ctx.clock.now = NOW + GC_GRACE_SECONDS - 1;
        expect(await runGc(ctx)).toEqual({ pool: [], index: [] });
        expect(await existing(ctx, paths)).toEqual(paths);
        expect(poolRows(ctx.db)).toHaveLength(7);

        // A file already gone from disk still loses its row
        await fs.unlink(repoFile(ctx, paths[0]));
        ctx.clock.now = NOW + GC_GRACE_SECONDS;
        expect(await runGc(ctx)).toEqual({ pool: paths, index: [] });
        expect(await existing(ctx, paths)).toEqual([]);
        expect(poolRows(ctx.db)).toEqual([]);
        expect(await runGc(ctx)).toEqual({ pool: [], index: [] });
    }));

    test("Never deletes a file referenced again", withGc(async ctx => {
        const paths = await importTrixie(ctx);
        new DebCatalog(ctx.db).remove({ source: "srm-hello" }, NOW, false);
        ctx.clock.now = NOW + 1;
        expect(await importTrixie(ctx)).toEqual(paths);
        expect(poolRows(ctx.db).map(r => r.removed_at)).toEqual(Array(7).fill(null));
        // A stale removed_at on a referenced row, checked with each format's own rule
        const orig = paths.find(p => p.endsWith(".orig.tar.gz"))!;
        ctx.db.prepare("UPDATE pool_files SET removed_at = ? WHERE path = ?").run(STALE, orig);
        const rpm = rpmPackage();
        new RpmCatalog(ctx.db).applyPackage(rpm, NOW);
        await writeRepoFile(ctx, rpm.file.path);
        ctx.db.prepare("UPDATE pool_files SET removed_at = ? WHERE path = ?").run(STALE, rpm.file.path);
        // One file nothing references proves the run collected
        const dropped = fakeFile("deb/debian/pool/main/s/srm-hello/srm-hello_0.9-1_amd64.deb");
        insertPoolRow(ctx.db, dropped, STALE);
        await writeRepoFile(ctx, dropped.path);
        await publishDebian(ctx);
        await publishRpm(ctx);

        ctx.clock.now = NOW + 2 * GC_GRACE_SECONDS;
        expect(await runGc(ctx)).toEqual({ pool: [dropped.path], index: [] });

        const all = [...paths, rpm.file.path].sort();
        expect(poolRows(ctx.db).map(r => r.path)).toEqual(all);
        expect(await existing(ctx, [...all, dropped.path])).toEqual(all);
    }));

    test("A pool file it cannot delete keeps its row for the next run, which deletes it", withGc(async ctx => {
        const good = fakeFile("deb/debian/pool/main/s/srm-hello/srm-hello_0.9-1_amd64.deb");
        const bad = fakeFile("deb/debian/pool/main/s/srm-hello/srm-hello_0.9-2_amd64.deb");
        insertPoolRow(ctx.db, good, STALE);
        insertPoolRow(ctx.db, bad, STALE);
        await writeRepoFile(ctx, good.path);
        // unlink refuses a directory on every platform, with a platform-specific code
        await fs.mkdir(repoFile(ctx, bad.path), { recursive: true });
        const old = `deb/debian/dists/trixie/main/binary-amd64/by-hash/SHA256/${ "a".repeat(64) }`;
        supersede(ctx.db, old, STALE);
        await writeRepoFile(ctx, old);

        const error = await runGc(ctx).then(() => undefined, (err: unknown) => err);

        expect(error).toBeInstanceOf(AggregateError);
        const { errors, message } = error as AggregateError;
        expect(errors).toHaveLength(1);
        const code = (errors[0] as NodeJS.ErrnoException).code;
        expect(["EISDIR", "EPERM", "EACCES"]).toContain(code);
        expect(message).toBe(`Pool file(s) could not be deleted: ${ bad.path } (${ code })`);
        expect(await existing(ctx, [good.path, bad.path, old])).toEqual([bad.path]);
        expect(poolRows(ctx.db)).toEqual([{ path: bad.path, removed_at: STALE }]);
        expect(superseded(ctx.db)).toEqual([]);

        await fs.rmdir(repoFile(ctx, bad.path));
        await writeRepoFile(ctx, bad.path);
        expect(await runGc(ctx)).toEqual({ pool: [bad.path], index: [] });
        expect(await existing(ctx, [bad.path])).toEqual([]);
        expect(poolRows(ctx.db)).toEqual([]);
    }));

    test("A pending index publish defers pool collection to the run after publishing", withGc(async ctx => {
        const paths = await importTrixie(ctx);
        await publishDebian(ctx);
        new DebCatalog(ctx.db).remove({ source: "srm-hello" }, NOW, false);
        const old = `deb/debian/dists/trixie/main/binary-amd64/by-hash/SHA256/${ "a".repeat(64) }`;
        supersede(ctx.db, old, STALE);
        await writeRepoFile(ctx, old);
        ctx.clock.now = NOW + GC_GRACE_SECONDS;
        const infoSpy = jest.spyOn(logger, "info").mockReturnValue(logger);
        try {
            expect(await runGc(ctx)).toEqual({ pool: [], index: [old] });
            expect(infoSpy).toHaveBeenCalledWith("Garbage collection leaves the pool files to its next run: an index publish is pending");
        } finally {
            infoSpy.mockRestore();
        }
        expect(await existing(ctx, paths)).toEqual(paths);
        expect(poolRows(ctx.db).map(r => r.removed_at)).toEqual(Array(7).fill(ctx.clock.now));

        // The publish that drops the files comes late, and the grace counts from there
        await publishDebian(ctx);
        expect((await runGc(ctx)).pool).toEqual([]);
        ctx.clock.now += GC_GRACE_SECONDS - 1;
        expect((await runGc(ctx)).pool).toEqual([]);
        ctx.clock.now += 1;
        expect((await runGc(ctx)).pool).toEqual(paths);
        expect(await existing(ctx, paths)).toEqual([]);
    }));

    test("An index never published defers pool collection as well", withGc(async ctx => {
        const paths = await importTrixie(ctx);
        new DebCatalog(ctx.db).remove({ source: "srm-hello" }, NOW, false);
        // Generation 0 alone, without dirty keys
        ctx.db.exec("DELETE FROM dirty_keys");
        ctx.clock.now = NOW + GC_GRACE_SECONDS;

        expect(await runGc(ctx)).toEqual({ pool: [], index: [] });
        expect(await existing(ctx, paths)).toEqual(paths);

        await publishDebian(ctx);
        ctx.clock.now += GC_GRACE_SECONDS;
        expect((await runGc(ctx)).pool).toEqual(paths);
    }));

    test("Deferring restarts the grace of every removed row, so it ends about a day after the publish that drops them", withGc(async ctx => {
        const paths = await importTrixie(ctx);
        const expired = fakeFile("deb/debian/pool/main/s/srm-gz/srm-gz_0.1-1_amd64.deb");
        const younger = fakeFile("deb/debian/pool/main/s/srm-gz/srm-gz_0.2-1_amd64.deb");
        insertPoolRow(ctx.db, expired, NOW - GC_GRACE_SECONDS);
        insertPoolRow(ctx.db, younger, NOW - GC_GRACE_SECONDS + 1);

        expect(await runGc(ctx)).toEqual({ pool: [], index: [] });

        expect(poolRows(ctx.db)).toEqual([
            ...paths.map(path => ({ path, removed_at: null })),
            { path: expired.path, removed_at: NOW },
            { path: younger.path, removed_at: NOW },
        ].sort((a, b) => a.path < b.path ? -1 : 1));
    }));

    test("Deletes the directories a collected pool file leaves empty, up to the pool root", withGc(async ctx => {
        const kept = await importTrixie(ctx);
        await publishDebian(ctx);
        const dropped = [
            "deb/debian/pool/main/s/srm-gz/srm-gz_0.1-1_amd64.deb",
            "deb/ubuntu/pool/universe/s/srm-zst/srm-zst_3.0-1_amd64.deb",
            "rpm/fedora/42/Packages/s/srm-hello/srm-hello-1.0-1.fc42.x86_64.rpm",
        ];
        for (const p of dropped) {
            insertPoolRow(ctx.db, fakeFile(p), STALE);
            await writeRepoFile(ctx, p);
        }

        expect(await runGc(ctx)).toEqual({ pool: dropped, index: [] });

        expect(await existing(ctx, [...kept, ...dropped])).toEqual(kept);
        expect(await existing(ctx, ["deb/debian/pool/main/s/srm-gz", "deb/ubuntu/pool/universe", "rpm/fedora/42/Packages/s"])).toEqual([]);
        expect(await existing(ctx, ["deb/debian/pool/main/s", "deb/ubuntu/pool", "rpm/fedora/42/Packages"]))
            .toEqual(["deb/debian/pool/main/s", "deb/ubuntu/pool", "rpm/fedora/42/Packages"]);
    }));

    test("Keeps the directories of a pool file outside a pool directory, with a warning", withGc(async ctx => {
        const stray = fakeFile("deb/debian/stray/srm-hello_0.9-1_amd64.deb");
        insertPoolRow(ctx.db, stray, STALE);
        await writeRepoFile(ctx, stray.path);
        const warnSpy = jest.spyOn(logger, "warn").mockReturnValue(logger);
        try {
            expect(await runGc(ctx)).toEqual({ pool: [stray.path], index: [] });
            expect(warnSpy).toHaveBeenCalledWith(`${ stray.path } is not below a pool directory; its parent directories are kept`);
        } finally {
            warnSpy.mockRestore();
        }
        expect(await existing(ctx, [stray.path, "deb/debian/stray"])).toEqual(["deb/debian/stray"]);
    }));

    test("A first segment naming an Object.prototype property skips pruning", withGc(async ctx => {
        const warnSpy = jest.spyOn(logger, "warn").mockReturnValue(logger);
        try {
            for (const p of ["__proto__/pool/s/srm-hello/file.deb", "constructor/pool/s/srm-hello/file.deb"]) {
                await writeRepoFile(ctx, p);
                await deletePoolFile(ctx, p);
                expect(warnSpy).toHaveBeenCalledWith(`${ p } is not below a pool directory; its parent directories are kept`);
                expect(await existing(ctx, [p, path.dirname(p)])).toEqual([path.dirname(p)]);
            }
        } finally {
            warnSpy.mockRestore();
        }
    }));

    test("A directory that cannot be removed only warns and the run goes on", withGc(async ctx => {
        const dropped = fakeFile("deb/debian/pool/main/s/srm-gz/srm-gz_0.1-1_amd64.deb");
        insertPoolRow(ctx.db, dropped, STALE);
        await writeRepoFile(ctx, dropped.path);
        const old = `deb/debian/dists/trixie/main/binary-amd64/by-hash/SHA256/${ "a".repeat(64) }`;
        supersede(ctx.db, old, STALE);
        await writeRepoFile(ctx, old);
        const busy = Object.assign(new Error("resource busy"), { code: "EBUSY" });
        const rmdirSpy = jest.spyOn(fs, "rmdir").mockRejectedValue(busy);
        const warnSpy = jest.spyOn(logger, "warn").mockReturnValue(logger);
        try {
            expect(await runGc(ctx)).toEqual({ pool: [dropped.path], index: [old] });
            expect(warnSpy).toHaveBeenCalledWith(`Empty directories above ${ dropped.path } could not be removed`, { err: busy });
        } finally {
            rmdirSpy.mockRestore();
            warnSpy.mockRestore();
        }
        expect(await existing(ctx, [dropped.path, old, "deb/debian/pool/main/s/srm-gz"])).toEqual(["deb/debian/pool/main/s/srm-gz"]);
    }));

    test("Keeps a superseded index file younger than a day", withGc(async ctx => {
        const paths = await importTrixie(ctx);
        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);
        const old = currentPaths(ctx.db);
        expect(old).toHaveLength(6);
        ctx.clock.now = NOW + 1;
        new DebCatalog(ctx.db).remove({ source: "srm-hello" }, ctx.now(), false);
        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);
        const current = currentPaths(ctx.db);
        expect(current.filter(p => old.includes(p))).toEqual([]);
        expect(superseded(ctx.db)).toEqual(old.map(path => ({ path, superseded_at: NOW + 1 })));

        ctx.clock.now = NOW + 1 + GC_GRACE_SECONDS - 1;
        expect(await runGc(ctx)).toEqual({ pool: [], index: [] });
        expect(await existing(ctx, old)).toEqual(old);
        expect(superseded(ctx.db)).toHaveLength(6);

        ctx.clock.now = NOW + 1 + GC_GRACE_SECONDS;
        expect(await runGc(ctx)).toEqual({ pool: paths, index: old });
        expect(await existing(ctx, old)).toEqual([]);
        expect(await existing(ctx, current)).toEqual(current);
        expect(await exists(repoFile(ctx, "deb/debian/dists/trixie/Release"))).toBe(true);
        expect(await exists(repoFile(ctx, "deb/debian/dists/trixie/main/binary-amd64/Packages.gz"))).toBe(true);
        expect(superseded(ctx.db)).toEqual([]);
        expect(poolRows(ctx.db)).toEqual([]);
    }));

    test("Never deletes the current stored_path even if listed as superseded", withGc(async ctx => {
        await importTrixie(ctx);
        await publishDebian(ctx);
        const rpm = rpmIndex(ctx.db);
        await writeRepoFile(ctx, rpm.stored_path);
        const listed = currentIndexes(ctx.db).map(row => row.stored_path);
        expect(listed).toHaveLength(4);
        expect(listed).toContain(rpm.stored_path);
        for (const p of listed) {
            supersede(ctx.db, p, STALE);
        }
        // One path no index names proves the run collected
        const stale = `${ path.dirname(currentPackages(ctx.db).stored_path) }/${ "2".repeat(64) }`;
        await writeRepoFile(ctx, stale);
        supersede(ctx.db, stale, STALE);

        expect(await runGc(ctx)).toEqual({ pool: [], index: [stale] });

        expect(await existing(ctx, [...listed, stale])).toEqual(listed);
        expect(await existing(ctx, currentPaths(ctx.db))).toEqual(currentPaths(ctx.db));
        expect(superseded(ctx.db)).toEqual(listed.map(p => ({ path: p, superseded_at: STALE })));
    }));

    test("Never deletes what a current release publishes, whatever superseded_files says", withGc(async ctx => {
        await importTrixie(ctx);
        await publishDebian(ctx);
        rpmIndex(ctx.db);
        const dists = "deb/debian/dists/trixie";
        const repodata = "rpm/fedora/42/repodata";
        const published = [
            ...currentPaths(ctx.db), `${ dists }/Release`, `${ dists }/InRelease`, `${ dists }/Release.gpg`, `${ dists }/main/Contents-amd64.gz`,
            `${ dists }/main/binary-amd64/Packages.gz`, `${ dists }/main/source/Sources.gz`, `${ repodata }/repomd.xml`, `${ repodata }/repomd.xml.asc`,
        ].sort();
        // The same names where no current release publishes them, and files of a live release it does not publish
        ctx.db.prepare("INSERT INTO releases (format, distro, name) VALUES ('deb', 'debian', 'bookworm')").run();
        const collected = [
            "deb/debian/dists/bookworm/Release", "deb/debian/dists/forky/Release", "deb/debian/dists/forky/main/binary-amd64/Packages.gz",
            `${ dists }/main/binary-amd64/Packages`, `${ dists }/main/binary-amd64/Release`, "rpm/fedora/41/repodata/repomd.xml",
        ].sort();
        for (const p of [...published, ...collected]) {
            if (!await exists(repoFile(ctx, p))) {
                await writeRepoFile(ctx, p);
            }
            supersede(ctx.db, p, STALE);
        }

        expect(await runGc(ctx)).toEqual({ pool: [], index: collected });

        expect(await existing(ctx, [...published, ...collected])).toEqual(published);
        expect(superseded(ctx.db).map(s => s.path)).toEqual(published);
    }));

    test("The guard looks only at the releases expired rows point into, each once", withGc(async ctx => {
        await importTrixie(ctx);
        await publishDebian(ctx);
        rpmIndex(ctx.db);
        const dir = path.dirname(currentPackages(ctx.db).stored_path);
        const prepare = jest.spyOn(ctx.db, "prepare");
        const lookups = (): number => prepare.mock.calls.filter(([sql]) => sql.includes("r.format = ?")).length;
        try {
            await runGc(ctx);
            expect(lookups()).toBe(0);

            supersede(ctx.db, `${ dir }/${ "0".repeat(64) }`, STALE);
            supersede(ctx.db, `${ dir }/${ "1".repeat(64) }`, STALE);
            await runGc(ctx);
            expect(lookups()).toBe(1);
        } finally {
            prepare.mockRestore();
        }
    }));

    test("An index not yet published keeps its canonical name", withGc(async ctx => {
        await importTrixie(ctx);
        const canonical = "deb/debian/dists/trixie/main/binary-amd64/Packages.gz";
        await writeRepoFile(ctx, canonical);
        supersede(ctx.db, canonical, STALE);

        expect(await runGc(ctx)).toEqual({ pool: [], index: [] });

        expect(await exists(repoFile(ctx, canonical))).toBe(true);
    }));

    test("Keeps the MD5Sum twin of a current row and deletes its superseded SHA256 sibling", withGc(async ctx => {
        await importTrixie(ctx);
        await publishDebian(ctx);
        const packages = currentPackages(ctx.db);
        const twin = md5LinkPath(packages.stored_path, packages.md5);
        const sibling = `${ path.dirname(packages.stored_path) }/${ "0".repeat(64) }`;
        const gone = `${ path.dirname(packages.stored_path) }/${ "1".repeat(64) }`;
        await writeRepoFile(ctx, sibling);
        for (const p of [twin, sibling, gone]) {
            supersede(ctx.db, p, STALE);
        }

        expect(await runGc(ctx)).toEqual({ pool: [], index: [sibling, gone] });

        expect(await existing(ctx, [twin, sibling, gone, packages.stored_path])).toEqual([twin, packages.stored_path]);
        expect(superseded(ctx.db)).toEqual([{ path: twin, superseded_at: STALE }]);
    }));

    test("Deletes an orphan MD5Sum link older than the grace and keeps a younger one", withGc(async ctx => {
        await importTrixie(ctx);
        await publishDebian(ctx);
        const packages = currentPackages(ctx.db);
        const twin = md5LinkPath(packages.stored_path, packages.md5);
        const dir = path.dirname(twin);
        const old = `${ dir }/${ "a".repeat(32) }`;
        const young = `${ dir }/${ "b".repeat(32) }`;
        const listed = `${ dir }/${ "c".repeat(32) }`;
        await writeRepoFile(ctx, old, NOW - GC_GRACE_SECONDS);
        await writeRepoFile(ctx, young, NOW - GC_GRACE_SECONDS + 1);
        await writeRepoFile(ctx, listed, STALE);
        supersede(ctx.db, listed, NOW - 1);
        // The twin's age does not matter while its row is current
        await fs.utimes(repoFile(ctx, twin), STALE, STALE);

        expect(await runGc(ctx)).toEqual({ pool: [], index: [old] });

        expect(await existing(ctx, [old, young, listed, twin])).toEqual([young, listed, twin]);
        expect(superseded(ctx.db)).toEqual([{ path: listed, superseded_at: NOW - 1 }]);
    }));
});

describe("Tests for removeEmptyParents", () => {
    test("Walks past a directory already gone, stops at one not empty and never removes stopDir", withLocalTmpDir(async () => {
        await fs.mkdir(osPath.join("root", "pool", "a"), { recursive: true });
        await fs.writeFile(osPath.join("root", "pool", "a", "kept"), "");
        await fs.mkdir(osPath.join("root", "pool", "a", "b"));

        await removeEmptyParents(osPath.join("root", "pool", "a", "b", "gone", "file"), osPath.join("root", "pool"));
        expect(await fs.readdir(osPath.join("root", "pool", "a"))).toEqual(["kept"]);

        await fs.unlink(osPath.join("root", "pool", "a", "kept"));
        await removeEmptyParents(osPath.join("root", "pool", "a", "file"), osPath.join("root", "pool"));
        expect(await fs.readdir("root")).toEqual(["pool"]);
        expect(await fs.readdir(osPath.join("root", "pool"))).toEqual([]);
    }));
});

describe("Tests for startGc", () => {
    test("Runs through exclusive on the interval and stop() halts it", withGc(async ctx => {
        expect(GC_INTERVAL_MS).toBe(3600000);
        expect(GC_GRACE_SECONDS).toBe(86400);
        const runs: (() => Promise<unknown>)[] = [];
        let failure: Error | undefined;
        // Not async on purpose: a synchronous throw must be logged like a rejection
        const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
            runs.push(fn);
            if (failure !== undefined) {
                throw failure;
            }
            return Promise.resolve(undefined as T);
        };
        jest.useFakeTimers();
        const setIntervalSpy = jest.spyOn(globalThis, "setInterval");
        const errorSpy = jest.spyOn(logger, "error").mockReturnValue(logger);
        try {
            const gc = startGc(ctx, exclusive);
            expect(setIntervalSpy).toHaveBeenCalledTimes(1);
            expect(setIntervalSpy.mock.calls[0][1]).toBe(GC_INTERVAL_MS);
            expect((setIntervalSpy.mock.results[0].value as NodeJS.Timeout).hasRef()).toBe(false);
            await jest.advanceTimersByTimeAsync(GC_INTERVAL_MS - 1);
            expect(runs).toHaveLength(0);
            await jest.advanceTimersByTimeAsync(1);
            expect(runs).toHaveLength(1);

            failure = new Error("boom");
            await jest.advanceTimersByTimeAsync(GC_INTERVAL_MS);
            expect(runs).toHaveLength(2);
            expect(errorSpy).toHaveBeenCalledWith("Garbage collection failed", { err: failure });
            failure = undefined;
            await jest.advanceTimersByTimeAsync(GC_INTERVAL_MS);
            expect(runs).toHaveLength(3);

            gc.stop();
            await jest.advanceTimersByTimeAsync(3 * GC_INTERVAL_MS);
            expect(runs).toHaveLength(3);
            expect(errorSpy).toHaveBeenCalledTimes(1);
        } finally {
            setIntervalSpy.mockRestore();
            errorSpy.mockRestore();
            jest.useRealTimers();
        }
        // What the timer hands to exclusive is a collection run
        await expect(runs[0]()).resolves.toEqual({ pool: [], index: [] });
    }));
});
