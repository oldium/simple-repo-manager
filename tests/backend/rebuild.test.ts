import { debWithControl, withLocalTmpDir } from "../utils.ts";
import { jest } from "@jest/globals";
import crypto from "crypto";
import osPath from "path";
import path from "path/posix";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import zlib from "zlib";
import { Database } from "node:sqlite";
import * as openpgp from "openpgp";
import type { BackendContext } from "../../server/backend/context.ts";
import { field, parseControl, parseFileList } from "../../server/backend/control.ts";
import { openDatabase } from "../../server/backend/db.ts";
import { DebCatalog } from "../../server/backend/deb/catalog.ts";
import { importDebian } from "../../server/backend/deb/importer.ts";
import { inspectDeb } from "../../server/backend/deb/inspect.ts";
import { publishDebian } from "../../server/backend/deb/publisher.ts";
import { renderPackagesStanza } from "../../server/backend/deb/stanzas.ts";
import type { SectionPriority } from "../../server/backend/deb/stanzas.ts";
import { GC_GRACE_SECONDS, runGc } from "../../server/backend/gc.ts";
import { hashFile } from "../../server/backend/hash.ts";
import { rebuildFromDisk, removeLeftoverTemps } from "../../server/backend/rebuild/index.ts";
import { RpmCatalog } from "../../server/backend/rpm/catalog.ts";
import { importRpm } from "../../server/backend/rpm/importer.ts";
import { publishRpm } from "../../server/backend/rpm/publisher.ts";
import { NOT_IN_LOWER_CASE, resetFileNaming, setFileNaming } from "../../server/lib/file-naming.ts";
import logger from "../../server/lib/logger.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const GOLDEN = osPath.join(FIXTURES, "golden");
const windowsTest = process.platform === "win32" ? test : test.skip;

const NOW = 1700000000;

type Bundle = { dir: string; pool: string; target: string };

const SRM_HELLO_POOL = "deb/debian/pool/main/s/srm-hello";
const TRIXIE: Bundle = { dir: osPath.join(FIXTURES, "packages", "deb", "debian", "trixie", "main"), pool: SRM_HELLO_POOL, target: "deb/debian/trixie/main" };
const ARM64: Bundle = { dir: osPath.join(FIXTURES, "packages-arm64", "deb", "debian", "trixie", "main"), pool: SRM_HELLO_POOL, target: TRIXIE.target };
const UDEB: Bundle = { dir: osPath.join(FIXTURES, "packages-udeb", "deb", "debian", "trixie", "main"), pool: SRM_HELLO_POOL, target: TRIXIE.target };
const BOOKWORM: Bundle = {
    dir: osPath.join(FIXTURES, "packages", "deb", "debian", "bookworm", "main"), pool: "deb/debian/pool/main/s/srm-gz", target: "deb/debian/bookworm/main",
};
const NOBLE: Bundle = {
    dir: osPath.join(FIXTURES, "packages", "deb", "ubuntu", "noble", "universe"), pool: "deb/ubuntu/pool/universe/s/srm-zst", target: "deb/ubuntu/noble/universe",
};
const RPMS = osPath.join(FIXTURES, "packages", "rpm", "fedora", "42");
const RPM_RELEASE = "rpm/fedora/42";
const RPM_POOL = `${ RPM_RELEASE }/Packages/s/srm-hello`;
const SRC_RPM = "srm-hello-1.0-1.fc42.src.rpm";
const BIN_RPM = "srm-hello-1.0-1.fc42.x86_64.rpm";
const DOC_RPM = "srm-hello-doc-1.0-1.fc42.noarch.rpm";
const AMD64_DEB = "srm-hello_1.0-1_amd64.deb";
const ARM64_DEB = "srm-hello_1.0-1_arm64.deb";
const DOC_DEB = "srm-hello-doc_1.0-1_all.deb";
const STALE_DEB = "srm-hello_0.9-1_amd64.deb";
const KINDS = ["primary", "filelists", "other"] as const;
const CASE_INSENSITIVE = { caseSensitive: false, shortNames: false };
const CASE_SENSITIVE = { caseSensitive: true, shortNames: false };

/** A context without a database: the rebuild owns the database file */
type Ctx = Omit<BackendContext, "db"> & { clock: { now: number } };

type Row = Record<string, unknown>;

let key: openpgp.PrivateKey;

beforeAll(async () => {
    const { privateKey } = await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "t" }], format: "object" });
    key = privateKey;
});

afterEach(() => {
    jest.restoreAllMocks();
    resetFileNaming();
});

function osJoin(root: string, ...posix: string[]): string {
    return osPath.join(root, ...posix.join("/").split("/"));
}

function withTree(fn: (ctx: Ctx) => Promise<void>, o: { signed?: boolean } = {}) {
    return withLocalTmpDir(async () => {
        const clock = { now: NOW };
        await fn({ paths: { incomingDir: "incoming", repoStateDir: "state", repoDir: "repo" }, signingKey: o.signed === false ? undefined : key, now: () => clock.now, clock });
    });
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

async function writeRepoFile(ctx: Ctx, rel: string, data: Buffer | string): Promise<void> {
    const file = repoFile(ctx, rel);
    await fs.mkdir(osPath.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
}

/** Writes a golden index the way reprepro lays it out; returns the paths the native publish will not write again */
async function writeGoldenFile(ctx: Ctx, rel: string, data: Buffer, nested: boolean): Promise<string[]> {
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    if (name === "Packages" || name === "Sources") {
        await writeRepoFile(ctx, rel, data);
        await writeRepoFile(ctx, `${ rel }.gz`, zlib.gzipSync(data));
        return [rel];
    }
    if (name.startsWith("Contents-")) {
        await writeRepoFile(ctx, `${ rel }.gz`, zlib.gzipSync(data));
        return [];
    }
    await writeRepoFile(ctx, rel, data);
    return nested ? [rel] : [];
}

async function writeDists(ctx: Ctx, distro: string, release: string, goldenRel: string): Promise<string[]> {
    const root = osJoin(GOLDEN, goldenRel);
    const leftovers: string[] = [];
    const walk = async (segments: string[]): Promise<void> => {
        for (const entry of await fs.readdir(osJoin(root, ...segments), { withFileTypes: true })) {
            if (entry.isDirectory()) {
                await walk([...segments, entry.name]);
            } else {
                const data = await fs.readFile(osJoin(root, ...segments, entry.name));
                leftovers.push(...await writeGoldenFile(ctx, `deb/${ distro }/dists/${ release }/${ [...segments, entry.name].join("/") }`, data, segments.length > 0));
            }
        }
    };
    await walk([]);
    return leftovers;
}

async function copyBundle(ctx: Ctx, bundle: Bundle, names?: string[]): Promise<void> {
    await fs.mkdir(repoFile(ctx, bundle.pool), { recursive: true });
    for (const name of names ?? await fs.readdir(bundle.dir)) {
        await fs.copyFile(osPath.join(bundle.dir, name), repoFile(ctx, `${ bundle.pool }/${ name }`));
    }
}

async function binaryStanza(file: string, filename: string, sp: SectionPriority): Promise<string> {
    const { control } = await inspectDeb(file, false);
    const d = await hashFile(file);
    return renderPackagesStanza(control, { filename, size: d.size, md5: d.md5, sha256: d.sha256 }, sp);
}

function sha256(data: Buffer): string {
    return crypto.createHash("sha256").update(data).digest("hex");
}

/** The x86_64 rpm built from NetworkManager; a SOURCERPM of the same length keeps the header readable */
async function networkManagerRpm(): Promise<Buffer> {
    const bytes = await fs.readFile(osPath.join(RPMS, BIN_RPM));
    bytes.write("NetworkManager-1-1.1.src.rpm", bytes.indexOf(SRC_RPM), "latin1");
    return bytes;
}

/** The fixtures in both layouts below the release, plus createrepo_c's repodata; returns the old metadata paths */
async function writeRpmTree(ctx: Ctx): Promise<string[]> {
    for (const name of [SRC_RPM, BIN_RPM]) {
        await fs.mkdir(repoFile(ctx, `${ RPM_RELEASE }/Packages/s`), { recursive: true });
        await fs.copyFile(osPath.join(RPMS, name), repoFile(ctx, `${ RPM_RELEASE }/Packages/s/${ name }`));
    }
    await fs.mkdir(repoFile(ctx, RPM_POOL), { recursive: true });
    await fs.copyFile(osPath.join(RPMS, DOC_RPM), repoFile(ctx, `${ RPM_POOL }/${ DOC_RPM }`));
    const leftovers: string[] = [];
    for (const kind of KINDS) {
        const data = zlib.gzipSync(await fs.readFile(osJoin(GOLDEN, `rpm/fedora/42/repodata/${ kind }.xml`)));
        const rel = `${ RPM_RELEASE }/repodata/${ sha256(data) }-${ kind }.xml.gz`;
        await writeRepoFile(ctx, rel, data);
        leftovers.push(rel);
    }
    await writeRepoFile(ctx, `${ RPM_RELEASE }/repodata/repomd.xml`, await fs.readFile(osJoin(GOLDEN, "rpm/fedora/42/repodata/repomd.xml")));
    return leftovers;
}

/**
 * A tree as reprepro and createrepo_c left it: trixie with the udeb and an arm64 build, forky listing trixie's files again,
 * bookworm without its .changes, noble with an epoch and a ddeb, a package nothing lists, and reprepro's own state.
 */
async function writeRepreproTree(ctx: Ctx): Promise<string[]> {
    const leftovers = [
        ...await writeDists(ctx, "debian", "trixie", "udeb/deb/debian/dists/trixie"),
        ...await writeDists(ctx, "debian", "forky", "deb/debian/dists/trixie"),
        ...await writeDists(ctx, "debian", "bookworm", "deb/debian/dists/bookworm"),
        ...await writeDists(ctx, "ubuntu", "noble", "deb/ubuntu/dists/noble"),
    ];
    const arm64 = [
        await binaryStanza(osPath.join(ARM64.dir, ARM64_DEB), `pool/main/s/srm-hello/${ ARM64_DEB }`, { section: "utils", priority: "optional" }),
        await binaryStanza(osPath.join(TRIXIE.dir, DOC_DEB), `pool/main/s/srm-hello/${ DOC_DEB }`, { section: "doc", priority: "optional" }),
    ];
    leftovers.push(...await writeGoldenFile(ctx, "deb/debian/dists/trixie/main/binary-arm64/Packages", Buffer.from(arm64.join("\n")), true));
    for (const bundle of [TRIXIE, ARM64, UDEB, NOBLE]) {
        await copyBundle(ctx, bundle);
    }
    await copyBundle(ctx, BOOKWORM, (await fs.readdir(BOOKWORM.dir)).filter(name => !name.endsWith(".changes") && !name.endsWith(".buildinfo")));
    await fs.copyFile(osPath.join(TRIXIE.dir, AMD64_DEB), repoFile(ctx, `${ SRM_HELLO_POOL }/${ STALE_DEB }`));
    leftovers.push(...await writeRpmTree(ctx));
    await fs.mkdir(osJoin(ctx.paths.repoStateDir, "deb-debian", "conf"), { recursive: true });
    await fs.writeFile(osJoin(ctx.paths.repoStateDir, "deb-debian", "conf", "distributions"), "Codename: trixie\n");
    return leftovers.sort();
}

async function stage(ctx: Ctx, bundle: Bundle): Promise<void> {
    const dir = osJoin(ctx.paths.incomingDir, "process", bundle.target);
    await fs.mkdir(dir, { recursive: true });
    for (const name of await fs.readdir(bundle.dir)) {
        await fs.copyFile(osPath.join(bundle.dir, name), osPath.join(dir, name));
    }
}

async function stageRpms(ctx: Ctx): Promise<void> {
    const dir = osJoin(ctx.paths.incomingDir, "process", RPM_RELEASE);
    await fs.mkdir(dir, { recursive: true });
    for (const name of [SRC_RPM, BIN_RPM, DOC_RPM]) {
        await fs.copyFile(osPath.join(RPMS, name), osPath.join(dir, name));
    }
}

/** Every file below the directory with its content hash; the state the rebuild must not touch on failure */
async function treeDigests(dir: string): Promise<Record<string, string>> {
    const digests: Record<string, string> = {};
    const walk = async (segments: string[]): Promise<void> => {
        let entries;
        try {
            entries = await fs.readdir(osPath.join(dir, ...segments), { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                await walk([...segments, entry.name]);
            } else {
                digests[[...segments, entry.name].join("/")] = sha256(await fs.readFile(osPath.join(dir, ...segments, entry.name)));
            }
        }
    };
    await walk([]);
    return digests;
}

function rows(db: Database, sql: string): Row[] {
    return db.prepare(sql).all() as Row[];
}

const SOURCES = `
    SELECT r.distro, r.name AS release, s.component, s.source, s.version FROM deb_sources s JOIN releases r ON r.id = s.release_id
        ORDER BY r.distro, r.name, s.component, s.sort_key`;
const BINARIES = `
    SELECT r.distro, r.name AS release, b.component, b.kind, b.package, b.version, b.architecture, b.source, b.source_version, b.section, p.path
        FROM deb_binaries b JOIN releases r ON r.id = b.release_id JOIN pool_files p ON p.id = b.file_id ORDER BY r.distro, r.name, b.sort_key, b.kind`;
const UPLOADS = `
    SELECT r.distro, r.name AS release, u.source, u.version, u.changes_name, u.architectures,
        (SELECT group_concat(p.path, ' ' ORDER BY p.path) FROM deb_upload_files uf JOIN pool_files p ON p.id = uf.file_id WHERE uf.upload_id = u.id) AS files
        FROM deb_uploads u JOIN releases r ON r.id = u.release_id ORDER BY r.distro, r.name, u.changes_name`;
const SUPERSEDED = "SELECT path, superseded_at FROM superseded_files ORDER BY path";
const CELLS = `
    SELECT r.format, r.distro, r.name AS release, i.kind, i.component, i.architecture FROM index_files i JOIN releases r ON r.id = i.release_id
        ORDER BY r.format, r.distro, r.name, i.component, i.kind, i.architecture`;
const RPM_PACKAGES = `
    SELECT r.distro, r.name AS release, k.filename, k.name, k.arch, k.source_name, k.source_version, p.path
        FROM rpm_packages k JOIN releases r ON r.id = k.release_id JOIN pool_files p ON p.id = k.file_id ORDER BY r.distro, r.name, k.sort_key`;
const INDEX_FILES = `
    SELECT r.format, r.distro, r.name AS release, i.kind, i.component, i.architecture, i.generation, i.stored_path, i.size, i.md5, i.sha256,
        i.raw_size, i.raw_md5, i.raw_sha256 FROM index_files i JOIN releases r ON r.id = i.release_id
        ORDER BY r.format, r.distro, r.name, i.component, i.kind, i.architecture`;

/** Everything a rebuild must reproduce, keyed by natural keys rather than row ids */
function snapshot(db: Database): Record<string, Row[]> {
    return {
        releases: rows(db, "SELECT format, distro, name, published_date, origin, description FROM releases ORDER BY format, distro, name"),
        pool: rows(db, "SELECT path, size, md5, sha1, sha256, sha512, removed_at FROM pool_files ORDER BY path"),
        sources: rows(db, `
            SELECT r.distro, r.name AS release, s.component, s.source, s.version, s.sort_key, s.stanza,
                (SELECT group_concat(p.path, ' ' ORDER BY p.path) FROM deb_source_files sf JOIN pool_files p ON p.id = sf.file_id WHERE sf.source_id = s.id) AS files
                FROM deb_sources s JOIN releases r ON r.id = s.release_id ORDER BY r.distro, r.name, s.component, s.sort_key`),
        binaries: rows(db, `
            SELECT r.distro, r.name AS release, b.component, b.kind, b.package, b.version, b.architecture, b.source, b.source_version, b.section,
                b.sort_key, b.stanza, p.path, (SELECT group_concat(bp.path, ' ' ORDER BY bp.path) FROM deb_binary_paths bp WHERE bp.binary_id = b.id) AS paths
                FROM deb_binaries b JOIN releases r ON r.id = b.release_id JOIN pool_files p ON p.id = b.file_id ORDER BY r.distro, r.name, b.sort_key, b.kind`),
        uploads: rows(db, UPLOADS),
        rpm: rows(db, `
            SELECT r.distro, r.name AS release, k.filename, k.name, k.epoch, k.version, k.rel, k.arch, k.source_name, k.source_version, k.sort_key, p.path,
                k.primary_xml, k.filelists_xml, k.other_xml FROM rpm_packages k JOIN releases r ON r.id = k.release_id JOIN pool_files p ON p.id = k.file_id
                ORDER BY r.distro, r.name, k.sort_key`),
        indexes: rows(db, INDEX_FILES),
        superseded: rows(db, SUPERSEDED),
    };
}

async function withDatabase<T>(file: string, fn: (db: Database) => T | Promise<T>): Promise<T> {
    const db = openDatabase(file);
    try {
        return await fn(db);
    } finally {
        db.close();
    }
}

async function readIndex(ctx: Ctx, rel: string): Promise<string> {
    return zlib.gunzipSync(await fs.readFile(repoFile(ctx, rel))).toString("utf8");
}

async function golden(rel: string): Promise<string> {
    return fs.readFile(osJoin(GOLDEN, rel), "utf8");
}

function withoutWeakHashes(text: string): string {
    return text.split("\n").filter(line => !line.startsWith("SHA1: ") && !line.startsWith("SHA512: ")).join("\n");
}

async function stateFiles(ctx: Ctx, prefix: string): Promise<string[]> {
    try {
        return (await fs.readdir(ctx.paths.repoStateDir)).filter(name => name.startsWith(prefix)).sort();
    } catch {
        return [];
    }
}

/** reprepro's uncompressed indexes, at names the native Release lists too */
function atListedName(path: string): boolean {
    return path.endsWith("/Packages") || path.endsWith("/Sources");
}

/** A tree this backend published, every package removed again and the freed pool files deleted; returns its cells */
async function writeEmptiedTree(ctx: Ctx): Promise<Row[]> {
    await fs.mkdir(ctx.paths.repoStateDir);
    return withDatabase(osJoin(ctx.paths.repoStateDir, "repo.db"), async db => {
        const full: BackendContext = { ...ctx, db };
        for (const bundle of [TRIXIE, ARM64, UDEB]) {
            await stage(ctx, bundle);
        }
        await stageRpms(ctx);
        expect((await importDebian(full)).filter(f => f.status !== "ok")).toEqual([]);
        expect((await importRpm(full)).filter(f => f.status !== "ok")).toEqual([]);
        await publishDebian(full);
        await publishRpm(full);
        const freed = [
            ...new DebCatalog(db).remove({ source: "srm-hello" }, ctx.now(), true).deleteNow,
            ...new RpmCatalog(db).remove({ source: "srm-hello" }, ctx.now(), true).deleteNow,
        ];
        expect(freed.length).toBeGreaterThan(0);
        await publishDebian(full);
        await publishRpm(full);
        for (const rel of freed) {
            await fs.unlink(repoFile(ctx, rel));
        }
        return rows(db, CELLS);
    });
}

/**
 * What apt can fetch: every name Release lists with its digests (a raw name through its .gz, the only one written), the
 * by-hash names of the .gz, and the pool files the indexes list. Returns the files read.
 */
async function debClientView(ctx: Ctx, distro: string, release: string): Promise<string[]> {
    const dists = `deb/${ distro }/dists/${ release }`;
    const read: string[] = [`${ dists }/Release`];
    const check = async (rel: string, digest: string, size: number): Promise<void> => {
        const data = await fs.readFile(repoFile(ctx, rel));
        expect({ rel, sha256: sha256(data), size: data.length }).toEqual({ rel, sha256: digest, size });
        read.push(rel);
    };
    const [stanza] = parseControl(await fs.readFile(repoFile(ctx, `${ dists }/Release`), "utf8"));
    const listed = parseFileList(field(stanza, "SHA256")!, false);
    const md5 = new Map(parseFileList(field(stanza, "MD5Sum")!, false).map(f => [f.name, f.hash]));
    expect(listed.length).toBeGreaterThan(0);
    for (const f of listed.filter(f => f.name.endsWith(".gz"))) {
        const dir = f.name.slice(0, f.name.lastIndexOf("/"));
        for (const name of [f.name, `${ dir }/by-hash/SHA256/${ f.hash }`, `${ dir }/by-hash/MD5Sum/${ md5.get(f.name) }`]) {
            await check(`${ dists }/${ name }`, f.hash, f.size);
        }
    }
    for (const f of listed.filter(f => !f.name.endsWith(".gz"))) {
        const raw = zlib.gunzipSync(await fs.readFile(repoFile(ctx, `${ dists }/${ f.name }.gz`)));
        expect({ name: f.name, sha256: sha256(raw), size: raw.length }).toEqual({ name: f.name, sha256: f.hash, size: f.size });
        for (const entry of f.name.endsWith("/Packages") || f.name.endsWith("/Sources") ? parseControl(raw.toString("utf8")) : []) {
            if (f.name.endsWith("/Packages")) {
                await check(`deb/${ distro }/${ field(entry, "Filename")! }`, field(entry, "SHA256")!, Number(field(entry, "Size")));
            } else {
                for (const file of parseFileList(field(entry, "Checksums-Sha256")!, false)) {
                    await check(`deb/${ distro }/${ field(entry, "Directory")! }/${ file.name }`, file.hash, file.size);
                }
            }
        }
    }
    return [...new Set(read)].sort();
}

function between(text: string, open: string, close: string): string {
    const from = text.indexOf(open) + open.length;
    return text.slice(from, text.indexOf(close, from));
}

/** What dnf can fetch: the metadata repomd.xml lists with its digests and the packages primary lists. Returns the files read. */
async function rpmClientView(ctx: Ctx, distro: string, release: string): Promise<string[]> {
    const base = `rpm/${ distro }/${ release }`;
    const read: string[] = [`${ base }/repodata/repomd.xml`];
    const repomd = await fs.readFile(repoFile(ctx, `${ base }/repodata/repomd.xml`), "utf8");
    const blocks = repomd.split('<data type="').slice(1);
    expect(blocks.map(block => block.slice(0, block.indexOf('"')))).toEqual(["primary", "filelists", "other"]);
    for (const block of blocks) {
        const rel = `${ base }/${ between(block, '<location href="', '"') }`;
        const data = await fs.readFile(repoFile(ctx, rel));
        expect({ rel, sha256: sha256(data) }).toEqual({ rel, sha256: between(block, '<checksum type="sha256">', "<") });
        const raw = zlib.zstdDecompressSync(data);
        expect(sha256(raw)).toBe(between(block, '<open-checksum type="sha256">', "<"));
        read.push(rel);
        for (const pkg of block.startsWith('primary"') ? raw.toString("utf8").split("<package ").slice(1) : []) {
            const location = `${ base }/${ between(pkg, '<location href="', '"') }`;
            expect({ location, sha256: sha256(await fs.readFile(repoFile(ctx, location))) }).toEqual({ location, sha256: between(pkg, 'pkgid="YES">', "<") });
            read.push(location);
        }
    }
    return read.sort();
}

function hello(release: string, pkg: string, architecture: string, kind: string, section: string, file: string): Row {
    return { distro: "debian", release, component: "main", kind, package: pkg, version: "1.0-1", architecture, source: "srm-hello", source_version: "1.0-1", section, path: `${ SRM_HELLO_POOL }/${ file }` };
}

function helloUpload(release: string, name: string, architectures: string): Row {
    const stem = name.slice(0, -".changes".length);
    return { distro: "debian", release, source: "srm-hello", version: "1.0-1", changes_name: name, architectures, files: `${ SRM_HELLO_POOL }/${ stem }.buildinfo ${ SRM_HELLO_POOL }/${ name }` };
}

describe("Tests for rebuildFromDisk", () => {
    test("Rebuilds sources, binaries and uploads from a reprepro tree", withTree(async ctx => {
        const leftovers = await writeRepreproTree(ctx);
        const warn = jest.spyOn(logger, "warn").mockReturnValue(logger);

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        expect(await stateFiles(ctx, "repo.db")).toEqual(["repo.db"]);
        expect(await fs.readFile(osJoin(ctx.paths.repoStateDir, "deb-debian", "conf", "distributions"), "utf8")).toBe("Codename: trixie\n");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${ SRM_HELLO_POOL }/${ STALE_DEB }`));
        expect(await exists(repoFile(ctx, `${ SRM_HELLO_POOL }/${ STALE_DEB }`))).toBe(true);
        await withDatabase(osJoin(ctx.paths.repoStateDir, "repo.db"), db => {
            expect(rows(db, SOURCES)).toEqual([
                { distro: "debian", release: "bookworm", component: "main", source: "srm-gz", version: "0.1-1" },
                { distro: "debian", release: "forky", component: "main", source: "srm-hello", version: "1.0-1" },
                { distro: "debian", release: "trixie", component: "main", source: "srm-hello", version: "1.0-1" },
                { distro: "ubuntu", release: "noble", component: "universe", source: "srm-zst", version: "2:3.0-1" },
            ]);
            expect(rows(db, BINARIES)).toEqual([
                {
                    distro: "debian", release: "bookworm", component: "main", kind: "deb", package: "srm-gz", version: "0.1-1", architecture: "amd64",
                    source: "srm-gz", source_version: "0.1-1", section: "misc", path: `${ BOOKWORM.pool }/srm-gz_0.1-1_amd64.deb`,
                },
                hello("forky", "srm-hello", "amd64", "deb", "utils", AMD64_DEB),
                hello("forky", "srm-hello-doc", "all", "deb", "doc", DOC_DEB),
                hello("trixie", "srm-hello", "amd64", "deb", "utils", AMD64_DEB),
                hello("trixie", "srm-hello", "arm64", "deb", "utils", ARM64_DEB),
                hello("trixie", "srm-hello-doc", "all", "deb", "doc", DOC_DEB),
                hello("trixie", "srm-hello-udeb", "amd64", "udeb", "debian-installer", "srm-hello-udeb_1.0-1_amd64.udeb"),
                {
                    distro: "ubuntu", release: "noble", component: "universe", kind: "deb", package: "srm-zst", version: "2:3.0-1", architecture: "amd64",
                    source: "srm-zst", source_version: "2:3.0-1", section: "utils", path: `${ NOBLE.pool }/srm-zst_3.0-1_amd64.deb`,
                },
                {
                    distro: "ubuntu", release: "noble", component: "universe", kind: "ddeb", package: "srm-zst-dbgsym", version: "2:3.0-1", architecture: "amd64",
                    source: "srm-zst", source_version: "2:3.0-1", section: "debug", path: `${ NOBLE.pool }/srm-zst-dbgsym_3.0-1_amd64.ddeb`,
                },
            ]);
            // Every .changes of the source version is an upload of each release listing it; a version without one gets an upload named after it
            expect(rows(db, UPLOADS)).toEqual([
                { distro: "debian", release: "bookworm", source: "srm-gz", version: "0.1-1", changes_name: "srm-gz_0.1-1", architectures: "amd64 source", files: null },
                helloUpload("forky", "srm-hello-udeb_1.0-1_amd64.changes", "amd64"),
                helloUpload("forky", "srm-hello_1.0-1_amd64.changes", "all amd64 source"),
                helloUpload("forky", "srm-hello_1.0-1_arm64.changes", "arm64"),
                helloUpload("trixie", "srm-hello-udeb_1.0-1_amd64.changes", "amd64"),
                helloUpload("trixie", "srm-hello_1.0-1_amd64.changes", "all amd64 source"),
                helloUpload("trixie", "srm-hello_1.0-1_arm64.changes", "arm64"),
                {
                    distro: "ubuntu", release: "noble", source: "srm-zst", version: "2:3.0-1", changes_name: "srm-zst_3.0-1_amd64.changes", architectures: "amd64 source",
                    files: `${ NOBLE.pool }/srm-zst_3.0-1_amd64.buildinfo ${ NOBLE.pool }/srm-zst_3.0-1_amd64.changes`,
                },
            ]);
            expect(rows(db, SUPERSEDED)).toEqual(leftovers.filter(path => !atListedName(path)).map(path => ({ path, superseded_at: NOW })));
        });
        for (const path of leftovers.filter(atListedName)) {
            expect(await exists(repoFile(ctx, path))).toBe(false);
        }
        expect(await exists(repoFile(ctx, "deb/debian/dists/trixie/InRelease"))).toBe(true);
        expect(withoutWeakHashes(await readIndex(ctx, "deb/debian/dists/trixie/main/binary-amd64/Packages.gz")))
            .toBe(withoutWeakHashes(await golden("udeb/deb/debian/dists/trixie/main/binary-amd64/Packages")));
        expect(withoutWeakHashes(await readIndex(ctx, "deb/debian/dists/trixie/main/debian-installer/binary-amd64/Packages.gz")))
            .toBe(withoutWeakHashes(await golden("udeb/deb/debian/dists/trixie/main/debian-installer/binary-amd64/Packages")));
        expect(await readIndex(ctx, "deb/debian/dists/trixie/main/source/Sources.gz")).toBe(await golden("udeb/deb/debian/dists/trixie/main/source/Sources"));
        expect(await readIndex(ctx, "deb/debian/dists/trixie/main/Contents-amd64.gz")).toBe(await golden("udeb/deb/debian/dists/trixie/main/Contents-amd64"));
        expect(await readIndex(ctx, "deb/debian/dists/trixie/main/Contents-udeb-amd64.gz")).toBe(await golden("udeb/deb/debian/dists/trixie/main/Contents-udeb-amd64"));
        expect(withoutWeakHashes(await readIndex(ctx, "deb/debian/dists/bookworm/main/binary-amd64/Packages.gz")))
            .toBe(withoutWeakHashes(await golden("deb/debian/dists/bookworm/main/binary-amd64/Packages")));
        expect(await readIndex(ctx, "deb/debian/dists/bookworm/main/source/Sources.gz")).toBe(await golden("deb/debian/dists/bookworm/main/source/Sources"));
        expect(withoutWeakHashes(await readIndex(ctx, "deb/ubuntu/dists/noble/universe/binary-amd64/Packages.gz")))
            .toBe(withoutWeakHashes(await golden("deb/ubuntu/dists/noble/universe/binary-amd64/Packages")));
        expect(withoutWeakHashes(await readIndex(ctx, "deb/ubuntu/dists/noble/universe/debug/binary-amd64/Packages.gz")))
            .toBe(withoutWeakHashes(await golden("deb/ubuntu/dists/noble/universe/debug/binary-amd64/Packages")));
        expect(await readIndex(ctx, "deb/ubuntu/dists/noble/universe/source/Sources.gz")).toBe(await golden("deb/ubuntu/dists/noble/universe/source/Sources"));
    }));

    test("A leftover at a name the new Release lists is deleted, the other leftovers are superseded", withTree(async ctx => {
        const dists = "deb/debian/dists/trixie";
        const leftovers = await writeDists(ctx, "debian", "trixie", dists);
        await copyBundle(ctx, TRIXIE);
        const stale = `${ dists }/main/binary-amd64/Packages`;
        const staleSha256 = sha256(await fs.readFile(repoFile(ctx, stale)));

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        const [release] = parseControl(await fs.readFile(repoFile(ctx, `${ dists }/Release`), "utf8"));
        const listed = parseFileList(field(release, "SHA256")!, false);
        const md5 = new Map(parseFileList(field(release, "MD5Sum")!, false).map(f => [f.name, f.hash]));
        // reprepro's Packages carries SHA1 and SHA512 lines that the native one drops
        const listedSha256 = listed.find(f => f.name === "main/binary-amd64/Packages")?.hash;
        expect(listedSha256).toBeDefined();
        expect(listedSha256).not.toBe(staleSha256);
        expect(await exists(repoFile(ctx, stale))).toBe(false);
        const superseded = leftovers.filter(path => !listed.some(f => `${ dists }/${ f.name }` === path)).sort();
        expect(superseded).toEqual([`${ dists }/main/binary-amd64/Release`, `${ dists }/main/source/Release`]);
        await withDatabase(osJoin(ctx.paths.repoStateDir, "repo.db"), db => {
            expect(rows(db, SUPERSEDED)).toEqual(superseded.map(path => ({ path, superseded_at: NOW })));
        });
        // Everything else below dists/ is what the publish wrote, intact
        const published = new Set(["Release", "InRelease", "Release.gpg"]);
        for (const f of listed.filter(f => f.name.endsWith(".gz"))) {
            const dir = f.name.slice(0, f.name.lastIndexOf("/"));
            for (const name of [f.name, `${ dir }/by-hash/SHA256/${ f.hash }`, `${ dir }/by-hash/MD5Sum/${ md5.get(f.name) }`]) {
                published.add(name);
            }
            expect(sha256(await fs.readFile(repoFile(ctx, `${ dists }/${ f.name }`)))).toBe(f.hash);
        }
        expect(Object.keys(await treeDigests(repoFile(ctx, dists))).sort())
            .toEqual([...published, ...superseded.map(path => path.slice(dists.length + 1))].sort());
    }));

    test("Digest mismatch and missing pool file are reported and abort without touching disk", withTree(async ctx => {
        await writeRepreproTree(ctx);
        const corrupt = repoFile(ctx, `${ SRM_HELLO_POOL }/${ AMD64_DEB }`);
        const data = await fs.readFile(corrupt);
        data[data.length - 1] ^= 0xff;
        await fs.writeFile(corrupt, data);
        await fs.unlink(repoFile(ctx, `${ BOOKWORM.pool }/srm-gz_0.1.orig.tar.gz`));
        const before = { repo: await treeDigests(ctx.paths.repoDir), state: await treeDigests(ctx.paths.repoStateDir) };

        const result = await rebuildFromDisk(ctx);

        expect(result.ok).toBe(false);
        expect(result.ok ? [] : [...result.problems].sort()).toEqual([
            `${ BOOKWORM.pool }/srm-gz_0.1.orig.tar.gz: missing, listed in deb/debian/dists/bookworm/main/source/Sources.gz`,
            `${ SRM_HELLO_POOL }/${ AMD64_DEB }: SHA256 does not match deb/debian/dists/forky/main/binary-amd64/Packages.gz`,
            `${ SRM_HELLO_POOL }/${ AMD64_DEB }: SHA256 does not match deb/debian/dists/trixie/main/binary-amd64/Packages.gz`,
        ]);
        expect({ repo: await treeDigests(ctx.paths.repoDir), state: await treeDigests(ctx.paths.repoStateDir) }).toEqual(before);
        expect(await stateFiles(ctx, "repo.db")).toEqual([]);
    }));

    test("Two .changes of one scope would retire the first's files, which is a problem, not a loss", withTree(async ctx => {
        await writeRepreproTree(ctx);
        const second = "srm-hello_1.0-1_second.changes";
        await fs.copyFile(repoFile(ctx, `${ SRM_HELLO_POOL }/srm-hello_1.0-1_amd64.changes`), repoFile(ctx, `${ SRM_HELLO_POOL }/${ second }`));
        const before = await treeDigests(ctx.paths.repoDir);

        const result = await rebuildFromDisk(ctx);

        expect(result.ok ? [] : [...result.problems].sort()).toEqual(["forky", "trixie"].map(release =>
            `deb/debian/dists/${ release }/main: srm-hello 1.0-1: ${ second } would unreference ${ SRM_HELLO_POOL }/srm-hello_1.0-1_amd64.changes`));
        expect(await treeDigests(ctx.paths.repoDir)).toEqual(before);
        expect(await stateFiles(ctx, "repo.db")).toEqual([]);
    }));

    test("A version in two components of one release is a problem even when another release shares its files", withTree(async ctx => {
        await writeDists(ctx, "debian", "trixie", "deb/debian/dists/trixie");
        for (const [release, index] of [["trixie", "binary-amd64/Packages"], ["trixie", "source/Sources"], ["forky", "binary-amd64/Packages"], ["forky", "source/Sources"]]) {
            await writeGoldenFile(ctx, `deb/debian/dists/${ release }/contrib/${ index }`, await fs.readFile(osJoin(GOLDEN, `deb/debian/dists/trixie/main/${ index }`)), true);
        }
        await copyBundle(ctx, TRIXIE);
        const before = await treeDigests(ctx.paths.repoDir);

        const result = await rebuildFromDisk(ctx);

        expect(result).toEqual({ ok: false, problems: ["deb/debian/dists/trixie: srm-hello 1.0-1 is in components contrib, main"] });
        expect(await treeDigests(ctx.paths.repoDir)).toEqual(before);
        expect(await stateFiles(ctx, "repo.db")).toEqual([]);
    }));

    test.each<[string, string]>([
        ["Package", "../../../evil"], ["Architecture", "../../../evil"], ["Architecture", "source"], ["Architecture", "ev il"], ["Version", "1/0"],
    ])("A pool .deb with %s %s is a problem, not a throw", (name, value) => withTree(async ctx => {
        const data = debWithControl({ Package: "srm-hello", Source: "srm-hello (1.0-1)", Version: "1.0-1", Architecture: "amd64", Maintainer: "x", Description: "x", [name]: value });
        await writeRepoFile(ctx, `${ SRM_HELLO_POOL }/evil.deb`, data);
        await writeRepoFile(ctx, "deb/debian/dists/trixie/main/binary-amd64/Packages",
            `Package: srm-hello\nSource: srm-hello (1.0-1)\nVersion: 1.0-1\nArchitecture: amd64\nFilename: pool/main/s/srm-hello/evil.deb\nSize: ${ data.length }\nSHA256: ${ sha256(data) }\n`);
        const before = await treeDigests(ctx.paths.repoDir);

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: [`${ SRM_HELLO_POOL }/evil.deb: Malformed ${ name } of evil.deb: ${ JSON.stringify(value) }`] });

        expect(await treeDigests(ctx.paths.repoDir)).toEqual(before);
        expect(await stateFiles(ctx, "repo.db")).toEqual([]);
    })());

    test("A pool .dsc with a Source that climbs out of the pool is a problem, not a throw", withTree(async ctx => {
        const dsc = Buffer.from("Source: ../../../evil\nVersion: 1.0-1\nFiles:\nChecksums-Sha256:\n");
        await writeRepoFile(ctx, `${ SRM_HELLO_POOL }/evil.dsc`, dsc);
        await writeRepoFile(ctx, "deb/debian/dists/trixie/main/source/Sources",
            `Package: ../../../evil\nVersion: 1.0-1\nDirectory: pool/main/s/srm-hello\nChecksums-Sha256:\n ${ sha256(dsc) } ${ dsc.length } evil.dsc\n`);
        const before = await treeDigests(ctx.paths.repoDir);

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: [`${ SRM_HELLO_POOL }/evil.dsc: Malformed Source of evil.dsc: "../../../evil"`] });

        expect(await treeDigests(ctx.paths.repoDir)).toEqual(before);
        expect(await stateFiles(ctx, "repo.db")).toEqual([]);
    }));

    test("A hostile source in an index alone is reported escaped", withTree(async ctx => {
        const data = debWithControl({ Package: "srm-hello", Source: "srm-hello (1.0-1)", Version: "1.0-1", Architecture: "amd64", Maintainer: "x", Description: "x" });
        await writeRepoFile(ctx, `${ SRM_HELLO_POOL }/evil.deb`, data);
        await writeRepoFile(ctx, "deb/debian/dists/trixie/main/binary-amd64/Packages",
            `Package: srm-hello\nSource: ev\u0001il (1.0-1)\nVersion: 1.0-1\nArchitecture: amd64\nFilename: pool/main/s/srm-hello/evil.deb\nSize: ${ data.length }\nSHA256: ${ sha256(data) }\n`);
        const dsc = Buffer.from("Source: srm-hello\nVersion: 1.0-1\nFiles:\nChecksums-Sha256:\n");
        await writeRepoFile(ctx, `${ SRM_HELLO_POOL }/evil.dsc`, dsc);
        await writeRepoFile(ctx, "deb/debian/dists/trixie/main/source/Sources",
            `Package: ev\u0001il\nVersion: 1.0-1\nDirectory: pool/main/s/srm-hello\nChecksums-Sha256:\n ${ sha256(dsc) } ${ dsc.length } evil.dsc\n`);

        expect(await rebuildFromDisk(ctx)).toEqual({
            ok: false, problems: [`${ SRM_HELLO_POOL }/evil.deb: Malformed Source of evil.deb: "ev\\u0001il"`, `${ SRM_HELLO_POOL }/evil.dsc: Malformed Source of evil.dsc: "ev\\u0001il"`],
        });
    }));

    test("An .rpm with a source name that climbs out of the pool is a problem, not a throw", withTree(async ctx => {
        const data = await fs.readFile(osPath.join(RPMS, BIN_RPM));
        data.write("../../evi", data.indexOf(SRC_RPM), "latin1");
        await writeRepoFile(ctx, `${ RPM_RELEASE }/Packages/s/${ BIN_RPM }`, data);
        const before = await treeDigests(ctx.paths.repoDir);

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: [`${ RPM_RELEASE }/Packages/s/${ BIN_RPM }: Malformed source name: "../../evi"`] });

        expect(await treeDigests(ctx.paths.repoDir)).toEqual(before);
        expect(await stateFiles(ctx, "repo.db")).toEqual([]);
    }));

    test.each<[string, (text: string) => string, string]>([
        ["an Architecture that climbs out of dists", text => text.replace("Architecture: source all amd64", "Architecture: source ../evil"), 'Malformed Architecture of srm-hello_1.0-1_amd64.changes: "../evil"'],
        ["a .buildinfo that climbs out of the pool", text => text.replaceAll(" srm-hello_1.0-1_amd64.buildinfo", " ../../../../outside.buildinfo"), 'Malformed file name in Files: "../../../../outside.buildinfo"'],
    ])("A pool .changes with %s is a file no upload references", (_, change, reason) => withTree(async ctx => {
        await writeDists(ctx, "debian", "trixie", "deb/debian/dists/trixie");
        await copyBundle(ctx, TRIXIE);
        await writeRepoFile(ctx, "deb/debian/outside.buildinfo", "outside");
        const changes = repoFile(ctx, `${ SRM_HELLO_POOL }/srm-hello_1.0-1_amd64.changes`);
        await fs.writeFile(changes, change(await fs.readFile(changes, "utf8")));
        const warn = jest.spyOn(logger, "warn").mockReturnValue(logger);

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        expect(warn).toHaveBeenCalledWith(`${ SRM_HELLO_POOL }/srm-hello_1.0-1_amd64.changes: ${ reason }; treated as a file no upload references`);
        await withDatabase(osJoin(ctx.paths.repoStateDir, "repo.db"), db => {
            expect(rows(db, "SELECT path FROM pool_files WHERE path LIKE '%..%' OR path LIKE '%.changes'")).toEqual([]);
        });
    })());

    test("A pool .dsc over 16 MiB is a problem, not a throw", withTree(async ctx => {
        const dsc = Buffer.alloc(16 * 1024 * 1024 + 1);
        await writeRepoFile(ctx, `${ SRM_HELLO_POOL }/evil.dsc`, dsc);
        await writeRepoFile(ctx, "deb/debian/dists/trixie/main/source/Sources",
            `Package: srm-hello\nVersion: 1.0-1\nDirectory: pool/main/s/srm-hello\nChecksums-Sha256:\n ${ sha256(dsc) } ${ dsc.length } evil.dsc\n`);

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: [`${ SRM_HELLO_POOL }/evil.dsc: evil.dsc holds ${ dsc.length } bytes, over the ${ dsc.length - 1 } limit`] });

        expect(await stateFiles(ctx, "repo.db")).toEqual([]);
    }));

    test("A pool .changes over 16 MiB is a file no upload references, unread", withTree(async ctx => {
        await writeDists(ctx, "debian", "trixie", "deb/debian/dists/trixie");
        await copyBundle(ctx, TRIXIE);
        const changes = "srm-hello_1.0-1_amd64.changes";
        const size = 16 * 1024 * 1024 + 1;
        await fs.truncate(repoFile(ctx, `${ SRM_HELLO_POOL }/${ changes }`), size);
        const warn = jest.spyOn(logger, "warn").mockReturnValue(logger);

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        expect(warn).toHaveBeenCalledWith(`${ SRM_HELLO_POOL }/${ changes }: ${ changes } holds ${ size } bytes, over the ${ size - 1 } limit; treated as a file no upload references`);
    }));

    test("A directory no repo-relative path can reach aborts the rebuild and changes nothing", withTree(async ctx => {
        await writeRpmTree(ctx);
        // What each system can really hold; Node creates the Windows one literally
        const name = process.platform === "win32" ? "aux" : "a\\b";
        const unreachable = osJoin(ctx.paths.repoDir, "rpm", "fedora", "42", "Packages", name);
        await fs.mkdir(unreachable);
        await fs.copyFile(repoFile(ctx, `${ RPM_RELEASE }/Packages/s/${ BIN_RPM }`), osJoin(unreachable, BIN_RPM));
        const warn = jest.spyOn(logger, "warn").mockReturnValue(logger);

        const result = await rebuildFromDisk(ctx);

        expect(warn).toHaveBeenCalled();
        expect(result).toEqual({ ok: false, problems: [expect.stringContaining(JSON.stringify(name))] });
        expect(await exists(repoFile(ctx, `${ RPM_RELEASE }/Packages/s/${ BIN_RPM }`))).toBe(true);
        expect(await exists(repoFile(ctx, `${ RPM_POOL }/${ BIN_RPM }`))).toBe(false);
    }));

    test("Successful rebuild moves RPMs to Packages/<c>/<source>/ and publishes", withTree(async ctx => {
        const leftovers = await writeRpmTree(ctx);

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        for (const name of [SRC_RPM, BIN_RPM]) {
            expect(await exists(repoFile(ctx, `${ RPM_RELEASE }/Packages/s/${ name }`))).toBe(false);
        }
        for (const name of [SRC_RPM, BIN_RPM, DOC_RPM]) {
            expect(await exists(repoFile(ctx, `${ RPM_POOL }/${ name }`))).toBe(true);
        }
        const repomd = await fs.readFile(repoFile(ctx, `${ RPM_RELEASE }/repodata/repomd.xml`), "utf8");
        expect(await exists(repoFile(ctx, `${ RPM_RELEASE }/repodata/repomd.xml.asc`))).toBe(true);
        await withDatabase(osJoin(ctx.paths.repoStateDir, "repo.db"), async db => {
            const rpm = (filename: string, name: string, arch: string): Row =>
                ({ distro: "fedora", release: "42", filename, name, arch, source_name: "srm-hello", source_version: "1.0-1.fc42", path: `${ RPM_POOL }/${ filename }` });
            expect(rows(db, RPM_PACKAGES)).toEqual([rpm(SRC_RPM, "srm-hello", "src"), rpm(BIN_RPM, "srm-hello", "x86_64"), rpm(DOC_RPM, "srm-hello-doc", "noarch")]);
            const indexes = rows(db, INDEX_FILES) as { kind: string; stored_path: string; sha256: string }[];
            expect(indexes.map(i => i.kind).sort()).toEqual([...KINDS].sort());
            for (const index of indexes) {
                expect(index.stored_path).toBe(`${ RPM_RELEASE }/repodata/${ index.sha256 }-${ index.kind }.xml.zst`);
                expect(await exists(repoFile(ctx, index.stored_path))).toBe(true);
                expect(repomd).toContain(`repodata/${ index.sha256 }-${ index.kind }.xml.zst`);
            }
            const primary = zlib.zstdDecompressSync(await fs.readFile(repoFile(ctx, indexes.find(i => i.kind === "primary")!.stored_path))).toString("utf8");
            for (const name of [SRC_RPM, BIN_RPM, DOC_RPM]) {
                expect(primary).toContain(`<location href="Packages/s/srm-hello/${ name }"/>`);
            }
            expect(rows(db, SUPERSEDED)).toEqual(leftovers.sort().map(path => ({ path, superseded_at: NOW })));
        });
    }));

    test("A letter directory respelled because case is set not to count still gives up its files", withTree(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        const letter = repoFile(ctx, `${ RPM_RELEASE }/Packages/S`);
        await fs.mkdir(letter, { recursive: true });
        await fs.copyFile(osPath.join(RPMS, BIN_RPM), osJoin(letter, BIN_RPM));

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        expect(await fs.readdir(repoFile(ctx, `${ RPM_RELEASE }/Packages`))).toEqual(["s"]);
        expect(await exists(repoFile(ctx, `${ RPM_POOL }/${ BIN_RPM }`))).toBe(true);
    }));

    test("An upper-case letter directory of the old layout moves to lower case and leaves nothing behind", withTree(async ctx => {
        const letter = repoFile(ctx, `${ RPM_RELEASE }/Packages/S`);
        await fs.mkdir(letter, { recursive: true });
        await fs.copyFile(osPath.join(RPMS, BIN_RPM), osJoin(letter, BIN_RPM));

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        expect(await fs.readdir(repoFile(ctx, `${ RPM_RELEASE }/Packages`))).toEqual(["s"]);
        expect(await exists(repoFile(ctx, `${ RPM_POOL }/${ BIN_RPM }`))).toBe(true);
    }));

    test.each(["N", "n"])("A source directory with upper case below Packages/%s moves to lower case, the names in the database stay exact", letter => withTree(async ctx => {
        await writeRepoFile(ctx, `${ RPM_RELEASE }/Packages/${ letter }/NetworkManager/x.rpm`, await networkManagerRpm());

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        const packages = repoFile(ctx, `${ RPM_RELEASE }/Packages`);
        expect(await fs.readdir(packages)).toEqual(["n"]);
        expect(await fs.readdir(osJoin(packages, "n"))).toEqual(["networkmanager"]);
        expect(await fs.readdir(osJoin(packages, "n", "networkmanager"))).toEqual(["x.rpm"]);
        await withDatabase(osJoin(ctx.paths.repoStateDir, "repo.db"), db => {
            expect(rows(db, RPM_PACKAGES)).toEqual([{
                distro: "fedora", release: "42", filename: "x.rpm", name: "srm-hello", arch: "x86_64",
                source_name: "NetworkManager", source_version: "1-1.1", path: `${ RPM_RELEASE }/Packages/n/networkmanager/x.rpm`,
            }]);
            expect(rows(db, "SELECT primary_xml FROM rpm_packages")[0].primary_xml).toContain('<location href="Packages/n/networkmanager/x.rpm"/>');
        });
    })());

    test("An empty directory left by an interrupted rebuild goes as well", withTree(async ctx => {
        await fs.mkdir(repoFile(ctx, `${ RPM_RELEASE }/Packages/a/old`), { recursive: true });
        await fs.mkdir(repoFile(ctx, `${ RPM_RELEASE }/Packages/s`), { recursive: true });
        await fs.copyFile(osPath.join(RPMS, BIN_RPM), repoFile(ctx, `${ RPM_RELEASE }/Packages/s/${ BIN_RPM }`));

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        expect(await fs.readdir(repoFile(ctx, `${ RPM_RELEASE }/Packages`))).toEqual(["s"]);
    }));

    test("A directory that cannot be removed is only logged", withTree(async ctx => {
        await fs.mkdir(repoFile(ctx, `${ RPM_RELEASE }/Packages/a`), { recursive: true });
        await fs.mkdir(repoFile(ctx, `${ RPM_RELEASE }/Packages/s`), { recursive: true });
        await fs.copyFile(osPath.join(RPMS, BIN_RPM), repoFile(ctx, `${ RPM_RELEASE }/Packages/s/${ BIN_RPM }`));
        const rmdir = jest.spyOn(fs, "rmdir").mockRejectedValue(Object.assign(new Error("busy"), { code: "EBUSY" }));
        const warn = jest.spyOn(logger, "warn").mockReturnValue(logger);
        try {
            expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be removed"), expect.anything());
        } finally {
            rmdir.mockRestore();
        }
    }));

    test("A rebuild leaves an upper-case letter directory in lower case", withTree(async ctx => {
        const letter = repoFile(ctx, `${ RPM_RELEASE }/Packages/S`);
        await fs.mkdir(letter, { recursive: true });
        await fs.copyFile(osPath.join(RPMS, BIN_RPM), osJoin(letter, BIN_RPM));

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        expect(await fs.readdir(repoFile(ctx, `${ RPM_RELEASE }/Packages`))).toEqual(["s"]);
    }));

    test("Where case does not count, a directory no move leaves from takes the spelling of the targets below it", withTree(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        await fs.mkdir(repoFile(ctx, `${ RPM_RELEASE }/Other`), { recursive: true });
        await fs.copyFile(osPath.join(RPMS, BIN_RPM), repoFile(ctx, `${ RPM_RELEASE }/Other/${ BIN_RPM }`));
        await fs.mkdir(osJoin(ctx.paths.repoDir, RPM_RELEASE, "Packages", "S"), { recursive: true });
        await fs.writeFile(osJoin(ctx.paths.repoDir, RPM_RELEASE, "Packages", "S", "notes.txt"), "kept");

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        expect(await fs.readdir(repoFile(ctx, `${ RPM_RELEASE }/Packages`))).toEqual(["s"]);
    }));

    test("Where case counts, a directory keeps its spelling", withTree(async ctx => {
        setFileNaming(CASE_SENSITIVE);
        await fs.mkdir(repoFile(ctx, `${ RPM_RELEASE }/Other`), { recursive: true });
        await fs.copyFile(osPath.join(RPMS, BIN_RPM), repoFile(ctx, `${ RPM_RELEASE }/Other/${ BIN_RPM }`));
        await fs.mkdir(osJoin(ctx.paths.repoDir, RPM_RELEASE, "Packages", "S"), { recursive: true });
        await fs.writeFile(osJoin(ctx.paths.repoDir, RPM_RELEASE, "Packages", "S", "notes.txt"), "kept");

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        expect(await fs.readdir(repoFile(ctx, `${ RPM_RELEASE }/Packages`))).toContain("S");
    }));

    windowsTest("A junction keeps its target as it is named while the letter directory below it is respelled", withTree(async ctx => {
        const target = osPath.resolve("RPM");
        const letter = osJoin(target, "fedora", "42", "Packages", "S");
        await fs.mkdir(letter, { recursive: true });
        await fs.copyFile(osPath.join(RPMS, BIN_RPM), osJoin(letter, BIN_RPM));
        await fs.mkdir(ctx.paths.repoDir, { recursive: true });
        await fs.symlink(target, repoFile(ctx, "rpm"), "junction");

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        expect(await fs.readdir(".")).toContain("RPM");
        expect(await fs.readdir(ctx.paths.repoDir)).toContain("rpm");
        expect(await fs.readdir(osJoin(target, "fedora", "42", "Packages"))).toEqual(["s"]);
    }));

    test("Where case does not count, two RPMs whose targets differ only in case abort the rebuild and overwrite nothing", withTree(async ctx => {
        setFileNaming(CASE_INSENSITIVE);
        const [first, second] = [`${ RPM_RELEASE }/a/${ BIN_RPM }`, `${ RPM_RELEASE }/b/SRM-hello-1.0-1.fc42.x86_64.rpm`];
        await fs.mkdir(repoFile(ctx, `${ RPM_RELEASE }/a`), { recursive: true });
        await fs.mkdir(repoFile(ctx, `${ RPM_RELEASE }/b`), { recursive: true });
        await fs.copyFile(osPath.join(RPMS, BIN_RPM), repoFile(ctx, first));
        await fs.copyFile(osPath.join(RPMS, BIN_RPM), repoFile(ctx, second));

        expect(await rebuildFromDisk(ctx)).toEqual({
            ok: false,
            problems: [`${ RPM_POOL }/SRM-hello-1.0-1.fc42.x86_64.rpm differs only in case from ${ RPM_POOL }/${ BIN_RPM }, which this file system cannot keep apart`],
        });

        expect(await exists(repoFile(ctx, first))).toBe(true);
        expect(await exists(repoFile(ctx, second))).toBe(true);
    }));

    test.each([
        "rpm/Fedora", "rpm/fedora/Rawhide", "deb/Debian", "deb/debian/dists/Trixie", "deb/debian/dists/trixie/Main",
        "deb/debian/dists/bookworm-security/updates/Main", "deb/debian/pool/Main", "deb/debian/pool/updates/Main",
        `rpm/f${ String.fromCodePoint(0xE9) }dora`, `rpm/${ String.fromCodePoint(0x212A) }ali`, `deb/debian/dists/trixie/m${ String.fromCodePoint(0xE1) }in`,
    ])("%s aborts the rebuild where case does not count and stays, where case counts it passes", dir => withTree(async ctx => {
        await fs.mkdir(repoFile(ctx, dir), { recursive: true });
        const parent = repoFile(ctx, path.dirname(dir));
        const name = path.basename(dir);

        setFileNaming(CASE_INSENSITIVE);
        expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: [`${ dir }: ${ NOT_IN_LOWER_CASE }`] });
        expect(await fs.readdir(parent)).toEqual([name]);
        expect(await stateFiles(ctx, "repo.db")).toEqual([]);

        setFileNaming(CASE_SENSITIVE);
        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });
        expect(await fs.readdir(parent)).toEqual([name]);
    })());

    test("An rpm tree in rpm/Fedora/42 aborts the rebuild where case does not count, where case counts it is rebuilt in that spelling", withTree(async ctx => {
        await writeRepoFile(ctx, `rpm/Fedora/42/Packages/s/${ BIN_RPM }`, await fs.readFile(osPath.join(RPMS, BIN_RPM)));
        const before = await treeDigests(ctx.paths.repoDir);

        setFileNaming(CASE_INSENSITIVE);
        expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: [`rpm/Fedora: ${ NOT_IN_LOWER_CASE }`] });
        expect(await treeDigests(ctx.paths.repoDir)).toEqual(before);
        expect(await stateFiles(ctx, "repo.db")).toEqual([]);

        setFileNaming(CASE_SENSITIVE);
        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });
        expect(await fs.readdir(repoFile(ctx, "rpm"))).toEqual(["Fedora"]);
        expect(await exists(repoFile(ctx, `rpm/Fedora/42/Packages/s/srm-hello/${ BIN_RPM }`))).toBe(true);
    }));

    test.each(["release", "inrelease"])("A directory %s below a release aborts the rebuild where case does not count and stays, where case counts it passes", name => withTree(async ctx => {
        const dir = `deb/debian/dists/trixie/${ name }`;
        await fs.mkdir(repoFile(ctx, dir), { recursive: true });

        setFileNaming(CASE_INSENSITIVE);
        expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: [`${ dir }: "${ name }" cannot be a component, the release has a file of that name`] });
        expect(await exists(repoFile(ctx, dir))).toBe(true);
        expect(await stateFiles(ctx, "repo.db")).toEqual([]);

        setFileNaming(CASE_SENSITIVE);
        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });
    })());

    test.each(["deb/debian/pool/release", "deb/debian/dists/trixie/main/release"])("%s is no file of a release and passes where case does not count", dir => withTree(async ctx => {
        await fs.mkdir(repoFile(ctx, dir), { recursive: true });

        setFileNaming(CASE_INSENSITIVE);

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });
    })());

    test.each([["main/source", "source"], ["main/by-hash", "by-hash"], ["main/debug", "debug"], ["main/binary-amd64", "binary-amd64"], ["debian-installer", "debian-installer"]])("A Release listing the component %s aborts the rebuild, which would read it as a part of its parent", (component, name) => withTree(async ctx => {
        await writeRepoFile(ctx, "deb/debian/dists/trixie/Release", `Origin: x\nComponents: main ${ component }\nSHA256:\n`);

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: [`deb/debian/dists/trixie/Release, which lists ${ component }: "${ name }" cannot be a component, the publish writes that name below a component`] });
        expect(await stateFiles(ctx, "repo.db")).toEqual([]);
    }, { signed: false })());

    test.each([["deb/archive-keyring.asc/dists", "deb/archive-keyring.asc", "archive-keyring.asc"], ["rpm/RPM-GPG-KEY.asc/42", "rpm/RPM-GPG-KEY.asc", "RPM-GPG-KEY.asc"]])("A directory %s aborts the rebuild, the format has a keyring of that name", (dir, named, name) => withTree(async ctx => {
        await fs.mkdir(repoFile(ctx, dir), { recursive: true });

        setFileNaming(CASE_SENSITIVE);

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: [`${ named }: ${ JSON.stringify(name) } cannot be a distribution, the format has a keyring of that name`] });
    })());

    test("A directory by-hash below a release aborts the rebuild where case counts as well", withTree(async ctx => {
        const dir = "deb/debian/dists/trixie/by-hash";
        await fs.mkdir(repoFile(ctx, dir), { recursive: true });

        setFileNaming(CASE_SENSITIVE);

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: [`${ dir }: "by-hash" cannot be a component, the publish writes that name below a component`] });
    }));

    test("A Release listing the components it may list passes", withTree(async ctx => {
        await writeRepoFile(ctx, "deb/debian/dists/trixie/Release", "Origin: x\nComponents: main updates/main\nSHA256:\n");

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });
    }, { signed: false }));

    describe("Temp files a crash left", () => {
        const LONGEST = `${ "a".repeat(236) }.rpm`;
        const temps = [`${ RPM_RELEASE }/Packages/s/${ BIN_RPM }.tmp-123`, `${ RPM_RELEASE }/Packages/s/${ LONGEST }.tmp-0`, "deb/debian/pool/main/s/srm-hello/srm-hello_1.0-1_amd64.deb.tmp-1234567890",
            `deb/debian/pool/main/s/srm-hello/${ LONGEST }.tmp-0`, "deb/debian/dists/trixie/main/binary-amd64/Packages.gz.tmp-5", "deb/debian/dists/trixie/Release.tmp-5"];

        test("Go with a rebuild, whatever their length and wherever they are", withTree(async ctx => {
            await writeRpmTree(ctx);
            for (const temp of temps) {
                await writeRepoFile(ctx, temp, "half");
            }
            const warn = jest.spyOn(logger, "warn").mockReturnValue(logger);

            expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

            for (const temp of temps) {
                expect(await exists(repoFile(ctx, temp))).toBe(false);
            }
            expect(await exists(repoFile(ctx, `${ RPM_RELEASE }/Packages/s/srm-hello/${ BIN_RPM }`))).toBe(true);
            expect(warn.mock.calls.filter(([line]) => String(line).includes("referenced by no index"))).toEqual([]);
        }));

        test("Stay when the rebuild aborts", withTree(async ctx => {
            for (const temp of temps) {
                await writeRepoFile(ctx, temp, "half");
            }
            await writeRepoFile(ctx, `${ RPM_RELEASE }/Packages/s/bad.rpm`, "not an rpm");

            expect(await rebuildFromDisk(ctx)).toMatchObject({ ok: false });

            for (const temp of temps) {
                expect(await exists(repoFile(ctx, temp))).toBe(true);
            }
        }));

        test("Only the suffix is free of the limit, a longer name aborts", withTree(async ctx => {
            await writeRepoFile(ctx, `deb/debian/pool/main/s/srm-hello/${ "a".repeat(241) }.tmp-0`, "x");

            expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: [expect.stringContaining('is longer than 240 bytes')] });
        }));

        test("A directory named like a temp file is an ordinary directory", withTree(async ctx => {
            const dir = "deb/debian/pool/main/s/srm-hello.tmp-5";
            await fs.mkdir(repoFile(ctx, dir), { recursive: true });

            expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

            expect(await exists(repoFile(ctx, dir))).toBe(true);
        }));

        test("A package named like a temp file stays, it has its row", withTree(async ctx => {
            await fs.mkdir(ctx.paths.repoStateDir);
            const db = openDatabase(osJoin(ctx.paths.repoStateDir, "repo.db"));
            const listed = "deb/debian/pool/main/s/srm-hello/srm-hello_1.0.tar.tmp-1";
            const unlisted = "deb/debian/pool/main/s/srm-hello/srm-hello_1.0-1_amd64.deb.tmp-1";
            db.prepare("INSERT INTO pool_files (path, size, md5, sha1, sha256, sha512) VALUES (?, 0, '', '', '', '')").run(listed);
            await writeRepoFile(ctx, listed, "x");
            await writeRepoFile(ctx, unlisted, "x");

            await removeLeftoverTemps(db, [listed, unlisted].map(rel => ({ rel, file: repoFile(ctx, rel) })));
            db.close();

            expect(await exists(repoFile(ctx, listed))).toBe(true);
            expect(await exists(repoFile(ctx, unlisted))).toBe(false);
        }));
    });

    describe("A link to a directory", () => {
        const linkTo = async (ctx: Ctx, rel: string): Promise<void> => {
            const target = osJoin("elsewhere", rel);
            await fs.mkdir(target, { recursive: true });
            await fs.mkdir(osPath.dirname(repoFile(ctx, rel)), { recursive: true });
            await fs.symlink(osPath.resolve(target), repoFile(ctx, rel), process.platform === "win32" ? "junction" : "dir");
        };

        test.each([
            "rpm/fedora", "rpm/fedora/42", "rpm/fedora/42/Packages", "rpm/fedora/42/Packages/s", "deb/debian", "deb/debian/dists", "deb/debian/dists/trixie",
            "deb/debian/dists/trixie/main", "deb/debian/dists/trixie/main/binary-amd64",
        ])("%s aborts the rebuild, which would lose what is behind it", rel => withTree(async ctx => {
            await linkTo(ctx, rel);

            expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: [`${ rel }: a link to a directory, which the rebuild does not follow, so what is behind it would be lost`] });
            expect(await stateFiles(ctx, "repo.db")).toEqual([]);
        })());

        test.each(["rpm", "deb", "deb/debian/pool", "deb/debian/pool/main", "deb/debian/pool/main/s", "rpm/fedora/42/repodata"])("%s is fine, the rebuild needs no walk there", rel => withTree(async ctx => {
            await linkTo(ctx, rel);

            expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });
        })());

        test("All of them are named at once", withTree(async ctx => {
            await linkTo(ctx, "rpm/fedora");
            await linkTo(ctx, "deb/debian");

            expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: expect.arrayContaining([expect.stringContaining("deb/debian: a link"), expect.stringContaining("rpm/fedora: a link")]) as string[] });
        }));
    });

    // Windows lets only some accounts create one
    (process.platform === "win32" ? test.skip : test)("A link to a package is read like the package", withTree(async ctx => {
        await writeRpmTree(ctx);
        const file = repoFile(ctx, `${ RPM_RELEASE }/Packages/s/${ BIN_RPM }`);
        await fs.rename(file, "elsewhere-rpm");
        await fs.symlink(osPath.resolve("elsewhere-rpm"), file);

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });
    }));

    /** Published through an import where case counts, as a volume that tells case apart leaves it; returns the database */
    const publishInSpelling = async (ctx: Ctx, target: string, changes: (text: string) => string): Promise<Record<string, Row[]>> => {
        setFileNaming(CASE_SENSITIVE);
        await fs.mkdir(ctx.paths.repoStateDir);
        return withDatabase(osJoin(ctx.paths.repoStateDir, "repo.db"), async db => {
            const full: BackendContext = { ...ctx, db };
            await stage(ctx, { ...TRIXIE, target });
            const file = osJoin(ctx.paths.incomingDir, "process", target, "srm-hello_1.0-1_amd64.changes");
            await fs.writeFile(file, changes(await fs.readFile(file, "utf8")));
            expect((await importDebian(full)).filter(f => f.status !== "ok")).toEqual([]);
            await publishDebian(full);
            return snapshot(db);
        });
    };

    test("A Debian tree in upper case aborts the rebuild where case does not count and changes nothing, where case counts it is reproduced", withTree(async ctx => {
        const before = await publishInSpelling(ctx, "deb/Debian/Trixie/Main", text => text.replace("Distribution: trixie", "Distribution: Trixie"));
        const published = await treeDigests(ctx.paths.repoDir);
        const file = osJoin(ctx.paths.repoStateDir, "repo.db");

        setFileNaming(CASE_INSENSITIVE);
        expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: [
            `deb/Debian: ${ NOT_IN_LOWER_CASE }`,
            `deb/Debian/pool/Main: ${ NOT_IN_LOWER_CASE }`,
            `deb/Debian/dists/Trixie: ${ NOT_IN_LOWER_CASE }`,
            `deb/Debian/dists/Trixie/Main: ${ NOT_IN_LOWER_CASE }`,
            `deb/Debian/pool/Main/s/srm-hello, listed in deb/Debian/dists/Trixie/Main/binary-amd64/Packages.gz: ${ NOT_IN_LOWER_CASE }`,
        ] });
        expect(await treeDigests(ctx.paths.repoDir)).toEqual(published);
        expect(await withDatabase(file, snapshot)).toEqual(before);

        setFileNaming(CASE_SENSITIVE);
        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });
        expect(await withDatabase(file, snapshot)).toEqual(before);
        expect(await treeDigests(ctx.paths.repoDir)).toEqual(published);
    }, { signed: false }));

    test("An index naming a pool directory with upper case aborts the rebuild also when the directory on disk is renamed to lower case", withTree(async ctx => {
        await publishInSpelling(ctx, "deb/debian/trixie/Main", text => text);
        await fs.rename(repoFile(ctx, "deb/debian/pool/Main"), repoFile(ctx, "deb/debian/pool/main"));
        await fs.rename(repoFile(ctx, "deb/debian/dists/trixie/Main"), repoFile(ctx, "deb/debian/dists/trixie/main"));

        setFileNaming(CASE_INSENSITIVE);

        // Off a case-insensitive volume the files listed under pool/Main are also missing
        expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: expect.arrayContaining([
            `deb/debian/pool/Main/s/srm-hello, listed in deb/debian/dists/trixie/main/binary-amd64/Packages.gz: ${ NOT_IN_LOWER_CASE }`,
        ]) });
    }));

    const PACKAGES = "deb/debian/dists/trixie/main/binary-amd64/Packages.gz";
    const LISTED = `Filename: pool/main/s/srm-hello/${ AMD64_DEB }\n`;
    const LISTED_IN_OTHER_CASE = `Filename: pool/main/s/srm-hello/SRM${ AMD64_DEB.slice(3) }\n`;

    /** Packages.gz of trixie edited, as its own file: the canonical name is a link to the by-hash one */
    async function editPackages(ctx: Ctx, edit: (text: string) => string): Promise<void> {
        const text = await readIndex(ctx, PACKAGES);
        expect(text).toContain(LISTED);
        await fs.rm(repoFile(ctx, PACKAGES));
        await writeRepoFile(ctx, PACKAGES, zlib.gzipSync(edit(text)));
    }

    test("An index naming a pool file in another case than the disk aborts the rebuild where case does not count", withTree(async ctx => {
        await publishInSpelling(ctx, TRIXIE.target, text => text);
        await editPackages(ctx, text => text.replace(LISTED, LISTED_IN_OTHER_CASE));
        const before = await treeDigests(ctx.paths.repoDir);

        setFileNaming(CASE_INSENSITIVE);

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: [`${ SRM_HELLO_POOL }/SRM${ AMD64_DEB.slice(3) }: missing, listed in ${ PACKAGES }`] });
        expect(await treeDigests(ctx.paths.repoDir)).toEqual(before);
    }));

    test("An index naming two pool files differing only in case aborts the rebuild where case does not count", withTree(async ctx => {
        await publishInSpelling(ctx, TRIXIE.target, text => text);
        await editPackages(ctx, text => text.split("\n\n").flatMap(stanza => stanza.includes(LISTED) ? [stanza, stanza.replace(LISTED, LISTED_IN_OTHER_CASE)] : [stanza]).join("\n\n"));

        setFileNaming(CASE_INSENSITIVE);

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: expect.arrayContaining([
            `${ SRM_HELLO_POOL }/SRM${ AMD64_DEB.slice(3) } differs only in case from ${ SRM_HELLO_POOL }/${ AMD64_DEB }, which this file system cannot keep apart`,
        ]) });
    }));

    test("An index naming a pool directory other than ASCII aborts the rebuild where case does not count", withTree(async ctx => {
        const component = `m${ String.fromCodePoint(0xE1) }in`;
        await publishInSpelling(ctx, `deb/debian/trixie/${ component }`, text => text);

        setFileNaming(CASE_INSENSITIVE);

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: false, problems: expect.arrayContaining([
            `deb/debian/pool/${ component }/s/srm-hello, listed in deb/debian/dists/trixie/${ component }/binary-amd64/Packages.gz: ${ NOT_IN_LOWER_CASE }`,
        ]) });
    }));

    // All of it published and rebuilt, too much for the default under a full parallel run
    const REPRODUCTION_TIMEOUT_MS = 30_000;

    const expectRebuildReproducesPublishedTree = async (ctx: Ctx): Promise<void> => {
        await fs.mkdir(ctx.paths.repoStateDir);
        const file = osJoin(ctx.paths.repoStateDir, "repo.db");
        const before = await withDatabase(file, async db => {
            const full: BackendContext = { ...ctx, db };
            for (const bundle of [TRIXIE, ARM64, BOOKWORM, NOBLE]) {
                await stage(ctx, bundle);
            }
            expect((await importDebian(full)).filter(f => f.status !== "ok")).toEqual([]);
            await stageRpms(ctx);
            expect((await importRpm(full)).filter(f => f.status !== "ok")).toEqual([]);
            await publishDebian(full);
            await publishRpm(full);
            return snapshot(db);
        });
        expect(before.uploads).toHaveLength(4);
        expect(before.rpm).toHaveLength(3);
        const published = await treeDigests(ctx.paths.repoDir);

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        expect(await withDatabase(file, snapshot)).toEqual(before);
        expect(await stateFiles(ctx, "repo.db")).toEqual(["repo.db"]);
        expect(await treeDigests(ctx.paths.repoDir)).toEqual(published);
    };

    test("Rebuild from the tree this backend published reproduces the same rows", withTree(expectRebuildReproducesPublishedTree, { signed: false }), REPRODUCTION_TIMEOUT_MS);

    test("Fixed names with upper case pass where case does not count", withTree(async ctx => {
        setFileNaming(CASE_INSENSITIVE);

        await expectRebuildReproducesPublishedTree(ctx);

        expect(await exists(repoFile(ctx, "deb/debian/dists/trixie/main/binary-amd64/by-hash/SHA256"))).toBe(true);
        expect(await exists(repoFile(ctx, `${ RPM_RELEASE }/Packages`))).toBe(true);
    }, { signed: false }), REPRODUCTION_TIMEOUT_MS);

    test("Rebuild reproduces the same rows and files where canonical names are copies, not hard links", withTree(async ctx => {
        const link = jest.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("not permitted"), { code: "EPERM" }));

        await expectRebuildReproducesPublishedTree(ctx);

        expect(link).toHaveBeenCalled();
    }, { signed: false }), REPRODUCTION_TIMEOUT_MS);

    test("A release emptied by removal stays published, listed and signed, with all its cells", withTree(async ctx => {
        const cells = await writeEmptiedTree(ctx);
        ctx.clock.now = NOW + 10;

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        await withDatabase(osJoin(ctx.paths.repoStateDir, "repo.db"), db => {
            expect(rows(db, CELLS)).toEqual(cells);
            expect(new DebCatalog(db).releases()).toEqual([{ distro: "debian", release: "trixie", components: ["main"], architectures: ["amd64", "arm64"] }]);
            expect(new RpmCatalog(db).releases()).toEqual([{ distro: "fedora", release: "42" }]);
            expect(rows(db, SOURCES)).toEqual([]);
            expect(rows(db, RPM_PACKAGES)).toEqual([]);
        });
        const dists = "deb/debian/dists/trixie";
        for (const index of ["main/binary-arm64/Packages.gz", "main/debian-installer/binary-amd64/Packages.gz", "main/source/Sources.gz", "main/Contents-amd64.gz", "main/Contents-udeb-arm64.gz"]) {
            expect(await readIndex(ctx, `${ dists }/${ index }`)).toBe("");
        }
        await debClientView(ctx, "debian", "trixie");
        expect(await rpmClientView(ctx, "fedora", "42")).toHaveLength(4);
        for (const signature of [`${ dists }/InRelease`, `${ dists }/Release.gpg`, `${ RPM_RELEASE }/repodata/repomd.xml.asc`]) {
            expect(await exists(repoFile(ctx, signature))).toBe(true);
        }
    }));

    test("A reprepro release without packages stays published; its leftovers go as usual", withTree(async ctx => {
        const dists = "deb/debian/dists/forky";
        for (const index of ["main/binary-amd64/Packages", "main/debian-installer/binary-amd64/Packages", "main/source/Sources"]) {
            await writeGoldenFile(ctx, `${ dists }/${ index }`, Buffer.alloc(0), true);
        }
        await writeRepoFile(ctx, `${ dists }/Release`, "Codename: forky\n");
        await writeRepoFile(ctx, `${ dists }/main/binary-amd64/Release`, "Archive: forky\n");

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        await withDatabase(osJoin(ctx.paths.repoStateDir, "repo.db"), db => {
            expect(rows(db, CELLS).map(c => `${ c.kind as string } ${ c.architecture as string }`)).toEqual([
                "contents amd64", "contents-udeb amd64", "installer amd64", "packages amd64", "sources ",
            ]);
            expect(rows(db, SUPERSEDED)).toEqual([{ path: `${ dists }/main/binary-amd64/Release`, superseded_at: NOW }]);
        });
        expect(await exists(repoFile(ctx, `${ dists }/main/binary-amd64/Packages`))).toBe(false);
        expect(await fs.readFile(repoFile(ctx, `${ dists }/Release`), "utf8")).toContain("Suite: forky\n");
        await debClientView(ctx, "debian", "forky");
    }));

    test("Every repodata directory keeps its release, with packages or without", withTree(async ctx => {
        const leftovers = await writeRpmTree(ctx);
        const old = `rpm/fedora/41/repodata/${ "0".repeat(64) }-primary.xml.gz`;
        await writeRepoFile(ctx, old, zlib.gzipSync(""));
        await writeRepoFile(ctx, "rpm/fedora/41/repodata/repomd.xml", "<repomd/>");
        await fs.mkdir(repoFile(ctx, "rpm/fedora/40/repodata"), { recursive: true });
        await fs.mkdir(repoFile(ctx, "rpm/fedora/39/Packages"), { recursive: true });
        await writeRepoFile(ctx, "rpm/RPM-GPG-KEY.asc", "key");

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        await withDatabase(osJoin(ctx.paths.repoStateDir, "repo.db"), db => {
            expect(new RpmCatalog(db).releases().map(r => r.release)).toEqual(["40", "41", "42"]);
            expect(rows(db, SUPERSEDED)).toEqual([...leftovers, old].sort().map(path => ({ path, superseded_at: NOW })));
        });
        for (const release of ["40", "41"]) {
            expect(await rpmClientView(ctx, "fedora", release)).toHaveLength(4);
        }
        expect(await rpmClientView(ctx, "fedora", "42")).toHaveLength(7);
    }));

    /** Past the grace of what the upload and the rebuild superseded */
    const collect = async (ctx: Ctx, db: Database): Promise<string[]> => {
        ctx.clock.now += GC_GRACE_SECONDS + 1;
        const first = await runGc({ ...ctx, db });
        ctx.clock.now += 2 * GC_GRACE_SECONDS;
        const second = await runGc({ ...ctx, db });
        return [...first.index, ...second.index];
    };

    test("Rebuild of an emptied Debian release, an upload into it and GC past the grace keep what clients see", withTree(async ctx => {
        await writeEmptiedTree(ctx);
        ctx.clock.now = NOW + 10;
        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        await withDatabase(osJoin(ctx.paths.repoStateDir, "repo.db"), async db => {
            const full: BackendContext = { ...ctx, db };
            await stage(ctx, TRIXIE);
            ctx.clock.now = NOW + 20;
            expect((await importDebian(full)).filter(f => f.status !== "ok")).toEqual([]);
            expect(await publishDebian(full)).toEqual(["debian/trixie"]);
            const dists = "deb/debian/dists/trixie";
            const view = await debClientView(ctx, "debian", "trixie");
            expect(view).toContain(`${ SRM_HELLO_POOL }/${ AMD64_DEB }`);
            const files = [...view, `${ dists }/InRelease`, `${ dists }/Release.gpg`];
            const digests = await Promise.all(files.map(async rel => sha256(await fs.readFile(repoFile(ctx, rel)))));

            const deleted = await collect(ctx, db);

            expect(deleted.length).toBeGreaterThan(0);
            expect(deleted.filter(rel => files.includes(rel))).toEqual([]);
            expect(await Promise.all(files.map(async rel => sha256(await fs.readFile(repoFile(ctx, rel)))))).toEqual(digests);
            expect(await debClientView(ctx, "debian", "trixie")).toEqual(view);
            expect(new DebCatalog(db).releases().map(r => r.release)).toEqual(["trixie"]);
        });
    }));

    test("Rebuild of an emptied RPM release, an upload into it and GC past the grace keep what clients see", withTree(async ctx => {
        await writeEmptiedTree(ctx);
        ctx.clock.now = NOW + 10;
        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        await withDatabase(osJoin(ctx.paths.repoStateDir, "repo.db"), async db => {
            const full: BackendContext = { ...ctx, db };
            await stageRpms(ctx);
            ctx.clock.now = NOW + 20;
            expect((await importRpm(full)).filter(f => f.status !== "ok")).toEqual([]);
            expect(await publishRpm(full)).toEqual(["fedora/42"]);
            const view = await rpmClientView(ctx, "fedora", "42");
            expect(view).toContain(`${ RPM_POOL }/${ BIN_RPM }`);
            const files = [...view, `${ RPM_RELEASE }/repodata/repomd.xml.asc`];
            const digests = await Promise.all(files.map(async rel => sha256(await fs.readFile(repoFile(ctx, rel)))));

            const deleted = await collect(ctx, db);

            expect(deleted.length).toBeGreaterThan(0);
            expect(deleted.filter(rel => files.includes(rel))).toEqual([]);
            expect(await Promise.all(files.map(async rel => sha256(await fs.readFile(repoFile(ctx, rel)))))).toEqual(digests);
            expect(await rpmClientView(ctx, "fedora", "42")).toEqual(view);
            expect(new RpmCatalog(db).releases().map(r => r.release)).toEqual(["42"]);
        });
    }));

    test("Files of a release without an index go to GC, and an upload into it takes the names it writes back", withTree(async ctx => {
        const dists = "deb/debian/dists/trixie";
        const names = [`${ dists }/InRelease`, `${ dists }/Release`, `${ dists }/Release.gpg`, `${ dists }/main/Contents-amd64.gz`];
        const stale = `${ dists }/Release.old`;
        for (const name of [...names, stale]) {
            await writeRepoFile(ctx, name, "stale");
        }

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        await withDatabase(osJoin(ctx.paths.repoStateDir, "repo.db"), async db => {
            const full: BackendContext = { ...ctx, db };
            expect(new DebCatalog(db).releases()).toEqual([]);
            expect(rows(db, SUPERSEDED)).toEqual([...names, stale].sort().map(path => ({ path, superseded_at: NOW })));
            await stage(ctx, TRIXIE);
            expect((await importDebian(full)).filter(f => f.status !== "ok")).toEqual([]);
            expect(await publishDebian(full)).toEqual(["debian/trixie"]);
            expect(rows(db, SUPERSEDED)).toEqual([{ path: stale, superseded_at: NOW }]);

            expect(await collect(ctx, db)).toEqual([stale]);

            for (const name of names) {
                expect(await exists(repoFile(ctx, name))).toBe(true);
            }
            await debClientView(ctx, "debian", "trixie");
        });
    }));

    test("The temporary database runs without fsync, and the rename publishes a fully synced file with every row", withTree(async ctx => {
        await writeRpmTree(ctx);
        const stateDir = ctx.paths.repoStateDir;
        const file = osJoin(stateDir, "repo.db");
        const tempFile = osJoin(stateDir, "repo.db.rebuild");
        const exec = jest.spyOn(Database.prototype, "exec");
        const close = jest.spyOn(Database.prototype, "close");
        const { open: realOpen, rename: realRename } = fs;
        const synced = jest.fn<(file: string) => void>();
        const open = jest.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
            const handle = await realOpen(path, flags, mode);
            // NTFS refuses to sync a directory
            const sync = path === stateDir ? () => Promise.resolve() : handle.sync.bind(handle);
            handle.sync = () => {
                synced(String(path));
                return sync();
            };
            return handle;
        });
        const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
        const rename = jest.spyOn(fs, "rename").mockImplementation(async (from, to) => {
            await realRename(from, to);
            if (to === file) {
                // The directory sync happens on all but Windows, so the test takes it on Windows too
                Object.defineProperty(process, "platform", { ...platform, value: "linux" });
            }
        });

        try {
            expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });
        } finally {
            Object.defineProperty(process, "platform", platform);
        }

        const pragmas = exec.mock.calls.flatMap(([sql], i) => sql.startsWith("PRAGMA synchronous") || sql.startsWith("PRAGMA wal_checkpoint") ? [{ sql, at: exec.mock.invocationCallOrder[i] }] : []);
        expect(pragmas.map(p => p.sql)).toEqual(["PRAGMA synchronous = FULL", "PRAGMA synchronous = OFF", "PRAGMA synchronous = FULL", "PRAGMA wal_checkpoint(TRUNCATE)"]);
        // Off through the publish, whose files all open in between; synced after it and closed
        const closed = close.mock.invocationCallOrder[0];
        expect(closed).toBeGreaterThan(pragmas[3].at);
        const opened = open.mock.invocationCallOrder.filter(at => at < closed);
        expect(opened.length).toBeGreaterThan(0);
        expect(opened.every(at => at > pragmas[1].at && at < pragmas[2].at)).toBe(true);
        // The checkpoint may not sync the file, so that comes next, then the rename, then the rename's own sync
        const renamed = rename.mock.invocationCallOrder[rename.mock.calls.findIndex(([, to]) => to === file)];
        const syncsAfterClose = synced.mock.calls.flatMap(([path], i) => synced.mock.invocationCallOrder[i] > closed ? [{ path, renamedBefore: renamed < synced.mock.invocationCallOrder[i] }] : []);
        expect(syncsAfterClose).toEqual([{ path: tempFile, renamedBefore: false }, { path: stateDir, renamedBefore: true }]);
        jest.restoreAllMocks();

        expect(await stateFiles(ctx, "repo.db")).toEqual(["repo.db"]);
        const alone = new Database(file, { readOnly: true });
        try {
            expect(rows(alone, RPM_PACKAGES)).toHaveLength(3);
            expect(alone.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        } finally {
            alone.close();
        }
    }));

    test("A leftover repo.db.rebuild is replaced", withTree(async ctx => {
        await writeRpmTree(ctx);
        await fs.mkdir(ctx.paths.repoStateDir);
        await fs.writeFile(osJoin(ctx.paths.repoStateDir, "repo.db.rebuild"), "not a database");
        await fs.writeFile(osJoin(ctx.paths.repoStateDir, "repo.db.rebuild-wal"), "stale");

        expect(await rebuildFromDisk(ctx)).toEqual({ ok: true });

        expect(await stateFiles(ctx, "repo.db")).toEqual(["repo.db"]);
        await withDatabase(osJoin(ctx.paths.repoStateDir, "repo.db"), db => {
            expect(rows(db, RPM_PACKAGES)).toHaveLength(3);
        });
    }));
});
