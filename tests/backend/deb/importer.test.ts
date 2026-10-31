import { debWithControl, debWithControlTar, tarBytes, tarEntry, withLocalTmpDir } from "../../utils.ts";
import { jest } from "@jest/globals";
import osPath from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import type { Database } from "node:sqlite";
import * as openpgp from "openpgp";
import { signBundle } from "../../signing.ts";
import { clearsign } from "../../../server/backend/pgp.ts";
import { stripClearsign } from "../../../server/backend/control.ts";
import { openDatabase } from "../../../server/backend/db.ts";
import { hashFile } from "../../../server/backend/hash.ts";
import type { Digests } from "../../../server/backend/hash.ts";
import type { BackendContext } from "../../../server/backend/context.ts";
import { DebCatalog } from "../../../server/backend/deb/catalog.ts";
import { importDebian } from "../../../server/backend/deb/importer.ts";
import { readControlFile } from "../../../server/backend/deb/inputs.ts";
import { publishDebian } from "../../../server/backend/deb/publisher.ts";
import { checkSafeName, checkVersion } from "../../../server/backend/staging.ts";
import { RepoValidationError } from "../../../server/lib/errors.ts";
import { NOT_IN_LOWER_CASE, resetFileNaming, setFileNaming } from "../../../server/lib/file-naming.ts";
import logger from "../../../server/lib/logger.ts";
import type { ImportFile } from "../../../server/lib/repo-service.ts";

const windowsTest = process.platform === "win32" ? test : test.skip;
const notWindowsTest = process.platform === "win32" ? test.skip : test;

const CASE_INSENSITIVE = { caseSensitive: false, shortNames: false };
const CASE_SENSITIVE = { caseSensitive: true, shortNames: false };

afterEach(resetFileNaming);

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const GOLDEN =osPath.join(FIXTURES, "golden");
const NOW = 1700000000;
const MIB = 1024 * 1024;
const SKIPPED = "no .changes file references it";

type Bundle = { dir: string; target: string; changes: string };

const TRIXIE: Bundle = {
    dir: osPath.join(FIXTURES, "packages", "deb", "debian", "trixie", "main"),
    target: "deb/debian/trixie/main",
    changes: "srm-hello_1.0-1_amd64.changes",
};
const NOBLE: Bundle = {
    dir: osPath.join(FIXTURES, "packages", "deb", "ubuntu", "noble", "universe"),
    target: "deb/ubuntu/noble/universe",
    changes: "srm-zst_3.0-1_amd64.changes",
};
const BOOKWORM: Bundle = {
    dir: osPath.join(FIXTURES, "packages", "deb", "debian", "bookworm", "main"),
    target: "deb/debian/bookworm/main",
    changes: "srm-gz_0.1-1_amd64.changes",
};
const ARM64: Bundle = {
    dir: osPath.join(FIXTURES, "packages-arm64", "deb", "debian", "trixie", "main"),
    target: "deb/debian/trixie/main",
    changes: "srm-hello_1.0-1_arm64.changes",
};
const UDEB: Bundle = {
    dir: osPath.join(FIXTURES, "packages-udeb", "deb", "debian", "trixie", "main"),
    target: "deb/debian/trixie/main",
    changes: "srm-hello-udeb_1.0-1_amd64.changes",
};

const HELLO_POOL = "deb/debian/pool/main/s/srm-hello";
const DSC = "srm-hello_1.0-1.dsc";
const ORIG = "srm-hello_1.0.orig.tar.gz";
const BUILDINFO = "srm-hello_1.0-1_amd64.buildinfo";
const DEB = "srm-hello_1.0-1_amd64.deb";
const CONTROL = { Package: "srm-hello", Source: "srm-hello (1.0-1)", Version: "1.0-1", Architecture: "amd64", Maintainer: "x", Description: "x" };

function osJoin(root: string, ...posix: string[]): string {
    return osPath.join(root, ...posix.join("/").split("/"));
}

function withImporter(fn: (ctx: BackendContext) => Promise<void>) {
    return withLocalTmpDir(async () => {
        await fs.mkdir("state");
        const db = openDatabase(osPath.join("state", "repo.db"));
        try {
            await fn({ db, paths: { incomingDir: "incoming", repoStateDir: "state", repoDir: "repo" }, signingKey: undefined, now: () => NOW });
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

/** A row whose staged file is gone, as a crash between the move and the row deletion leaves it */
function insertStaleRow(ctx: BackendContext, relPath: string): void {
    ctx.db.prepare("INSERT OR REPLACE INTO staged_digests (rel_path, size, mtime_ms, md5, sha1, sha256, sha512) VALUES (?, 1, 1, ?, ?, ?, ?)")
        .run(relPath, "0".repeat(32), "0".repeat(40), "0".repeat(64), "0".repeat(128));
}

async function recordAll(ctx: BackendContext, target: string): Promise<void> {
    for (const name of await staged(ctx, target)) {
        await record(ctx, `${ target }/${ name }`);
    }
}

/** Copies the bundle (or the given names) into the staging dir and records their digests unless told otherwise */
async function stage(ctx: BackendContext, bundle: Bundle, o: { names?: string[]; record?: boolean; target?: string } = {}): Promise<string[]> {
    const names = o.names ?? (await fs.readdir(bundle.dir)).sort();
    const target = o.target ?? bundle.target;
    await fs.mkdir(stagedPath(ctx, target), { recursive: true });
    for (const name of names) {
        await fs.copyFile(osPath.join(bundle.dir, name), stagedPath(ctx, `${ target }/${ name }`));
        if (o.record !== false) {
            await record(ctx, `${ target }/${ name }`);
        }
    }
    return names;
}

async function staged(ctx: BackendContext, target: string): Promise<string[]> {
    try {
        return (await fs.readdir(stagedPath(ctx, target))).sort();
    } catch {
        return [];
    }
}

async function pooled(ctx: BackendContext, poolDir = HELLO_POOL): Promise<string[]> {
    try {
        return (await fs.readdir(poolPath(ctx, poolDir))).sort();
    } catch {
        return [];
    }
}

function expected(target: string, names: string[], status: ImportFile["status"], reason?: string): ImportFile[] {
    return names.map(name => ({ filename: name, path: `${ target }/${ name }`, status, ...(reason === undefined ? {} : { reason }) }));
}

function failed(files: ImportFile[]): ImportFile[] {
    return files.map(f => ({ ...f, reason: expect.stringMatching(/^import failed/) as unknown as string }));
}

function reasons(files: ImportFile[]): string[] {
    return [...new Set(files.map(f => f.reason ?? ""))];
}

type PoolRow = { path: string; size: number; md5: string; sha1: string; sha256: string; sha512: string; removed_at: number | null };

function poolRows(db: Database): PoolRow[] {
    return db.prepare("SELECT path, size, md5, sha1, sha256, sha512, removed_at FROM pool_files ORDER BY path").all() as PoolRow[];
}

function binaries(db: Database): string[] {
    return db.prepare("SELECT component || ' ' || kind || ' ' || package || ' ' || version || ' ' || architecture || ' ' || section AS b FROM deb_binaries ORDER BY b")
        .all().map(r => r.b as string);
}

function sources(db: Database): string[] {
    return db.prepare("SELECT component || ' ' || source || ' ' || version AS s FROM deb_sources ORDER BY s").all().map(r => r.s as string);
}

function uploads(db: Database): string[] {
    return db.prepare("SELECT changes_name || ': ' || architectures AS u FROM deb_uploads ORDER BY u").all().map(r => r.u as string);
}

function count(db: Database, table: string): number {
    return (db.prepare(`SELECT count(*) AS n FROM ${ table }`).get() as { n: number }).n;
}

function binaryStanza(db: Database, pkg: string): string {
    return (db.prepare("SELECT stanza FROM deb_binaries WHERE package = ?").get(pkg) as { stanza: string }).stanza;
}

function binaryPaths(db: Database, pkg: string): string[] {
    return db.prepare("SELECT p.path FROM deb_binary_paths p JOIN deb_binaries b ON b.id = p.binary_id WHERE b.package = ? ORDER BY p.path")
        .all(pkg).map(r => r.path as string);
}

async function goldenStanza(file: string, pkg: string): Promise<string> {
    const found = (await fs.readFile(osJoin(GOLDEN, file), "utf8")).split("\n\n").find(s => s.startsWith(`Package: ${ pkg }\n`));
    if (found === undefined) {
        throw new Error(`${ pkg } is not in ${ file }`);
    }
    return `${ found }\n`;
}

function withoutWeakHashes(stanza: string): string {
    return stanza.split("\n").filter(line => !line.startsWith("SHA1: ") && !line.startsWith("SHA512: ")).join("\n");
}

function isListLine(line: string, name: string): boolean {
    return line.startsWith(" ") && line.endsWith(` ${ name }`);
}

/** Drops the Files/Checksums-* lines of `name` */
function unlisted(text: string, name: string): string {
    return text.split("\n").filter(line => !isListLine(line, name)).join("\n");
}

/** Replaces the hash and size of `name` in every Files/Checksums-* line */
function relisted(text: string, name: string, d: Digests): string {
    const byLength: Record<number, string> = { 32: d.md5, 40: d.sha1, 64: d.sha256, 128: d.sha512 };
    return text.split("\n").map(line => {
        if (!isListLine(line, name)) {
            return line;
        }
        const parts = line.trim().split(" ");
        parts[0] = byLength[parts[0].length];
        parts[1] = String(d.size);
        return ` ${ parts.join(" ") }`;
    }).join("\n");
}

/** Drops the Checksums-Sha256 line of `name`, keeping its other list lines */
function withoutSha256Line(text: string, name: string): string {
    return text.split("\n").filter(line => !(isListLine(line, name) && line.trim().split(" ")[0].length === 64)).join("\n");
}

/** Drops a field with its continuation lines */
function withoutField(text: string, name: string): string {
    const lines = text.split("\n");
    const at = lines.findIndex(line => line.startsWith(`${ name }:`));
    let end = at + 1;
    while (end < lines.length && lines[end].startsWith(" ")) {
        end++;
    }
    return [...lines.slice(0, at), ...lines.slice(end)].join("\n");
}

async function edit(ctx: BackendContext, relPath: string, fn: (text: string) => string): Promise<void> {
    const file = stagedPath(ctx, relPath);
    await fs.writeFile(file, fn(await fs.readFile(file, "utf8")));
}

/** A second trixie upload whose .changes no longer lists the orig tarball */
async function stageWithoutOrig(ctx: BackendContext): Promise<string[]> {
    const names = (await stage(ctx, TRIXIE, { record: false })).filter(name => name !== ORIG);
    await fs.unlink(stagedPath(ctx, `${ TRIXIE.target }/${ ORIG }`));
    await edit(ctx, `${ TRIXIE.target }/${ TRIXIE.changes }`, text => unlisted(text, ORIG));
    await recordAll(ctx, TRIXIE.target);
    return names;
}

describe("Tests for readControlFile", () => {
    test("Reads a file of exactly 16 MiB", withLocalTmpDir(async () => {
        await fs.writeFile("x.changes", "");
        await fs.truncate("x.changes", 16 * MIB);
        expect(await readControlFile("x.changes")).toHaveLength(16 * MIB);
    }));

    test("Names a larger one without its directory", withLocalTmpDir(async () => {
        await fs.mkdir("staged");
        await fs.writeFile(osPath.join("staged", "x.changes"), "");
        await fs.truncate(osPath.join("staged", "x.changes"), 16 * MIB + 1);
        await expect(readControlFile(osPath.join("staged", "x.changes"))).rejects
            .toStrictEqual(new RepoValidationError(`x.changes holds ${ 16 * MIB + 1 } bytes, over the ${ 16 * MIB } limit`));
    }));
});

describe("Tests for the name checks", () => {
    type Kind = Parameters<typeof checkSafeName>[0];

    const cases = (kind: Kind, values: string[]): [Kind, string][] => values.map(value => [kind, value]);

    test.each([
        ...cases("debName", ["srm-hello", "clevis-pkcs11-dbgsym", "libstdc++6", "g++", "python3.12", "0ad", "a0"]),
        ...cases("debArchitecture", ["amd64", "all", "source", "hurd-i386", "ppc64el", "s390x"]),
        ...cases("debBinaryArchitecture", ["amd64", "all", "hurd-i386"]),
        ...cases("rpmName", ["srm-hello", "NetworkManager", "gcc-c++", "python3_foo", "java-1.8.0-openjdk", "a", "x86_64", "noarch", "src"]),
    ])("%s accepts %s", (kind, value) => {
        expect(() => checkSafeName(kind, value, "x")).not.toThrow();
    });

    const HOSTILE = ["", "..", "../x", "a/b", "a\\b", "-x", ".x", "a b", "a\tb", "a\nb", "ab\n", "a\u0001b", "a\u007fb", "a\u0085b", "a b", "a b", '"><img>'];

    test.each([
        ...cases("debName", [...HOSTILE, "e", "Evil", "a_b", "+x"]),
        ...cases("debArchitecture", [...HOSTILE, "AMD64", "x86_64", "a.b", "a+b"]),
        ...cases("debBinaryArchitecture", [...HOSTILE, "source"]),
        ...cases("rpmName", [...HOSTILE, "_x", "+x", "a~b", "a:b"]),
    ])("%s refuses %j", (kind, value) => {
        expect(() => checkSafeName(kind, value, "x")).toThrow(new RepoValidationError(`Malformed x: ${ JSON.stringify(value) }`));
    });

    test.each(["2:3.0-1", "22-1+tpm1u0+deb14", "1.0~rc1+dfsg-1", "1.0^git1", "1_0", "1..2"])("A version may be %s", value => {
        expect(() => checkVersion(value, "x")).not.toThrow();
    });

    test.each(["", ".", "..", "1/0", "1\\0", "1 0", "1\t0", "1\n", "1\u0001", "1\u007f", "1\u0085", "1 ", "1 "])("A version may not be %j", value => {
        expect(() => checkVersion(value, "x")).toThrow(new RepoValidationError(`Malformed x: ${ JSON.stringify(value) }`));
    });
});

/** A trixie upload whose amd64 .deb carries these control fields */
async function stageWithControl(ctx: BackendContext, fields: Partial<typeof CONTROL>): Promise<string[]> {
    const names = await stage(ctx, TRIXIE, { record: false });
    const deb = `${ TRIXIE.target }/${ DEB }`;
    await fs.writeFile(stagedPath(ctx, deb), debWithControl({ ...CONTROL, ...fields }));
    const digests = await hashFile(stagedPath(ctx, deb));
    await edit(ctx, `${ TRIXIE.target }/${ TRIXIE.changes }`, text => relisted(text, DEB, digests));
    await recordAll(ctx, TRIXIE.target);
    return names;
}

describe("Tests for importDebian", () => {
    test("Imports a full bundle and moves every file to the pool", withImporter(async ctx => {
        const names = await stage(ctx, TRIXIE);
        expect(count(ctx.db, "staged_digests")).toBe(7);

        expect(await importDebian(ctx)).toEqual(expected(TRIXIE.target, names, "ok"));

        expect(await staged(ctx, TRIXIE.target)).toEqual([]);
        expect(await pooled(ctx)).toEqual(names);
        expect(count(ctx.db, "staged_digests")).toBe(0);
        const rows = poolRows(ctx.db);
        expect(rows.map(r => r.path)).toEqual(names.map(name => `${ HELLO_POOL }/${ name }`));
        for (const row of rows) {
            expect(row).toEqual({ path: row.path, removed_at: null, ...await hashFile(osPath.join(TRIXIE.dir, osPath.basename(row.path))) });
        }
        expect(sources(ctx.db)).toEqual(["main srm-hello 1.0-1"]);
        expect(binaries(ctx.db)).toEqual(["main deb srm-hello 1.0-1 amd64 utils", "main deb srm-hello-doc 1.0-1 all doc"]);
        expect(uploads(ctx.db)).toEqual(["srm-hello_1.0-1_amd64.changes: all amd64 source"]);
        expect(count(ctx.db, "deb_source_files")).toBe(3);
        expect(count(ctx.db, "deb_upload_files")).toBe(2);
        expect(binaryPaths(ctx.db, "srm-hello")).toEqual(["usr/bin/srm-hello"]);
        expect(binaryStanza(ctx.db, "srm-hello-doc"))
            .toBe(withoutWeakHashes(await goldenStanza("deb/debian/dists/trixie/main/binary-amd64/Packages", "srm-hello-doc")));
        expect((ctx.db.prepare("SELECT stanza FROM deb_sources").get() as { stanza: string }).stanza)
            .toBe(await goldenStanza("deb/debian/dists/trixie/main/source/Sources", "srm-hello"));
    }));

    test("Files without a .changes are skipped and stay staged", withImporter(async ctx => {
        const names = await stage(ctx, BOOKWORM, { names: ["srm-gz_0.1-1.dsc", "srm-gz_0.1-1_amd64.deb", "srm-gz_0.1.orig.tar.gz"] });
        const trixie = await stage(ctx, TRIXIE);
        const extra = await stage(ctx, BOOKWORM, { names: ["srm-gz_0.1-1.debian.tar.gz"], target: TRIXIE.target });

        expect(await importDebian(ctx)).toEqual([
            ...expected(BOOKWORM.target, names, "skipped", SKIPPED),
            ...expected(TRIXIE.target, [...extra, ...trixie].sort(), "ok").map(f => f.filename === extra[0] ? { ...f, status: "skipped", reason: SKIPPED } : f),
        ]);

        expect(await staged(ctx, BOOKWORM.target)).toEqual(names);
        expect(await staged(ctx, TRIXIE.target)).toEqual(extra);
        expect(await pooled(ctx)).toEqual(trixie);
        expect(count(ctx.db, "releases")).toBe(1);
        expect(count(ctx.db, "staged_digests")).toBe(4);
    }));

    test("Checksum mismatch fails the bundle and moves nothing", withImporter(async ctx => {
        const names = await stage(ctx, TRIXIE, { record: false });
        const orig = stagedPath(ctx, `${ TRIXIE.target }/${ ORIG }`);
        const bytes = await fs.readFile(orig);
        bytes[bytes.length - 1] ^= 0xff;
        await fs.writeFile(orig, bytes);
        await recordAll(ctx, TRIXIE.target);

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(result)).toHaveLength(1);
        expect(reasons(result)[0]).toContain(ORIG);
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
        expect(await pooled(ctx)).toEqual([]);
        expect(count(ctx.db, "pool_files")).toBe(0);
        expect(count(ctx.db, "releases")).toBe(0);
        expect(count(ctx.db, "staged_digests")).toBe(7);
    }));

    test("Recorded digests are trusted over the file content", withImporter(async ctx => {
        await stage(ctx, TRIXIE);
        const deb = `${ TRIXIE.target }/srm-hello_1.0-1_amd64.deb`;
        await record(ctx, deb, { ...await hashFile(stagedPath(ctx, deb)), md5: "0".repeat(32) });

        const result = await importDebian(ctx);

        expect(result.map(f => f.status)).toEqual(Array(7).fill("failed"));
        expect(reasons(result)[0]).toContain("srm-hello_1.0-1_amd64.deb");
        expect(await pooled(ctx)).toEqual([]);
    }));

    test("Missing listed file fails the bundle", withImporter(async ctx => {
        const names = await stage(ctx, TRIXIE);
        await fs.unlink(stagedPath(ctx, `${ TRIXIE.target }/${ BUILDINFO }`));

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(TRIXIE.target, names.filter(n => n !== BUILDINFO), "failed")));
        expect(reasons(result)[0]).toContain(BUILDINFO);
        expect(await pooled(ctx)).toEqual([]);
    }));

    test("Binary-only arm64 bundle imports next to amd64", withImporter(async ctx => {
        const amd64 = await stage(ctx, TRIXIE);
        await importDebian(ctx);
        const arm64 = await stage(ctx, ARM64);

        expect(await importDebian(ctx)).toEqual(expected(TRIXIE.target, arm64, "ok"));

        expect(await staged(ctx, TRIXIE.target)).toEqual([]);
        expect(await pooled(ctx)).toEqual([...amd64, ...arm64].sort());
        expect(binaries(ctx.db)).toEqual([
            "main deb srm-hello 1.0-1 amd64 utils", "main deb srm-hello 1.0-1 arm64 utils", "main deb srm-hello-doc 1.0-1 all doc",
        ]);
        expect(sources(ctx.db)).toEqual(["main srm-hello 1.0-1"]);
        expect(uploads(ctx.db)).toEqual(["srm-hello_1.0-1_amd64.changes: all amd64 source", "srm-hello_1.0-1_arm64.changes: arm64"]);
        expect(poolRows(ctx.db).map(r => r.removed_at)).toEqual(Array(10).fill(null));
        expect(binaryStanza(ctx.db, "srm-hello").split("\n").filter(l => l.startsWith("Architecture"))).toHaveLength(1);
        expect(count(ctx.db, "staged_digests")).toBe(0);
    }));

    test("Orig tarball omitted from a second upload is taken from the pool", withImporter(async ctx => {
        await stage(ctx, TRIXIE);
        await importDebian(ctx);
        const before = poolRows(ctx.db);
        const names = await stageWithoutOrig(ctx);

        expect(await importDebian(ctx)).toEqual(expected(TRIXIE.target, names, "ok"));

        expect(await staged(ctx, TRIXIE.target)).toEqual([]);
        expect(await pooled(ctx)).toEqual([...names, ORIG].sort());
        // The rewritten .changes is the only file whose content differs
        expect(poolRows(ctx.db).filter(r => !r.path.endsWith(".changes"))).toEqual(before.filter(r => !r.path.endsWith(".changes")));
        expect(poolRows(ctx.db).find(r => r.path.endsWith(".changes")))
            .toEqual({ path: `${ HELLO_POOL }/${ TRIXIE.changes }`, removed_at: null, ...await hashFile(poolPath(ctx, `${ HELLO_POOL }/${ TRIXIE.changes }`)) });
        expect(sources(ctx.db)).toEqual(["main srm-hello 1.0-1"]);
        expect(count(ctx.db, "deb_source_files")).toBe(3);
        expect(uploads(ctx.db)).toEqual(["srm-hello_1.0-1_amd64.changes: all amd64 source"]);
    }));

    test("Orig tarball missing from the pool or with another digest fails", withImporter(async ctx => {
        const names = await stageWithoutOrig(ctx);
        const result = await importDebian(ctx);
        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(result)[0]).toContain(ORIG);
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
        expect(count(ctx.db, "releases")).toBe(0);

        await stage(ctx, TRIXIE, { names: [ORIG, TRIXIE.changes] });
        expect((await importDebian(ctx)).map(f => f.status)).toEqual(Array(7).fill("ok"));
        ctx.db.prepare("UPDATE pool_files SET sha256 = ? WHERE path = ?").run("f".repeat(64), `${ HELLO_POOL }/${ ORIG }`);
        await stageWithoutOrig(ctx);

        const again = await importDebian(ctx);

        expect(again.map(f => f.status)).toEqual(Array(6).fill("failed"));
        expect(reasons(again)[0]).toContain(ORIG);
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
    }));

    test("Orig tarball truncated or replaced by a directory in the pool is not accepted", withImporter(async ctx => {
        await stage(ctx, TRIXIE);
        await importDebian(ctx);
        const orig = poolPath(ctx, `${ HELLO_POOL }/${ ORIG }`);
        await fs.truncate(orig, 10);
        const names = await stageWithoutOrig(ctx);

        const truncated = await importDebian(ctx);

        expect(truncated).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(truncated)).toEqual([expect.stringContaining(`${ ORIG } is missing or damaged in the pool`)]);
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
        expect(count(ctx.db, "deb_sources")).toBe(1);

        await fs.unlink(orig);
        await fs.mkdir(orig);
        const directory = await importDebian(ctx);

        expect(directory).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(directory)).toEqual([expect.stringContaining(`${ ORIG } is missing or damaged in the pool`)]);
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
    }));

    test("Distribution header for another release fails", withImporter(async ctx => {
        const names = await stage(ctx, TRIXIE, { target: BOOKWORM.target });

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(BOOKWORM.target, names, "failed")));
        expect(reasons(result)[0]).toContain("bookworm");
        expect(await staged(ctx, BOOKWORM.target)).toEqual(names);
        expect(await fs.readdir(".")).not.toContain("repo");
        expect(count(ctx.db, "releases")).toBe(0);
    }));

    test("Staged file without a staged_digests row is hashed at import", withImporter(async ctx => {
        const names = await stage(ctx, TRIXIE, { record: false });
        const bogus = { size: 1, md5: "0".repeat(32), sha1: "0".repeat(40), sha256: "0".repeat(64), sha512: "0".repeat(128) };
        for (const name of names.filter(n => n !== ORIG && n !== DSC && n !== BUILDINFO)) {
            await record(ctx, `${ TRIXIE.target }/${ name }`);
        }
        // Stale rows: another mtime, another size
        await record(ctx, `${ TRIXIE.target }/${ DSC }`, bogus);
        await fs.utimes(stagedPath(ctx, `${ TRIXIE.target }/${ DSC }`), new Date(NOW * 1000), new Date(NOW * 1000));
        ctx.db.prepare("UPDATE staged_digests SET size = size + 1, md5 = ?, sha256 = ? WHERE rel_path = ?")
            .run(bogus.md5, bogus.sha256, `${ TRIXIE.target }/${ BUILDINFO }`);

        expect(await importDebian(ctx)).toEqual(expected(TRIXIE.target, names, "ok"));

        expect(count(ctx.db, "staged_digests")).toBe(0);
        for (const row of poolRows(ctx.db)) {
            expect(row).toEqual({ path: row.path, removed_at: null, ...await hashFile(osPath.join(TRIXIE.dir, osPath.basename(row.path))) });
        }
    }));

    test("A .dsc without Checksums-Sha256 fails", withImporter(async ctx => {
        const names = await stage(ctx, TRIXIE, { record: false });
        await edit(ctx, `${ TRIXIE.target }/${ DSC }`, text => withoutField(text, "Checksums-Sha256"));
        const dsc = await hashFile(stagedPath(ctx, `${ TRIXIE.target }/${ DSC }`));
        await edit(ctx, `${ TRIXIE.target }/${ TRIXIE.changes }`, text => relisted(text, DSC, dsc));
        await recordAll(ctx, TRIXIE.target);

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(result)[0]).toContain("Checksums-Sha256");
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
    }));

    test("ddeb, epoch and udeb land as their own kinds", withImporter(async ctx => {
        const noble = await stage(ctx, NOBLE);
        const udeb = await stage(ctx, UDEB);

        expect(await importDebian(ctx)).toEqual([...expected(UDEB.target, udeb, "ok"), ...expected(NOBLE.target, noble, "ok")]);

        expect(await pooled(ctx, "deb/ubuntu/pool/universe/s/srm-zst")).toEqual(noble);
        expect(await pooled(ctx)).toEqual(udeb);
        expect(binaries(ctx.db)).toEqual([
            "main udeb srm-hello-udeb 1.0-1 amd64 debian-installer",
            "universe ddeb srm-zst-dbgsym 2:3.0-1 amd64 debug",
            "universe deb srm-zst 2:3.0-1 amd64 utils",
        ]);
        expect(sources(ctx.db)).toEqual(["universe srm-zst 2:3.0-1"]);
        expect(uploads(ctx.db)).toEqual(["srm-hello-udeb_1.0-1_amd64.changes: amd64", "srm-zst_3.0-1_amd64.changes: amd64 source"]);
        expect(binaryStanza(ctx.db, "srm-zst-dbgsym"))
            .toBe(withoutWeakHashes(await goldenStanza("deb/ubuntu/dists/noble/universe/debug/binary-amd64/Packages", "srm-zst-dbgsym")));
        expect(binaryStanza(ctx.db, "srm-hello-udeb"))
            .toBe(withoutWeakHashes(await goldenStanza("udeb/deb/debian/dists/trixie/main/debian-installer/binary-amd64/Packages", "srm-hello-udeb")));
        expect(binaryPaths(ctx.db, "srm-zst-dbgsym")).toEqual([]);
        expect(binaryPaths(ctx.db, "srm-hello-udeb")).toEqual(["usr/bin/srm-hello"]);
        expect(binaryStanza(ctx.db, "srm-zst")).toContain("\nFilename: pool/universe/s/srm-zst/srm-zst_3.0-1_amd64.deb\n");
    }));

    test("Rebuild with a changed .buildinfo overwrites it in the pool", withImporter(async ctx => {
        await stage(ctx, TRIXIE);
        await importDebian(ctx);
        const before = poolRows(ctx.db);
        const names = await stage(ctx, TRIXIE, { record: false });
        await edit(ctx, `${ TRIXIE.target }/${ BUILDINFO }`, text => `${ text }Build-Tainted-By:\n rebuilt\n`);
        const buildinfo = await hashFile(stagedPath(ctx, `${ TRIXIE.target }/${ BUILDINFO }`));
        await edit(ctx, `${ TRIXIE.target }/${ TRIXIE.changes }`, text => relisted(text, BUILDINFO, buildinfo));
        await recordAll(ctx, TRIXIE.target);

        expect(await importDebian(ctx)).toEqual(expected(TRIXIE.target, names, "ok"));

        expect(await staged(ctx, TRIXIE.target)).toEqual([]);
        expect(await fs.readFile(poolPath(ctx, `${ HELLO_POOL }/${ BUILDINFO }`), "utf8")).toContain("\n rebuilt\n");
        const after = poolRows(ctx.db);
        expect(after.find(r => r.path.endsWith(BUILDINFO))).toEqual({ path: `${ HELLO_POOL }/${ BUILDINFO }`, removed_at: null, ...buildinfo });
        expect(after.filter(r => !r.path.endsWith(BUILDINFO) && !r.path.endsWith(".changes")))
            .toEqual(before.filter(r => !r.path.endsWith(BUILDINFO) && !r.path.endsWith(".changes")));
        expect(uploads(ctx.db)).toEqual(["srm-hello_1.0-1_amd64.changes: all amd64 source"]);
        expect(count(ctx.db, "deb_upload_files")).toBe(2);
        expect(count(ctx.db, "deb_binaries")).toBe(2);
    }));

    test("Orig tarball with another digest referenced by another release is a conflict", withImporter(async ctx => {
        await stage(ctx, TRIXIE);
        await importDebian(ctx);
        const names = await stage(ctx, TRIXIE, { target: BOOKWORM.target, record: false });
        await fs.appendFile(stagedPath(ctx, `${ BOOKWORM.target }/${ ORIG }`), "x");
        const orig = await hashFile(stagedPath(ctx, `${ BOOKWORM.target }/${ ORIG }`));
        await edit(ctx, `${ BOOKWORM.target }/${ DSC }`, text => relisted(text, ORIG, orig));
        const dsc = await hashFile(stagedPath(ctx, `${ BOOKWORM.target }/${ DSC }`));
        await edit(ctx, `${ BOOKWORM.target }/${ TRIXIE.changes }`,
            text => relisted(relisted(text, ORIG, orig), DSC, dsc).replace("Distribution: trixie", "Distribution: bookworm"));
        await recordAll(ctx, BOOKWORM.target);

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(BOOKWORM.target, names, "failed")));
        expect(reasons(result)[0]).toContain(`${ HELLO_POOL }/${ ORIG }`);
        expect(await staged(ctx, BOOKWORM.target)).toEqual(names);
        expect(await pooled(ctx)).toEqual(names);
        expect(count(ctx.db, "releases")).toBe(1);
        expect(poolRows(ctx.db).find(r => r.path.endsWith(ORIG))?.sha256).not.toBe(orig.sha256);
    }));

    test("A subcomponent directory keeps the component in the pool path", withImporter(async ctx => {
        const names = await stage(ctx, TRIXIE, { target: "deb/debian/trixie/main/sub" });

        expect(await importDebian(ctx)).toEqual(expected("deb/debian/trixie/main/sub", names, "ok"));

        expect(await pooled(ctx, "deb/debian/pool/main/sub/s/srm-hello")).toEqual(names);
        expect(sources(ctx.db)).toEqual(["main/sub srm-hello 1.0-1"]);
        expect(binaryStanza(ctx.db, "srm-hello")).toContain("\nFilename: pool/main/sub/s/srm-hello/srm-hello_1.0-1_amd64.deb\n");
    }));

    test("Falls back to copy and unlink when rename crosses devices", withImporter(async ctx => {
        const names = await stage(ctx, TRIXIE);
        const rename = fs.rename;
        const spy = jest.spyOn(fs, "rename").mockImplementation(async (from, to) => {
            if (osPath.dirname(String(from)) !== osPath.dirname(String(to))) {
                throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
            }
            return rename(from, to);
        });
        try {
            expect(await importDebian(ctx)).toEqual(expected(TRIXIE.target, names, "ok"));
        } finally {
            spy.mockRestore();
        }

        expect(await staged(ctx, TRIXIE.target)).toEqual([]);
        expect(await pooled(ctx)).toEqual(names);
    }));

    test("Interrupted move is completed by the next import", withImporter(async ctx => {
        const names = await stage(ctx, TRIXIE);
        const rename = fs.rename;
        let calls = 0;
        const spy = jest.spyOn(fs, "rename").mockImplementation(async (from, to) => {
            if (++calls === 3) {
                throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
            }
            return rename(from, to);
        });
        const errorSpy = jest.spyOn(logger, "error");
        let first: ImportFile[];
        let errors: unknown[][];
        try {
            first = await importDebian(ctx);
        } finally {
            errors = [...errorSpy.mock.calls];
            spy.mockRestore();
            errorSpy.mockRestore();
        }

        // Moves follow the Files order of the .changes, which itself goes last
        const moved = [DSC, ORIG];
        const left = names.filter(name => !moved.includes(name));
        expect(first).toEqual(names.map(name => moved.includes(name)
            ? expected(TRIXIE.target, [name], "ok")[0]
            : failed(expected(TRIXIE.target, [name], "failed"))[0]));
        expect(reasons(first.filter(f => f.status === "failed"))).toEqual(["import failed"]);
        expect(errors).toContainEqual([`Import of ${ TRIXIE.target }/${ TRIXIE.changes } failed`, { err: expect.objectContaining({ code: "EIO" }) }]);
        expect(await pooled(ctx)).toEqual(moved);
        expect(await staged(ctx, TRIXIE.target)).toEqual(left);
        expect(count(ctx.db, "pool_files")).toBe(7);
        expect(sources(ctx.db)).toEqual(["main srm-hello 1.0-1"]);
        expect(count(ctx.db, "staged_digests")).toBe(5);
        const rows = poolRows(ctx.db);
        for (const name of moved) {
            insertStaleRow(ctx, `${ TRIXIE.target }/${ name }`);
        }
        expect(count(ctx.db, "staged_digests")).toBe(7);

        expect(await importDebian(ctx)).toEqual(expected(TRIXIE.target, left, "ok"));

        expect(await staged(ctx, TRIXIE.target)).toEqual([]);
        expect(await pooled(ctx)).toEqual(names);
        expect(count(ctx.db, "staged_digests")).toBe(0);
        expect(poolRows(ctx.db)).toEqual(rows);
        expect(sources(ctx.db)).toEqual(["main srm-hello 1.0-1"]);
        expect(count(ctx.db, "deb_binaries")).toBe(2);
        expect(uploads(ctx.db)).toEqual(["srm-hello_1.0-1_amd64.changes: all amd64 source"]);
    }));

    test("Architecture listing source without a .dsc fails", withImporter(async ctx => {
        const sourceFiles = [DSC, ORIG, "srm-hello_1.0-1.debian.tar.xz"];
        const names = (await stage(ctx, TRIXIE, { record: false })).filter(name => !sourceFiles.includes(name));
        for (const name of sourceFiles) {
            await fs.unlink(stagedPath(ctx, `${ TRIXIE.target }/${ name }`));
        }
        await edit(ctx, `${ TRIXIE.target }/${ TRIXIE.changes }`, text => sourceFiles.reduce(unlisted, text));
        await recordAll(ctx, TRIXIE.target);

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(result)).toEqual([expect.stringContaining("Architecture lists source but no .dsc is listed")]);
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
        expect(count(ctx.db, "releases")).toBe(0);
    }));

    type Malformed = { changes?: (text: string) => string; dsc?: (text: string) => string; reason: string; whole: boolean };

    test.each<[string, Malformed]>([
        ["a file listed twice", {
            changes: text => text.split("\n").flatMap(line => isListLine(line, DSC) ? [line, line] : [line]).join("\n"),
            reason: `${ DSC } is listed twice in Files`, whole: false,
        }],
        ["a ../ name in Files", { changes: text => text.replaceAll(` ${ DSC }`, ` ../${ DSC }`), reason: "Malformed file name in Files", whole: false }],
        ["a checksum size that differs from Files", { changes: text => text.replace(` 207 ${ ORIG }`, ` 208 ${ ORIG }`), reason: "does not match Files", whole: false }],
        ["content that is no control file", { changes: () => "garbage without a colon\n", reason: "Malformed control line", whole: false }],
        ["no Checksums-Sha256", { changes: text => withoutField(text, "Checksums-Sha256"), reason: "is not listed in Checksums-Sha256 of the .changes", whole: true }],
        ["an empty Checksums-Sha256", {
            changes: text => withoutField(text, "Checksums-Sha256").replace("Files:", "Checksums-Sha256:\nFiles:"),
            reason: `${ DSC } is not listed in Checksums-Sha256 of the .changes`, whole: true,
        }],
        ["a file missing from Checksums-Sha256", {
            changes: text => withoutSha256Line(text, ORIG), reason: `${ ORIG } is not listed in Checksums-Sha256 of the .changes`, whole: true,
        }],
        ["a .dsc file missing from the .dsc Checksums-Sha256", {
            dsc: text => withoutSha256Line(text, "srm-hello_1.0-1.debian.tar.xz"),
            reason: `srm-hello_1.0-1.debian.tar.xz is not listed in Checksums-Sha256 of ${ DSC }`, whole: true,
        }],
        ["a / name in the .dsc", { dsc: text => text.replaceAll(` ${ ORIG }`, ` sub/${ ORIG }`), reason: `Malformed file name in ${ DSC }`, whole: true }],
        ["a .dsc of another version", { dsc: text => text.replace("Version: 1.0-1", "Version: 1.0-2"), reason: "srm-hello 1.0-2, not srm-hello 1.0-1", whole: true }],
        ["a .dsc Source with markup", { dsc: text => text.replace("Source: srm-hello", `Source: "><img>`), reason: `Malformed Source of ${ DSC }: "\\"><img>"`, whole: true }],
        ["a .dsc Version with a slash", { dsc: text => text.replace("Version: 1.0-1", "Version: 1/0-1"), reason: `Malformed Version of ${ DSC }: "1/0-1"`, whole: true }],
        ["a .dsc without a Source", { dsc: text => withoutField(text, "Source"), reason: "Missing Source field", whole: true }],
        ["a .dsc without a Version", { dsc: text => withoutField(text, "Version"), reason: "Missing Version field", whole: true }],
        ["a Source that climbs out of the pool", {
            changes: text => text.replace("Source: srm-hello", "Source: ../../../evil"), reason: `Malformed Source of ${ TRIXIE.changes }: "../../../evil"`, whole: true,
        }],
        ["a Source over the length limit", {
            changes: text => text.replace("Source: srm-hello", `Source: ${ "a".repeat(241) }`), reason: `Malformed Source of ${ TRIXIE.changes }: "${ "a".repeat(64) }…" is longer than 240 bytes`, whole: true,
        }],
        ["a Source starting with a dash", { changes: text => text.replace("Source: srm-hello", "Source: -evil"), reason: `Malformed Source of ${ TRIXIE.changes }: "-evil"`, whole: true }],
        ["a Source starting with a dot", { changes: text => text.replace("Source: srm-hello", "Source: .evil"), reason: `Malformed Source of ${ TRIXIE.changes }: ".evil"`, whole: true }],
        ["a Source with a space", { changes: text => text.replace("Source: srm-hello", "Source: ev il"), reason: `Malformed Source of ${ TRIXIE.changes }: "ev il"`, whole: true }],
        ["a Source with markup", {
            changes: text => text.replace("Source: srm-hello", `Source: "><img>`), reason: `Malformed Source of ${ TRIXIE.changes }: "\\"><img>"`, whole: true,
        }],
        ["a Source version with a slash", {
            changes: text => text.replace("Source: srm-hello", "Source: srm-hello (../1)"), reason: `Malformed Version of ${ TRIXIE.changes }: "../1"`, whole: true,
        }],
        ["a Version with a slash", { changes: text => text.replace("Version: 1.0-1", "Version: 1/0-1"), reason: `Malformed Version of ${ TRIXIE.changes }: "1/0-1"`, whole: true }],
        ["an Architecture that climbs out of dists", {
            changes: text => text.replace("Architecture: source all amd64", "Architecture: source ../../evil"), reason: `Malformed Architecture of ${ TRIXIE.changes }: "../../evil"`, whole: true,
        }],
        ["an Architecture broken over two lines", {
            changes: text => text.replace("Architecture: source all amd64", "Architecture: source all\n amd64"), reason: `Malformed Architecture of ${ TRIXIE.changes }: "all\\n"`, whole: true,
        }],
    ])("A .changes with %s fails", (_, m) => withImporter(async ctx => {
        const names = await stage(ctx, TRIXIE, { record: false });
        const changes = `${ TRIXIE.target }/${ TRIXIE.changes }`;
        if (m.dsc !== undefined) {
            await edit(ctx, `${ TRIXIE.target }/${ DSC }`, m.dsc);
            const dsc = await hashFile(stagedPath(ctx, `${ TRIXIE.target }/${ DSC }`));
            await edit(ctx, changes, text => relisted(text, DSC, dsc));
        }
        if (m.changes !== undefined) {
            await edit(ctx, changes, m.changes);
        }
        await recordAll(ctx, TRIXIE.target);

        const result = await importDebian(ctx);

        const own = result.find(f => f.filename === TRIXIE.changes);
        expect(own?.status).toBe("failed");
        expect(own?.reason).toContain(m.reason);
        const rest = names.filter(name => name !== TRIXIE.changes);
        expect(result.filter(f => f.filename !== TRIXIE.changes)).toEqual(m.whole
            ? failed(expected(TRIXIE.target, rest, "failed"))
            : expected(TRIXIE.target, rest, "skipped", `${ SKIPPED }; ${ TRIXIE.changes } could not be parsed`));
        if (m.whole) {
            expect(reasons(result)).toHaveLength(1);
        }
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
        expect(count(ctx.db, "releases")).toBe(0);
    })());

    test("A source named aux fails where its pool directory cannot exist, and moves nothing", withImporter(async ctx => {
        const names = await stage(ctx, TRIXIE, { record: false });
        await edit(ctx, `${ TRIXIE.target }/${ TRIXIE.changes }`, text => text.replace("Source: srm-hello", "Source: aux"));
        await recordAll(ctx, TRIXIE.target);

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        // Elsewhere the name is fine and only the .deb built from another source is in the way
        expect(reasons(result)[0]).toContain(process.platform === "win32" ? `Malformed Source of ${ TRIXIE.changes }: "aux" is a reserved name on Windows` : `is built from srm-hello 1.0-1, not aux 1.0-1`);
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
        expect(await pooled(ctx)).toEqual([]);
        expect(count(ctx.db, "pool_files")).toBe(0);
        expect(count(ctx.db, "releases")).toBe(0);
    }));

    test("A listed file with the shape of a short name fails where it could alias another, and moves nothing", withImporter(async ctx => {
        const names = await stage(ctx, TRIXIE, { record: false });
        await edit(ctx, `${ TRIXIE.target }/${ TRIXIE.changes }`, text => text.replaceAll(` ${ ORIG }`, " git~1.xz"));
        await recordAll(ctx, TRIXIE.target);

        const result = await importDebian(ctx);

        expect(result.find(f => f.filename === TRIXIE.changes)?.reason).toContain(process.platform === "win32"
            ? 'Malformed file name in Files: "git~1.xz" has the shape of a Windows 8.3 short name'
            : "git~1.xz is neither uploaded nor in the pool");
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
        expect(await pooled(ctx)).toEqual([]);
        expect(count(ctx.db, "pool_files")).toBe(0);
    }));

    test("A file named like a device with an extension imports on any OS", withImporter(async ctx => {
        await stage(ctx, TRIXIE, { record: false });
        const renamed = "con.buildinfo";
        await fs.rename(stagedPath(ctx, `${ TRIXIE.target }/${ BUILDINFO }`), stagedPath(ctx, `${ TRIXIE.target }/${ renamed }`));
        await edit(ctx, `${ TRIXIE.target }/${ TRIXIE.changes }`, text => text.replaceAll(` ${ BUILDINFO }`, ` ${ renamed }`));
        await recordAll(ctx, TRIXIE.target);

        expect((await importDebian(ctx)).filter(f => f.status !== "ok")).toEqual([]);

        expect(await staged(ctx, TRIXIE.target)).toEqual([]);
        expect(await pooled(ctx)).toContain(renamed);
    }));

    test("One import reads each directory of the repository once", withImporter(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        const names = await stage(ctx, TRIXIE);
        const readdir = jest.spyOn(fs, "readdir");
        let reads: string[];
        try {
            expect(await importDebian(ctx)).toEqual(expected(TRIXIE.target, names, "ok"));
            reads = readdir.mock.calls.map(([dir]) => String(dir)).filter(dir => dir === ctx.paths.repoDir || dir.startsWith(`${ ctx.paths.repoDir }${ osPath.sep }`));
        } finally {
            readdir.mockRestore();
        }
        expect(reads.length).toBeGreaterThan(0);
        expect(reads).toEqual([...new Set(reads)]);
    }));

    test.each<[string, string]>([
        ["distribution", "deb/Debian/trixie/main"],
        ["release", "deb/debian/Trixie/main"],
        ["component", "deb/debian/trixie/Main"],
    ])("Where case does not count, a %s differing only in case from a published one imports into it", (_, target) => withImporter(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        await stage(ctx, TRIXIE);
        await importDebian(ctx);
        await publishDebian(ctx);
        await fs.rm(stagedPath(ctx, "deb"), { recursive: true });
        const names = await stage(ctx, TRIXIE, { target });
        const rows = poolRows(ctx.db);

        expect(await importDebian(ctx)).toEqual(expected(target, names, "ok"));

        expect(await staged(ctx, target)).toEqual([]);
        expect(await pooled(ctx)).toEqual(names);
        expect(poolRows(ctx.db)).toEqual(rows);
        expect(count(ctx.db, "releases")).toBe(1);
        expect(count(ctx.db, "staged_digests")).toBe(0);
        expect(sources(ctx.db)).toEqual(["main srm-hello 1.0-1"]);
    })());

    test.each<[string, string, string]>([
        ["deb/Debian/Trixie/Main", "main", HELLO_POOL],
        ["deb/debian/trixie/Updates/Main", "updates/main", "deb/debian/pool/updates/main/s/srm-hello"],
    ])("Where case does not count, a bundle placed in %s lands in lower case, reported as staged", (target, component, pool) => withImporter(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        const names = await stage(ctx, TRIXIE, { target });

        expect(await importDebian(ctx)).toEqual(expected(target, names, "ok"));
        await publishDebian(ctx);

        expect(await pooled(ctx, pool)).toEqual(names);
        expect(await fs.readdir(poolPath(ctx, "deb"))).toEqual(["debian"]);
        expect(await fs.readdir(poolPath(ctx, "deb/debian/dists"))).toEqual(["trixie"]);
        expect(await fs.readdir(poolPath(ctx, `deb/debian/dists/trixie/${ component }`))).toContain("binary-amd64");
        expect(sources(ctx.db)).toEqual([`${ component } srm-hello 1.0-1`]);
    })());

    test("Where case counts, a bundle placed in deb/Debian/Trixie/Main stays in that spelling", withImporter(async ctx => {
        setFileNaming(CASE_SENSITIVE);
        const target = "deb/Debian/Trixie/Main";
        const names = await stage(ctx, TRIXIE, { target, record: false });
        await edit(ctx, `${ target }/${ TRIXIE.changes }`, text => text.replace("Distribution: trixie", "Distribution: Trixie"));

        expect(await importDebian(ctx)).toEqual(expected(target, names, "ok"));
        await publishDebian(ctx);

        expect(await pooled(ctx, "deb/Debian/pool/Main/s/srm-hello")).toEqual(names);
        expect(await fs.readdir(poolPath(ctx, "deb"))).toEqual(["Debian"]);
        expect(await fs.readdir(poolPath(ctx, "deb/Debian/dists"))).toEqual(["Trixie"]);
        expect(await fs.readdir(poolPath(ctx, "deb/Debian/dists/Trixie/Main"))).toContain("binary-amd64");
        expect(sources(ctx.db)).toEqual(["Main srm-hello 1.0-1"]);
    }));

    test("Where case does not count, a .changes must still name the release in lower case", withImporter(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        const target = "deb/debian/Trixie/main";
        const names = await stage(ctx, TRIXIE, { target, record: false });
        await edit(ctx, `${ target }/${ TRIXIE.changes }`, text => text.replace("Distribution: trixie", "Distribution: Trixie"));

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(target, names, "failed")));
        expect(reasons(result)).toEqual([expect.stringContaining('Distribution "Trixie" does not contain trixie')]);
        expect(await staged(ctx, target)).toEqual(names);
        expect(await pooled(ctx)).toEqual([]);
        expect(count(ctx.db, "releases")).toBe(0);
    }));

    /** The bundle failed, with nothing moved and no row, so the next publish has nothing to fail on */
    async function expectRefused(ctx: BackendContext, target: string, names: string[], reason: string): Promise<void> {
        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(target, names, "failed")));
        expect(reasons(result)).toEqual([expect.stringContaining(reason)]);
        expect(await staged(ctx, target)).toEqual(names);
        expect(count(ctx.db, "pool_files")).toBe(0);
        expect(count(ctx.db, "releases")).toBe(0);
        expect(await publishDebian(ctx)).toEqual([]);
    }

    test.each(["release", "Release", "INRELEASE", "InRelease", "Release.gpg", "release/main", "Release/Main"])("Where case does not count, a bundle placed in the component %s fails, named as placed", component => withImporter(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        const target = `deb/Debian/trixie/${ component }`;
        const names = await stage(ctx, TRIXIE, { target });

        await expectRefused(ctx, target, names, `${ target }: ${ JSON.stringify(component.split("/")[0]) } cannot be a component, the release has a file of that name`);
    })());

    test("Where case counts, a bundle placed in the component release imports, as the release has only a Release", withImporter(async ctx => {
        setFileNaming(CASE_SENSITIVE);
        const target = "deb/debian/trixie/release";
        const names = await stage(ctx, TRIXIE, { target });

        expect(await importDebian(ctx)).toEqual(expected(target, names, "ok"));

        expect(sources(ctx.db)).toEqual(["release srm-hello 1.0-1"]);
    }));

    test.each(["Release", "InRelease"])("Where case counts, a bundle placed in the component %s fails all the same", component => withImporter(async ctx => {
        setFileNaming(CASE_SENSITIVE);
        const target = `deb/debian/trixie/${ component }`;
        const names = await stage(ctx, TRIXIE, { target });

        await expectRefused(ctx, target, names, `${ target }: "${ component }" cannot be a component, the release has a file of that name`);
    })());

    test.each([CASE_INSENSITIVE, CASE_SENSITIVE])("With %j, a sub-component release is no file of the release and publishes", naming => withImporter(async ctx => {
        setFileNaming(naming);
        const target = "deb/debian/trixie/main/release";
        const names = await stage(ctx, TRIXIE, { target });

        expect(await importDebian(ctx)).toEqual(expected(target, names, "ok"));

        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);
        expect(sources(ctx.db)).toEqual(["main/release srm-hello 1.0-1"]);
    })());

    describe.each([CASE_INSENSITIVE, CASE_SENSITIVE])("With %j", naming => {
        test.each([["source", "source"], ["debug", "debug"], ["by-hash", "by-hash"], ["main/source", "source"], ["main/by-hash", "by-hash"], ["main/debug", "debug"], ["main/debian-installer", "debian-installer"],
            ["main/binary-amd64", "binary-amd64"], ["main/Contents-amd64.gz", "Contents-amd64.gz"], ["a/b/source/c", "source"]])("A bundle placed in the component %s fails, the publish writes that name", (component, name) => withImporter(async ctx => {
            setFileNaming(naming);
            const target = `deb/debian/trixie/${ component }`;
            const names = await stage(ctx, TRIXIE, { target });

            await expectRefused(ctx, target, names, `${ target }: ${ JSON.stringify(name) } cannot be a component, the publish writes that name below a component`);
        })());

        test("A bundle placed in the distribution named as the keyring fails", withImporter(async ctx => {
            setFileNaming(naming);
            const target = "deb/archive-keyring.asc/trixie/main";
            const names = await stage(ctx, TRIXIE, { target });

            await expectRefused(ctx, target, names, `${ target }: "archive-keyring.asc" cannot be a distribution, the format has a keyring of that name`);
        }));
    });

    test("Where case counts, a bundle placed in the sub-component Source imports", withImporter(async ctx => {
        setFileNaming(CASE_SENSITIVE);
        const target = "deb/debian/trixie/main/Source";
        const names = await stage(ctx, TRIXIE, { target });

        expect(await importDebian(ctx)).toEqual(expected(target, names, "ok"));
    }));

    test("Where case does not count, a bundle placed in the sub-component Source fails, named as placed", withImporter(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        const target = "deb/Debian/trixie/main/Source";
        const names = await stage(ctx, TRIXIE, { target });

        await expectRefused(ctx, target, names, `${ target }: "Source" cannot be a component`);
    }));

    test("With short names, a hand-placed release of that shape fails before the catalog commits", withImporter(async ctx => {
        setFileNaming({ caseSensitive: false, shortNames: true });
        const target = "deb/debian/foo~1/main";
        const names = await stage(ctx, TRIXIE, { target, record: false });
        await edit(ctx, `${ target }/${ TRIXIE.changes }`, text => text.replace("Distribution: trixie", "Distribution: foo~1"));

        await expectRefused(ctx, target, names, '"foo~1" has the shape of a Windows 8.3 short name');
    }));

    test("Without short names, a release of that shape imports", withImporter(async ctx => {
        setFileNaming(CASE_SENSITIVE);
        const target = "deb/debian/foo~1/main";
        const names = await stage(ctx, TRIXIE, { target, record: false });
        await edit(ctx, `${ target }/${ TRIXIE.changes }`, text => text.replace("Distribution: trixie", "Distribution: foo~1"));

        expect(await importDebian(ctx)).toEqual(expected(target, names, "ok"));
    }));

    const OTHER_THAN_ASCII = `f${ String.fromCodePoint(0xE9) }dora`;

    test.each([`deb/${ OTHER_THAN_ASCII }/trixie/main`, `deb/debian/${ OTHER_THAN_ASCII }/main`, `deb/debian/trixie/${ OTHER_THAN_ASCII }`, `deb/debian/trixie/main/${ OTHER_THAN_ASCII }`])("Where case does not count, a bundle placed in %s fails", target => withImporter(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        const names = await stage(ctx, TRIXIE, { target });

        await expectRefused(ctx, target, names, `${ OTHER_THAN_ASCII }": ${ NOT_IN_LOWER_CASE }`);
    })());

    test("A problem names the folder as found, not as the repository would hold it", withImporter(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        const target = `deb/Debian/Trixie/${ OTHER_THAN_ASCII }`;
        const names = await stage(ctx, TRIXIE, { target });

        await expectRefused(ctx, target, names, `${ target }: "${ OTHER_THAN_ASCII }": ${ NOT_IN_LOWER_CASE }`);
    }));

    test("A name the platform refuses is named as found, in no path of the repository", withImporter(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        const target = `deb/Debian/Trixie/${ "M".repeat(241) }`;
        const names = await stage(ctx, TRIXIE, { target });

        await expectRefused(ctx, target, names, `"${ "M".repeat(64) }…" is longer than 240 bytes`);
    }));

    test("Where case counts, a bundle placed below a name other than ASCII imports", withImporter(async ctx => {
        setFileNaming(CASE_SENSITIVE);
        const target = `deb/debian/trixie/${ OTHER_THAN_ASCII }`;
        const names = await stage(ctx, TRIXIE, { target });

        expect(await importDebian(ctx)).toEqual(expected(target, names, "ok"));
    }));

    const BUILDINFO_IN_OTHER_CASE = "SRM-hello_1.0-1_amd64.buildinfo";

    /** The trixie bundle again, its .buildinfo under the name in another case and with other content */
    async function stageBuildinfoInOtherCase(ctx: BackendContext): Promise<string[]> {
        const names = await stage(ctx, TRIXIE, { record: false });
        const renamed = stagedPath(ctx, `${ TRIXIE.target }/${ BUILDINFO_IN_OTHER_CASE }`);
        await fs.rename(stagedPath(ctx, `${ TRIXIE.target }/${ BUILDINFO }`), renamed);
        await fs.appendFile(renamed, "Build-Tainted-By:\n rebuilt\n");
        const digests = await hashFile(renamed);
        await edit(ctx, `${ TRIXIE.target }/${ TRIXIE.changes }`, text => relisted(text, BUILDINFO, digests).replaceAll(` ${ BUILDINFO }`, ` ${ BUILDINFO_IN_OTHER_CASE }`));
        await recordAll(ctx, TRIXIE.target);
        return names.map(name => name === BUILDINFO ? BUILDINFO_IN_OTHER_CASE : name).sort();
    }

    test("A listed file differing only in case from a pool file fails the bundle, moves nothing and adds no row", withImporter(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        const original = await stage(ctx, TRIXIE);
        await importDebian(ctx);
        const rows = poolRows(ctx.db);
        const names = await stageBuildinfoInOtherCase(ctx);

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(result)).toEqual([expect.stringContaining(`${ HELLO_POOL }/${ BUILDINFO_IN_OTHER_CASE } differs only in case from ${ HELLO_POOL }/${ BUILDINFO }`)]);
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
        expect(await pooled(ctx)).toEqual(original);
        expect(await hashFile(poolPath(ctx, `${ HELLO_POOL }/${ BUILDINFO }`))).toEqual(await hashFile(osPath.join(TRIXIE.dir, BUILDINFO)));
        expect(poolRows(ctx.db)).toEqual(rows);

        expect((await importDebian(ctx)).map(f => f.status)).toEqual(Array(7).fill("failed"));
    }));

    test("A pool file waiting for garbage collection still conflicts", withImporter(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        const original = await stage(ctx, TRIXIE);
        await importDebian(ctx);
        new DebCatalog(ctx.db).remove({ source: "srm-hello" }, NOW, false);
        const rows = poolRows(ctx.db);
        expect(rows.map(row => row.removed_at)).toEqual(Array(7).fill(NOW));
        const names = await stageBuildinfoInOtherCase(ctx);

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(result)).toEqual([expect.stringContaining(`${ HELLO_POOL }/${ BUILDINFO_IN_OTHER_CASE } differs only in case from ${ HELLO_POOL }/${ BUILDINFO }`)]);
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
        expect(await pooled(ctx)).toEqual(original);
        expect(poolRows(ctx.db)).toEqual(rows);
        expect(sources(ctx.db)).toEqual([]);
    }));

    windowsTest("A .changes listing two names differing only in case fails, moves nothing and adds no row", withImporter(async ctx => {
        const names = await stage(ctx, TRIXIE, { record: false });
        await edit(ctx, `${ TRIXIE.target }/${ TRIXIE.changes }`, text =>
            text.split("\n").flatMap(line => isListLine(line, BUILDINFO) ? [line, line.replace(` ${ BUILDINFO }`, ` ${ BUILDINFO_IN_OTHER_CASE }`)] : [line]).join("\n"));
        await recordAll(ctx, TRIXIE.target);

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(result)).toEqual([expect.stringContaining(`${ BUILDINFO_IN_OTHER_CASE } is neither uploaded nor in the pool`)]);
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
        expect(await pooled(ctx)).toEqual([]);
        expect(count(ctx.db, "pool_files")).toBe(0);
        expect(count(ctx.db, "releases")).toBe(0);
    }));

    test("A .changes naming a staged file in another case fails and leaves the staged file unclaimed", withImporter(async ctx => {
        const doc = "srm-hello-doc_1.0-1_all.deb";
        const names = await stage(ctx, TRIXIE, { record: false });
        await edit(ctx, `${ TRIXIE.target }/${ TRIXIE.changes }`, text => text.replaceAll(` ${ doc }`, " SRM-hello-doc_1.0-1_all.deb"));
        await recordAll(ctx, TRIXIE.target);

        const result = await importDebian(ctx);

        expect(result.find(f => f.filename === TRIXIE.changes)?.reason).toContain("SRM-hello-doc_1.0-1_all.deb is neither uploaded nor in the pool");
        expect(result.find(f => f.filename === doc)?.status).toBe("skipped");
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
        expect(await pooled(ctx)).toEqual([]);
        expect(count(ctx.db, "pool_files")).toBe(0);
    }));

    notWindowsTest("Off Windows names differing only in case are different files", withImporter(async ctx => {
        await stage(ctx, TRIXIE);
        await importDebian(ctx);
        const names = await stageBuildinfoInOtherCase(ctx);

        expect(await importDebian(ctx)).toEqual(expected(TRIXIE.target, names, "ok"));

        expect(await pooled(ctx)).toEqual(expect.arrayContaining([BUILDINFO, BUILDINFO_IN_OTHER_CASE]));
    }));

    test.each<[keyof typeof CONTROL, string]>([
        ["Package", "../../../evil"], ["Package", "-evil"], ["Package", ".evil"], ["Package", "ev il"], ["Package", "Evil"], ["Package", "e"],
        ["Architecture", "../../../evil"], ["Architecture", "-evil"], ["Architecture", "ev il"], ["Architecture", "source"], ["Architecture", "x86_64"],
        ["Version", "../1"], ["Version", "1\\0"], ["Version", "1 0"], ["Version", "1\u00010"], ["Version", ".."],
        ["Source", "../../../evil"], ["Source", "-evil"], ["Source", "ev il"], ["Source", "\"><img>"], ["Source", "ev\u0001il"],
    ])("A .deb with %s %j fails", (name, value) => withImporter(async ctx => {
        const names = await stageWithControl(ctx, { [name]: value });

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(result)).toEqual([expect.stringContaining(`Malformed ${ name } of ${ DEB }: ${ JSON.stringify(value) }`)]);
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
        expect(await fs.readdir(".")).not.toContain("repo");
        expect(count(ctx.db, "releases")).toBe(0);
    })());

    test.each<[string, string, string]>([
        ["another source", "other", `${ DEB } is built from other 1.0-1, not srm-hello 1.0-1`],
        ["another source version", "srm-hello (2.0-1)", `${ DEB } is built from srm-hello 2.0-1, not srm-hello 1.0-1`],
        ["a source version with a slash", "srm-hello (../1)", `Malformed Version of ${ DEB }: "../1"`],
    ])("A .deb of %s fails", (_, source, reason) => withImporter(async ctx => {
        const names = await stageWithControl(ctx, { Source: source });

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(result)).toEqual([expect.stringContaining(reason)]);
    })());

    test("An Architecture starting with udeb- fails, its Contents would be the one of the udebs", withImporter(async ctx => {
        const names = await stageWithControl(ctx, { Architecture: "udeb-amd64" });

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(result)).toEqual([expect.stringContaining(`Malformed Architecture of ${ DEB }: "udeb-amd64"`)]);
        expect(count(ctx.db, "releases")).toBe(0);
    }));

    test("An Architecture too long for the index names fails before anything is recorded", withImporter(async ctx => {
        const names = await stageWithControl(ctx, { Architecture: "a".repeat(224) });

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(result)).toEqual([expect.stringContaining(`Malformed Architecture of ${ DEB }: "Contents-udeb-${ "a".repeat(50) }…" is longer than 240 bytes`)]);
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
        expect(count(ctx.db, "releases")).toBe(0);
    }));

    test("The longest Architecture imports and publishes", withImporter(async ctx => {
        const names = await stageWithControl(ctx, { Architecture: "a".repeat(223) });

        expect(await importDebian(ctx)).toEqual(expected(TRIXIE.target, names, "ok"));
        await publishDebian(ctx);

        expect(await fs.readdir(osPath.join(ctx.paths.repoDir, "deb", "debian", "dists", "trixie", "main"))).toContain(`binary-${ "a".repeat(223) }`);
    }));

    test("A .deb with every character policy allows imports", withImporter(async ctx => {
        const names = await stageWithControl(ctx, { Package: "libstdc++6.1", Version: "1:1.0~rc1+dfsg-1", Architecture: "hurd-i386" });

        expect(await importDebian(ctx)).toEqual(expected(TRIXIE.target, names, "ok"));

        expect(binaries(ctx.db)).toContain("main deb libstdc++6.1 1:1.0~rc1+dfsg-1 hurd-i386 utils");
    }));

    test("A .changes over 16 MiB fails unread", withImporter(async ctx => {
        const names = await stage(ctx, TRIXIE, { record: false });
        await fs.truncate(stagedPath(ctx, `${ TRIXIE.target }/${ TRIXIE.changes }`), 16 * MIB + 1);
        await recordAll(ctx, TRIXIE.target);
        const readFile = jest.spyOn(fs, "readFile");
        let result: ImportFile[];
        let read: string[];
        try {
            result = await importDebian(ctx);
            read = readFile.mock.calls.map(([file]) => String(file));
        } finally {
            readFile.mockRestore();
        }

        expect(read).toEqual([]);
        expect(result.find(f => f.filename === TRIXIE.changes)?.reason).toContain(`${ TRIXIE.changes } holds ${ 16 * MIB + 1 } bytes, over the ${ 16 * MIB } limit`);
        expect(result.filter(f => f.filename !== TRIXIE.changes).map(f => f.status)).toEqual(Array(6).fill("skipped"));
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
        expect(count(ctx.db, "releases")).toBe(0);
    }));

    test("A .dsc over 16 MiB fails unread", withImporter(async ctx => {
        const names = await stage(ctx, TRIXIE, { record: false });
        await fs.truncate(stagedPath(ctx, `${ TRIXIE.target }/${ DSC }`), 16 * MIB + 1);
        const dsc = await hashFile(stagedPath(ctx, `${ TRIXIE.target }/${ DSC }`));
        await edit(ctx, `${ TRIXIE.target }/${ TRIXIE.changes }`, text => relisted(text, DSC, dsc));
        await recordAll(ctx, TRIXIE.target);
        const readFile = jest.spyOn(fs, "readFile");
        let result: ImportFile[];
        let read: string[];
        try {
            result = await importDebian(ctx);
            read = readFile.mock.calls.map(([file]) => String(file));
        } finally {
            readFile.mockRestore();
        }

        expect(read.filter(file => file.endsWith(".dsc"))).toEqual([]);
        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(result)).toEqual([expect.stringContaining(`${ DSC } holds ${ 16 * MIB + 1 } bytes, over the ${ 16 * MIB } limit`)]);
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
        expect(count(ctx.db, "releases")).toBe(0);
    }));

    test("A .deb with a tar header body over the limit fails, naming the file and the entry", withImporter(async ctx => {
        const names = await stage(ctx, TRIXIE, { record: false });
        const deb = `${ TRIXIE.target }/${ DEB }`;
        await fs.writeFile(stagedPath(ctx, deb), debWithControlTar(tarBytes(tarEntry("./PaxHeaders/x", "1".repeat(MIB + 1), "x"), tarEntry("./control", "Package: a\n"))));
        const digests = await hashFile(stagedPath(ctx, deb));
        await edit(ctx, `${ TRIXIE.target }/${ TRIXIE.changes }`, text => relisted(text, DEB, digests));
        await recordAll(ctx, TRIXIE.target);

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(result)).toEqual([expect.stringContaining(`${ DEB }: control.tar: tar entry "./PaxHeaders/x" holds ${ MIB + 1 } bytes, over the ${ MIB } limit`)]);
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
        expect(count(ctx.db, "releases")).toBe(0);
    }));

    test("Two .changes in one directory import in name order", withImporter(async ctx => {
        const amd64 = await stage(ctx, TRIXIE);
        const arm64 = await stage(ctx, ARM64);
        const names = [...amd64, ...arm64].sort();

        expect(await importDebian(ctx)).toEqual(expected(TRIXIE.target, names, "ok"));

        expect(await staged(ctx, TRIXIE.target)).toEqual([]);
        expect(await pooled(ctx)).toEqual(names);
        expect(binaries(ctx.db)).toEqual([
            "main deb srm-hello 1.0-1 amd64 utils", "main deb srm-hello 1.0-1 arm64 utils", "main deb srm-hello-doc 1.0-1 all doc",
        ]);
        expect(uploads(ctx.db)).toEqual(["srm-hello_1.0-1_amd64.changes: all amd64 source", "srm-hello_1.0-1_arm64.changes: arm64"]);
        expect(count(ctx.db, "staged_digests")).toBe(0);
    }));

    test("Nothing staged yields no files", withImporter(async ctx => {
        expect(await importDebian(ctx)).toEqual([]);
        await fs.mkdir(stagedPath(ctx, "deb/debian/trixie"), { recursive: true });
        expect(await importDebian(ctx)).toEqual([]);
    }));
});

describe("Tests for the keys that verify uploads", () => {
    let key: openpgp.PrivateKey;
    let other: openpgp.PrivateKey;

    beforeAll(async () => {
        [key, other] = await Promise.all(["key", "other"].map(async name =>
            (await openpgp.generateKey({ type: "rsa", rsaBits: 2048, userIDs: [{ name }], format: "object" })).privateKey));
    });

    const stagedDir = (ctx: BackendContext): string => stagedPath(ctx, TRIXIE.target);

    test("A bundle signed with one of the keys imports, and the pool keeps the signed files", withImporter(async ctx => {
        ctx.uploadKeys = [other.toPublic(), key.toPublic()];
        const names = await stage(ctx, TRIXIE);
        await signBundle(stagedDir(ctx), key);

        expect(await importDebian(ctx)).toEqual(expected(TRIXIE.target, names, "ok"));

        expect(await fs.readFile(osPath.join(ctx.paths.repoDir, "deb/debian/pool/main/s/srm-hello", TRIXIE.changes), "utf8")).toContain("BEGIN PGP SIGNED MESSAGE");
        expect(sources(ctx.db)).toEqual(["main srm-hello 1.0-1"]);
    }));

    test("An unsigned bundle fails as a whole, moving nothing", withImporter(async ctx => {
        ctx.uploadKeys = [key.toPublic()];
        const names = await stage(ctx, TRIXIE);

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(result)).toEqual([expect.stringContaining(`${ TRIXIE.changes } is not signed`)]);
        expect(await staged(ctx, TRIXIE.target)).toEqual(names);
        expect(count(ctx.db, "releases")).toBe(0);
    }));

    test("A bundle signed with another key fails, naming the key", withImporter(async ctx => {
        ctx.uploadKeys = [key.toPublic()];
        const names = await stage(ctx, TRIXIE);
        await signBundle(stagedDir(ctx), other);

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(result)).toEqual([expect.stringContaining(`${ TRIXIE.changes } is signed by ${ other.getKeyID().toHex() }, none of the keys that verify uploads`)]);
    }));

    test("A signed .changes does not make up for an unsigned .dsc", withImporter(async ctx => {
        ctx.uploadKeys = [key.toPublic()];
        const names = await stage(ctx, TRIXIE);
        const changes = osPath.join(stagedDir(ctx), TRIXIE.changes);
        await fs.writeFile(changes, await clearsign(await fs.readFile(changes, "utf8"), key));

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(result)).toEqual([expect.stringContaining("srm-hello_1.0-1.dsc is not signed")]);
        expect(count(ctx.db, "releases")).toBe(0);
    }));

    test("A .dsc signed with another key fails", withImporter(async ctx => {
        ctx.uploadKeys = [key.toPublic()];
        await stage(ctx, TRIXIE);
        await signBundle(stagedDir(ctx), other);
        const changes = osPath.join(stagedDir(ctx), TRIXIE.changes);
        await fs.writeFile(changes, await clearsign(stripClearsign(await fs.readFile(changes, "utf8")), key));

        expect(reasons(await importDebian(ctx))).toEqual([expect.stringContaining(`srm-hello_1.0-1.dsc is signed by ${ other.getKeyID().toHex() }`)]);
    }));

    test("A .changes with more than its signature covers fails", withImporter(async ctx => {
        ctx.uploadKeys = [key.toPublic()];
        const names = await stage(ctx, TRIXIE);
        await signBundle(stagedDir(ctx), key);
        await fs.appendFile(osPath.join(stagedDir(ctx), TRIXIE.changes), "\nDistribution: bookworm\n");

        const result = await importDebian(ctx);

        expect(result).toEqual(failed(expected(TRIXIE.target, names, "failed")));
        expect(reasons(result)).toEqual([expect.stringContaining(`${ TRIXIE.changes } holds more than its signature covers`)]);
    }));

    test("A signed .changes under the name of another version fails, it could take that version's place", withImporter(async ctx => {
        ctx.uploadKeys = [key.toPublic()];
        await stage(ctx, TRIXIE);
        await signBundle(stagedDir(ctx), key);
        const renamed = "srm-hello_1.1-1_amd64.changes";
        await fs.rename(osPath.join(stagedDir(ctx), TRIXIE.changes), osPath.join(stagedDir(ctx), renamed));

        expect(reasons(await importDebian(ctx))).toEqual([expect.stringContaining(`${ renamed } does not match what it is signed for, a name starting with srm-hello_1.0-1_`)]);
        expect(count(ctx.db, "releases")).toBe(0);
    }));

    test("A failed bundle goes through once its key is there", withImporter(async ctx => {
        ctx.uploadKeys = [other.toPublic()];
        const names = await stage(ctx, TRIXIE);
        await signBundle(stagedDir(ctx), key);
        expect(failed(await importDebian(ctx))).toEqual(failed(expected(TRIXIE.target, names, "failed")));

        ctx.uploadKeys = [key.toPublic()];

        expect(await importDebian(ctx)).toEqual(expected(TRIXIE.target, names, "ok"));
    }));

    test.each([[undefined], [[]]])("With keys %j a signed bundle imports with a warning for each signed file", keys => withImporter(async ctx => {
        ctx.uploadKeys = keys;
        const warn = jest.spyOn(logger, "warn").mockReturnValue(logger);
        const names = await stage(ctx, TRIXIE);
        await signBundle(stagedDir(ctx), other);

        expect(await importDebian(ctx)).toEqual(expected(TRIXIE.target, names, "ok"));

        expect(warn.mock.calls.map(([line]) => line)).toEqual([
            `Could not verify the signature of ${ TRIXIE.changes }: there are no keys to verify uploads with`,
            "Could not verify the signature of srm-hello_1.0-1.dsc: there are no keys to verify uploads with",
        ]);
        warn.mockRestore();
    })());
});
