import { debWithControlTar, tarBytes, tarEntry, withLocalTmpDir } from "../utils.ts";
import { jest } from "@jest/globals";
import crypto from "crypto";
import osPath from "path";
import path from "path/posix";
import { fileURLToPath } from "url";
import { gunzipSync, zstdDecompressSync } from "zlib";
import fs from "fs/promises";
import { Database } from "node:sqlite";
import * as openpgp from "openpgp";
import { openDatabase } from "../../server/backend/db.ts";
import { DebCatalog } from "../../server/backend/deb/catalog.ts";
import { GC_GRACE_SECONDS, GC_INTERVAL_MS, runGc } from "../../server/backend/gc.ts";
import { hashFile } from "../../server/backend/hash.ts";
import { getBackend, openBackend } from "../../server/backend/index.ts";
import type { Backend } from "../../server/backend/index.ts";
import { describeSigningKey, loadSigningKey, verifyClearsigned, verifyDetached } from "../../server/backend/pgp.ts";
import { listFiles } from "../../server/backend/publish-fs.ts";
import { NOT_IN_LOWER_CASE, resetFileNaming, setFileNaming } from "../../server/lib/file-naming.ts";
import lock from "../../server/lib/lock.ts";
import logger from "../../server/lib/logger.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const TRIXIE = { dir: osPath.join(FIXTURES, "packages", "deb", "debian", "trixie", "main"), target: "deb/debian/trixie/main" };
const NOBLE = { dir: osPath.join(FIXTURES, "packages", "deb", "ubuntu", "noble", "universe"), target: "deb/ubuntu/noble/universe" };
const RPMS = { dir: osPath.join(FIXTURES, "packages", "rpm", "fedora", "42"), target: "rpm/fedora/42" };
const PATHS = { incomingDir: "incoming", repoStateDir: "state", repoDir: "repo" };
const KEY_FILE = "key.asc";
const DEB_POOL = "deb/debian/pool/main/s/srm-hello";
const RPM_POOL = "rpm/fedora/42/Packages/s/srm-hello";
const AMD64_DEB = "srm-hello_1.0-1_amd64.deb";
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MIB = 1024 * 1024;
const BOMB_DEB = "bomb_1_amd64.deb";
const BOMB_CHANGES = "bomb_1_amd64.changes";
const HOSTILE_RPM = "evil-1-2.x86_64.rpm";
const RPM_HEADER_MAGIC = [0x8e, 0xad, 0xe8, 0x01];
const RPM_STRING_ARRAY = 8;
const REPOMD = "rpm/fedora/42/repodata/repomd.xml";
// libuv's UV_FS_O_EXLOCK, which Node does not name on Windows: the handle shares nothing, not even delete
const WINDOWS_EXCLUSIVE = 0x10000000;

type Row = Record<string, unknown>;

/** Hash and size by the name Release or repomd.xml lists it under */
type Published = Record<string, [string, number]>;

type Ref = { format: string; distribution: string; release: string };

let armoredKey: string;

beforeAll(async () => {
    armoredKey = (await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "t" }], format: "armored" })).privateKey;
});

function osJoin(...posix: string[]): string {
    return osPath.join(...posix.join("/").split("/"));
}

/** Copies a fixture bundle into incoming/staging below its upload path; returns its file names */
async function stage(bundle: { dir: string; target: string }): Promise<string[]> {
    const to = osJoin(PATHS.incomingDir, "staging", bundle.target);
    await fs.mkdir(to, { recursive: true });
    const names = (await fs.readdir(bundle.dir)).sort();
    for (const name of names) {
        await fs.copyFile(osPath.join(bundle.dir, name), osPath.join(to, name));
    }
    return names;
}

/** Stages an upload whose .deb opens its control member with a pax header over the limit, as a decompression bomb would */
async function stageBomb(): Promise<void> {
    const deb = debWithControlTar(tarBytes(tarEntry("./PaxHeaders/x", "1".repeat(MIB + 1), "x"), tarEntry("./control", "Package: bomb\n")));
    const md5 = crypto.createHash("md5").update(deb).digest("hex");
    const to = osJoin(PATHS.incomingDir, "staging", TRIXIE.target);
    await fs.mkdir(to, { recursive: true });
    await fs.writeFile(osPath.join(to, BOMB_DEB), deb);
    await fs.writeFile(osPath.join(to, BOMB_CHANGES), "Format: 1.8\nSource: bomb\nBinary: bomb\nArchitecture: amd64\nVersion: 1\nDistribution: trixie\n"
        + `Files:\n ${ md5 } ${ deb.length } utils optional ${ BOMB_DEB }\nChecksums-Sha256:\n ${ sha256(deb) } ${ deb.length } ${ BOMB_DEB }\n`);
}

/** Stages an rpm in order but for a Provides name over the string limit, which rendering would escape to several times its size */
async function stageHostileRpm(): Promise<void> {
    const tags: [number, string][] = [[1000, "evil"], [1001, "1"], [1002, "2"], [1022, "x86_64"], [1044, "evil-1-2.src.rpm"], [1047, "&".repeat(MIB + 1)]];
    const header = Buffer.alloc(16 + 16 * tags.length);
    header.set(RPM_HEADER_MAGIC);
    header.writeUInt32BE(tags.length, 8);
    let store = "";
    tags.forEach(([tag, value], i) => {
        const entry = 16 + 16 * i;
        header.writeUInt32BE(tag, entry);
        header.writeUInt32BE(RPM_STRING_ARRAY, entry + 4);
        header.writeUInt32BE(store.length, entry + 8);
        header.writeUInt32BE(1, entry + 12);
        store += `${ value }\0`;
    });
    header.writeUInt32BE(store.length, 12);
    const lead = Buffer.alloc(96);
    lead.set([0xed, 0xab, 0xee, 0xdb]);
    const signature = Buffer.alloc(16);
    signature.set(RPM_HEADER_MAGIC);
    const to = osJoin(PATHS.incomingDir, "staging", RPMS.target);
    await fs.mkdir(to, { recursive: true });
    await fs.writeFile(osPath.join(to, HOSTILE_RPM), Buffer.concat([lead, signature, header, Buffer.from(store)]));
}

/** Opens the backend of the test directory, signing with the generated key unless another key file is named */
async function open(keyFile: string | undefined = KEY_FILE, options: { rebuild?: boolean } = {}): Promise<Backend> {
    if (keyFile === KEY_FILE) {
        await fs.writeFile(KEY_FILE, armoredKey);
    }
    return openBackend(PATHS, keyFile, options);
}

function query(sql: string): Row[] {
    const db = new Database(osPath.join(PATHS.repoStateDir, "repo.db"), { readOnly: true });
    try {
        return db.prepare(sql).all() as Row[];
    } finally {
        db.close();
    }
}

function repoFile(rel: string): string {
    return osJoin(PATHS.repoDir, rel);
}

function dists(rel: string, distro = "debian", release = "trixie"): string {
    return repoFile(`deb/${ distro }/dists/${ release }/${ rel }`);
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.stat(file);
        return true;
    } catch {
        return false;
    }
}

async function inode(file: string): Promise<bigint> {
    return (await fs.stat(file, { bigint: true })).ino;
}

function sha256(data: Buffer): string {
    return crypto.createHash("sha256").update(data).digest("hex");
}

/** The SHA256 block of a Release: hash and size by name */
async function releaseSha256(distro = "debian", release = "trixie"): Promise<Published> {
    const lines = (await fs.readFile(dists("Release", distro, release), "utf8")).split("\n");
    const entries: Published = {};
    for (const line of lines.slice(lines.indexOf("SHA256:") + 1)) {
        if (line.startsWith(" ")) {
            const [hash, size, name] = line.trim().split(" ");
            entries[name] = [hash, Number(size)];
        }
    }
    return entries;
}

/** The canonical indexes of debian/trixie as their files hash: each .gz and its raw content */
async function debIndexes(): Promise<Published> {
    const entries: Published = {};
    for (const name of await listFiles(dists(""), rel => path.basename(rel) === "by-hash")) {
        if (name.endsWith(".gz")) {
            const data = await fs.readFile(dists(name));
            const raw = gunzipSync(data);
            entries[name] = [sha256(data), data.length];
            entries[name.slice(0, -".gz".length)] = [sha256(raw), raw.length];
        }
    }
    return entries;
}

/** What repomd.xml lists */
async function repomdSha256(): Promise<Published> {
    const field = (block: string, open: string, close: string): string => {
        const at = block.indexOf(open) + open.length;
        return block.slice(at, block.indexOf(close, at));
    };
    const blocks = (await fs.readFile(repoFile(REPOMD), "utf8")).split('<data type="').slice(1);
    return Object.fromEntries(blocks.map(block => [
        field(block, '<location href="', '"'), [field(block, '<checksum type="sha256">', "<"), Number(field(block, "<size>", "<"))],
    ]));
}

/** The metadata files of fedora/42 the database names, as they hash */
async function rpmIndexes(): Promise<Published> {
    const rows = query("SELECT stored_path FROM index_files i JOIN releases r ON r.id = i.release_id WHERE r.format = 'rpm'") as { stored_path: string }[];
    const entries: Published = {};
    for (const { stored_path: stored } of rows) {
        const data = await fs.readFile(repoFile(stored));
        entries[`repodata/${ path.basename(stored) }`] = [sha256(data), data.length];
    }
    return entries;
}

async function expectSignedDeb(): Promise<void> {
    const key = (await loadSigningKey(KEY_FILE))!;
    const text = await fs.readFile(dists("Release"), "utf8");
    expect(await verifyClearsigned(await fs.readFile(dists("InRelease"), "utf8"), text, key)).toBe(true);
    expect(await verifyDetached(text, await fs.readFile(dists("Release.gpg"), "utf8"), key)).toBe(true);
}

async function expectSignedRpm(): Promise<void> {
    const key = (await loadSigningKey(KEY_FILE))!;
    const text = await fs.readFile(repoFile(REPOMD), "utf8");
    expect(await verifyDetached(text, await fs.readFile(repoFile(`${ REPOMD }.asc`), "utf8"), key)).toBe(true);
}

/** A directory at the temp name fails an atomic write for real and leaves the file as it is; returns how to lift it */
async function blockWrite(file: string): Promise<() => Promise<void>> {
    const temp = `${ file }.tmp-${ process.pid }`;
    await fs.mkdir(temp);
    return () => fs.rmdir(temp);
}

/** As if every removal and supersession happened long before the grace */
function age(): void {
    const db = new Database(osPath.join(PATHS.repoStateDir, "repo.db"));
    try {
        db.exec("UPDATE pool_files SET removed_at = 1 WHERE removed_at IS NOT NULL; UPDATE superseded_files SET superseded_at = 1");
    } finally {
        db.close();
    }
}

/** Opens the backend and hands back the callback of its GC timer */
async function openWithGcTick(): Promise<{ backend: Backend; tick: () => void }> {
    const interval = jest.spyOn(globalThis, "setInterval");
    try {
        const backend = await open();
        return { backend, tick: interval.mock.calls.find(([, ms]) => ms === GC_INTERVAL_MS)![0] as () => void };
    } finally {
        interval.mockRestore();
    }
}

/** Fires the tick and waits until its failure is logged */
async function failingTick(tick: () => void): Promise<void> {
    const logged = Promise.withResolvers<void>();
    const spy = jest.spyOn(logger, "error").mockImplementation(() => {
        logged.resolve();
        return logger;
    });
    try {
        tick();
        await logged.promise;
    } finally {
        spy.mockRestore();
    }
}

function packagesIndex(): { stored_path: string; sha256: string; generation: number } {
    const [row] = query(`
        SELECT i.stored_path, i.sha256, i.generation FROM index_files i JOIN releases r ON r.id = i.release_id
            WHERE r.distro = 'debian' AND r.name = 'trixie' AND i.kind = 'packages' AND i.architecture = 'amd64'`);
    return row as { stored_path: string; sha256: string; generation: number };
}

function sources(backend: Backend): string[] {
    return backend.listSourcePackages({}).items.map(i => `${ i.format }/${ i.distribution }/${ i.release } ${ i.source } ${ i.version }`);
}

async function removeDatabase(): Promise<void> {
    for (const suffix of ["", "-wal", "-shm"]) {
        await fs.rm(osPath.join(PATHS.repoStateDir, `repo.db${ suffix }`), { force: true });
    }
}

const DEB_REF: Ref = { format: "deb", distribution: "debian", release: "trixie" };
const RPM_REF: Ref = { format: "rpm", distribution: "fedora", release: "42" };

const windowsTest = process.platform === "win32" ? test : test.skip;

describe("Tests for the backend facade", () => {
    test("The start logs the algorithm and fingerprint of the key that signs", withLocalTmpDir(async () => {
        const info = jest.spyOn(logger, "info");
        try {
            const backend = await open();
            expect(info).toHaveBeenCalledWith(`Signing repository metadata with ${ await describeSigningKey((await loadSigningKey(KEY_FILE))!) }`);
            await backend.close();
        } finally {
            info.mockRestore();
        }
    }));

    test("Import then list returns the fixture source and files", withLocalTmpDir(async () => {
        const debNames = await stage(TRIXIE);
        const rpmNames = await stage(RPMS);
        const backend = await open();
        expect(await openBackend(PATHS, KEY_FILE)).toBe(backend);
        expect(getBackend(PATHS.repoStateDir)).toBe(backend);
        const staged = osJoin(PATHS.incomingDir, "staging", TRIXIE.target, AMD64_DEB);
        backend.recordStagedDigest(`${ TRIXIE.target }/${ AMD64_DEB }`, await fs.stat(staged), await hashFile(staged));
        expect(query("SELECT rel_path FROM staged_digests")).toEqual([{ rel_path: `${ TRIXIE.target }/${ AMD64_DEB }` }]);

        const result = await backend.importStaged();

        expect(result.ok).toBe(true);
        expect(result.files.map(f => `${ f.path } ${ f.status }`).sort()).toEqual([
            ...debNames.map(n => `${ TRIXIE.target }/${ n } ok`), ...rpmNames.map(n => `${ RPMS.target }/${ n } ok`),
        ].sort());
        expect(query("SELECT rel_path FROM staged_digests")).toEqual([]);
        expect(backend.listRepositories()).toEqual([DEB_REF, RPM_REF]);
        expect(backend.listRepositories({ format: "rpm" })).toEqual([RPM_REF]);
        expect(backend.listRepositories({ distribution: "ubuntu" })).toEqual([]);
        expect(backend.listSourcePackages({})).toEqual({ items: [
            { ...DEB_REF, source: "srm-hello", version: "1.0-1" }, { ...RPM_REF, source: "srm-hello", version: "1.0-1.fc42" },
        ] });
        const first = backend.listSourcePackages({}, { limit: 1 });
        expect(first.items).toEqual([{ ...DEB_REF, source: "srm-hello", version: "1.0-1" }]);
        expect(first.nextCursor).toBeDefined();
        expect(backend.listSourcePackages({}, { limit: 1, cursor: first.nextCursor })).toEqual({ items: [{ ...RPM_REF, source: "srm-hello", version: "1.0-1.fc42" }] });
        expect(backend.listSourcePackages({ format: "deb" }, { limit: 1 })).toEqual({ items: [{ ...DEB_REF, source: "srm-hello", version: "1.0-1" }] });
        // A page ending exactly at the deb boundary gets no cursor when rpm has nothing for the filter
        expect(backend.listPackageFiles({ source: "srm-hello", release: "trixie" }, { limit: debNames.length }).nextCursor).toBeUndefined();
        expect(backend.listSourcePackages({ format: "deb", source: "srm-zst" })).toEqual({ items: [] });
        expect(() => backend.listSourcePackages({}, { cursor: "nonsense" })).toThrow(/cursor/i);
        expect(backend.listPackageFiles({ source: "srm-hello" })).toEqual({ items: [
            ...debNames.map(n => ({ ...DEB_REF, path: `${ DEB_POOL }/${ n }`, filename: n })),
            ...rpmNames.map(n => ({ ...RPM_REF, path: `${ RPM_POOL }/${ n }`, filename: n })),
        ] });
        expect(backend.listPackageFiles({ format: "rpm", source: "srm-hello", version: "1.0-1.fc42" }).items).toHaveLength(3);
        expect(backend.repositoryTree()).toEqual({
            deb: [{ distro: "debian", release: "trixie", components: ["main"], architectures: ["amd64"] }], rpm: [{ distro: "fedora", release: "42" }],
        });
        for (const name of [...debNames.map(n => `${ DEB_POOL }/${ n }`), ...rpmNames.map(n => `${ RPM_POOL }/${ n }`)]) {
            expect(await exists(repoFile(name))).toBe(true);
        }
        expect(await exists(dists("InRelease"))).toBe(true);
        expect(await exists(repoFile("rpm/fedora/42/repodata/repomd.xml.asc"))).toBe(true);
        expect(await exists(osJoin(PATHS.incomingDir, "staging", TRIXIE.target, AMD64_DEB))).toBe(false);
    }));

    test("A read during an import returns committed state without waiting", withLocalTmpDir(async () => {
        await stage(TRIXIE);
        const backend = await open();
        await backend.importStaged();
        await stage(NOBLE);

        // Held at the first link of the publish: the upload is committed, the release it creates not yet published
        const held = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const link = fs.link;
        const spy = jest.spyOn(fs, "link").mockImplementation(async (from, to) => {
            held.resolve();
            await resume.promise;
            return link(from, to);
        });
        let during: string[];
        let published: boolean;
        let settled = false;
        let result: Awaited<ReturnType<Backend["importStaged"]>>;
        try {
            const importing = backend.importStaged().finally(() => {
                settled = true;
            });
            await held.promise;
            during = sources(backend);
            published = await exists(dists("Release", "ubuntu", "noble"));
            expect(settled).toBe(false);
            resume.resolve();
            result = await importing;
        } finally {
            resume.resolve();
            spy.mockRestore();
        }

        expect(during).toEqual(["deb/debian/trixie srm-hello 1.0-1", "deb/ubuntu/noble srm-zst 2:3.0-1"]);
        expect(published).toBe(false);
        expect(result.ok).toBe(true);
        expect(await exists(dists("Release", "ubuntu", "noble"))).toBe(true);
    }));

    test("A hostile bundle fails, stays in incoming/process and fails again at the next start, which still opens", withLocalTmpDir(async () => {
        const leftovers = osJoin(PATHS.incomingDir, "process", TRIXIE.target);
        await stageBomb();
        await stage(TRIXIE);
        const backend = await open();

        const result = await backend.importStaged();

        expect(result.ok).toBe(false);
        const hostile = result.files.filter(f => f.status === "failed");
        expect(hostile.map(f => f.filename).sort()).toEqual([BOMB_CHANGES, BOMB_DEB]);
        expect(hostile[0].reason).toContain(`${ BOMB_DEB }: control.tar: tar entry "./PaxHeaders/x" holds ${ MIB + 1 } bytes, over the ${ MIB } limit`);
        expect((await fs.readdir(leftovers)).sort()).toEqual([BOMB_CHANGES, BOMB_DEB]);
        expect(sources(backend)).toEqual(["deb/debian/trixie srm-hello 1.0-1"]);
        await backend.close();

        const info = jest.spyOn(logger, "info");
        let reopened: Backend;
        let lines: string[];
        try {
            reopened = await open();
            lines = info.mock.calls.map(([message]) => String(message));
        } finally {
            info.mockRestore();
        }

        expect(lines).toContain("incoming/process: 0 file(s) imported, 0 skipped, 2 failed");
        expect(getBackend(PATHS.repoStateDir)).toBe(reopened);
        expect((await fs.readdir(leftovers)).sort()).toEqual([BOMB_CHANGES, BOMB_DEB]);
        expect(sources(reopened)).toEqual(["deb/debian/trixie srm-hello 1.0-1"]);

        const noble = await stage(NOBLE);
        const next = await reopened.importStaged();

        expect(next.files.filter(f => f.status === "ok").map(f => f.filename).sort()).toEqual(noble);
        expect(next.files.filter(f => f.status === "failed").map(f => f.filename).sort()).toEqual([BOMB_CHANGES, BOMB_DEB]);
        expect(sources(reopened)).toEqual(["deb/debian/trixie srm-hello 1.0-1", "deb/ubuntu/noble srm-zst 2:3.0-1"]);
    }));

    test("A hostile rpm fails, stays in incoming/process and fails again at the next start, which still opens", withLocalTmpDir(async () => {
        const leftovers = osJoin(PATHS.incomingDir, "process", RPMS.target);
        await stageHostileRpm();
        await stage(TRIXIE);
        const backend = await open();

        const result = await backend.importStaged();

        expect(result.ok).toBe(false);
        const hostile = result.files.filter(f => f.status === "failed");
        expect(hostile.map(f => f.filename)).toEqual([HOSTILE_RPM]);
        expect(hostile[0].reason).toContain(`${ HOSTILE_RPM }: header tag 1047 holds a string of ${ MIB + 1 } bytes, over the ${ MIB } limit`);
        expect(await fs.readdir(leftovers)).toEqual([HOSTILE_RPM]);
        expect(sources(backend)).toEqual(["deb/debian/trixie srm-hello 1.0-1"]);
        await backend.close();

        const info = jest.spyOn(logger, "info");
        let reopened: Backend;
        let lines: string[];
        try {
            reopened = await open();
            lines = info.mock.calls.map(([message]) => String(message));
        } finally {
            info.mockRestore();
        }

        expect(lines).toContain("incoming/process: 0 file(s) imported, 0 skipped, 1 failed");
        expect(getBackend(PATHS.repoStateDir)).toBe(reopened);
        expect(await fs.readdir(leftovers)).toEqual([HOSTILE_RPM]);
        expect(sources(reopened)).toEqual(["deb/debian/trixie srm-hello 1.0-1"]);
    }));

    test("Restart repairs a canonical link that points to the previous generation", withLocalTmpDir(async () => {
        await stage(TRIXIE);
        const backend = await open();
        await backend.importStaged();
        const first = packagesIndex();
        const removed = await backend.remove({ source: "srm-hello" });
        expect(removed.files.map(f => f.status)).toEqual(Array<string>(7).fill("ok"));
        expect(removed.touchedTargets).toBe(1);
        const second = packagesIndex();
        expect(second).toMatchObject({ generation: 2 });
        expect(second.stored_path).not.toBe(first.stored_path);
        // Written beside and renamed over, as a crashed publish would leave it: the stored file keeps its own inode
        const canonical = dists("main/binary-amd64/Packages.gz");
        await fs.copyFile(repoFile(first.stored_path), `${ canonical }.old`);
        await fs.rename(`${ canonical }.old`, canonical);
        expect(sha256(await fs.readFile(canonical))).toBe(first.sha256);
        await backend.close();

        const reopened = await open();

        expect(reopened).not.toBe(backend);
        expect(await inode(canonical)).toBe(await inode(repoFile(second.stored_path)));
        expect(sha256(await fs.readFile(canonical))).toBe(second.sha256);
        const listed = await releaseSha256();
        expect(listed["main/binary-amd64/Packages.gz"][0]).toBe(second.sha256);
        expect(listed["main/binary-amd64/Packages"][0]).toBe(SHA256_EMPTY);
        for (const [name, [hash, size]] of Object.entries(listed)) {
            if (name.endsWith(".gz")) {
                const data = await fs.readFile(dists(name));
                expect([sha256(data), data.length]).toEqual([hash, size]);
                expect(await exists(dists(`${ osPath.posix.dirname(name) }/by-hash/SHA256/${ hash }`))).toBe(true);
            }
        }
        expect(sources(reopened)).toEqual([]);
    }));

    test("Missing repo.db with an existing tree triggers rebuild", withLocalTmpDir(async () => {
        await stage(TRIXIE);
        await stage(RPMS);
        const backend = await open();
        await backend.importStaged();
        const before = sources(backend);
        const files = backend.listPackageFiles({ source: "srm-hello" }).items.map(f => f.path);
        await backend.close();
        await removeDatabase();

        const rebuilt = await open();

        expect(sources(rebuilt)).toEqual(before);
        expect(rebuilt.listPackageFiles({ source: "srm-hello" }).items.map(f => f.path)).toEqual(files);
        expect(await exists(osPath.join(PATHS.repoStateDir, "repo.db"))).toBe(true);
        expect(await exists(dists("InRelease"))).toBe(true);
        await rebuilt.close();

        await removeDatabase();
        await fs.truncate(repoFile(`${ DEB_POOL }/${ AMD64_DEB }`), 10);
        const errorSpy = jest.spyOn(logger, "error").mockReturnValue(logger);
        try {
            await expect(open()).rejects.toThrow(/problem/);
            expect(errorSpy.mock.calls.map(([message]) => String(message)).some(m => m.includes(AMD64_DEB))).toBe(true);
        } finally {
            errorSpy.mockRestore();
        }
        expect(() => getBackend(PATHS.repoStateDir)).toThrow(/state/);
        expect(await exists(osPath.join(PATHS.repoStateDir, "repo.db"))).toBe(false);
    }));

    test("importStaged and remove called concurrently run one after the other", withLocalTmpDir(async () => {
        const debNames = await stage(TRIXIE);
        const rpmNames = await stage(RPMS);
        const backend = await open();
        const order: string[] = [];

        const importing = backend.importStaged().then(r => {
            order.push("import");
            return r;
        });
        const removing = backend.remove({ source: "srm-hello", immediate: true }).then(r => {
            order.push("remove");
            return r;
        });
        const [imported, removed] = await Promise.all([importing, removing]);

        expect(order).toEqual(["import", "remove"]);
        expect(imported.ok).toBe(true);
        expect(imported.files).toHaveLength(debNames.length + rpmNames.length);
        expect(removed.touchedTargets).toBe(2);
        expect(removed.files.map(f => `${ f.path } ${ f.status }`).sort()).toEqual([
            ...debNames.map(n => `${ DEB_POOL }/${ n } ok`), ...rpmNames.map(n => `${ RPM_POOL }/${ n } ok`),
        ].sort());
        for (const f of removed.files) {
            expect(await exists(repoFile(f.path))).toBe(false);
        }
        expect(sources(backend)).toEqual([]);
        expect(query("SELECT count(*) AS n FROM pool_files")).toEqual([{ n: 0 }]);
        expect((await releaseSha256())["main/binary-amd64/Packages"][0]).toBe(SHA256_EMPTY);
    }));

    test("Immediate removal deletes the directories it leaves empty, up to the pool roots", withLocalTmpDir(async () => {
        await stage(TRIXIE);
        const nobleNames = await stage(NOBLE);
        await stage(RPMS);
        const backend = await open();
        await backend.importStaged();

        await backend.remove({ source: "srm-hello", immediate: true });

        expect(await fs.readdir(repoFile("deb/debian/pool"))).toEqual([]);
        expect(await fs.readdir(repoFile("rpm/fedora/42/Packages"))).toEqual([]);
        expect(await fs.readdir(repoFile("deb/ubuntu/pool/universe/s/srm-zst"))).toEqual(nobleNames);
    }));

    test("A source with upper case goes through import, publish, listing and removal in a lower-case directory, its file name exact", withLocalTmpDir(async () => {
        const name = "NetworkManager-1.56.0-1.fc42.x86_64.rpm";
        const file = `rpm/fedora/42/Packages/n/networkmanager/${ name }`;
        const rpm = await fs.readFile(osPath.join(RPMS.dir, "srm-hello-1.0-1.fc42.x86_64.rpm"));
        // A SOURCERPM of the same length keeps the header readable
        rpm.write("NetworkManager-1-1.1.src.rpm", rpm.indexOf("srm-hello-1.0-1.fc42.src.rpm"), "latin1");
        await fs.mkdir(osJoin(PATHS.incomingDir, "staging", RPMS.target), { recursive: true });
        await fs.writeFile(osJoin(PATHS.incomingDir, "staging", RPMS.target, name), rpm);
        const backend = await open();

        expect(await backend.importStaged()).toEqual({ ok: true, files: [{ filename: name, path: `${ RPMS.target }/${ name }`, status: "ok" }] });

        expect(await fs.readdir(repoFile("rpm/fedora/42/Packages"))).toEqual(["n"]);
        expect(await fs.readdir(repoFile("rpm/fedora/42/Packages/n"))).toEqual(["networkmanager"]);
        expect(await fs.readdir(repoFile("rpm/fedora/42/Packages/n/networkmanager"))).toEqual([name]);
        const primary = async (): Promise<string> => {
            const [row] = query("SELECT stored_path FROM index_files WHERE kind = 'primary'") as { stored_path: string }[];
            return zstdDecompressSync(await fs.readFile(repoFile(row.stored_path))).toString("utf8");
        };
        expect(await primary()).toContain(`<location href="Packages/n/networkmanager/${ name }"/>`);
        expect(backend.listSourcePackages({ source: "NetworkManager" })).toEqual({ items: [{ ...RPM_REF, source: "NetworkManager", version: "1-1.1" }] });
        expect(backend.listPackageFiles({ source: "NetworkManager" })).toEqual({ items: [{ ...RPM_REF, path: file, filename: name }] });

        expect(await backend.remove({ source: "NetworkManager", immediate: true })).toEqual({ files: [{ filename: name, path: file, status: "ok" }], touchedTargets: 1 });

        expect(await exists(repoFile(file))).toBe(false);
        expect(await primary()).not.toContain(name);
        expect(sources(backend)).toEqual([]);
    }));

    test("A directory that cannot be removed leaves an immediate removal ok", withLocalTmpDir(async () => {
        const debNames = await stage(TRIXIE);
        const backend = await open();
        await backend.importStaged();
        const busy = Object.assign(new Error("resource busy"), { code: "EBUSY" });
        const rmdirSpy = jest.spyOn(fs, "rmdir").mockRejectedValue(busy);
        const warnSpy = jest.spyOn(logger, "warn").mockReturnValue(logger);
        try {
            const removed = await backend.remove({ source: "srm-hello", immediate: true });
            expect(removed.files.map(f => `${ f.path } ${ f.status }`)).toEqual(debNames.map(n => `${ DEB_POOL }/${ n } ok`));
            expect(warnSpy).toHaveBeenCalledWith(`Empty directories above ${ DEB_POOL }/${ debNames[0] } could not be removed`, { err: busy });
        } finally {
            rmdirSpy.mockRestore();
            warnSpy.mockRestore();
        }
        expect(await fs.readdir(repoFile(DEB_POOL))).toEqual([]);
    }));

    test("A publish failure in immediate mode keeps the rows removed, so GC deletes the files once a publish succeeds", withLocalTmpDir(async () => {
        const debNames = await stage(TRIXIE);
        const backend = await open();
        await backend.importStaged();
        const paths = debNames.map(n => `${ DEB_POOL }/${ n }`);
        // A file where the publisher's temp directory belongs
        await fs.rm(osJoin(PATHS.repoStateDir, "tmp"), { recursive: true, force: true });
        await fs.writeFile(osJoin(PATHS.repoStateDir, "tmp"), "");

        await expect(backend.remove({ source: "srm-hello", immediate: true })).rejects.toThrow(/EEXIST/);

        for (const p of paths) {
            expect(await exists(repoFile(p))).toBe(true);
        }
        const rows = query("SELECT path, removed_at FROM pool_files ORDER BY path");
        expect(rows).toEqual(paths.map(p => ({ path: p, removed_at: expect.any(Number) })));
        // Until a publish succeeds the published indexes still list the files
        await fs.rm(osJoin(PATHS.repoStateDir, "tmp"));
        age();
        expect((await backend.importStaged()).ok).toBe(true);
        expect(query("SELECT DISTINCT removed_at > 1 AS restarted FROM pool_files")).toEqual([{ restarted: 1 }]);
        await backend.close();
        const db = openDatabase(osJoin(PATHS.repoStateDir, "repo.db"));
        try {
            const later = (query("SELECT max(removed_at) AS at FROM pool_files")[0].at as number) + GC_GRACE_SECONDS;
            expect((await runGc({ db, paths: PATHS, signingKey: undefined, now: () => later })).pool).toEqual(paths);
        } finally {
            db.close();
        }
        for (const p of paths) {
            expect(await exists(repoFile(p))).toBe(false);
        }
    }));

    test("close() during a running import waits for it", withLocalTmpDir(async () => {
        await stage(TRIXIE);
        const backend = await open();
        const order: string[] = [];

        const importing = backend.importStaged().then(r => {
            order.push("import");
            return r;
        });
        const closing = backend.close().then(() => order.push("close"));
        await Promise.all([importing, closing]);

        expect(order).toEqual(["import", "close"]);
        expect((await importing).ok).toBe(true);
        expect(await exists(dists("InRelease"))).toBe(true);
        expect(() => getBackend(PATHS.repoStateDir)).toThrow(/state/);
        await expect(backend.importStaged()).rejects.toThrow(/closed/);
        expect(() => backend.listRepositories()).toThrow(/closed/);
        await backend.close();
    }));

    test("close() waits for an import still queued behind the running one", withLocalTmpDir(async () => {
        await stage(TRIXIE);
        const backend = await open();
        const order: string[] = [];
        const note = (name: string) => (): void => {
            order.push(name);
        };

        const first = backend.importStaged();
        const second = backend.importStaged();
        const closing = backend.close();
        void first.then(note("first"), note("first"));
        void second.then(note("second"), note("second"));
        void closing.then(note("close"));
        await Promise.allSettled([first, second, closing]);

        expect(order).toEqual(["first", "second", "close"]);
        expect((await first).files.map(f => f.status)).toEqual(Array<string>(7).fill("ok"));
        expect(await second).toEqual({ ok: true, files: [] });
        expect(await exists(dists("InRelease"))).toBe(true);
        expect(() => getBackend(PATHS.repoStateDir)).toThrow(/state/);
        await expect(backend.importStaged()).rejects.toThrow(/closed/);
    }));

    test("close() waits for an import still waiting for an upload move", withLocalTmpDir(async () => {
        await stage(TRIXIE);
        const backend = await open();
        const gate = Promise.withResolvers<void>();
        const moving = lock.forMove(() => gate.promise);
        const order: string[] = [];

        const importing = backend.importStaged();
        const closing = backend.close();
        void importing.then(() => order.push("import"), () => order.push("import"));
        void closing.then(() => order.push("close"));
        expect(order).toEqual([]);
        gate.resolve();
        await moving;
        await Promise.allSettled([importing, closing]);

        expect(order).toEqual(["import", "close"]);
        expect((await importing).ok).toBe(true);
        expect(await exists(osJoin(PATHS.incomingDir, "staging", TRIXIE.target, AMD64_DEB))).toBe(false);
        expect(await exists(dists("InRelease"))).toBe(true);
    }));

    test("openBackend for a directory whose backend is still closing waits for that close", withLocalTmpDir(async () => {
        await stage(TRIXIE);
        const backend = await open();
        const order: string[] = [];

        const importing = backend.importStaged();
        const closing = backend.close();
        const reopening = openBackend(PATHS, KEY_FILE);
        void closing.then(() => order.push("close"));
        void reopening.then(() => order.push("open"), () => order.push("open"));
        const reopened = await reopening;

        expect(order).toEqual(["close", "open"]);
        expect(reopened).not.toBe(backend);
        expect(getBackend(PATHS.repoStateDir)).toBe(reopened);
        expect(await openBackend(PATHS, KEY_FILE)).toBe(reopened);
        expect((await importing).ok).toBe(true);
        expect(sources(reopened)).toEqual(["deb/debian/trixie srm-hello 1.0-1"]);
    }));

    test("A configured key file that does not exist warns, keeps earlier signatures and publishes unsigned", withLocalTmpDir(async () => {
        await stage(TRIXIE);
        const signed = await open();
        await signed.importStaged();
        const inRelease = await fs.readFile(dists("InRelease"), "utf8");
        await signed.close();
        const warnSpy = jest.spyOn(logger, "warn").mockReturnValue(logger);
        let backend: Backend;
        try {
            backend = await open("missing.asc");
            expect(warnSpy).toHaveBeenCalledWith("GPG key file missing.asc does not exist.");
        } finally {
            warnSpy.mockRestore();
        }
        expect(await fs.readFile(dists("InRelease"), "utf8")).toBe(inRelease);

        await stage(NOBLE);
        expect((await backend.importStaged()).ok).toBe(true);

        expect(await exists(dists("Release", "ubuntu", "noble"))).toBe(true);
        expect(await exists(dists("InRelease", "ubuntu", "noble"))).toBe(false);
        expect(await fs.readFile(dists("InRelease"), "utf8")).toBe(inRelease);
    }));
});

describe.each([
    {
        format: "deb", bundle: TRIXIE, pool: DEB_POOL, file: () => dists("Release"),
        listed: () => releaseSha256(), indexes: debIndexes, expectSigned: expectSignedDeb,
    },
    {
        format: "rpm", bundle: RPMS, pool: RPM_POOL, file: () => repoFile(REPOMD),
        listed: repomdSha256, indexes: rpmIndexes, expectSigned: expectSignedRpm,
    },
])("Tests for the repair after a failed publish, $format", c => {
    /** The published file is still the given one and names other indexes than the committed ones */
    async function expectStale(stale: Buffer): Promise<void> {
        expect(await fs.readFile(c.file())).toEqual(stale);
        expect(await c.listed()).not.toEqual(await c.indexes());
    }

    async function expectInOrder(): Promise<void> {
        expect(await c.listed()).toEqual(await c.indexes());
        await c.expectSigned();
    }

    test("The next import repairs it, and one that fails again keeps the state", withLocalTmpDir(async () => {
        await stage(c.bundle);
        const backend = await open();
        await backend.importStaged();
        await expectInOrder();
        await backend.remove({ source: "srm-hello", immediate: true });
        await expectInOrder();
        const stale = await fs.readFile(c.file());
        const unblock = await blockWrite(c.file());
        await stage(c.bundle);

        await expect(backend.importStaged()).rejects.toThrow();

        const committed = await c.indexes();
        await expectStale(stale);
        expect(sources(backend)).toHaveLength(1);

        await expect(backend.importStaged()).rejects.toThrow();

        await expectStale(stale);
        expect(await c.indexes()).toEqual(committed);

        await unblock();
        expect(await backend.importStaged()).toEqual({ ok: true, files: [] });

        expect(await c.indexes()).toEqual(committed);
        await expectInOrder();
    }));

    test("The next removal repairs it and restarts the grace once", withLocalTmpDir(async () => {
        const names = await stage(c.bundle);
        const backend = await open();
        await backend.importStaged();
        const stale = await fs.readFile(c.file());
        const unblock = await blockWrite(c.file());

        await expect(backend.remove({ source: "srm-hello", immediate: true })).rejects.toThrow();

        await expectStale(stale);
        for (const name of names) {
            expect(await exists(repoFile(`${ c.pool }/${ name }`))).toBe(true);
        }

        await unblock();
        age();
        expect(await backend.remove({ source: "nothing" })).toEqual({ files: [], touchedTargets: 0 });

        await expectInOrder();
        expect(query("SELECT DISTINCT removed_at > 1 AS restarted FROM pool_files")).toEqual([{ restarted: 1 }]);

        // Nothing is due any more: a later publish leaves the grace alone
        age();
        expect(await backend.importStaged()).toEqual({ ok: true, files: [] });
        expect(query("SELECT DISTINCT removed_at FROM pool_files")).toEqual([{ removed_at: 1 }]);
    }));

    test("The hourly tick repairs it, and while it cannot it collects nothing", withLocalTmpDir(async () => {
        const names = await stage(c.bundle);
        const { backend, tick } = await openWithGcTick();
        await backend.importStaged();
        const stale = await fs.readFile(c.file());
        const unblock = await blockWrite(c.file());
        await expect(backend.remove({ source: "srm-hello" })).rejects.toThrow();
        const superseded = query("SELECT path FROM superseded_files").map(row => row.path as string);
        expect(superseded).not.toEqual([]);
        age();

        await failingTick(tick);

        await expectStale(stale);
        expect(query("SELECT DISTINCT removed_at FROM pool_files")).toEqual([{ removed_at: 1 }]);
        for (const rel of [...names.map(name => `${ c.pool }/${ name }`), ...superseded]) {
            expect(await exists(repoFile(rel))).toBe(true);
        }

        await unblock();
        tick();
        await backend.close();

        await expectInOrder();
        for (const name of names) {
            expect(await exists(repoFile(`${ c.pool }/${ name }`))).toBe(true);
        }
        const [{ at }] = query("SELECT max(removed_at) AS at FROM pool_files") as { at: number }[];
        expect(at).toBeGreaterThan(1);

        const db = openDatabase(osJoin(PATHS.repoStateDir, "repo.db"));
        try {
            const later = at + GC_GRACE_SECONDS;
            expect((await runGc({ db, paths: PATHS, signingKey: undefined, now: () => later })).pool).toHaveLength(names.length);
        } finally {
            db.close();
        }
    }));

    test("After a failure longer than the grace, the old index files stay a full grace from the repair", withLocalTmpDir(async () => {
        await stage(c.bundle);
        const { backend, tick } = await openWithGcTick();
        await backend.importStaged();
        const stale = await c.listed();
        const unblock = await blockWrite(c.file());
        await expect(backend.remove({ source: "srm-hello" })).rejects.toThrow();
        const old = query("SELECT path FROM superseded_files ORDER BY path").map(row => row.path as string);
        expect(old).not.toEqual([]);
        age();

        await unblock();
        tick();
        await backend.close();

        await expectInOrder();
        expect(await c.listed()).not.toEqual(stale);
        for (const rel of old) {
            expect(await exists(repoFile(rel))).toBe(true);
        }
        const [{ at }] = query("SELECT DISTINCT superseded_at AS at FROM superseded_files") as { at: number }[];
        expect(at).toBeGreaterThan(1);

        const db = openDatabase(osJoin(PATHS.repoStateDir, "repo.db"));
        try {
            const ctx = { db, paths: PATHS, signingKey: undefined };
            expect((await runGc({ ...ctx, now: () => at + GC_GRACE_SECONDS - 1 })).index).toEqual([]);
            for (const rel of old) {
                expect(await exists(repoFile(rel))).toBe(true);
            }
            expect((await runGc({ ...ctx, now: () => at + GC_GRACE_SECONDS })).index).toEqual(old);
        } finally {
            db.close();
        }
        for (const rel of old) {
            expect(await exists(repoFile(rel))).toBe(false);
        }
    }));

    windowsTest("A reader that does not share delete fails the publish until it is gone", withLocalTmpDir(async () => {
        await stage(c.bundle);
        const backend = await open();
        await backend.importStaged();
        const stale = await fs.readFile(c.file());
        const reader = await fs.open(c.file(), WINDOWS_EXCLUSIVE);
        try {
            await expect(backend.remove({ source: "srm-hello" })).rejects.toThrow(/EBUSY/);
            await expect(backend.importStaged()).rejects.toThrow(/EBUSY/);
        } finally {
            await reader.close();
        }
        await expectStale(stale);

        expect(await backend.importStaged()).toEqual({ ok: true, files: [] });

        await expectInOrder();
    }));
});

describe("Tests for the repair after a failed publish", () => {
    test("A failure stops the publish, and the tick finishes what it did not reach", withLocalTmpDir(async () => {
        await stage(TRIXIE);
        await stage(RPMS);
        const { backend, tick } = await openWithGcTick();
        await backend.importStaged();
        const repomd = await fs.readFile(repoFile(REPOMD));
        const unblock = await blockWrite(dists("Release"));

        await expect(backend.remove({ source: "srm-hello" })).rejects.toThrow();

        expect(await releaseSha256()).not.toEqual(await debIndexes());
        expect(await fs.readFile(repoFile(REPOMD))).toEqual(repomd);
        expect(query("SELECT count(*) AS n FROM dirty_keys")).not.toEqual([{ n: 0 }]);

        await unblock();
        tick();
        await backend.close();

        expect(await releaseSha256()).toEqual(await debIndexes());
        expect(await repomdSha256()).toEqual(await rpmIndexes());
        expect(query("SELECT count(*) AS n FROM dirty_keys")).toEqual([{ n: 0 }]);
    }));

    test("A canonical name that could not be placed after the commit is linked again", withLocalTmpDir(async () => {
        await stage(TRIXIE);
        const backend = await open();
        await backend.importStaged();
        const canonical = dists("main/binary-amd64/Packages.gz");
        const unblock = await blockWrite(canonical);

        await expect(backend.remove({ source: "srm-hello" })).rejects.toThrow();

        const committed = packagesIndex();
        expect(committed.generation).toBe(2);
        expect(sha256(await fs.readFile(canonical))).not.toBe(committed.sha256);

        await unblock();
        expect(await backend.importStaged()).toEqual({ ok: true, files: [] });

        expect(sha256(await fs.readFile(canonical))).toBe(committed.sha256);
        expect(await releaseSha256()).toEqual(await debIndexes());
    }));

    test("With a configured key file that is missing, the repair keeps the earlier signatures", withLocalTmpDir(async () => {
        await stage(TRIXIE);
        await stage(RPMS);
        const signed = await open();
        await signed.importStaged();
        const inRelease = await fs.readFile(dists("InRelease"), "utf8");
        const repomdSignature = await fs.readFile(repoFile(`${ REPOMD }.asc`), "utf8");
        await signed.close();
        const warnSpy = jest.spyOn(logger, "warn").mockReturnValue(logger);
        let backend: Backend;
        try {
            backend = await open("missing.asc");
        } finally {
            warnSpy.mockRestore();
        }
        await stage(NOBLE);
        await fs.mkdir(dists("", "ubuntu", "noble"), { recursive: true });
        const unblock = await blockWrite(dists("Release", "ubuntu", "noble"));
        await expect(backend.importStaged()).rejects.toThrow();
        expect(await exists(dists("Release", "ubuntu", "noble"))).toBe(false);

        await unblock();
        expect(await backend.importStaged()).toEqual({ ok: true, files: [] });

        expect(await exists(dists("Release", "ubuntu", "noble"))).toBe(true);
        expect(await fs.readFile(dists("InRelease"), "utf8")).toBe(inRelease);
        expect(await fs.readFile(repoFile(`${ REPOMD }.asc`), "utf8")).toBe(repomdSignature);
    }));
});

const CASE_INSENSITIVE = { caseSensitive: false, shortNames: false };
const CASE_SENSITIVE = { caseSensitive: true, shortNames: false };

function processPath(relPath: string): string {
    return osJoin(PATHS.incomingDir, "process", relPath);
}

describe("Tests for a start where case does not count", () => {
    afterEach(resetFileNaming);

    /** Imported where case counts, as a volume that tells case apart leaves it */
    async function importInSpelling(bundle: { dir: string; target: string }): Promise<void> {
        setFileNaming(CASE_SENSITIVE);
        await stage(bundle);
        const backend = await open();
        expect((await backend.importStaged()).ok).toBe(true);
        await backend.close();
    }

    test.each<[string, typeof TRIXIE, string]>([
        ["a distribution of rpm", { ...RPMS, target: "rpm/Fedora/42" }, "rpm/Fedora/42"],
        ["a release of rpm", { ...RPMS, target: "rpm/fedora/Rawhide" }, "rpm/fedora/Rawhide"],
        ["a distribution of deb", { ...TRIXIE, target: "deb/Debian/trixie/main" }, "deb/Debian/trixie"],
        ["a component of deb", { ...TRIXIE, target: "deb/debian/trixie/Main" }, "deb/debian/trixie/Main"],
        ["a sub-component of deb", { ...TRIXIE, target: "deb/debian/trixie/updates/Main" }, "deb/debian/trixie/updates/Main"],
        ["a distribution with a Kelvin sign", { ...RPMS, target: `rpm/${ String.fromCodePoint(0x212A) }ali/42` }, `rpm/${ String.fromCodePoint(0x212A) }ali/42`],
        ["a distribution with a lower-case letter other than ASCII", { ...RPMS, target: `rpm/f${ String.fromCodePoint(0xE9) }dora/42` }, `rpm/f${ String.fromCodePoint(0xE9) }dora/42`],
    ])("A database holding %s refuses the start and the message names it", (_, bundle, name) => withLocalTmpDir(async () => {
        await importInSpelling(bundle);
        const published = await listFiles(PATHS.repoDir);
        const leftover = processPath("rpm/fedora/41/left.rpm");
        await fs.mkdir(osPath.dirname(leftover), { recursive: true });
        await fs.writeFile(leftover, "x");

        setFileNaming(CASE_INSENSITIVE);
        await expect(open()).rejects.toThrow(`The database holds ${ name }, which this file system cannot keep apart`);

        expect(await listFiles(PATHS.repoDir)).toEqual(published);
        expect(await exists(leftover)).toBe(true);
        await fs.rm(leftover);

        setFileNaming(CASE_SENSITIVE);
        await (await open()).close();
    })());

    test("All the names with upper case are named at once", withLocalTmpDir(async () => {
        await importInSpelling({ ...RPMS, target: "rpm/Fedora/42" });
        await importInSpelling({ ...TRIXIE, target: "deb/debian/trixie/Main" });

        setFileNaming(CASE_INSENSITIVE);

        await expect(open()).rejects.toThrow("The database holds deb/debian/trixie/Main, rpm/Fedora/42, which");
    }));

    test.each([
        [CASE_INSENSITIVE, "release", '"release" cannot be a component, the release has a file of that name'],
        [CASE_SENSITIVE, "main/by-hash", '"by-hash" cannot be a component, the publish writes that name below a component'],
    ])("With %j, a database holding the component %s refuses the start and the message names it", (naming, component, problem) => withLocalTmpDir(async () => {
        await fs.mkdir(PATHS.repoStateDir);
        const db = openDatabase(osJoin(PATHS.repoStateDir, "repo.db"));
        new DebCatalog(db).ensureCell({ distro: "debian", release: "trixie", component, architecture: "amd64", kind: "deb" }, 0);
        db.close();

        setFileNaming(naming);

        await expect(open()).rejects.toThrow(`The database holds names the server itself writes: deb/debian/trixie/${ component }: ${ problem }`);
    })());

    test("A database in lower case starts", withLocalTmpDir(async () => {
        await importInSpelling(RPMS);
        await importInSpelling(TRIXIE);

        setFileNaming(CASE_INSENSITIVE);
        const backend = await open();

        expect(backend.listRepositories()).toEqual([{ format: "deb", distribution: "debian", release: "trixie" }, { format: "rpm", distribution: "fedora", release: "42" }]);
    }));

    test.each([
        { ...RPMS, target: `rpm/${ String.fromCodePoint(0x212A) }ali/42` },
        { ...TRIXIE, target: `deb/${ String.fromCodePoint(0x212A) }ali/trixie/main` },
    ])("A folder in $target fails the import, it is not a plain k, and the next start is clean", bundle => withLocalTmpDir(async () => {
        setFileNaming(CASE_INSENSITIVE);
        await stage(bundle);
        const imported = await open();

        const { files } = await imported.importStaged();

        expect(new Set(files.map(file => file.status))).toEqual(new Set(["failed"]));
        expect(files[0].reason).toContain(NOT_IN_LOWER_CASE);
        expect(imported.listRepositories()).toEqual([]);
        await imported.close();

        expect((await open()).listRepositories()).toEqual([]);
    })());

    test("An upper-case tree aborts the rebuild first, a tree renamed to lower case rebuilds and starts", withLocalTmpDir(async () => {
        await importInSpelling({ ...RPMS, target: "rpm/Fedora/42" });
        const error = jest.spyOn(logger, "error").mockReturnValue(logger);

        try {
            setFileNaming(CASE_INSENSITIVE);
            await expect(open(KEY_FILE, { rebuild: true })).rejects.toThrow("Rebuild found 1 problem(s)");
            expect(error).toHaveBeenCalledWith(expect.stringContaining("rpm/Fedora"));
        } finally {
            error.mockRestore();
        }

        await fs.rename(repoFile("rpm/Fedora"), repoFile("rpm/fedora"));
        const backend = await open(KEY_FILE, { rebuild: true });

        expect(backend.listRepositories()).toEqual([{ format: "rpm", distribution: "fedora", release: "42" }]);
    }));

    test("A Debian distribution renamed to lower case rebuilds and starts", withLocalTmpDir(async () => {
        await importInSpelling({ ...TRIXIE, target: "deb/Debian/trixie/main" });
        await fs.rename(repoFile("deb/Debian"), repoFile("deb/debian"));

        setFileNaming(CASE_INSENSITIVE);
        const backend = await open(KEY_FILE, { rebuild: true });

        expect(backend.listRepositories()).toEqual([{ format: "deb", distribution: "debian", release: "trixie" }]);
    }));
});

describe("Tests for the sweep of incoming/process", () => {
    beforeEach(() => setFileNaming(CASE_INSENSITIVE));
    afterEach(resetFileNaming);

    test("An import removes the directories it emptied and the empty hand-placed ones, the format roots stay", withLocalTmpDir(async () => {
        await stage({ ...RPMS, target: "rpm/Fedora/42" });
        await fs.mkdir(processPath("deb/Debian/trixie/main"), { recursive: true });
        const backend = await open();

        expect((await backend.importStaged()).ok).toBe(true);

        expect(await listFiles(osJoin(PATHS.incomingDir, "process"))).toEqual([]);
        expect(await fs.readdir(processPath("deb"))).toEqual([]);
        expect(await fs.readdir(processPath("rpm"))).toEqual([]);
        expect((await fs.readdir(osJoin(PATHS.incomingDir, "process"))).sort()).toEqual(["deb", "rpm"]);
    }));

    test("A start that imports what process holds sweeps too", withLocalTmpDir(async () => {
        const [name] = await fs.readdir(RPMS.dir);
        await fs.mkdir(processPath("rpm/Fedora/42"), { recursive: true });
        await fs.copyFile(osPath.join(RPMS.dir, name), processPath(`rpm/Fedora/42/${ name }`));

        await open();

        expect(await fs.readdir(processPath("rpm"))).toEqual([]);
    }));

    test("A directory holding what an import left stays, its empty neighbour goes", withLocalTmpDir(async () => {
        await fs.mkdir(processPath("rpm/fedora/42"), { recursive: true });
        await fs.writeFile(processPath("rpm/fedora/42/notes.txt"), "kept");
        await fs.mkdir(processPath("rpm/fedora/41/Packages"), { recursive: true });
        const backend = await open();
        await fs.mkdir(processPath("rpm/fedora/40"), { recursive: true });

        const { files } = await backend.importStaged();

        expect(files.map(file => file.status)).toEqual(["skipped"]);
        expect(await fs.readdir(processPath("rpm/fedora"))).toEqual(["42"]);
        expect(await fs.readdir(processPath("rpm/fedora/42"))).toEqual(["notes.txt"]);
    }));

    test("A directory that cannot be removed is logged and the import stays good", withLocalTmpDir(async () => {
        await stage(RPMS);
        const backend = await open();
        const rmdir = jest.spyOn(fs, "rmdir").mockRejectedValue(Object.assign(new Error("busy"), { code: "EBUSY" }));
        const warn = jest.spyOn(logger, "warn").mockReturnValue(logger);
        try {
            expect((await backend.importStaged()).ok).toBe(true);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be removed"), expect.anything());
        } finally {
            rmdir.mockRestore();
            warn.mockRestore();
        }
    }));

    test("A directory that cannot be read is logged and the import stays good", withLocalTmpDir(async () => {
        await stage(RPMS);
        const backend = await open();
        const root = osPath.join(PATHS.incomingDir, "process", "rpm");
        const readdir = fs.readdir;
        let reads = 0;
        const refused = jest.spyOn(fs, "readdir").mockImplementation((async (dir: string, options: never) => {
            if (dir === root && ++reads === 2) {
                throw Object.assign(new Error("denied"), { code: "EACCES" });
            }
            return readdir(dir, options);
        }) as never);
        const warn = jest.spyOn(logger, "warn").mockReturnValue(logger);
        try {
            expect((await backend.importStaged()).ok).toBe(true);
            expect(reads).toBe(2);
            expect(warn).toHaveBeenCalledWith("Empty directories in incoming/process could not be swept", expect.anything());
        } finally {
            refused.mockRestore();
            warn.mockRestore();
        }
    }));

    test("After an emptied hand-placed directory a later upload lands in lower case", withLocalTmpDir(async () => {
        const [first, second] = await fs.readdir(RPMS.dir);
        await fs.mkdir(processPath("rpm/Fedora/42"), { recursive: true });
        await fs.copyFile(osPath.join(RPMS.dir, first), processPath(`rpm/Fedora/42/${ first }`));
        const backend = await open();
        const to = osJoin(PATHS.incomingDir, "staging", "rpm", "fedora", "42");
        await fs.mkdir(to, { recursive: true });
        await fs.copyFile(osPath.join(RPMS.dir, second), osPath.join(to, second));

        const { files } = await backend.importStaged();

        expect(files).toEqual([{ filename: second, path: `rpm/fedora/42/${ second }`, status: "ok" }]);
    }));
});
