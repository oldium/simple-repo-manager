import { withLocalTmpDir } from "../../utils.ts";
import { jest } from "@jest/globals";
import crypto from "crypto";
import osPath from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import type { Database } from "node:sqlite";
import { openDatabase } from "../../../server/backend/db.ts";
import { GC_GRACE_SECONDS, runGc } from "../../../server/backend/gc.ts";
import { hashFile } from "../../../server/backend/hash.ts";
import type { Digests } from "../../../server/backend/hash.ts";
import type { BackendContext } from "../../../server/backend/context.ts";
import type { PoolFile } from "../../../server/backend/pool.ts";
import { KEY_SEP } from "../../../server/backend/deb/stanzas.ts";
import { RpmCatalog, rpmPoolPath, rpmSortKey } from "../../../server/backend/rpm/catalog.ts";
import type { RpmPackageInput } from "../../../server/backend/rpm/catalog.ts";
import { importRpm } from "../../../server/backend/rpm/importer.ts";
import { publishRpm } from "../../../server/backend/rpm/publisher.ts";
import { RepoValidationError } from "../../../server/lib/errors.ts";
import { NOT_IN_LOWER_CASE, resetFileNaming, setFileNaming } from "../../../server/lib/file-naming.ts";
import logger from "../../../server/lib/logger.ts";
import type { ImportFile } from "../../../server/lib/repo-service.ts";

const notWindowsTest = process.platform === "win32" ? test.skip : test;

const CASE_INSENSITIVE = { caseSensitive: false, shortNames: false };
const CASE_SENSITIVE = { caseSensitive: true, shortNames: false };

afterEach(resetFileNaming);

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const RPMS =osPath.join(FIXTURES, "packages", "rpm", "fedora", "42");
const GOLDEN = osPath.join(FIXTURES, "golden", "rpm", "fedora", "42", "repodata");
const NOW = 1700000000;
const TARGET = "rpm/fedora/42";
const POOL = "rpm/fedora/42/Packages/s/srm-hello";
const SRC = "srm-hello-1.0-1.fc42.src.rpm";
const BIN = "srm-hello-1.0-1.fc42.x86_64.rpm";
const DOC = "srm-hello-doc-1.0-1.fc42.noarch.rpm";
/** The fixture names in readdir order, which is also the golden package order */
const ALL = [SRC, BIN, DOC];
const KINDS = ["primary", "filelists", "other"] as const;

const SOURCERPM = "srm-hello-1.0-1.fc42.src.rpm";

const KEY_SRC = rpmSortKey("srm-hello", "srm-hello", 0, "1.0", "1.fc42", "src", SRC);
const KEY_BIN = rpmSortKey("srm-hello", "srm-hello", 0, "1.0", "1.fc42", "x86_64", BIN);
const KEY_DOC = rpmSortKey("srm-hello", "srm-hello-doc", 0, "1.0", "1.fc42", "noarch", DOC);

type Kind = typeof KINDS[number];

type PoolRow = { path: string; sha256: string; removed_at: number | null };

type FullPoolRow = PoolRow & Digests;

function osJoin(...posix: string[]): string {
    return osPath.join(...posix.join("/").split("/"));
}

function withImporter(fn: (ctx: BackendContext, catalog: RpmCatalog) => Promise<void>) {
    return withLocalTmpDir(async () => {
        await fs.mkdir("state");
        const db = openDatabase(osPath.join("state", "repo.db"));
        try {
            await fn({ db, paths: { incomingDir: "incoming", repoStateDir: "state", repoDir: "repo" }, signingKey: undefined, now: () => NOW }, new RpmCatalog(db));
        } finally {
            db.close();
        }
    });
}

function withCatalog(fn: (db: Database, catalog: RpmCatalog) => void) {
    return withLocalTmpDir(async () => {
        const db = openDatabase("repo.db");
        try {
            fn(db, new RpmCatalog(db));
        } finally {
            db.close();
        }
    });
}

function stagedPath(ctx: BackendContext, relPath: string): string {
    return osJoin(ctx.paths.incomingDir, "process", relPath);
}

function poolPath(ctx: BackendContext, relPath: string): string {
    return osJoin(ctx.paths.repoDir, relPath);
}

/** What the upload handler records for a staged file */
async function record(ctx: BackendContext, relPath: string, digests?: Digests): Promise<void> {
    const file = stagedPath(ctx, relPath);
    const stat = await fs.stat(file);
    const d = digests ?? await hashFile(file);
    ctx.db.prepare("INSERT OR REPLACE INTO staged_digests (rel_path, size, mtime_ms, md5, sha1, sha256, sha512) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(relPath, stat.size, Math.trunc(stat.mtimeMs), d.md5, d.sha1, d.sha256, d.sha512);
}

/** Copies the named fixtures into the staging dir and records their digests unless told otherwise */
async function stage(ctx: BackendContext, names: string[], o: { record?: boolean; target?: string } = {}): Promise<string[]> {
    const target = o.target ?? TARGET;
    await fs.mkdir(stagedPath(ctx, target), { recursive: true });
    for (const name of names) {
        await fs.copyFile(osPath.join(RPMS, name), stagedPath(ctx, `${ target }/${ name }`));
        if (o.record !== false) {
            await record(ctx, `${ target }/${ name }`);
        }
    }
    return [...names].sort();
}

async function staged(ctx: BackendContext, target = TARGET): Promise<string[]> {
    try {
        return (await fs.readdir(stagedPath(ctx, target))).sort();
    } catch {
        return [];
    }
}

async function pooled(ctx: BackendContext, poolDir = POOL): Promise<string[]> {
    try {
        return (await fs.readdir(poolPath(ctx, poolDir))).sort();
    } catch {
        return [];
    }
}

async function mtimeOf(file: string): Promise<number> {
    return Math.floor((await fs.stat(file)).mtimeMs / 1000);
}

function expected(target: string, names: string[], status: ImportFile["status"], reason?: string): ImportFile[] {
    return names.map(name => ({ filename: name, path: `${ target }/${ name }`, status, ...(reason === undefined ? {} : { reason }) }));
}

function failed(files: ImportFile[]): ImportFile[] {
    return files.map(f => ({ ...f, reason: expect.stringMatching(/^import failed/) as unknown as string }));
}

/** Digests of fake content, so another variant changes every hash */
function poolFile(path: string, variant = ""): PoolFile {
    const content = Buffer.from(`${ path }#${ variant }`);
    const digest = (name: string) => crypto.createHash(name).update(content).digest("hex");
    return { path, size: content.length, md5: digest("md5"), sha1: digest("sha1"), sha256: digest("sha256"), sha512: digest("sha512") };
}

type PackageSpec = Partial<Omit<RpmPackageInput, "file">> & { variant?: string };

/** A catalog input shaped like an imported srm-hello package; the file name follows NEVRA */
function pkg(o: PackageSpec = {}): RpmPackageInput {
    const name = o.name ?? "srm-hello";
    const version = o.version ?? "1.0";
    const rel = o.rel ?? "1.fc42";
    const arch = o.arch ?? "x86_64";
    const sourceName = o.sourceName ?? "srm-hello";
    const distro = o.distro ?? "fedora";
    const release = o.release ?? "42";
    const filename = o.filename ?? `${ name }-${ version }-${ rel }.${ arch }.rpm`;
    return {
        distro, release, filename, name, epoch: o.epoch ?? 0, version, rel, arch, sourceName, sourceVersion: o.sourceVersion ?? `${ version }-${ rel }`,
        file: poolFile(rpmPoolPath(distro, release, sourceName, filename), o.variant),
        primaryXml: `<package>${ filename }</package>\n`, filelistsXml: `<package pkgid="${ filename }"/>\n`, otherXml: `<package other="${ filename }"/>\n`,
    };
}

function keyOf(p: RpmPackageInput): string {
    return rpmSortKey(p.sourceName, p.name, p.epoch, p.version, p.rel, p.arch, p.filename);
}

/** The x86_64 rpm with its SOURCERPM header string overwritten in place; the same length keeps the header readable */
async function withSourceRpm(replacement: string): Promise<Buffer> {
    expect(replacement).toHaveLength(SOURCERPM.length);
    const bytes = await fs.readFile(osPath.join(RPMS, BIN));
    const at = bytes.indexOf(SOURCERPM);
    expect(at).toBeGreaterThan(0);
    expect(bytes.indexOf(SOURCERPM, at + 1)).toBe(-1);
    bytes.write(replacement, at, "latin1");
    return bytes;
}

/** Runs fn and returns its result with the info lines logged meanwhile; read before mockRestore, which clears the calls */
async function loggedInfo<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
    const spy = jest.spyOn(logger, "info");
    try {
        const result = await fn();
        return { result, lines: spy.mock.calls.map(call => String(call[0])) };
    } finally {
        spy.mockRestore();
    }
}

function sortedPaths(ps: RpmPackageInput[]): string[] {
    return ps.map(p => p.file.path).sort();
}

function sortedKeys(ps: RpmPackageInput[]): string[] {
    return ps.map(keyOf).sort();
}

function rowsOf(ps: RpmPackageInput[], removedAt: number | null): PoolRow[] {
    return ps.map(p => ({ path: p.file.path, sha256: p.file.sha256, removed_at: removedAt }));
}

function byPath(a: PoolRow, b: PoolRow): number {
    return a.path < b.path ? -1 : 1;
}

function poolRows(db: Database): PoolRow[] {
    return db.prepare("SELECT path, sha256, removed_at FROM pool_files ORDER BY path").all() as PoolRow[];
}

function fullPoolRows(db: Database): FullPoolRow[] {
    return db.prepare("SELECT path, size, md5, sha1, sha256, sha512, removed_at FROM pool_files ORDER BY path").all() as FullPoolRow[];
}

function poolRow(db: Database, path: string): PoolRow | undefined {
    return poolRows(db).find(r => r.path === path);
}

function packages(db: Database): string[] {
    return db.prepare(`
        SELECT r.distro || ' ' || r.name || ' ' || p.filename || ' ' || p.name || ' ' || p.epoch || ' ' || p.version || ' ' || p.rel || ' ' || p.arch || ' '
            || p.source_name || ' ' || p.source_version AS s FROM rpm_packages p JOIN releases r ON r.id = p.release_id ORDER BY s`).all().map(r => r.s as string);
}

function xmlOf(db: Database, filename: string, kind: Kind): string {
    return (db.prepare(`SELECT ${ kind }_xml AS xml FROM rpm_packages WHERE filename = ?`).get(filename) as { xml: string }).xml;
}

function indexFiles(db: Database, distro = "fedora", release = "42"): string[] {
    return db.prepare(`
        SELECT i.kind || ':' || i.component || ':' || i.architecture || ':' || i.generation AS f FROM index_files i
        JOIN releases r ON r.id = i.release_id WHERE r.distro = ? AND r.name = ? ORDER BY f`).all(distro, release).map(r => r.f as string);
}

function dirtyKeys(db: Database, kind: Kind, distro = "fedora", release = "42"): string[] {
    return db.prepare(`
        SELECT d.key FROM dirty_keys d JOIN index_files i ON i.id = d.index_file_id JOIN releases r ON r.id = i.release_id
        WHERE r.distro = ? AND r.name = ? AND i.kind = ? AND i.component = '' AND i.architecture = '' ORDER BY d.key`)
        .all(distro, release, kind).map(r => r.key as string);
}

function count(db: Database, table: string): number {
    return (db.prepare(`SELECT count(*) AS n FROM ${ table }`).get() as { n: number }).n;
}

async function goldenPackages(kind: Kind): Promise<string[]> {
    const text = await fs.readFile(osPath.join(GOLDEN, `${ kind }.xml`), "utf8");
    const start = text.indexOf("<package ");
    const end = text.lastIndexOf("</package>\n") + "</package>\n".length;
    return text.slice(start, end).split("</package>\n").filter(p => p.length > 0).map(p => `${ p }</package>\n`);
}

/** Replaces the value between the first marker and the terminator following it */
function replaceValue(text: string, marker: string, terminator: string, value: string): string {
    const at = text.indexOf(marker);
    if (at < 0) {
        throw new Error(`${ marker } not found`);
    }
    const from = at + marker.length;
    return `${ text.slice(0, from) }${ value }${ text.slice(text.indexOf(terminator, from)) }`;
}

describe("Tests for importRpm", () => {
    test("Imports binaries and src.rpm into Packages/s/srm-hello/", withImporter(async (ctx, catalog) => {
        const names = await stage(ctx, ALL);
        expect(count(ctx.db, "staged_digests")).toBe(3);

        expect(await importRpm(ctx)).toEqual(expected(TARGET, names, "ok"));

        expect(await staged(ctx)).toEqual([]);
        expect(await pooled(ctx)).toEqual(names);
        expect(count(ctx.db, "staged_digests")).toBe(0);
        const rows = fullPoolRows(ctx.db);
        expect(rows.map(r => r.path)).toEqual(names.map(name => `${ POOL }/${ name }`));
        for (const row of rows) {
            expect(row).toEqual({ path: row.path, removed_at: null, ...await hashFile(osPath.join(RPMS, osPath.basename(row.path))) });
        }
        expect(packages(ctx.db)).toEqual([
            `fedora 42 ${ SRC } srm-hello 0 1.0 1.fc42 src srm-hello 1.0-1.fc42`,
            `fedora 42 ${ BIN } srm-hello 0 1.0 1.fc42 x86_64 srm-hello 1.0-1.fc42`,
            `fedora 42 ${ DOC } srm-hello-doc 0 1.0 1.fc42 noarch srm-hello 1.0-1.fc42`,
        ]);
        expect(indexFiles(ctx.db)).toEqual(["filelists:::0", "other:::0", "primary:::0"]);
        for (const kind of KINDS) {
            expect(dirtyKeys(ctx.db, kind)).toEqual([KEY_SRC, KEY_BIN, KEY_DOC]);
        }
        expect(catalog.releases()).toEqual([{ distro: "fedora", release: "42" }]);
        expect(catalog.listSources({}, {}).items).toEqual([{ distro: "fedora", release: "42", source: "srm-hello", version: "1.0-1.fc42" }]);
        expect(catalog.listFiles({ source: "srm-hello" }, {}).items.map(i => i.path)).toEqual(names.map(name => `${ POOL }/${ name }`));

        // The stored fragments are createrepo_c's, with our layout, the pool file's mtime and the upload digest as pkgid
        const [primary, filelists, other] = await Promise.all(KINDS.map(goldenPackages));
        for (const [i, name] of ALL.entries()) {
            const { sha256 } = rows[i];
            const mtime = await mtimeOf(poolPath(ctx, `${ POOL }/${ name }`));
            let golden = replaceValue(primary[i], '<location href="', '"', `Packages/s/srm-hello/${ name }`);
            golden = replaceValue(golden, '<time file="', '"', String(mtime));
            golden = replaceValue(golden, 'pkgid="YES">', "<", sha256);
            expect(xmlOf(ctx.db, name, "primary")).toBe(golden);
            expect(xmlOf(ctx.db, name, "filelists")).toBe(replaceValue(filelists[i], 'pkgid="', '"', sha256));
            expect(xmlOf(ctx.db, name, "other")).toBe(replaceValue(other[i], 'pkgid="', '"', sha256));
        }
    }));

    test("Binary without its src.rpm is listed under its source and removable", withImporter(async (ctx, catalog) => {
        const names = await stage(ctx, [BIN, DOC]);

        expect(await importRpm(ctx)).toEqual(expected(TARGET, names, "ok"));

        const paths = names.map(name => `${ POOL }/${ name }`);
        expect(await pooled(ctx)).toEqual(names);
        expect(catalog.listSources({}, {}).items).toEqual([{ distro: "fedora", release: "42", source: "srm-hello", version: "1.0-1.fc42" }]);
        expect(catalog.listSources({ source: "srm-hello-doc" }, {})).toEqual({ items: [] });
        expect(catalog.listFiles({ source: "srm-hello", version: "1.0-1.fc42" }, {}).items.map(i => i.path)).toEqual(paths);
        ctx.db.exec("DELETE FROM dirty_keys");

        expect(catalog.remove({ source: "srm-hello" }, NOW + 1, true)).toEqual({ removed: paths, deleteNow: paths });

        expect(count(ctx.db, "rpm_packages")).toBe(0);
        expect(poolRows(ctx.db).map(r => [r.path, r.removed_at])).toEqual(paths.map(p => [p, NOW + 1]));
        for (const kind of KINDS) {
            expect(dirtyKeys(ctx.db, kind)).toEqual([KEY_BIN, KEY_DOC]);
        }
        expect(catalog.listSources({}, {})).toEqual({ items: [] });
        expect(catalog.releases()).toEqual([{ distro: "fedora", release: "42" }]);
    }));

    test("Re-upload with the same filename replaces the row", withImporter(async (ctx, catalog) => {
        await stage(ctx, ALL);
        await importRpm(ctx);
        const before = fullPoolRows(ctx.db);
        ctx.db.exec("DELETE FROM dirty_keys");
        await stage(ctx, [BIN], { record: false });
        // The payload is never read, so a longer file still has a readable header but new digests
        await fs.appendFile(stagedPath(ctx, `${ TARGET }/${ BIN }`), "rebuilt");
        const rebuilt = await hashFile(stagedPath(ctx, `${ TARGET }/${ BIN }`));
        await record(ctx, `${ TARGET }/${ BIN }`);
        const { result, lines } = await loggedInfo(() => importRpm(ctx));

        expect(result).toEqual(expected(TARGET, [BIN], "ok"));
        // Overwritten in place: nothing left behind to report
        expect(lines.filter(line => line.includes("replaced"))).toEqual([]);
        expect(await staged(ctx)).toEqual([]);
        expect(packages(ctx.db)).toHaveLength(3);
        expect(count(ctx.db, "pool_files")).toBe(3);
        const after = fullPoolRows(ctx.db);
        expect(after.find(r => r.path.endsWith(BIN))).toEqual({ path: `${ POOL }/${ BIN }`, removed_at: null, ...rebuilt });
        expect(after.filter(r => !r.path.endsWith(BIN))).toEqual(before.filter(r => !r.path.endsWith(BIN)));
        expect((await fs.stat(poolPath(ctx, `${ POOL }/${ BIN }`))).size).toBe(rebuilt.size);
        expect(xmlOf(ctx.db, BIN, "primary")).toContain(`<checksum type="sha256" pkgid="YES">${ rebuilt.sha256 }</checksum>`);
        expect(xmlOf(ctx.db, BIN, "primary")).toContain(`<size package="${ rebuilt.size }" `);
        expect(xmlOf(ctx.db, BIN, "filelists")).toContain(`<package pkgid="${ rebuilt.sha256 }"`);
        for (const kind of KINDS) {
            expect(dirtyKeys(ctx.db, kind)).toEqual([KEY_BIN]);
        }
        expect(catalog.listSources({}, {}).items).toHaveLength(1);
    }));

    test("Unreadable rpm fails and stays staged", withImporter(async ctx => {
        const names = await stage(ctx, [SRC]);
        await fs.writeFile(stagedPath(ctx, `${ TARGET }/bad.rpm`), "not an rpm package at all, just text that is longer than the lead\n".repeat(3));
        await record(ctx, `${ TARGET }/bad.rpm`);
        const whole = await fs.readFile(osPath.join(RPMS, BIN));
        await fs.writeFile(stagedPath(ctx, `${ TARGET }/short.rpm`), whole.subarray(0, 200));
        await record(ctx, `${ TARGET }/short.rpm`);

        const result = await importRpm(ctx);

        expect(result).toEqual([
            ...failed(expected(TARGET, ["bad.rpm", "short.rpm"], "failed")),
            ...expected(TARGET, names, "ok"),
        ]);
        expect(result[0].reason).toContain("is not an rpm package");
        expect(result[1].reason).toContain("truncated");
        expect(await staged(ctx)).toEqual(["bad.rpm", "short.rpm"]);
        expect(await pooled(ctx)).toEqual(names);
        expect(count(ctx.db, "rpm_packages")).toBe(1);
        expect(count(ctx.db, "pool_files")).toBe(1);
        expect(count(ctx.db, "staged_digests")).toBe(2);
    }));

    test("A SOURCERPM that does not parse or names a bad source fails and stays staged", withImporter(async ctx => {
        const names = await stage(ctx, [SRC]);
        await fs.writeFile(stagedPath(ctx, `${ TARGET }/nodash.rpm`), await withSourceRpm("srm_hello_1.0_1.fc42.src.rpm"));
        await fs.writeFile(stagedPath(ctx, `${ TARGET }/slash.rpm`), await withSourceRpm("srm/hello-1.0-1.fc42.src.rpm"));

        const result = await importRpm(ctx);

        expect(result).toEqual([...failed(expected(TARGET, ["nodash.rpm", "slash.rpm"], "failed")), ...expected(TARGET, names, "ok")]);
        expect(result[0].reason).toContain("Malformed source rpm name: srm_hello_1.0_1.fc42.src.rpm");
        expect(result[1].reason).toContain('Malformed source name: "srm/hello"');
        expect(await staged(ctx)).toEqual(["nodash.rpm", "slash.rpm"]);
        expect(await pooled(ctx)).toEqual(names);
        expect(count(ctx.db, "rpm_packages")).toBe(1);
        expect(await fs.readdir(poolPath(ctx, "rpm/fedora/42/Packages/s"))).toEqual(["srm-hello"]);
    }));

    test("A source named aux fails where its pool directory cannot exist, elsewhere it is a name like any", withImporter(async ctx => {
        await fs.mkdir(stagedPath(ctx, TARGET), { recursive: true });
        await fs.writeFile(stagedPath(ctx, `${ TARGET }/x.rpm`), await withSourceRpm("aux-1.0.0.0.0-1.fc42.src.rpm"));

        const result = await importRpm(ctx);

        if (process.platform === "win32") {
            expect(result).toEqual(failed(expected(TARGET, ["x.rpm"], "failed")));
            expect(result[0].reason).toContain('Malformed source name: "aux" is a reserved name on Windows');
            expect(await staged(ctx)).toEqual(["x.rpm"]);
            expect(count(ctx.db, "rpm_packages")).toBe(0);
            expect(count(ctx.db, "pool_files")).toBe(0);
        } else {
            expect(result).toEqual(expected(TARGET, ["x.rpm"], "ok"));
            expect(await pooled(ctx, "rpm/fedora/42/Packages/a/aux")).toEqual(["x.rpm"]);
        }
    }));

    test("A file named like a device with an extension imports on any OS", withImporter(async ctx => {
        await fs.mkdir(stagedPath(ctx, TARGET), { recursive: true });
        await fs.copyFile(osPath.join(RPMS, BIN), stagedPath(ctx, `${ TARGET }/con.rpm`));

        expect(await importRpm(ctx)).toEqual(expected(TARGET, ["con.rpm"], "ok"));

        expect(await pooled(ctx)).toEqual(["con.rpm"]);
    }));

    const BIN_IN_OTHER_CASE = "SRM-hello-1.0-1.fc42.x86_64.rpm";

    /** The doc package under the name of the binary in another case, so an overwrite would show in the content */
    async function stageInOtherCase(ctx: BackendContext): Promise<void> {
        await fs.copyFile(osPath.join(RPMS, DOC), stagedPath(ctx, `${ TARGET }/${ BIN_IN_OTHER_CASE }`));
    }

    test("An rpm differing only in case from a pool file fails, moves nothing, adds no row and is retried", withImporter(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        await stage(ctx, [BIN]);
        await importRpm(ctx);
        await stageInOtherCase(ctx);
        const rows = fullPoolRows(ctx.db);
        const listed = packages(ctx.db);

        const result = await importRpm(ctx);

        expect(result).toEqual(failed(expected(TARGET, [BIN_IN_OTHER_CASE], "failed")));
        expect(result[0].reason).toContain(`${ POOL }/${ BIN_IN_OTHER_CASE } differs only in case from ${ POOL }/${ BIN }`);
        expect(await staged(ctx)).toEqual([BIN_IN_OTHER_CASE]);
        expect(await pooled(ctx)).toEqual([BIN]);
        expect(await hashFile(poolPath(ctx, `${ POOL }/${ BIN }`))).toEqual(await hashFile(osPath.join(RPMS, BIN)));
        expect(fullPoolRows(ctx.db)).toEqual(rows);
        expect(packages(ctx.db)).toEqual(listed);

        expect((await importRpm(ctx)).map(f => f.status)).toEqual(["failed"]);
        expect(await staged(ctx)).toEqual([BIN_IN_OTHER_CASE]);
    }));

    test("Two rpms in one import whose sources differ only in case share a directory and stay two sources", withImporter(async (ctx, catalog) => {
        const second = "srm-hello-2.0-1.fc42.x86_64.rpm";
        await stage(ctx, [BIN]);
        await fs.writeFile(stagedPath(ctx, `${ TARGET }/${ second }`), await withSourceRpm("SRM-hello-1.0-1.fc42.src.rpm"));

        expect(await importRpm(ctx)).toEqual(expected(TARGET, [BIN, second], "ok"));

        expect(await staged(ctx)).toEqual([]);
        expect(await pooled(ctx)).toEqual([BIN, second]);
        expect(catalog.listSources({}, {}).items.map(i => i.source)).toEqual(["SRM-hello", "srm-hello"]);
        expect(catalog.remove({ source: "SRM-hello" }, NOW, true)).toEqual({ removed: [`${ POOL }/${ second }`], deleteNow: [`${ POOL }/${ second }`] });
        expect(catalog.listFiles({ source: "srm-hello" }, {}).items.map(i => i.path)).toEqual([`${ POOL }/${ BIN }`]);
    }));

    test("An rpm of a source differing only in case, named in another case than a pool file, fails and moves nothing", withImporter(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        await stage(ctx, [BIN]);
        await importRpm(ctx);
        await fs.writeFile(stagedPath(ctx, `${ TARGET }/${ BIN_IN_OTHER_CASE }`), await withSourceRpm("SRM-hello-1.0-1.fc42.src.rpm"));

        const result = await importRpm(ctx);

        expect(result).toEqual(failed(expected(TARGET, [BIN_IN_OTHER_CASE], "failed")));
        expect(result[0].reason).toContain(`${ POOL }/${ BIN_IN_OTHER_CASE } differs only in case from ${ POOL }/${ BIN }`);
        expect(await staged(ctx)).toEqual([BIN_IN_OTHER_CASE]);
        expect(await pooled(ctx)).toEqual([BIN]);
        expect(await hashFile(poolPath(ctx, `${ POOL }/${ BIN }`))).toEqual(await hashFile(osPath.join(RPMS, BIN)));
        expect(poolRows(ctx.db).map(row => row.path)).toEqual([`${ POOL }/${ BIN }`]);
        expect(count(ctx.db, "rpm_packages")).toBe(1);
    }));

    test("Sources with first letters differing only in case share their letter directory", withImporter(async ctx => {
        const second = "srm-hallo-1.0-1.fc42.x86_64.rpm";
        await stage(ctx, [BIN]);
        await fs.writeFile(stagedPath(ctx, `${ TARGET }/${ second }`), await withSourceRpm("SRM-hallo-1.0-1.fc42.src.rpm"));

        expect((await importRpm(ctx)).map(f => f.status)).toEqual(["ok", "ok"]);

        expect(poolRows(ctx.db).map(row => row.path).sort()).toEqual([`rpm/fedora/42/Packages/s/srm-hallo/${ second }`, `${ POOL }/${ BIN }`]);
    }));

    test("One import reads each directory of the repository once", withImporter(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        await stage(ctx, [BIN, DOC]);
        const readdir = jest.spyOn(fs, "readdir");
        let reads: string[];
        try {
            expect((await importRpm(ctx)).map(f => f.status)).toEqual(["ok", "ok"]);
            reads = readdir.mock.calls.map(([dir]) => String(dir)).filter(dir => dir === ctx.paths.repoDir || dir.startsWith(`${ ctx.paths.repoDir }${ osPath.sep }`));
        } finally {
            readdir.mockRestore();
        }
        expect(reads.length).toBeGreaterThan(0);
        expect(reads).toEqual([...new Set(reads)]);
    }));

    test("Where case does not count, a distribution differing only in case from a published one imports into it", withImporter(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        await stage(ctx, [BIN]);
        await importRpm(ctx);
        await fs.rm(stagedPath(ctx, "rpm"), { recursive: true });
        const target = "rpm/Fedora/42";
        await stage(ctx, [DOC], { target });

        expect(await importRpm(ctx)).toEqual(expected(target, [DOC], "ok"));

        expect(await staged(ctx, target)).toEqual([]);
        expect(await fs.readdir(poolPath(ctx, "rpm"))).toEqual(["fedora"]);
        expect(await pooled(ctx)).toEqual([DOC, BIN].sort());
        expect(count(ctx.db, "releases")).toBe(1);
        expect(count(ctx.db, "pool_files")).toBe(2);
        expect(count(ctx.db, "staged_digests")).toBe(0);
    }));

    test.each([
        ["rpm/Fedora/42", "fedora", "42"],
        ["rpm/fedora/Rawhide", "fedora", "rawhide"],
    ])("Where case does not count, an rpm placed in %s lands in lower case, reported as staged", (target, distro, release) => withImporter(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        await stage(ctx, [BIN], { target });

        expect(await importRpm(ctx)).toEqual(expected(target, [BIN], "ok"));

        expect(await pooled(ctx, `rpm/${ distro }/${ release }/Packages/s/srm-hello`)).toEqual([BIN]);
        expect(await fs.readdir(poolPath(ctx, "rpm"))).toEqual([distro]);
        expect(await fs.readdir(poolPath(ctx, `rpm/${ distro }`))).toEqual([release]);
        expect(packages(ctx.db)).toEqual([`${ distro } ${ release } ${ BIN } srm-hello 0 1.0 1.fc42 x86_64 srm-hello 1.0-1.fc42`]);
    })());

    test("Where case counts, an rpm placed in rpm/Fedora/42 stays in that spelling", withImporter(async ctx => {
        setFileNaming(CASE_SENSITIVE);
        const target = "rpm/Fedora/42";
        await stage(ctx, [BIN], { target });

        expect(await importRpm(ctx)).toEqual(expected(target, [BIN], "ok"));

        expect(await fs.readdir(poolPath(ctx, "rpm"))).toEqual(["Fedora"]);
        expect(await pooled(ctx, "rpm/Fedora/42/Packages/s/srm-hello")).toEqual([BIN]);
        expect(packages(ctx.db)).toEqual([`Fedora 42 ${ BIN } srm-hello 0 1.0 1.fc42 x86_64 srm-hello 1.0-1.fc42`]);
    }));

    const OTHER_THAN_ASCII = `f${ String.fromCodePoint(0xE9) }dora`;

    test.each([CASE_INSENSITIVE, CASE_SENSITIVE])("With %j, an rpm placed in the distribution named as the keyring fails", naming => withImporter(async ctx => {
        setFileNaming(naming);
        const target = "rpm/RPM-GPG-KEY.asc/42";
        await stage(ctx, [BIN], { target });

        const result = await importRpm(ctx);

        expect(result).toEqual(failed(expected(target, [BIN], "failed")));
        expect(result[0].reason).toContain(`${ target }: "RPM-GPG-KEY.asc" cannot be a distribution, the format has a keyring of that name`);
        expect(await staged(ctx, target)).toEqual([BIN]);
        expect(count(ctx.db, "releases")).toBe(0);
    })());

    test.each([`rpm/${ OTHER_THAN_ASCII }/42`, `rpm/fedora/${ OTHER_THAN_ASCII }`])("Where case does not count, an rpm placed in %s fails, moves nothing and adds no row", target => withImporter(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        await stage(ctx, [BIN], { target });

        const result = await importRpm(ctx);

        expect(result).toEqual(failed(expected(target, [BIN], "failed")));
        expect(result[0].reason).toContain(`${ JSON.stringify(OTHER_THAN_ASCII) }: ${ NOT_IN_LOWER_CASE }`);
        expect(await staged(ctx, target)).toEqual([BIN]);
        expect(count(ctx.db, "pool_files")).toBe(0);
        expect(count(ctx.db, "releases")).toBe(0);
    })());

    test("Where case counts, an rpm placed below a name other than ASCII imports", withImporter(async ctx => {
        setFileNaming(CASE_SENSITIVE);
        const target = `rpm/${ OTHER_THAN_ASCII }/42`;
        await stage(ctx, [BIN], { target });

        expect(await importRpm(ctx)).toEqual(expected(target, [BIN], "ok"));
    }));

    test("A pool file waiting for garbage collection still conflicts, and the import goes through once it is gone", withImporter(async (ctx, catalog) => {
        setFileNaming(CASE_INSENSITIVE);
        await stage(ctx, [BIN]);
        await importRpm(ctx);
        catalog.remove({ source: "srm-hello" }, NOW, false);
        await publishRpm(ctx);
        await stageInOtherCase(ctx);
        const rows = fullPoolRows(ctx.db);
        expect(rows.map(row => row.removed_at)).toEqual([NOW]);

        const result = await importRpm(ctx);

        expect(result).toEqual(failed(expected(TARGET, [BIN_IN_OTHER_CASE], "failed")));
        expect(result[0].reason).toContain(`${ POOL }/${ BIN_IN_OTHER_CASE } differs only in case from ${ POOL }/${ BIN }`);
        expect(await staged(ctx)).toEqual([BIN_IN_OTHER_CASE]);
        expect(await pooled(ctx)).toEqual([BIN]);
        expect(fullPoolRows(ctx.db)).toEqual(rows);
        expect(count(ctx.db, "rpm_packages")).toBe(0);

        expect((await runGc({ ...ctx, now: () => NOW + GC_GRACE_SECONDS })).pool).toEqual([`${ POOL }/${ BIN }`]);

        expect(await importRpm(ctx)).toEqual(expected(TARGET, [BIN_IN_OTHER_CASE], "ok"));
        expect(await pooled(ctx)).toEqual([BIN_IN_OTHER_CASE]);
        expect(await hashFile(poolPath(ctx, `${ POOL }/${ BIN_IN_OTHER_CASE }`))).toEqual(await hashFile(osPath.join(RPMS, DOC)));
    }));

    notWindowsTest("Off Windows names differing only in case are different files", withImporter(async ctx => {
        await stage(ctx, [BIN]);
        await importRpm(ctx);
        await stageInOtherCase(ctx);

        expect(await importRpm(ctx)).toEqual(expected(TARGET, [BIN_IN_OTHER_CASE], "ok"));

        expect(await pooled(ctx)).toEqual([BIN_IN_OTHER_CASE, BIN]);
        expect(count(ctx.db, "pool_files")).toBe(2);
    }));

    test("Same filename from another source moves the file and reports the replacement", withImporter(async (ctx, catalog) => {
        await stage(ctx, [BIN]);
        await importRpm(ctx);
        await fs.writeFile(stagedPath(ctx, `${ TARGET }/${ BIN }`), await withSourceRpm("srm-hallo-1.0-1.fc42.src.rpm"));
        const { result, lines } = await loggedInfo(() => importRpm(ctx));

        expect(result).toEqual(expected(TARGET, [BIN], "ok"));
        expect(lines.filter(line => line.includes("replaced"))).toEqual([`${ TARGET }/${ BIN } replaced ${ POOL }/${ BIN }`]);
        expect(await pooled(ctx, "rpm/fedora/42/Packages/s/srm-hallo")).toEqual([BIN]);
        expect(await pooled(ctx)).toEqual([BIN]);
        expect(poolRow(ctx.db, `${ POOL }/${ BIN }`)?.removed_at).toBe(NOW);
        expect(packages(ctx.db)).toEqual([`fedora 42 ${ BIN } srm-hello 0 1.0 1.fc42 x86_64 srm-hallo 1.0-1.fc42`]);
        expect(catalog.listSources({}, {}).items.map(i => i.source)).toEqual(["srm-hallo"]);
        expect(xmlOf(ctx.db, BIN, "primary")).toContain('<location href="Packages/s/srm-hallo/');
    }));

    test("Recorded digests are trusted; missing or stale rows are replaced by hashing", withImporter(async ctx => {
        const names = await stage(ctx, ALL, { record: false });
        const bogus = { size: 1, md5: "0".repeat(32), sha1: "0".repeat(40), sha256: "0".repeat(64), sha512: "0".repeat(128) };
        // A valid row is never checked against the content
        const recorded = { ...await hashFile(osPath.join(RPMS, SRC)), sha256: "f".repeat(64) };
        await record(ctx, `${ TARGET }/${ SRC }`, recorded);
        // Stale rows: another mtime, another size; the doc rpm has no row at all
        await record(ctx, `${ TARGET }/${ BIN }`, bogus);
        await fs.utimes(stagedPath(ctx, `${ TARGET }/${ BIN }`), new Date(NOW * 1000), new Date(NOW * 1000));

        expect(await importRpm(ctx)).toEqual(expected(TARGET, names, "ok"));

        expect(count(ctx.db, "staged_digests")).toBe(0);
        const rows = fullPoolRows(ctx.db);
        expect(rows[0]).toEqual({ path: `${ POOL }/${ SRC }`, removed_at: null, ...recorded });
        expect(xmlOf(ctx.db, SRC, "primary")).toContain(`pkgid="YES">${ "f".repeat(64) }<`);
        for (const row of rows.slice(1)) {
            expect(row).toEqual({ path: row.path, removed_at: null, ...await hashFile(osPath.join(RPMS, osPath.basename(row.path))) });
        }
        expect(xmlOf(ctx.db, BIN, "primary")).toContain(`<time file="${ NOW }" `);
    }));

    test("Interrupted move is completed by the next import", withImporter(async ctx => {
        const names = await stage(ctx, ALL);
        const rename = fs.rename;
        let calls = 0;
        const spy = jest.spyOn(fs, "rename").mockImplementation(async (from, to) => {
            if (++calls === 2) {
                throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
            }
            return rename(from, to);
        });
        const errorSpy = jest.spyOn(logger, "error");
        let first: ImportFile[];
        let errors: unknown[][];
        try {
            first = await importRpm(ctx);
        } finally {
            errors = [...errorSpy.mock.calls];
            spy.mockRestore();
            errorSpy.mockRestore();
        }

        expect(first).toEqual([...expected(TARGET, [SRC], "ok"), ...failed(expected(TARGET, [BIN], "failed")), ...expected(TARGET, [DOC], "ok")]);
        expect(errors).toContainEqual([`Import of ${ TARGET }/${ BIN } failed`, { err: expect.objectContaining({ code: "EIO" }) }]);
        expect(await pooled(ctx)).toEqual([SRC, DOC]);
        expect(await staged(ctx)).toEqual([BIN]);
        // The catalog accepted the package before the move failed
        expect(count(ctx.db, "rpm_packages")).toBe(3);
        expect(count(ctx.db, "staged_digests")).toBe(1);
        const rows = fullPoolRows(ctx.db);

        expect(await importRpm(ctx)).toEqual(expected(TARGET, [BIN], "ok"));

        expect(await staged(ctx)).toEqual([]);
        expect(await pooled(ctx)).toEqual(names);
        expect(count(ctx.db, "staged_digests")).toBe(0);
        expect(count(ctx.db, "rpm_packages")).toBe(3);
        expect(fullPoolRows(ctx.db)).toEqual(rows);
    }));

    test("Falls back to copy and unlink when rename crosses devices, keeping the mtime", withImporter(async ctx => {
        const names = await stage(ctx, ALL, { record: false });
        for (const name of names) {
            await fs.utimes(stagedPath(ctx, `${ TARGET }/${ name }`), new Date(NOW * 1000), new Date(NOW * 1000));
            await record(ctx, `${ TARGET }/${ name }`);
        }
        const rename = fs.rename;
        const spy = jest.spyOn(fs, "rename").mockImplementation(async (from, to) => {
            if (osPath.dirname(String(from)) !== osPath.dirname(String(to))) {
                throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
            }
            return rename(from, to);
        });
        try {
            expect(await importRpm(ctx)).toEqual(expected(TARGET, names, "ok"));
        } finally {
            spy.mockRestore();
        }

        expect(await staged(ctx)).toEqual([]);
        expect(await pooled(ctx)).toEqual(names);
        for (const name of names) {
            expect(await mtimeOf(poolPath(ctx, `${ POOL }/${ name }`))).toBe(NOW);
            expect(xmlOf(ctx.db, name, "primary")).toContain(`<time file="${ NOW }" `);
        }
    }));

    test("Files outside <distro>/<release> or without the .rpm extension are skipped", withImporter(async ctx => {
        await stage(ctx, [SRC]);
        await fs.writeFile(stagedPath(ctx, `${ TARGET }/notes.txt`), "x");
        await fs.mkdir(stagedPath(ctx, `${ TARGET }/sub`));
        await fs.copyFile(osPath.join(RPMS, BIN), stagedPath(ctx, `${ TARGET }/sub/${ BIN }`));
        await fs.copyFile(osPath.join(RPMS, DOC), stagedPath(ctx, `rpm/fedora/${ DOC }`));

        expect(await importRpm(ctx)).toEqual([
            ...expected("rpm/fedora", [DOC], "skipped", "not in a <distro>/<release> directory"),
            ...expected(TARGET, ["notes.txt"], "skipped", "not an .rpm file"),
            ...expected(TARGET, [SRC], "ok"),
            ...expected(`${ TARGET }/sub`, [BIN], "skipped", "not in a <distro>/<release> directory"),
        ]);

        expect(await staged(ctx)).toEqual(["notes.txt", "sub"]);
        expect(await staged(ctx, "rpm/fedora")).toEqual(["42", DOC]);
        expect(await pooled(ctx)).toEqual([SRC]);
        expect(count(ctx.db, "rpm_packages")).toBe(1);
    }));

    test("Nothing staged yields no files", withImporter(async ctx => {
        expect(await importRpm(ctx)).toEqual([]);
        await fs.mkdir(stagedPath(ctx, TARGET), { recursive: true });
        expect(await importRpm(ctx)).toEqual([]);
        expect(count(ctx.db, "releases")).toBe(0);
    }));
});

describe("Tests for RpmCatalog", () => {
    test("The first-letter and source directories are in lower case, the file name keeps its case", () => {
        expect(rpmPoolPath("fedora", "42", "NetworkManager", "NetworkManager-1.56.0-1.fc42.x86_64.rpm"))
            .toBe("rpm/fedora/42/Packages/n/networkmanager/NetworkManager-1.56.0-1.fc42.x86_64.rpm");
    });

    test("ensureRelease creates a release and its metadata without packages, and leaves an existing one alone", withCatalog((db, catalog) => {
        catalog.ensureRelease("fedora", "41");

        expect(catalog.releases()).toEqual([{ distro: "fedora", release: "41" }]);
        expect(indexFiles(db, "fedora", "41")).toEqual(["filelists:::0", "other:::0", "primary:::0"]);
        expect(count(db, "dirty_keys")).toBe(0);

        catalog.applyPackage(pkg(), NOW);
        catalog.ensureRelease("fedora", "42");

        expect(dirtyKeys(db, "primary")).toEqual([KEY_BIN]);
    }));

    test("Removal by source and version removes binaries and src.rpm", withCatalog((db, catalog) => {
        const v1 = [pkg({ arch: "src" }), pkg(), pkg({ name: "srm-hello-doc", arch: "noarch" })];
        const v2 = [pkg({ arch: "src", rel: "2.fc42" }), pkg({ rel: "2.fc42" })];
        const other = pkg({ name: "srm-other", sourceName: "srm-other" });
        for (const p of [...v1, ...v2, other]) {
            expect(catalog.applyPackage(p, NOW)).toEqual({});
        }
        expect(count(db, "rpm_packages")).toBe(6);
        expect(catalog.listSources({}, {}).items.map(i => `${ i.source } ${ i.version }`)).toEqual(["srm-hello 1.0-1.fc42", "srm-hello 1.0-2.fc42", "srm-other 1.0-1.fc42"]);
        db.exec("DELETE FROM dirty_keys");

        expect(catalog.remove({ release: "41", source: "srm-hello" }, NOW + 1, false)).toEqual({ removed: [], deleteNow: [] });
        expect(count(db, "rpm_packages")).toBe(6);

        expect(catalog.remove({ distro: "fedora", source: "srm-hello", version: "1.0-1.fc42" }, NOW + 1, false)).toEqual({ removed: sortedPaths(v1), deleteNow: [] });

        expect(packages(db).map(s => s.split(" ")[2])).toEqual([...v2, other].map(p => p.filename).sort());
        expect(poolRows(db)).toEqual([...rowsOf(v1, NOW + 1), ...rowsOf([...v2, other], null)].sort(byPath));
        for (const kind of KINDS) {
            expect(dirtyKeys(db, kind)).toEqual(sortedKeys(v1));
        }
        expect(catalog.listSources({ source: "srm-hello" }, {}).items.map(i => i.version)).toEqual(["1.0-2.fc42"]);
        expect(catalog.listFiles({ source: "srm-hello" }, {}).items.map(i => i.path)).toEqual(sortedPaths(v2));

        // Re-referencing a removed file clears removed_at
        expect(catalog.applyPackage(v1[1], NOW + 2)).toEqual({});
        expect(poolRow(db, v1[1].file.path)).toEqual({ path: v1[1].file.path, sha256: v1[1].file.sha256, removed_at: null });

        // Immediate removal marks the files nothing references as GC mode does; files already awaiting GC keep their time
        const rest = [...v2, v1[1]];
        expect(catalog.remove({ source: "srm-hello" }, NOW + 3, true)).toEqual({ removed: sortedPaths(rest), deleteNow: sortedPaths(rest) });
        expect(packages(db)).toHaveLength(1);
        expect(poolRows(db)).toEqual([...rowsOf([v1[0], v1[2]], NOW + 1), ...rowsOf(rest, NOW + 3), ...rowsOf([other], null)].sort(byPath));
    }));

    test("A source filter pages through its versions and seeks to them", withCatalog((db, catalog) => {
        const named = (sourceName: string, rel: string) => pkg({ name: sourceName, sourceName, rel });
        for (const p of [named("srm-a", "1.fc42"), named("srm-b", "1.fc42"), named("srm-b", "2.fc42"), pkg({ name: "srm-b-doc", sourceName: "srm-b", rel: "2.fc42" }), named("srm-b", "3.fc42"), named("srm-c", "1.fc42")]) {
            catalog.applyPackage(p, NOW);
        }

        const first = catalog.listSources({ source: "srm-b" }, { limit: 2 });
        expect(first.items.map(i => `${ i.source } ${ i.version }`)).toEqual(["srm-b 1.0-1.fc42", "srm-b 1.0-2.fc42"]);
        expect(catalog.listSources({ source: "srm-b" }, { cursor: first.nextCursor })).toEqual({ items: [{ distro: "fedora", release: "42", source: "srm-b", version: "1.0-3.fc42" }] });
        expect(catalog.listSources({ source: "srm-z" }, {})).toEqual({ items: [] });

        const prepare = jest.spyOn(db, "prepare");
        new RpmCatalog(db);
        const sql = prepare.mock.calls.map(([s]) => s).find(s => s.includes("source_name = ?4"))!;
        prepare.mockRestore();
        expect(db.prepare(`EXPLAIN QUERY PLAN ${ sql }`).all().map(r => r.detail))
            .toEqual(["SEARCH rpm_packages USING COVERING INDEX rpm_packages_source (release_id=? AND source_name=?)"]);
    }));

    test("A version matches ver-rel with or without one dot-free dist tag", withCatalog((db, catalog) => {
        const v1 = [pkg({ arch: "src" }), pkg()];
        const upstream = pkg({ version: "1.0.1" });
        const spaced = ["\t", "\u00a0", "\u2007", "\ufeff"].map((space, i) => pkg({ name: `srm-hello-ws${ i }`, sourceVersion: `1.0-1.fc${ space }42` }));
        const others = [
            pkg({ rel: "10.fc42" }), pkg({ rel: "1.1.fc42" }), upstream, ...spaced, pkg({ name: "srm-hello-dot", sourceVersion: "1.0-1." }),
        ];
        for (const p of [...v1, ...others]) {
            expect(catalog.applyPackage(p, NOW)).toEqual({});
        }
        const listed = (version: string) => catalog.listFiles({ source: "srm-hello", version }, {}).items.map(i => i.path);

        expect(listed("1.0-1")).toEqual(sortedPaths(v1));
        expect(listed("1.0-1.fc42")).toEqual(sortedPaths(v1));
        expect(listed("1.0.1-1")).toEqual([upstream.file.path]);
        for (const version of ["1.0", "1_0-1", "1.0-%"]) {
            expect(listed(version)).toEqual([]);
        }

        expect(catalog.remove({ source: "srm-hello", version: "1.0" }, NOW + 1, false)).toEqual({ removed: [], deleteNow: [] });
        expect(catalog.remove({ source: "srm-hello", version: "1.0-1" }, NOW + 1, false)).toEqual({ removed: sortedPaths(v1), deleteNow: [] });
        expect(packages(db).map(s => s.split(" ")[2])).toEqual(others.map(p => p.filename).sort());
    }));

    test("listSources reports ver-rel without epoch", withCatalog((db, catalog) => {
        const zst = pkg({ name: "srm-zst", sourceName: "srm-zst", epoch: 2, version: "3.0", rel: "1.fc42" });
        expect(zst.filename).toBe("srm-zst-3.0-1.fc42.x86_64.rpm");
        expect(catalog.applyPackage(zst, NOW)).toEqual({});

        expect(catalog.listSources({}, {}).items).toEqual([{ distro: "fedora", release: "42", source: "srm-zst", version: "3.0-1.fc42" }]);
        expect(keyOf(zst)).toBe(["srm-zst", "srm-zst", "2:3.0-1.fc42", "x86_64", zst.filename].join(KEY_SEP));
        expect(() => rpmPoolPath("fedora", "42", "", "x.rpm")).toThrow(RepoValidationError);
        expect(dirtyKeys(db, "primary")).toEqual([keyOf(zst)]);
        expect(indexFiles(db)).toEqual(["filelists:::0", "other:::0", "primary:::0"]);
        // The file name keeps two files of one NEVRA apart
        const twin = pkg({ name: "srm-zst", sourceName: "srm-zst", epoch: 2, version: "3.0", rel: "1.fc42", filename: "srm-zst-rebuilt.rpm" });
        expect(catalog.applyPackage(twin, NOW)).toEqual({});
        expect(count(db, "rpm_packages")).toBe(2);
        expect(dirtyKeys(db, "primary")).toEqual([keyOf(zst), keyOf(twin)]);

        for (const source of ["srm-c", "srm-a", "srm-b"]) {
            catalog.applyPackage(pkg({ name: source, sourceName: source }), NOW);
        }
        const item = (source: string) => ({ distro: "fedora", release: "42", source, version: "1.0-1.fc42" });
        const first = catalog.listSources({}, { limit: 2 });
        expect(first.items).toEqual([item("srm-a"), item("srm-b")]);
        expect(first.nextCursor).toEqual(expect.any(String));
        const second = catalog.listSources({}, { limit: 2, cursor: first.nextCursor });
        expect(second).toEqual({ items: [item("srm-c"), { ...item("srm-zst"), version: "3.0-1.fc42" }] });

        expect(catalog.listSources({ source: "srm-b" }, {}).items.map(i => i.source)).toEqual(["srm-b"]);
        expect(catalog.listSources({ distro: "centos" }, {})).toEqual({ items: [] });
        expect(() => catalog.listSources({}, { cursor: "not-a-cursor" })).toThrow(RepoValidationError);
        expect(() => catalog.listSources({}, { limit: 0 })).toThrow(RepoValidationError);
    }));

    test("Same filename under another source name retires the old pool file", withCatalog((db, catalog) => {
        const a = pkg({ name: "srm-tool", sourceName: "srm-a" });
        const b = pkg({ name: "srm-tool", sourceName: "srm-b", variant: "b" });
        expect(b.filename).toBe(a.filename);
        expect(b.file.path).not.toBe(a.file.path);
        expect(catalog.applyPackage(a, NOW)).toEqual({});

        expect(catalog.applyPackage(b, NOW + 1)).toEqual({ replacedPath: a.file.path });

        expect(packages(db)).toEqual([`fedora 42 ${ a.filename } srm-tool 0 1.0 1.fc42 x86_64 srm-b 1.0-1.fc42`]);
        expect(poolRows(db)).toEqual([...rowsOf([a], NOW + 1), ...rowsOf([b], null)]);
        expect(dirtyKeys(db, "primary")).toEqual([keyOf(a), keyOf(b)]);
        expect(catalog.listSources({}, {}).items.map(i => i.source)).toEqual(["srm-b"]);

        // The same path is overwritten in place and still reported as replaced
        const b2 = pkg({ name: "srm-tool", sourceName: "srm-b", variant: "b2" });
        expect(catalog.applyPackage(b2, NOW + 2)).toEqual({ replacedPath: b.file.path });
        expect(poolRow(db, b.file.path)).toEqual({ path: b.file.path, sha256: b2.file.sha256, removed_at: null });
        expect(count(db, "pool_files")).toBe(2);
        expect(count(db, "rpm_packages")).toBe(1);

        // Back under source a: its file is referenced again, b's awaits GC
        expect(catalog.applyPackage(a, NOW + 3)).toEqual({ replacedPath: b.file.path });
        expect(poolRows(db).map(r => r.removed_at)).toEqual([null, NOW + 3]);
        expect(catalog.listFiles({ source: "srm-a" }, {}).items.map(i => i.path)).toEqual([a.file.path]);
    }));

    test("listFiles pages across releases with a cursor and releases() filters", withCatalog((db, catalog) => {
        const f42 = [pkg({ arch: "src" }), pkg(), pkg({ name: "srm-hello-doc", arch: "noarch" })];
        const f41 = [pkg({ release: "41", arch: "src" }), pkg({ release: "41" }), pkg({ release: "41", name: "srm-hello-doc", arch: "noarch" })];
        const centos = pkg({ distro: "centos", release: "9" });
        for (const p of [...f42, ...f41, centos]) {
            catalog.applyPackage(p, NOW);
        }
        const expectedFiles = [
            ...sortedPaths(f41).map(path => ({ distro: "fedora", release: "41", path })),
            ...sortedPaths(f42).map(path => ({ distro: "fedora", release: "42", path })),
        ];

        const first = catalog.listFiles({ distro: "fedora", source: "srm-hello" }, { limit: 4 });
        expect(first.items).toEqual(expectedFiles.slice(0, 4));
        const second = catalog.listFiles({ distro: "fedora", source: "srm-hello" }, { limit: 4, cursor: first.nextCursor });
        expect(second).toEqual({ items: expectedFiles.slice(4) });

        expect(catalog.listFiles({ release: "42", source: "srm-hello", version: "1.0-1.fc42" }, {}).items).toEqual(expectedFiles.slice(3));
        expect(catalog.listFiles({ source: "srm-hello", version: "9.9-9" }, {})).toEqual({ items: [] });
        expect(catalog.listFiles({ source: "srm-hello" }, {}).items).toEqual([{ distro: "centos", release: "9", path: centos.file.path }, ...expectedFiles]);
        expect(() => catalog.listFiles({ source: "srm-hello" }, { cursor: first.nextCursor?.slice(0, -4) })).toThrow(RepoValidationError);

        expect(catalog.releases()).toEqual([{ distro: "centos", release: "9" }, { distro: "fedora", release: "41" }, { distro: "fedora", release: "42" }]);
        expect(catalog.releases("fedora").map(r => r.release)).toEqual(["41", "42"]);
        expect(catalog.releases("fedora", "42")).toEqual([{ distro: "fedora", release: "42" }]);
        expect(catalog.releases("centos", "42")).toEqual([]);
        expect(indexFiles(db, "centos", "9")).toEqual(["filelists:::0", "other:::0", "primary:::0"]);
    }));
});
