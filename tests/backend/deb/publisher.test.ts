import { withLocalTmpDir } from "../../utils.ts";
import { jest } from "@jest/globals";
import crypto from "crypto";
import osPath from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import zlib from "zlib";
import type { Database } from "node:sqlite";
import * as openpgp from "openpgp";
import { openDatabase } from "../../../server/backend/db.ts";
import type { BackendContext } from "../../../server/backend/context.ts";
import type { ChunkedIndexOptions, ChunkInfo } from "../../../server/backend/chunked.ts";
import { DebCatalog } from "../../../server/backend/deb/catalog.ts";
import type { DebUploadInput, PoolFile } from "../../../server/backend/deb/catalog.ts";
import { contentsRecords } from "../../../server/backend/deb/contents.ts";
import { importDebian } from "../../../server/backend/deb/importer.ts";
import { binarySortKey } from "../../../server/backend/deb/stanzas.ts";

// The publisher must see the spied modules, so it is imported after the mocks are registered; the catalog keeps the real ones
const chunked = await import("../../../server/backend/chunked.ts");
const writeChunkedIndex = jest.fn(chunked.writeChunkedIndex);
jest.unstable_mockModule("../../../server/backend/chunked.ts", () => ({ __esModule: true, ...chunked, writeChunkedIndex }));
const dbModule = await import("../../../server/backend/db.ts");
const transaction = jest.fn(dbModule.transaction);
jest.unstable_mockModule("../../../server/backend/db.ts", () => ({ __esModule: true, ...dbModule, transaction }));
const { publishDebian, renderRelease } = await import("../../../server/backend/deb/publisher.ts");

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const GOLDEN = osPath.join(FIXTURES, "golden");
const NOW = 1700000000;
const NOW_TEXT = "Tue, 14 Nov 2023 22:13:20 UTC";
const MD5_EMPTY = "d41d8cd98f00b204e9800998ecf8427e";
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ENV_NAMES = ["DEB_ORIGIN", "DEB_ORIGIN_DEBIAN_TRIXIE", "DEB_DESCRIPTION", "DEB_DESCRIPTION_DEBIAN"];

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

const TRIXIE_NAMES = ["main/binary-amd64/Packages", "main/binary-amd64/Packages.gz", "main/source/Sources", "main/source/Sources.gz",
    "main/Contents-amd64", "main/Contents-amd64.gz"];

type Ctx = BackendContext & { clock: { now: number } };

type IndexFileRow = {
    id: number; kind: string; component: string; architecture: string; generation: number; stored_path: string | null;
    size: number | null; md5: string | null; sha256: string | null; raw_size: number | null; raw_md5: string | null; raw_sha256: string | null;
};

type ParsedRelease = { fields: string[]; md5: Record<string, [string, number]>; sha256: Record<string, [string, number]> };

type SyntheticPackage = { name: string; section?: string; architecture?: string; paths?: string[]; filler?: number };

type Synthetic = { distro?: string; release?: string; component?: string; source: string; version?: string; packages: SyntheticPackage[] };

let key: openpgp.PrivateKey;

beforeAll(async () => {
    const { privateKey } = await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "t" }], format: "object" });
    key = privateKey;
});

function osJoin(root: string, ...posix: string[]): string {
    return osPath.join(root, ...posix.join("/").split("/"));
}

function withPublisher(fn: (ctx: Ctx) => Promise<void>, o: { signed?: boolean } = {}) {
    return withLocalTmpDir(async () => {
        await fs.mkdir("state");
        const db = openDatabase(osPath.join("state", "repo.db"));
        const clock = { now: NOW };
        try {
            await fn({
                db, paths: { incomingDir: "incoming", repoStateDir: "state", repoDir: "repo" },
                signingKey: o.signed === false ? undefined : key, now: () => clock.now, clock,
            });
        } finally {
            db.close();
        }
    });
}

function stagedPath(ctx: Ctx, relPath: string): string {
    return osJoin(ctx.paths.incomingDir, "process", relPath);
}

async function stage(ctx: Ctx, bundle: Bundle, o: { names?: string[]; target?: string } = {}): Promise<string[]> {
    const names = o.names ?? (await fs.readdir(bundle.dir)).sort();
    const target = o.target ?? bundle.target;
    await fs.mkdir(stagedPath(ctx, target), { recursive: true });
    for (const name of names) {
        await fs.copyFile(osPath.join(bundle.dir, name), stagedPath(ctx, `${ target }/${ name }`));
    }
    return names;
}

async function importStaged(ctx: Ctx): Promise<void> {
    const result = await importDebian(ctx);
    expect(result.length).toBeGreaterThan(0);
    expect(result.filter(f => f.status !== "ok")).toEqual([]);
}

async function importAll(ctx: Ctx, ...bundles: Bundle[]): Promise<void> {
    for (const bundle of bundles) {
        await stage(ctx, bundle);
    }
    await importStaged(ctx);
}

async function edit(ctx: Ctx, relPath: string, fn: (text: string) => string): Promise<void> {
    const file = stagedPath(ctx, relPath);
    await fs.writeFile(file, fn(await fs.readFile(file, "utf8")));
}

function fieldEnd(lines: string[], name: string): { at: number; end: number } {
    const at = lines.findIndex(line => line.startsWith(`${ name }:`));
    let end = at + 1;
    while (end < lines.length && lines[end].startsWith(" ")) {
        end++;
    }
    return { at, end };
}

function continuation(text: string, name: string): string[] {
    const lines = text.split("\n");
    const { at, end } = fieldEnd(lines, name);
    return lines.slice(at + 1, end);
}

function appendToField(text: string, name: string, extra: string[]): string {
    const lines = text.split("\n");
    const { end } = fieldEnd(lines, name);
    return [...lines.slice(0, end), ...extra, ...lines.slice(end)].join("\n");
}

/** Drops the Files/Checksums-* lines of `name` */
function unlisted(text: string, name: string): string {
    return text.split("\n").filter(line => !(line.startsWith(" ") && line.endsWith(` ${ name }`))).join("\n");
}

/** The trixie bundle with the udeb bundle merged into its .changes, as mergechanges would do */
async function stageCombined(ctx: Ctx): Promise<void> {
    await stage(ctx, TRIXIE);
    const udebNames = (await stage(ctx, UDEB)).filter(name => !name.endsWith(".changes"));
    await fs.unlink(stagedPath(ctx, `${ UDEB.target }/${ UDEB.changes }`));
    const udeb = await fs.readFile(osPath.join(UDEB.dir, UDEB.changes), "utf8");
    await edit(ctx, `${ TRIXIE.target }/${ TRIXIE.changes }`, text => {
        for (const name of ["Checksums-Sha1", "Checksums-Sha256", "Files"]) {
            text = appendToField(text, name, continuation(udeb, name));
        }
        return text;
    });
    expect(udebNames).toHaveLength(2);
}

/** The trixie bundle without the given files, its Architecture line replaced */
async function stageReduced(ctx: Ctx, dropped: string[], architecture: string): Promise<void> {
    await stage(ctx, TRIXIE, { names: (await fs.readdir(TRIXIE.dir)).filter(name => !dropped.includes(name)) });
    await edit(ctx, `${ TRIXIE.target }/${ TRIXIE.changes }`,
        text => dropped.reduce(unlisted, text).replace("Architecture: source all amd64", `Architecture: ${ architecture }`));
}

function stageArchAllOnly(ctx: Ctx): Promise<void> {
    return stageReduced(ctx, ["srm-hello_1.0-1_amd64.deb", "srm-hello_1.0-1_amd64.buildinfo"], "source all");
}

function stageSourceOnly(ctx: Ctx): Promise<void> {
    return stageReduced(ctx, ["srm-hello_1.0-1_amd64.deb", "srm-hello-doc_1.0-1_all.deb", "srm-hello_1.0-1_amd64.buildinfo"], "source");
}

function shadowFile(id: number, generation: number): string {
    return osPath.join("state", "shadow", `${ id }-${ generation }`);
}

async function shadows(): Promise<string[]> {
    return (await fs.readdir(osPath.join("state", "shadow"))).sort();
}

function fakeFile(path: string): PoolFile {
    const digest = (name: string): string => crypto.createHash(name).update(path).digest("hex");
    return { path, size: 1, md5: digest("md5"), sha1: digest("sha1"), sha256: digest("sha256"), sha512: digest("sha512") };
}

/** A binary-only upload with rendered stanzas, as the importer hands it to the catalog */
function synthetic(o: Synthetic): DebUploadInput {
    const distro = o.distro ?? "debian";
    const release = o.release ?? "trixie";
    const component = o.component ?? "main";
    const version = o.version ?? "1.0-1";
    const scope = new Set<string>();
    const binaries = o.packages.map(p => {
        const architecture = p.architecture ?? "amd64";
        const section = p.section ?? "misc";
        scope.add(architecture);
        const filename = `${ p.name }_${ version }_${ architecture }.deb`;
        const file = fakeFile(`deb/${ distro }/pool/${ component }/s/${ o.source }/${ filename }`);
        const stanza = `Package: ${ p.name }\nSource: ${ o.source }\nVersion: ${ version }\nArchitecture: ${ architecture }\n`
            + `Maintainer: Simple Repo Manager <srm@example.com>\nPriority: optional\nSection: ${ section }\n`
            + `Filename: pool/${ component }/s/${ o.source }/${ filename }\nSize: 1\nSHA256: ${ file.sha256 }\nMD5sum: ${ file.md5 }\n`
            + `Description: ${ p.name }${ p.filler === undefined ? "" : `\n ${ "x".repeat(p.filler) }` }\n`;
        return { kind: "deb" as const, package: p.name, version, architecture, section, stanza, file, paths: p.paths ?? [] };
    });
    return {
        distro, release, component, source: o.source, version, scope: [...scope], changesName: `${ o.source }_${ version }_amd64.changes`,
        trackedFiles: [], binaries,
    };
}

function upload(ctx: Ctx, o: Synthetic): void {
    expect(new DebCatalog(ctx.db).applyUpload(synthetic(o), ctx.now()).ok).toBe(true);
}

function dists(ctx: Ctx, distro = "debian", release = "trixie"): string {
    return osJoin(ctx.paths.repoDir, "deb", distro, "dists", release);
}

function distsFile(ctx: Ctx, rel: string, distro = "debian", release = "trixie"): string {
    return osJoin(dists(ctx, distro, release), rel);
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.stat(file);
        return true;
    } catch {
        return false;
    }
}

async function readBytes(ctx: Ctx, rel: string, distro = "debian", release = "trixie"): Promise<Buffer> {
    return fs.readFile(distsFile(ctx, rel, distro, release));
}

async function readIndex(ctx: Ctx, rel: string, distro = "debian", release = "trixie"): Promise<string> {
    return zlib.gunzipSync(await readBytes(ctx, rel, distro, release)).toString("utf8");
}

async function readIndexBytes(ctx: Ctx, rel: string, distro = "debian", release = "trixie"): Promise<Buffer> {
    return zlib.gunzipSync(await readBytes(ctx, rel, distro, release));
}

async function readRelease(ctx: Ctx, distro = "debian", release = "trixie"): Promise<string> {
    return fs.readFile(distsFile(ctx, "Release", distro, release), "utf8");
}

async function golden(rel: string): Promise<string> {
    return fs.readFile(osJoin(GOLDEN, rel), "utf8");
}

async function goldenBytes(rel: string): Promise<Buffer> {
    return fs.readFile(osJoin(GOLDEN, rel));
}

function withoutWeakHashes(text: string): string {
    return text.split("\n").filter(line => !line.startsWith("SHA1: ") && !line.startsWith("SHA512: ")).join("\n");
}

function digest(name: string, data: Buffer): string {
    return crypto.createHash(name).update(data).digest("hex");
}

function parseRelease(text: string): ParsedRelease {
    const parsed: ParsedRelease = { fields: [], md5: {}, sha256: {} };
    let block: Record<string, [string, number]> | undefined;
    for (const line of text.split("\n")) {
        if (line.length === 0) {
            continue;
        }
        if (line === "MD5Sum:") {
            block = parsed.md5;
        } else if (line === "SHA256:") {
            block = parsed.sha256;
        } else if (line.startsWith(" ")) {
            const [hash, size, name] = line.trim().split(" ");
            block![name] = [hash, Number(size)];
        } else {
            parsed.fields.push(line);
        }
    }
    return parsed;
}

/** Package and architecture of every stanza, in file order */
function stanzas(text: string): string[] {
    return text.split("\n\n").filter(s => s.length > 0).map(s => {
        const lines = s.split("\n");
        const value = (name: string): string => lines.find(l => l.startsWith(`${ name }: `))!.slice(name.length + 2);
        return `${ value("Package") } ${ value("Architecture") }`;
    });
}

function contentsPaths(text: string): string[] {
    return text.split("\n").filter(line => line.length > 0).map(line => line.slice(0, line.indexOf("\t")));
}

async function verifyClearsigned(out: string): Promise<string> {
    const message = await openpgp.readCleartextMessage({ cleartextMessage: out });
    const result = await openpgp.verify({ message, verificationKeys: key.toPublic() });
    await expect(result.signatures[0].verified).resolves.toBe(true);
    return message.getText();
}

async function verifyDetached(data: Buffer, armoredSignature: string): Promise<void> {
    const signature = await openpgp.readSignature({ armoredSignature });
    const result = await openpgp.verify({ message: await openpgp.createMessage({ binary: data }), signature, verificationKeys: key.toPublic() });
    await expect(result.signatures[0].verified).resolves.toBe(true);
}

/** InRelease and Release.gpg verify and carry the Release text */
async function expectSigned(ctx: Ctx, distro = "debian", release = "trixie"): Promise<string> {
    const text = await readRelease(ctx, distro, release);
    expect(await verifyClearsigned(await fs.readFile(distsFile(ctx, "InRelease", distro, release), "utf8"))).toBe(text);
    await verifyDetached(Buffer.from(text, "utf8"), await fs.readFile(distsFile(ctx, "Release.gpg", distro, release), "utf8"));
    return text;
}

async function walk(dir: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = osPath.join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...await walk(file));
        } else {
            found.push(file);
        }
    }
    return found.sort();
}

async function leftovers(dir: string): Promise<string[]> {
    return (await walk(dir)).filter(file => osPath.basename(file).includes(".tmp-"));
}

function indexFiles(db: Database, distro = "debian", release = "trixie"): IndexFileRow[] {
    return db.prepare(`
        SELECT i.id, i.kind, i.component, i.architecture, i.generation, i.stored_path, i.size, i.md5, i.sha256, i.raw_size, i.raw_md5, i.raw_sha256
            FROM index_files i JOIN releases r ON r.id = i.release_id WHERE r.distro = ? AND r.name = ?
            ORDER BY i.component, i.kind, i.architecture`).all(distro, release) as IndexFileRow[];
}

function cells(db: Database, distro = "debian", release = "trixie"): string[] {
    return indexFiles(db, distro, release).map(f => `${ f.kind } ${ f.component } ${ f.architecture } ${ f.generation }`);
}

function indexFile(db: Database, kind: string, component: string, architecture: string, distro = "debian", release = "trixie"): IndexFileRow {
    const found = indexFiles(db, distro, release).find(f => f.kind === kind && f.component === component && f.architecture === architecture);
    if (found === undefined) {
        throw new Error(`No ${ kind } ${ component } ${ architecture } index in ${ distro }/${ release }`);
    }
    return found;
}

function chunkRows(db: Database, id: number): ChunkInfo[] {
    return db.prepare("SELECT start_key, offset, length, raw_offset, raw_length FROM index_chunks WHERE index_file_id = ? ORDER BY seq").all(id)
        .map(r => ({
            startKey: r.start_key as string, offset: r.offset as number, length: r.length as number,
            rawOffset: r.raw_offset as number, rawLength: r.raw_length as number,
        }));
}

function dirtyCount(db: Database): number {
    return (db.prepare("SELECT count(*) AS n FROM dirty_keys").get() as { n: number }).n;
}

function superseded(db: Database): string[] {
    return db.prepare("SELECT path FROM superseded_files ORDER BY path").all().map(r => r.path as string);
}

function releaseRow(db: Database, distro = "debian", release = "trixie"): { published_date: number | null; origin: string | null; description: string | null } {
    return db.prepare("SELECT published_date, origin, description FROM releases WHERE distro = ? AND name = ?").get(distro, release) as
        { published_date: number | null; origin: string | null; description: string | null };
}

function callFor(id: number): ChunkedIndexOptions {
    const call = writeChunkedIndex.mock.calls.find(([o]) => osPath.basename(o.outFile) === `${ id }.gz`);
    if (call === undefined) {
        throw new Error(`writeChunkedIndex was not called for index file ${ id }`);
    }
    return call[0];
}

function md5LinkOf(storedPath: string, md5: string): string {
    return `${ storedPath.slice(0, storedPath.indexOf("/by-hash/")) }/by-hash/MD5Sum/${ md5 }`;
}

describe("Tests for publishDebian", () => {
    test("Packages.gz content equals the golden Packages without SHA1/SHA512", withPublisher(async ctx => {
        await importAll(ctx, TRIXIE);

        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);

        expect(await readIndex(ctx, "main/binary-amd64/Packages.gz"))
            .toBe(withoutWeakHashes(await golden("deb/debian/dists/trixie/main/binary-amd64/Packages")));
        expect(await readIndex(ctx, "main/source/Sources.gz")).toBe(await golden("deb/debian/dists/trixie/main/source/Sources"));
        expect(cells(ctx.db)).toEqual(["contents main amd64 1", "packages main amd64 1", "sources main  1"]);
        expect(dirtyCount(ctx.db)).toBe(0);
        expect(writeChunkedIndex).toHaveBeenCalledTimes(3);
        for (const [o] of writeChunkedIndex.mock.calls) {
            expect(o.codec).toBe("gzip");
            expect(o.previous).toBeUndefined();
            expect(osPath.dirname(o.outFile)).toBe(osPath.join("state", "tmp"));
        }

        expect(await publishDebian(ctx)).toEqual([]);
        expect(writeChunkedIndex).toHaveBeenCalledTimes(3);
    }));

    test("Release lists MD5Sum and SHA256 for raw and gz entries, Acquire-By-Hash: yes, no Valid-Until", withPublisher(async ctx => {
        await importAll(ctx, TRIXIE);
        await publishDebian(ctx);

        const text = await readRelease(ctx);
        const release = parseRelease(text);
        expect(release.fields).toEqual([
            "Suite: trixie", "Codename: trixie", `Date: ${ NOW_TEXT }`, "Acquire-By-Hash: yes", "Architectures: amd64", "Components: main",
        ]);
        expect(text).not.toContain("Valid-Until");
        expect(text).not.toContain("SHA1:");
        expect(text).not.toContain("SHA512:");
        expect(text.endsWith("\n")).toBe(true);
        expect(text.split("\n").filter(line => line !== line.trimEnd())).toEqual([]);
        expect(Object.keys(release.md5)).toEqual(TRIXIE_NAMES);
        expect(Object.keys(release.sha256)).toEqual(TRIXIE_NAMES);
        for (const name of TRIXIE_NAMES.filter(n => n.endsWith(".gz"))) {
            const gz = await readBytes(ctx, name);
            const raw = zlib.gunzipSync(gz);
            expect(raw.length).toBeGreaterThan(0);
            expect(release.md5[name]).toEqual([digest("md5", gz), gz.length]);
            expect(release.sha256[name]).toEqual([digest("sha256", gz), gz.length]);
            expect(release.md5[name.slice(0, -3)]).toEqual([digest("md5", raw), raw.length]);
            expect(release.sha256[name.slice(0, -3)]).toEqual([digest("sha256", raw), raw.length]);
            expect(await exists(distsFile(ctx, name.slice(0, -3)))).toBe(false);
        }
        expect(releaseRow(ctx.db)).toEqual({ published_date: NOW, origin: null, description: null });

        const rendered = renderRelease({
            distro: "debian", release: "trixie", origin: "Origin Text", description: "Description Text",
            date: new Date(Date.UTC(2026, 9, 25, 18, 44, 51)), architectures: ["amd64", "arm64"], components: ["main", "main/sub"],
        }, [{ name: "main/binary-amd64/Packages", size: 12, md5: "m", sha256: "s" }, { name: "main/binary-amd64/Packages.gz", size: 3, md5: "n", sha256: "t" }]);
        expect(rendered).toBe([
            "Origin: Origin Text", "Suite: trixie", "Codename: trixie", "Date: Sun, 25 Oct 2026 18:44:51 UTC", "Acquire-By-Hash: yes",
            "Architectures: amd64 arm64", "Components: main main/sub", "Description: Description Text",
            "MD5Sum:", " m 12 main/binary-amd64/Packages", " n 3 main/binary-amd64/Packages.gz",
            "SHA256:", " s 12 main/binary-amd64/Packages", " t 3 main/binary-amd64/Packages.gz", "",
        ].join("\n"));
        expect(renderRelease({ distro: "debian", release: "trixie", date: new Date(NOW * 1000), architectures: [], components: ["main"] }, []))
            .toBe(`Suite: trixie\nCodename: trixie\nDate: ${ NOW_TEXT }\nAcquire-By-Hash: yes\nComponents: main\nMD5Sum:\nSHA256:\n`);
    }));

    test("by-hash file and canonical name have identical content", withPublisher(async ctx => {
        await importAll(ctx, TRIXIE);
        await publishDebian(ctx);

        const rows = indexFiles(ctx.db);
        const dirs: Record<string, string> = { "contents main amd64": "main", "packages main amd64": "main/binary-amd64", "sources main ": "main/source" };
        for (const row of rows) {
            const dir = dirs[`${ row.kind } ${ row.component } ${ row.architecture }`];
            expect(row.stored_path).toBe(`deb/debian/dists/trixie/${ dir }/by-hash/SHA256/${ row.sha256 }`);
            const canonical = await readBytes(ctx, `${ dir }/${ row.kind === "contents" ? "Contents-amd64" : row.kind === "sources" ? "Sources" : "Packages" }.gz`);
            expect(canonical.length).toBe(row.size);
            expect(digest("sha256", canonical)).toBe(row.sha256);
            expect(digest("md5", canonical)).toBe(row.md5);
            expect((await fs.readFile(osJoin(ctx.paths.repoDir, row.stored_path!))).equals(canonical)).toBe(true);
            expect((await readBytes(ctx, `${ dir }/by-hash/MD5Sum/${ row.md5 }`)).equals(canonical)).toBe(true);
            const shadow = await fs.readFile(shadowFile(row.id, 1));
            expect(shadow.equals(zlib.gunzipSync(canonical))).toBe(true);
            expect(shadow.length).toBe(row.raw_size);
            expect(digest("sha256", shadow)).toBe(row.raw_sha256);
            expect(digest("md5", shadow)).toBe(row.raw_md5);
        }
        expect(await shadows()).toEqual(rows.map(row => `${ row.id }-1`).sort());
        expect(await leftovers("repo")).toEqual([]);
        expect(await fs.readdir(osPath.join("state", "tmp"))).toEqual([]);
        expect(superseded(ctx.db)).toEqual([]);
    }));

    test("Second publish after one more upload rewrites only the dirty chunk", withPublisher(async ctx => {
        await importAll(ctx, TRIXIE);
        upload(ctx, { source: "srm-bulk", packages: Array.from({ length: 1200 }, (_, i) => ({ name: `srm-bulk-${ String(i).padStart(4, "0") }`, filler: 900 })) });
        await publishDebian(ctx);
        const packages = indexFile(ctx.db, "packages", "main", "amd64");
        const contents = indexFile(ctx.db, "contents", "main", "amd64");
        const first = chunkRows(ctx.db, packages.id);
        expect(first.length).toBeGreaterThanOrEqual(2);
        expect(callFor(packages.id).previous).toBeUndefined();
        const before = await readBytes(ctx, "main/binary-amd64/Packages.gz");
        writeChunkedIndex.mockClear();

        upload(ctx, { source: "srm-zzz", packages: [{ name: "srm-zzz", paths: ["usr/bin/srm-zzz"] }] });
        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);

        expect(writeChunkedIndex).toHaveBeenCalledTimes(2);
        const call = callFor(packages.id);
        expect(call.previous).toEqual({ file: osJoin(ctx.paths.repoDir, packages.stored_path!), shadow: shadowFile(packages.id, 1), chunks: first });
        expect([...call.dirtyKeys!]).toEqual([binarySortKey("srm-zzz", "srm-zzz", "1.0-1", "amd64")]);
        expect([...callFor(contents.id).dirtyKeys!]).toEqual(["usr/bin/srm-zzz"]);
        const after = chunkRows(ctx.db, packages.id);
        const afterBytes = await readBytes(ctx, "main/binary-amd64/Packages.gz");
        expect(after).toHaveLength(first.length);
        expect(after.slice(0, -1)).toEqual(first.slice(0, -1));
        const clean = first[0];
        expect(afterBytes.subarray(clean.offset, clean.offset + clean.length).equals(before.subarray(clean.offset, clean.offset + clean.length))).toBe(true);
        expect(after[after.length - 1].rawLength).toBeGreaterThan(first[first.length - 1].rawLength);
        const text = zlib.gunzipSync(afterBytes).toString("utf8");
        expect(text.endsWith("\nPackage: srm-zzz\nSource: srm-zzz\nVersion: 1.0-1\nArchitecture: amd64\nMaintainer: Simple Repo Manager <srm@example.com>\n"
            + "Priority: optional\nSection: misc\nFilename: pool/main/s/srm-zzz/srm-zzz_1.0-1_amd64.deb\nSize: 1\nSHA256: "
            + `${ fakeFile("deb/debian/pool/main/s/srm-zzz/srm-zzz_1.0-1_amd64.deb").sha256 }\nMD5sum: ${ fakeFile("deb/debian/pool/main/s/srm-zzz/srm-zzz_1.0-1_amd64.deb").md5 }\n`
            + "Description: srm-zzz\n\n")).toBe(true);
        expect(stanzas(text).slice(1198)).toEqual(["srm-bulk-1198 amd64", "srm-bulk-1199 amd64", "srm-hello amd64", "srm-hello-doc all", "srm-zzz amd64"]);
        expect(cells(ctx.db)).toEqual(["contents main amd64 2", "packages main amd64 2", "sources main  1"]);
        expect(superseded(ctx.db)).toEqual([
            packages.stored_path!, md5LinkOf(packages.stored_path!, packages.md5!), contents.stored_path!, md5LinkOf(contents.stored_path!, contents.md5!),
        ].sort());
        expect(await exists(osJoin(ctx.paths.repoDir, packages.stored_path!))).toBe(true);
        expect(await readIndex(ctx, "main/Contents-amd64.gz")).toBe(
            "usr/bin/srm-hello\t    utils/srm-hello\nusr/bin/srm-zzz\t    misc/srm-zzz\nusr/share/doc/srm-hello-doc/README\t    doc/srm-hello-doc\n");
    }));

    test("Arch all package appears in amd64 and arm64 Packages", withPublisher(async ctx => {
        await importAll(ctx, TRIXIE, ARM64);

        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);

        expect(stanzas(await readIndex(ctx, "main/binary-amd64/Packages.gz"))).toEqual(["srm-hello amd64", "srm-hello-doc all"]);
        expect(stanzas(await readIndex(ctx, "main/binary-arm64/Packages.gz"))).toEqual(["srm-hello arm64", "srm-hello-doc all"]);
        const goldenContents = await golden("deb/debian/dists/trixie/main/Contents-amd64");
        expect(await readIndex(ctx, "main/Contents-amd64.gz")).toBe(goldenContents);
        expect(await readIndex(ctx, "main/Contents-arm64.gz")).toBe(goldenContents);
        const release = parseRelease(await readRelease(ctx));
        expect(release.fields).toContain("Architectures: amd64 arm64");
        expect(Object.keys(release.md5)).toEqual([
            "main/binary-amd64/Packages", "main/binary-amd64/Packages.gz", "main/binary-arm64/Packages", "main/binary-arm64/Packages.gz",
            "main/source/Sources", "main/source/Sources.gz", "main/Contents-amd64", "main/Contents-amd64.gz", "main/Contents-arm64", "main/Contents-arm64.gz",
        ]);
        expect(await exists(distsFile(ctx, "main/binary-all"))).toBe(false);
    }));

    test("A release with only arch all packages publishes binary-all until a concrete architecture arrives", withPublisher(async ctx => {
        await stageArchAllOnly(ctx);
        await importStaged(ctx);
        await publishDebian(ctx);

        expect(stanzas(await readIndex(ctx, "main/binary-all/Packages.gz"))).toEqual(["srm-hello-doc all"]);
        expect(await readIndex(ctx, "main/Contents-all.gz")).toBe("usr/share/doc/srm-hello-doc/README\t    doc/srm-hello-doc\n");
        expect(parseRelease(await readRelease(ctx)).fields).toContain("Architectures: all");
        const all = indexFile(ctx.db, "packages", "main", "all");
        const allContents = indexFile(ctx.db, "contents", "main", "all");
        expect(await exists(shadowFile(all.id, 1))).toBe(true);

        await importAll(ctx, ARM64);
        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);

        expect(cells(ctx.db)).toEqual(["contents main arm64 1", "packages main arm64 1", "sources main  1"]);
        expect(stanzas(await readIndex(ctx, "main/binary-arm64/Packages.gz"))).toEqual(["srm-hello arm64", "srm-hello-doc all"]);
        expect(await shadows()).toEqual(indexFiles(ctx.db).map(row => `${ row.id }-1`).sort());
        for (const row of [all, allContents]) {
            expect(await exists(shadowFile(row.id, 1))).toBe(false);
            expect(await exists(osJoin(ctx.paths.repoDir, row.stored_path!))).toBe(true);
            expect(await exists(osJoin(ctx.paths.repoDir, md5LinkOf(row.stored_path!, row.md5!)))).toBe(false);
        }
        expect(await exists(distsFile(ctx, "main/binary-all/Packages.gz"))).toBe(false);
        expect(await exists(distsFile(ctx, "main/Contents-all.gz"))).toBe(false);
        expect(await exists(distsFile(ctx, "main/Contents-arm64.gz"))).toBe(true);
        expect(superseded(ctx.db)).toEqual([all.stored_path!, allContents.stored_path!].sort());
        const release = parseRelease(await readRelease(ctx));
        expect(release.fields).toContain("Architectures: arm64");
        expect(Object.keys(release.md5)).toEqual([
            "main/binary-arm64/Packages", "main/binary-arm64/Packages.gz", "main/source/Sources", "main/source/Sources.gz",
            "main/Contents-arm64", "main/Contents-arm64.gz",
        ]);
    }));

    test("ddeb lands in universe/debug and udeb in main/debian-installer", withPublisher(async ctx => {
        await stageCombined(ctx);
        await stage(ctx, NOBLE);
        await importStaged(ctx);

        expect(await publishDebian(ctx)).toEqual(["debian/trixie", "ubuntu/noble"]);

        expect(await readIndex(ctx, "universe/debug/binary-amd64/Packages.gz", "ubuntu", "noble"))
            .toBe(withoutWeakHashes(await golden("deb/ubuntu/dists/noble/universe/debug/binary-amd64/Packages")));
        expect(await readIndex(ctx, "universe/binary-amd64/Packages.gz", "ubuntu", "noble"))
            .toBe(withoutWeakHashes(await golden("deb/ubuntu/dists/noble/universe/binary-amd64/Packages")));
        expect(await readIndex(ctx, "universe/source/Sources.gz", "ubuntu", "noble")).toBe(await golden("deb/ubuntu/dists/noble/universe/source/Sources"));
        expect(await readIndex(ctx, "main/debian-installer/binary-amd64/Packages.gz"))
            .toBe(withoutWeakHashes(await golden("udeb/deb/debian/dists/trixie/main/debian-installer/binary-amd64/Packages")));
        expect(await readIndex(ctx, "main/binary-amd64/Packages.gz"))
            .toBe(withoutWeakHashes(await golden("deb/debian/dists/trixie/main/binary-amd64/Packages")));
        expect(Object.keys(parseRelease(await readRelease(ctx, "ubuntu", "noble")).md5)).toEqual([
            "universe/binary-amd64/Packages", "universe/binary-amd64/Packages.gz", "universe/debug/binary-amd64/Packages", "universe/debug/binary-amd64/Packages.gz",
            "universe/source/Sources", "universe/source/Sources.gz", "universe/Contents-amd64", "universe/Contents-amd64.gz",
        ]);
        expect(Object.keys(parseRelease(await readRelease(ctx)).md5)).toEqual([
            "main/binary-amd64/Packages", "main/binary-amd64/Packages.gz", "main/debian-installer/binary-amd64/Packages",
            "main/debian-installer/binary-amd64/Packages.gz", "main/source/Sources", "main/source/Sources.gz",
            "main/Contents-amd64", "main/Contents-amd64.gz", "main/Contents-udeb-amd64", "main/Contents-udeb-amd64.gz",
        ]);
        expect(parseRelease(await readRelease(ctx, "ubuntu", "noble")).fields).toEqual([
            "Suite: noble", "Codename: noble", `Date: ${ NOW_TEXT }`, "Acquire-By-Hash: yes", "Architectures: amd64", "Components: universe",
        ]);
        await expectSigned(ctx, "ubuntu", "noble");
    }));

    test("Contents-amd64 equals the golden file; udeb paths go to Contents-udeb-amd64 only", withPublisher(async ctx => {
        await stageCombined(ctx);
        await stage(ctx, NOBLE);
        await importStaged(ctx);
        await publishDebian(ctx);

        expect((await readIndexBytes(ctx, "main/Contents-amd64.gz")).equals(await goldenBytes("udeb/deb/debian/dists/trixie/main/Contents-amd64"))).toBe(true);
        expect((await readIndexBytes(ctx, "main/Contents-udeb-amd64.gz")).equals(await goldenBytes("udeb/deb/debian/dists/trixie/main/Contents-udeb-amd64"))).toBe(true);
        expect(await readIndex(ctx, "main/Contents-udeb-amd64.gz")).toBe("usr/bin/srm-hello\t    debian-installer/srm-hello-udeb\n");
        expect((await readIndexBytes(ctx, "universe/Contents-amd64.gz", "ubuntu", "noble")).equals(await goldenBytes("deb/ubuntu/dists/noble/universe/Contents-amd64"))).toBe(true);
        expect(await exists(distsFile(ctx, "universe/Contents-udeb-amd64.gz", "ubuntu", "noble"))).toBe(false);
    }));

    test("A path shared by two packages is one line with both, comma-joined", withPublisher(async ctx => {
        await importAll(ctx, TRIXIE);
        upload(ctx, { source: "srm-alt", packages: [{ name: "srm-alt", section: "misc", paths: ["usr/bin/srm-hello", "usr/share/alt/file"] }] });
        upload(ctx, { source: "srm-alt", version: "1.0-2", packages: [{ name: "srm-alt", section: "misc", paths: ["usr/bin/srm-hello", "usr/share/alt/file"] }] });
        upload(ctx, { source: "srm-other", packages: [{ name: "srm-other", architecture: "arm64", paths: ["usr/bin/srm-hello", "usr/share/other"] }] });

        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);

        expect(await readIndex(ctx, "main/Contents-amd64.gz")).toBe(
            "usr/bin/srm-hello\t    misc/srm-alt,utils/srm-hello\nusr/share/alt/file\t    misc/srm-alt\nusr/share/doc/srm-hello-doc/README\t    doc/srm-hello-doc\n");
        expect(await readIndex(ctx, "main/Contents-arm64.gz")).toBe(
            "usr/bin/srm-hello\t    misc/srm-other\nusr/share/doc/srm-hello-doc/README\t    doc/srm-hello-doc\nusr/share/other\t    misc/srm-other\n");
        expect(stanzas(await readIndex(ctx, "main/binary-amd64/Packages.gz"))).toEqual(["srm-alt amd64", "srm-alt amd64", "srm-hello amd64", "srm-hello-doc all"]);

        const records = contentsRecords(ctx.db, indexFile(ctx.db, "contents", "main", "amd64").id);
        expect([...records("", undefined)].map(r => r.key)).toEqual(["usr/bin/srm-hello", "usr/share/alt/file", "usr/share/doc/srm-hello-doc/README"]);
        expect([...records("usr/share", undefined)].map(r => r.text)).toEqual([
            "usr/share/alt/file\t    misc/srm-alt\n", "usr/share/doc/srm-hello-doc/README\t    doc/srm-hello-doc\n",
        ]);
        expect([...records("usr/bin", "usr/share/alt/file")].map(r => r.key)).toEqual(["usr/bin/srm-hello"]);
        expect([...records("usr/share/alt/file", "usr/share/alt/file")]).toEqual([]);
        expect(() => contentsRecords(ctx.db, indexFile(ctx.db, "packages", "main", "amd64").id)).toThrow(/Contents/);
        expect(() => contentsRecords(ctx.db, 9999)).toThrow(/9999/);
    }));

    test("A chunk reads only its key range, Contents in path order without sorting, and the open end reaches every key", withPublisher(async ctx => {
        upload(ctx, { source: "srm-top", packages: [{ name: "srm-top", paths: ["\u{10FFFF}/top"] }] });
        const prepare = jest.spyOn(ctx.db, "prepare");
        await publishDebian(ctx);
        const statements = prepare.mock.calls.map(([sql]) => sql).filter(sql => sql.includes("< coalesce("));
        prepare.mockRestore();

        const plan = (table: string): unknown[] => ctx.db.prepare(`EXPLAIN QUERY PLAN ${ statements.find(sql => sql.includes(`${ table } `))! }`).all().map(r => r.detail);
        expect(plan("deb_binaries")).toEqual(["SEARCH deb_binaries USING INDEX deb_binaries_order (release_id=? AND component=? AND kind=? AND sort_key>? AND sort_key<?)"]);
        expect(plan("deb_sources")).toEqual(["SEARCH deb_sources USING INDEX deb_sources_order (release_id=? AND component=? AND sort_key>? AND sort_key<?)"]);
        expect(plan("deb_binary_paths")).toEqual([
            "SEARCH p USING PRIMARY KEY (release_id=? AND component=? AND path>? AND path<?)", "SEARCH b USING INTEGER PRIMARY KEY (rowid=?)", "USE TEMP B-TREE FOR group_concat(ORDER BY)",
        ]);
        expect(await readIndex(ctx, "main/Contents-amd64.gz")).toBe("\u{10FFFF}/top\t    misc/srm-top\n");
    }));

    test("Contents lists only its own release and component, also for a path they share", withPublisher(async ctx => {
        const shared = "usr/bin/shared";
        upload(ctx, { source: "srm-a", packages: [{ name: "srm-a", section: "a", paths: [shared] }] });
        upload(ctx, { source: "srm-b", component: "contrib", packages: [{ name: "srm-b", section: "b", paths: [shared] }] });
        upload(ctx, { source: "srm-c", release: "bookworm", packages: [{ name: "srm-c", section: "c", paths: [shared] }] });

        await publishDebian(ctx);

        expect(await readIndex(ctx, "main/Contents-amd64.gz")).toBe(`${ shared }\t    a/srm-a\n`);
        expect(await readIndex(ctx, "contrib/Contents-amd64.gz")).toBe(`${ shared }\t    b/srm-b\n`);
        expect(await readIndex(ctx, "main/Contents-amd64.gz", "debian", "bookworm")).toBe(`${ shared }\t    c/srm-c\n`);
    }));

    test("Non-ASCII path sorts as in SQLite and survives a round trip", withPublisher(async ctx => {
        await importAll(ctx, BOOKWORM);
        await publishDebian(ctx);
        const goldenContents = await goldenBytes("deb/debian/dists/bookworm/main/Contents-amd64");
        expect((await readIndexBytes(ctx, "main/Contents-amd64.gz", "debian", "bookworm")).equals(goldenContents)).toBe(true);

        const paths = ["usr/share/u/\u{1F600}", "usr/share/u/～", "usr/share/u/a b", "usr/share/u/ä"];
        upload(ctx, { release: "bookworm", source: "srm-uni", packages: [{ name: "srm-uni", paths }] });
        expect(await publishDebian(ctx)).toEqual(["debian/bookworm"]);

        const bytes = await readIndexBytes(ctx, "main/Contents-amd64.gz", "debian", "bookworm");
        expect(bytes.subarray(0, goldenContents.length).equals(goldenContents)).toBe(true);
        const listed = contentsPaths(bytes.toString("utf8"));
        const expected = ["usr/bin/srm-gz", "usr/share/srm-gz/naïve file", "usr/share/u/a b", "usr/share/u/ä", "usr/share/u/～", "usr/share/u/\u{1F600}"];
        expect(listed).toEqual(expected);
        expect([...listed].sort()).not.toEqual(expected);
        expect([...listed].sort(chunked.compareKeys)).toEqual(expected);
        expect(bytes.includes(Buffer.from("usr/share/u/\u{1F600}\t    misc/srm-uni\n", "utf8"))).toBe(true);
    }));

    test("InRelease verifies; Date increases monotonically", withPublisher(async ctx => {
        await importAll(ctx, TRIXIE);
        await publishDebian(ctx);
        const first = await expectSigned(ctx);
        expect(first).toContain(`\nDate: ${ NOW_TEXT }\n`);
        expect(releaseRow(ctx.db).published_date).toBe(NOW);

        await importAll(ctx, ARM64);
        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);
        const second = await expectSigned(ctx);
        expect(second).toContain("\nDate: Tue, 14 Nov 2023 22:13:21 UTC\n");
        expect(releaseRow(ctx.db).published_date).toBe(NOW + 1);
        expect(second).not.toBe(first);

        expect(await publishDebian(ctx)).toEqual([]);
        expect(await readRelease(ctx)).toBe(second);

        ctx.clock.now = NOW + 100;
        upload(ctx, { source: "srm-zzz", packages: [{ name: "srm-zzz" }] });
        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);
        expect(await expectSigned(ctx)).toContain("\nDate: Tue, 14 Nov 2023 22:15:00 UTC\n");
        expect(releaseRow(ctx.db).published_date).toBe(NOW + 100);
    }));

    test("Without a signing key only Release is written", withPublisher(async ctx => {
        await importAll(ctx, TRIXIE);
        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);
        expect(await exists(distsFile(ctx, "Release"))).toBe(true);
        expect(await exists(distsFile(ctx, "InRelease"))).toBe(false);
        expect(await exists(distsFile(ctx, "Release.gpg"))).toBe(false);

        ctx.signingKey = key;
        await importAll(ctx, ARM64);
        await publishDebian(ctx);
        await expectSigned(ctx);

        ctx.signingKey = undefined;
        upload(ctx, { source: "srm-zzz", packages: [{ name: "srm-zzz" }] });
        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);
        expect(await readRelease(ctx)).toContain("\nDate: Tue, 14 Nov 2023 22:13:22 UTC\n");
        expect(await exists(distsFile(ctx, "InRelease"))).toBe(false);
        expect(await exists(distsFile(ctx, "Release.gpg"))).toBe(false);
    }, { signed: false }));

    test("Removing the last package republishes empty, signed indexes", withPublisher(async ctx => {
        await importAll(ctx, TRIXIE);
        await publishDebian(ctx);
        const before = indexFiles(ctx.db);

        const removed = new DebCatalog(ctx.db).remove({ distro: "debian", release: "trixie", source: "srm-hello" }, NOW, false);
        expect(removed.removed).toHaveLength(7);
        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);

        for (const name of TRIXIE_NAMES.filter(n => n.endsWith(".gz"))) {
            expect(await readIndex(ctx, name)).toBe("");
        }
        const text = await expectSigned(ctx);
        const release = parseRelease(text);
        expect(release.fields).toEqual([
            "Suite: trixie", "Codename: trixie", "Date: Tue, 14 Nov 2023 22:13:21 UTC", "Acquire-By-Hash: yes", "Architectures: amd64", "Components: main",
        ]);
        expect(Object.keys(release.md5)).toEqual(TRIXIE_NAMES);
        for (const name of TRIXIE_NAMES.filter(n => !n.endsWith(".gz"))) {
            expect(release.md5[name]).toEqual([MD5_EMPTY, 0]);
            expect(release.sha256[name]).toEqual([SHA256_EMPTY, 0]);
        }
        expect(cells(ctx.db)).toEqual(["contents main amd64 2", "packages main amd64 2", "sources main  2"]);
        for (const row of indexFiles(ctx.db)) {
            expect(chunkRows(ctx.db, row.id)).toEqual([]);
            expect(row.raw_size).toBe(0);
            expect((await fs.readFile(osJoin(ctx.paths.repoDir, row.stored_path!))).length).toBe(row.size);
        }
        expect(superseded(ctx.db)).toEqual(before.flatMap(row => [row.stored_path!, md5LinkOf(row.stored_path!, row.md5!)]).sort());
        expect(dirtyCount(ctx.db)).toBe(0);
    }));

    test("A changed DEB_ORIGIN republishes Release with no dirty index", withPublisher(async ctx => {
        const saved = ENV_NAMES.map(name => process.env[name]);
        try {
            process.env.DEB_ORIGIN = "Global Origin";
            process.env.DEB_ORIGIN_DEBIAN_TRIXIE = "Trixie Origin";
            process.env.DEB_DESCRIPTION_DEBIAN = "  Debian repository  ";
            delete process.env.DEB_DESCRIPTION;
            await importAll(ctx, TRIXIE);
            await publishDebian(ctx);
            const first = await expectSigned(ctx);
            expect(parseRelease(first).fields).toEqual([
                "Origin: Trixie Origin", "Suite: trixie", "Codename: trixie", `Date: ${ NOW_TEXT }`, "Acquire-By-Hash: yes",
                "Architectures: amd64", "Components: main", "Description: Debian repository",
            ]);
            expect(releaseRow(ctx.db)).toEqual({ published_date: NOW, origin: "Trixie Origin", description: "Debian repository" });
            const generations = cells(ctx.db);
            writeChunkedIndex.mockClear();

            delete process.env.DEB_ORIGIN_DEBIAN_TRIXIE;
            expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);

            expect(writeChunkedIndex).not.toHaveBeenCalled();
            expect(cells(ctx.db)).toEqual(generations);
            const second = await expectSigned(ctx);
            expect(parseRelease(second).fields).toEqual([
                "Origin: Global Origin", "Suite: trixie", "Codename: trixie", "Date: Tue, 14 Nov 2023 22:13:21 UTC", "Acquire-By-Hash: yes",
                "Architectures: amd64", "Components: main", "Description: Debian repository",
            ]);
            expect(parseRelease(second).sha256).toEqual(parseRelease(first).sha256);
            expect(releaseRow(ctx.db)).toEqual({ published_date: NOW + 1, origin: "Global Origin", description: "Debian repository" });
            expect(await publishDebian(ctx)).toEqual([]);

            delete process.env.DEB_ORIGIN;
            process.env.DEB_DESCRIPTION_DEBIAN = "";
            expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);
            expect(parseRelease(await expectSigned(ctx)).fields).toEqual([
                "Suite: trixie", "Codename: trixie", "Date: Tue, 14 Nov 2023 22:13:22 UTC", "Acquire-By-Hash: yes", "Architectures: amd64", "Components: main",
            ]);
            expect(releaseRow(ctx.db)).toEqual({ published_date: NOW + 2, origin: null, description: null });
            expect(await publishDebian(ctx)).toEqual([]);
        } finally {
            ENV_NAMES.forEach((name, i) => {
                if (saved[i] === undefined) {
                    delete process.env[name];
                } else {
                    process.env[name] = saved[i];
                }
            });
        }
    }));

    test("Publishes every touched release and keeps a subcomponent in the index paths", withPublisher(async ctx => {
        await stage(ctx, TRIXIE, { target: "deb/debian/trixie/main/sub" });
        await stage(ctx, BOOKWORM);
        await stage(ctx, NOBLE);
        await importStaged(ctx);

        expect(await publishDebian(ctx)).toEqual(["debian/bookworm", "debian/trixie", "ubuntu/noble"]);

        expect(stanzas(await readIndex(ctx, "main/sub/binary-amd64/Packages.gz"))).toEqual(["srm-hello amd64", "srm-hello-doc all"]);
        expect(await readIndex(ctx, "main/sub/source/Sources.gz")).toContain("\nDirectory: pool/main/sub/s/srm-hello\n");
        expect(await readIndex(ctx, "main/sub/Contents-amd64.gz")).toBe(await golden("deb/debian/dists/trixie/main/Contents-amd64"));
        const release = parseRelease(await readRelease(ctx));
        expect(release.fields).toContain("Components: main/sub");
        expect(Object.keys(release.md5)).toEqual([
            "main/sub/binary-amd64/Packages", "main/sub/binary-amd64/Packages.gz", "main/sub/source/Sources", "main/sub/source/Sources.gz",
            "main/sub/Contents-amd64", "main/sub/Contents-amd64.gz",
        ]);
        const contents = indexFile(ctx.db, "contents", "main/sub", "amd64");
        expect(contents.stored_path).toBe(`deb/debian/dists/trixie/main/sub/by-hash/SHA256/${ contents.sha256 }`);
        expect((await readIndexBytes(ctx, "main/Contents-amd64.gz", "debian", "bookworm")).equals(await goldenBytes("deb/debian/dists/bookworm/main/Contents-amd64"))).toBe(true);
        expect(await readIndex(ctx, "main/binary-amd64/Packages.gz", "debian", "bookworm"))
            .toBe(withoutWeakHashes(await golden("deb/debian/dists/bookworm/main/binary-amd64/Packages")));
        for (const [distro, name] of [["debian", "bookworm"], ["debian", "trixie"], ["ubuntu", "noble"]]) {
            await expectSigned(ctx, distro, name);
        }
    }));

    test("A missing or damaged previous index is rebuilt in full", withPublisher(async ctx => {
        await importAll(ctx, TRIXIE);
        await publishDebian(ctx);
        const packages = indexFile(ctx.db, "packages", "main", "amd64");
        const contents = indexFile(ctx.db, "contents", "main", "amd64");
        await fs.unlink(shadowFile(packages.id, 1));
        await fs.truncate(osJoin(ctx.paths.repoDir, contents.stored_path!), 5);
        writeChunkedIndex.mockClear();

        upload(ctx, { source: "srm-zzz", packages: [{ name: "srm-zzz", paths: ["usr/bin/srm-zzz"] }] });
        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);

        expect(writeChunkedIndex).toHaveBeenCalledTimes(2);
        expect(callFor(packages.id).previous).toBeUndefined();
        expect(callFor(contents.id).previous).toBeUndefined();
        expect(stanzas(await readIndex(ctx, "main/binary-amd64/Packages.gz"))).toEqual(["srm-hello amd64", "srm-hello-doc all", "srm-zzz amd64"]);
        expect(contentsPaths(await readIndex(ctx, "main/Contents-amd64.gz"))).toEqual(["usr/bin/srm-hello", "usr/bin/srm-zzz", "usr/share/doc/srm-hello-doc/README"]);
        const rebuilt = indexFile(ctx.db, "packages", "main", "amd64");
        expect((await fs.stat(shadowFile(packages.id, 2))).size).toBe(rebuilt.raw_size);
        expect(await exists(shadowFile(packages.id, 1))).toBe(false);
        expect(dirtyCount(ctx.db)).toBe(0);
        await expectSigned(ctx);
    }));

    test("A crash before the commit leaves the previous shadow in use", withPublisher(async ctx => {
        await importAll(ctx, TRIXIE);
        await publishDebian(ctx);
        const contents = indexFile(ctx.db, "contents", "main", "amd64");
        const packages = indexFile(ctx.db, "packages", "main", "amd64");
        const sources = indexFile(ctx.db, "sources", "main", "");
        upload(ctx, { source: "srm-zzz", packages: [{ name: "srm-zzz", paths: ["usr/bin/srm-zzz"] }] });
        // The Contents index is the first pending one, so its new shadow is on disk when the commit dies
        transaction.mockImplementationOnce(() => { throw new Error("simulated crash before the commit"); });
        await expect(publishDebian(ctx)).rejects.toThrow("simulated crash");
        expect(cells(ctx.db)).toEqual(["contents main amd64 1", "packages main amd64 1", "sources main  1"]);
        expect(dirtyCount(ctx.db)).toBeGreaterThan(0);
        expect(await shadows()).toEqual([`${ contents.id }-1`, `${ contents.id }-2`, `${ packages.id }-1`, `${ sources.id }-1`].sort());
        expect(await readRelease(ctx)).toContain(`\nDate: ${ NOW_TEXT }\n`);
        writeChunkedIndex.mockClear();

        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);

        expect(callFor(contents.id).previous).toMatchObject({ file: osJoin(ctx.paths.repoDir, contents.stored_path!), shadow: shadowFile(contents.id, 1) });
        expect(callFor(packages.id).previous).toMatchObject({ shadow: shadowFile(packages.id, 1) });
        expect(cells(ctx.db)).toEqual(["contents main amd64 2", "packages main amd64 2", "sources main  1"]);
        expect(await shadows()).toEqual([`${ contents.id }-2`, `${ packages.id }-2`, `${ sources.id }-1`].sort());
        expect(contentsPaths(await readIndex(ctx, "main/Contents-amd64.gz"))).toEqual(["usr/bin/srm-hello", "usr/bin/srm-zzz", "usr/share/doc/srm-hello-doc/README"]);
        expect(stanzas(await readIndex(ctx, "main/binary-amd64/Packages.gz"))).toEqual(["srm-hello amd64", "srm-hello-doc all", "srm-zzz amd64"]);
        const rebuilt = indexFile(ctx.db, "contents", "main", "amd64");
        expect((await fs.stat(shadowFile(contents.id, 2))).size).toBe(rebuilt.raw_size);
        expect(dirtyCount(ctx.db)).toBe(0);
        expect(await leftovers("repo")).toEqual([]);
        expect(await fs.readdir(osPath.join("state", "tmp"))).toEqual([]);
        expect(await expectSigned(ctx)).toContain("\nDate: Tue, 14 Nov 2023 22:13:21 UTC\n");
    }));

    test("Contents shared between two architectures survives a one-architecture republish", withPublisher(async ctx => {
        await importAll(ctx, TRIXIE, ARM64);
        await publishDebian(ctx);
        const amd64 = indexFile(ctx.db, "contents", "main", "amd64");
        const arm64 = indexFile(ctx.db, "contents", "main", "arm64");
        const packages = indexFile(ctx.db, "packages", "main", "amd64");
        expect(arm64.stored_path).toBe(amd64.stored_path);
        const shared = amd64.stored_path!;
        const sharedMd5 = md5LinkOf(shared, amd64.md5!);

        upload(ctx, { source: "srm-zzz", packages: [{ name: "srm-zzz", paths: ["usr/bin/srm-zzz"] }] });
        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);

        expect(indexFile(ctx.db, "contents", "main", "amd64").stored_path).not.toBe(shared);
        expect(indexFile(ctx.db, "contents", "main", "arm64").stored_path).toBe(shared);
        expect(superseded(ctx.db)).toEqual([packages.stored_path!, md5LinkOf(packages.stored_path!, packages.md5!)].sort());
        expect(await exists(osJoin(ctx.paths.repoDir, shared))).toBe(true);
        expect(await exists(osJoin(ctx.paths.repoDir, sharedMd5))).toBe(true);
        expect(await readIndex(ctx, "main/Contents-arm64.gz")).toBe(await golden("deb/debian/dists/trixie/main/Contents-amd64"));
        expect(contentsPaths(await readIndex(ctx, "main/Contents-amd64.gz"))).toContain("usr/bin/srm-zzz");
        const release = parseRelease(await readRelease(ctx));
        expect(release.sha256["main/Contents-arm64.gz"]).toEqual([arm64.sha256, arm64.size]);

        upload(ctx, { source: "srm-arm", packages: [{ name: "srm-arm", architecture: "arm64", paths: ["usr/bin/srm-arm"] }] });
        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);

        expect(superseded(ctx.db)).toEqual(expect.arrayContaining([shared, sharedMd5]));
        expect(indexFile(ctx.db, "contents", "main", "arm64").stored_path).not.toBe(shared);
    }));

    test("An orphan's MD5Sum link shared with a live index is kept", withPublisher(async ctx => {
        await stageArchAllOnly(ctx);
        await importStaged(ctx);
        await publishDebian(ctx);
        const allContents = indexFile(ctx.db, "contents", "main", "all");
        const allPackages = indexFile(ctx.db, "packages", "main", "all");

        // No paths: Contents-arm64 holds the arch all README line only, exactly like Contents-all
        upload(ctx, { source: "srm-arm", packages: [{ name: "srm-arm", architecture: "arm64" }] });
        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);

        expect(indexFile(ctx.db, "contents", "main", "arm64").stored_path).toBe(allContents.stored_path);
        expect(await readIndex(ctx, "main/Contents-arm64.gz")).toBe("usr/share/doc/srm-hello-doc/README\t    doc/srm-hello-doc\n");
        expect(await exists(distsFile(ctx, "main/Contents-all.gz"))).toBe(false);
        expect(await exists(osJoin(ctx.paths.repoDir, allContents.stored_path!))).toBe(true);
        expect(await exists(osJoin(ctx.paths.repoDir, md5LinkOf(allContents.stored_path!, allContents.md5!)))).toBe(true);
        expect(await exists(distsFile(ctx, "main/binary-all/Packages.gz"))).toBe(false);
        expect(await exists(osJoin(ctx.paths.repoDir, allPackages.stored_path!))).toBe(true);
        expect(await exists(osJoin(ctx.paths.repoDir, md5LinkOf(allPackages.stored_path!, allPackages.md5!)))).toBe(false);
        expect(superseded(ctx.db)).toEqual([allPackages.stored_path!]);
        expect(Object.keys(parseRelease(await readRelease(ctx)).md5)).toEqual([
            "main/binary-arm64/Packages", "main/binary-arm64/Packages.gz", "main/source/Sources", "main/source/Sources.gz",
            "main/Contents-arm64", "main/Contents-arm64.gz",
        ]);
    }));

    test("A source-only release omits Architectures", withPublisher(async ctx => {
        await stageSourceOnly(ctx);
        await importStaged(ctx);

        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);

        expect(cells(ctx.db)).toEqual(["sources main  1"]);
        const text = await expectSigned(ctx);
        expect(text.split("\n").filter(line => line !== line.trimEnd())).toEqual([]);
        const release = parseRelease(text);
        expect(release.fields).toEqual(["Suite: trixie", "Codename: trixie", `Date: ${ NOW_TEXT }`, "Acquire-By-Hash: yes", "Components: main"]);
        expect(Object.keys(release.md5)).toEqual(["main/source/Sources", "main/source/Sources.gz"]);
        expect(await readIndex(ctx, "main/source/Sources.gz")).toBe(await golden("deb/debian/dists/trixie/main/source/Sources"));
    }));

    test("Writing a name takes it back from superseded_files", withPublisher(async ctx => {
        await importAll(ctx, TRIXIE);
        const dists = "deb/debian/dists/trixie";
        const notWritten = `${ dists }/main/binary-amd64/Release`;
        const supersede = ctx.db.prepare("INSERT INTO superseded_files (path, superseded_at) VALUES (?, ?)");
        for (const name of ["Release", "InRelease", "Release.gpg", "main/binary-amd64/Packages.gz", "main/source/Sources.gz", "main/Contents-amd64.gz", "main/binary-amd64/Release"]) {
            supersede.run(`${ dists }/${ name }`, NOW - 1);
        }

        await publishDebian(ctx);

        expect(superseded(ctx.db)).toEqual([notWritten]);
    }));

    test("Republishing identical content keeps the links and leaves no temp files", withPublisher(async ctx => {
        await importAll(ctx, TRIXIE);
        await publishDebian(ctx);
        const before = indexFiles(ctx.db);
        const release = await readRelease(ctx);

        await importAll(ctx, TRIXIE);
        expect(dirtyCount(ctx.db)).toBeGreaterThan(0);
        expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);

        const after = indexFiles(ctx.db);
        expect(after.map(row => row.generation)).toEqual([2, 2, 2]);
        expect(after.map(row => ({ ...row, generation: 1 }))).toEqual(before);
        expect(superseded(ctx.db)).toEqual([]);
        expect(await leftovers("repo")).toEqual([]);
        expect(await fs.readdir(osPath.join("state", "tmp"))).toEqual([]);
        expect(await shadows()).toEqual(after.map(row => `${ row.id }-2`).sort());
        for (const row of after) {
            const canonical = await readBytes(ctx, `${ row.kind === "contents" ? "main/Contents-amd64" : row.kind === "sources" ? "main/source/Sources" : "main/binary-amd64/Packages" }.gz`);
            expect(digest("sha256", canonical)).toBe(row.sha256);
            expect((await readBytes(ctx, md5LinkOf(row.stored_path!, row.md5!).slice("deb/debian/dists/trixie/".length))).equals(canonical)).toBe(true);
        }
        const text = await expectSigned(ctx);
        expect(text).not.toBe(release);
        expect(parseRelease(text).sha256).toEqual(parseRelease(release).sha256);
    }));
});
