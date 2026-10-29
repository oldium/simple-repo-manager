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
import { hashFile } from "../../../server/backend/hash.ts";
import { RpmCatalog } from "../../../server/backend/rpm/catalog.ts";
import { importRpm } from "../../../server/backend/rpm/importer.ts";
import { publishRpm } from "../../../server/backend/rpm/publisher.ts";
import { xmlFooter, xmlHeader } from "../../../server/backend/rpm/xml.ts";

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const RPMS = osPath.join(FIXTURES, "packages", "rpm", "fedora", "42");
const GOLDEN = osPath.join(FIXTURES, "golden", "rpm", "fedora", "42", "repodata");
const NOW = 1700000000;
const TARGET = "rpm/fedora/42";
const POOL = "rpm/fedora/42/Packages/s/srm-hello";
const SRC = "srm-hello-1.0-1.fc42.src.rpm";
const BIN = "srm-hello-1.0-1.fc42.x86_64.rpm";
const DOC = "srm-hello-doc-1.0-1.fc42.noarch.rpm";
/** The fixtures in sort-key order, which is also the golden package order */
const ALL = [SRC, BIN, DOC];
const KINDS = ["primary", "filelists", "other"] as const;

type Kind = typeof KINDS[number];

type Ctx = BackendContext & { clock: { now: number } };

type IndexFileRow = { id: number; kind: Kind; generation: number; stored_path: string; size: number; sha256: string; raw_size: number; raw_sha256: string };

type RepomdData = { type: string; checksum: string; openChecksum: string; href: string; timestamp: number; size: number; openSize: number };

let key: openpgp.PrivateKey;

beforeAll(async () => {
    const { privateKey } = await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "t" }], format: "object" });
    key = privateKey;
});

function osJoin(...posix: string[]): string {
    return osPath.join(...posix.join("/").split("/"));
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

/** Copies the fixtures into the staging dir and imports them; the importer hashes them itself */
async function importAll(ctx: Ctx, names: string[], target = TARGET): Promise<void> {
    const dir = osJoin(ctx.paths.incomingDir, "process", target);
    await fs.mkdir(dir, { recursive: true });
    for (const name of names) {
        await fs.copyFile(osPath.join(RPMS, name), osPath.join(dir, name));
    }
    const result = await importRpm(ctx);
    expect(result).toHaveLength(names.length);
    expect(result.filter(f => f.status !== "ok")).toEqual([]);
}

function repodata(ctx: Ctx, rel: string, distro = "fedora", release = "42"): string {
    return osJoin(ctx.paths.repoDir, "rpm", distro, release, "repodata", rel);
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.stat(file);
        return true;
    } catch {
        return false;
    }
}

function digest(data: Buffer | string): string {
    return crypto.createHash("sha256").update(data).digest("hex");
}

async function mtimeOf(file: string): Promise<number> {
    return Math.floor((await fs.stat(file)).mtimeMs / 1000);
}

async function readRepomd(ctx: Ctx, distro = "fedora", release = "42"): Promise<string> {
    return fs.readFile(repodata(ctx, "repomd.xml", distro, release), "utf8");
}

function valueBetween(text: string, open: string, close: string): string {
    const at = text.indexOf(open);
    if (at < 0) {
        throw new Error(`${ open } not found`);
    }
    const from = at + open.length;
    return text.slice(from, text.indexOf(close, from));
}

function parseRepomd(text: string): { revision: number; data: RepomdData[] } {
    const data = text.split('<data type="').slice(1).map(block => ({
        type: block.slice(0, block.indexOf('"')),
        checksum: valueBetween(block, '<checksum type="sha256">', "</checksum>"),
        openChecksum: valueBetween(block, '<open-checksum type="sha256">', "</open-checksum>"),
        href: valueBetween(block, '<location href="', '"/>'),
        timestamp: Number(valueBetween(block, "<timestamp>", "</timestamp>")),
        size: Number(valueBetween(block, "<size>", "</size>")),
        openSize: Number(valueBetween(block, "<open-size>", "</open-size>")),
    }));
    return { revision: Number(valueBetween(text, "<revision>", "</revision>")), data };
}

/** The decoded metadata the current repomd.xml names for the kind */
async function decoded(ctx: Ctx, kind: Kind, distro = "fedora", release = "42"): Promise<string> {
    const entry = parseRepomd(await readRepomd(ctx, distro, release)).data.find(d => d.type === kind);
    if (entry === undefined) {
        throw new Error(`No ${ kind } entry in repomd.xml`);
    }
    return zlib.zstdDecompressSync(await fs.readFile(repodata(ctx, entry.href.slice("repodata/".length), distro, release))).toString("utf8");
}

function packageCount(xml: string): number {
    return xml.split("<package ").length - 1;
}

async function verifyDetached(data: Buffer, armoredSignature: string): Promise<void> {
    const signature = await openpgp.readSignature({ armoredSignature });
    const result = await openpgp.verify({ message: await openpgp.createMessage({ binary: data }), signature, verificationKeys: key.toPublic() });
    await expect(result.signatures[0].verified).resolves.toBe(true);
}

/** repomd.xml.asc verifies and covers the repomd.xml bytes */
async function expectSigned(ctx: Ctx, distro = "fedora", release = "42"): Promise<string> {
    const text = await fs.readFile(repodata(ctx, "repomd.xml", distro, release));
    const armored = await fs.readFile(repodata(ctx, "repomd.xml.asc", distro, release), "utf8");
    expect(armored.startsWith("-----BEGIN PGP SIGNATURE-----")).toBe(true);
    await verifyDetached(text, armored);
    return text.toString("utf8");
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

async function shadows(): Promise<string[]> {
    return (await fs.readdir(osPath.join("state", "shadow"))).sort();
}

function indexFiles(db: Database, distro = "fedora", release = "42"): IndexFileRow[] {
    return db.prepare(`
        SELECT i.id, i.kind, i.generation, i.stored_path, i.size, i.sha256, i.raw_size, i.raw_sha256 FROM index_files i
            JOIN releases r ON r.id = i.release_id WHERE r.distro = ? AND r.name = ? ORDER BY i.kind`).all(distro, release) as IndexFileRow[];
}

function indexFile(db: Database, kind: Kind, distro = "fedora", release = "42"): IndexFileRow {
    const found = indexFiles(db, distro, release).find(f => f.kind === kind);
    if (found === undefined) {
        throw new Error(`No ${ kind } index in ${ distro }/${ release }`);
    }
    return found;
}

function chunkRows(db: Database, id: number): { startKey: string; rawOffset: number; rawLength: number }[] {
    return db.prepare("SELECT start_key, raw_offset, raw_length FROM index_chunks WHERE index_file_id = ? ORDER BY seq").all(id)
        .map(r => ({ startKey: r.start_key as string, rawOffset: r.raw_offset as number, rawLength: r.raw_length as number }));
}

function dirtyCount(db: Database): number {
    return (db.prepare("SELECT count(*) AS n FROM dirty_keys").get() as { n: number }).n;
}

function packageRows(db: Database): number {
    return (db.prepare("SELECT count(*) AS n FROM rpm_packages").get() as { n: number }).n;
}

function superseded(db: Database): { path: string; superseded_at: number }[] {
    return db.prepare("SELECT path, superseded_at FROM superseded_files ORDER BY path").all() as { path: string; superseded_at: number }[];
}

function publishedDate(db: Database, distro = "fedora", release = "42"): number | null {
    return (db.prepare("SELECT published_date FROM releases WHERE distro = ? AND name = ?").get(distro, release) as { published_date: number | null }).published_date;
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

/** The golden file with our pool layout, the pool files' mtimes and the upload digests as pkgid */
async function expectedMetadata(ctx: Ctx, kind: Kind): Promise<string> {
    const text = await fs.readFile(osPath.join(GOLDEN, `${ kind }.xml`), "utf8");
    const start = text.indexOf("<package ");
    const end = text.lastIndexOf("</package>\n") + "</package>\n".length;
    const packages = text.slice(start, end).split("</package>\n").filter(p => p.length > 0).map(p => `${ p }</package>\n`);
    expect(packages).toHaveLength(ALL.length);
    const substituted: string[] = [];
    for (const [i, name] of ALL.entries()) {
        const file = osJoin(ctx.paths.repoDir, POOL, name);
        const { sha256 } = await hashFile(file);
        if (kind === "primary") {
            let p = replaceValue(packages[i], '<location href="', '"', `Packages/s/srm-hello/${ name }`);
            p = replaceValue(p, '<time file="', '"', String(await mtimeOf(file)));
            substituted.push(replaceValue(p, 'pkgid="YES">', "<", sha256));
        } else {
            substituted.push(replaceValue(packages[i], 'pkgid="', '"', sha256));
        }
    }
    return `${ text.slice(0, start) }${ substituted.join("") }${ text.slice(end) }`;
}

describe("Tests for publishRpm", () => {
    test("repomd.xml checksums match the files and open-checksums match the decoded content", withPublisher(async ctx => {
        await importAll(ctx, ALL);

        expect(await publishRpm(ctx)).toEqual(["fedora/42"]);

        const repomd = parseRepomd(await readRepomd(ctx));
        expect(repomd.revision).toBe(NOW);
        expect(repomd.data.map(d => d.type)).toEqual(["primary", "filelists", "other"]);
        for (const entry of repomd.data) {
            expect(entry.href).toBe(`repodata/${ entry.checksum }-${ entry.type }.xml.zst`);
            const file = repodata(ctx, entry.href.slice("repodata/".length));
            const bytes = await fs.readFile(file);
            expect(digest(bytes)).toBe(entry.checksum);
            expect(bytes.length).toBe(entry.size);
            const raw = zlib.zstdDecompressSync(bytes);
            expect(raw.length).toBeGreaterThan(0);
            expect(digest(raw)).toBe(entry.openChecksum);
            expect(raw.length).toBe(entry.openSize);
            expect(entry.timestamp).toBe(await mtimeOf(file));
            const row = indexFile(ctx.db, entry.type as Kind);
            expect(row).toEqual({
                id: row.id, kind: entry.type, generation: 1, stored_path: `rpm/fedora/42/repodata/${ entry.checksum }-${ entry.type }.xml.zst`,
                size: entry.size, sha256: entry.checksum, raw_size: entry.openSize, raw_sha256: entry.openChecksum,
            });
            expect((await fs.readFile(osPath.join("state", "shadow", `${ row.id }-1`))).equals(raw)).toBe(true);
        }
        expect((await fs.readdir(repodata(ctx, ""))).sort()).toEqual([...repomd.data.map(d => d.href.slice("repodata/".length)), "repomd.xml", "repomd.xml.asc"].sort());
        expect(await shadows()).toEqual(indexFiles(ctx.db).map(row => `${ row.id }-1`).sort());
        expect(dirtyCount(ctx.db)).toBe(0);
        expect(superseded(ctx.db)).toEqual([]);
        expect(publishedDate(ctx.db)).toBe(NOW);
        expect(await leftovers("repo")).toEqual([]);
        expect(await fs.readdir(osPath.join("state", "tmp"))).toEqual([]);

        expect(await publishRpm(ctx)).toEqual([]);
        expect(parseRepomd(await readRepomd(ctx))).toEqual(repomd);
    }));

    test("Decoded primary.xml has packages count equal to rows", withPublisher(async ctx => {
        await importAll(ctx, ALL);
        await publishRpm(ctx);

        const primary = await decoded(ctx, "primary");
        expect(packageRows(ctx.db)).toBe(3);
        expect(packageCount(primary)).toBe(3);
        expect(primary.startsWith(xmlHeader("primary", 3))).toBe(true);
        expect(primary.endsWith(xmlFooter("primary"))).toBe(true);
        expect(primary).toBe(await expectedMetadata(ctx, "primary"));
        expect(await decoded(ctx, "filelists")).toBe(await expectedMetadata(ctx, "filelists"));
        expect(await decoded(ctx, "other")).toBe(await expectedMetadata(ctx, "other"));

        // Header and footer are frames of their own; the one chunk holds exactly the package records
        const chunks = chunkRows(ctx.db, indexFile(ctx.db, "primary").id);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].startKey).toBe("");
        expect(chunks[0].rawOffset).toBe(Buffer.byteLength(xmlHeader("primary", 3)));
        expect(chunks[0].rawLength).toBe(Buffer.byteLength(primary) - chunks[0].rawOffset - Buffer.byteLength(xmlFooter("primary")));
    }));

    test("repomd.xml.asc verifies", withPublisher(async ctx => {
        await importAll(ctx, ALL);
        expect(await publishRpm(ctx)).toEqual(["fedora/42"]);

        const text = await expectSigned(ctx);
        expect(text).toContain(`<revision>${ NOW }</revision>`);
        expect(text.endsWith("</repomd>\n")).toBe(true);
    }));

    test("Second publish keeps the previous primary file and records it as superseded", withPublisher(async ctx => {
        await importAll(ctx, [SRC, BIN]);
        await publishRpm(ctx);
        const before = indexFiles(ctx.db);
        expect(packageCount(await decoded(ctx, "primary"))).toBe(2);

        await importAll(ctx, [DOC]);
        expect(dirtyCount(ctx.db)).toBe(3);
        expect(await publishRpm(ctx)).toEqual(["fedora/42"]);

        const after = indexFiles(ctx.db);
        expect(after.map(row => row.generation)).toEqual([2, 2, 2]);
        for (const [i, row] of after.entries()) {
            expect(row.stored_path).not.toBe(before[i].stored_path);
            expect(await exists(osJoin(ctx.paths.repoDir, before[i].stored_path))).toBe(true);
            expect(await exists(osJoin(ctx.paths.repoDir, row.stored_path))).toBe(true);
        }
        expect(superseded(ctx.db)).toEqual(before.map(row => ({ path: row.stored_path, superseded_at: NOW })).sort((a, b) => a.path.localeCompare(b.path)));
        const previous = indexFile(ctx.db, "primary");
        const oldPrimary = before.find(row => row.kind === "primary")!;
        expect(packageCount(zlib.zstdDecompressSync(await fs.readFile(osJoin(ctx.paths.repoDir, oldPrimary.stored_path))).toString("utf8"))).toBe(2);
        expect(packageCount(await decoded(ctx, "primary"))).toBe(3);
        expect(await decoded(ctx, "primary")).toBe(await expectedMetadata(ctx, "primary"));
        const repomd = parseRepomd(await readRepomd(ctx));
        expect(repomd.data.map(d => d.href)).toEqual(after.map(row => `repodata/${ row.sha256 }-${ row.kind }.xml.zst`).sort((a, b) => {
            const order = (href: string) => KINDS.findIndex(kind => href.endsWith(`-${ kind }.xml.zst`));
            return order(a) - order(b);
        }));
        expect(repomd.revision).toBe(NOW + 1);
        expect(publishedDate(ctx.db)).toBe(NOW + 1);
        expect(await shadows()).toEqual(after.map(row => `${ row.id }-2`).sort());
        expect(await exists(osJoin(ctx.paths.repoDir, previous.stored_path))).toBe(true);
        expect(dirtyCount(ctx.db)).toBe(0);
        expect(await leftovers("repo")).toEqual([]);
        await expectSigned(ctx);
    }));

    test("Without a signing key repomd.xml.asc is absent, and a stale one is removed; the revision stays monotonic", withPublisher(async ctx => {
        await importAll(ctx, ALL);
        expect(await publishRpm(ctx)).toEqual(["fedora/42"]);
        expect(await exists(repodata(ctx, "repomd.xml"))).toBe(true);
        expect(await exists(repodata(ctx, "repomd.xml.asc"))).toBe(false);
        expect(parseRepomd(await readRepomd(ctx)).revision).toBe(NOW);

        ctx.signingKey = key;
        await importAll(ctx, [BIN]);
        expect(await publishRpm(ctx)).toEqual(["fedora/42"]);
        expect(await expectSigned(ctx)).toContain(`<revision>${ NOW + 1 }</revision>`);

        ctx.signingKey = undefined;
        ctx.clock.now = NOW + 100;
        await importAll(ctx, [BIN]);
        expect(await publishRpm(ctx)).toEqual(["fedora/42"]);
        expect(await exists(repodata(ctx, "repomd.xml.asc"))).toBe(false);
        expect(parseRepomd(await readRepomd(ctx)).revision).toBe(NOW + 100);
        expect(publishedDate(ctx.db)).toBe(NOW + 100);
    }, { signed: false }));

    test("Removing the last package republishes empty metadata", withPublisher(async ctx => {
        await importAll(ctx, ALL);
        await publishRpm(ctx);
        const before = indexFiles(ctx.db);

        expect(new RpmCatalog(ctx.db).remove({ source: "srm-hello" }, NOW, false).removed).toHaveLength(3);
        expect(await publishRpm(ctx)).toEqual(["fedora/42"]);

        for (const kind of KINDS) {
            expect(await decoded(ctx, kind)).toBe(xmlHeader(kind, 0) + xmlFooter(kind));
            expect(chunkRows(ctx.db, indexFile(ctx.db, kind).id)).toEqual([]);
        }
        const repomd = parseRepomd(await readRepomd(ctx));
        expect(repomd.data.map(d => d.openSize)).toEqual(KINDS.map(kind => Buffer.byteLength(xmlHeader(kind, 0) + xmlFooter(kind))));
        expect(superseded(ctx.db).map(s => s.path)).toEqual(before.map(row => row.stored_path).sort());
        expect(dirtyCount(ctx.db)).toBe(0);
        await expectSigned(ctx);
    }));

    test("Writing repomd.xml takes it and its signature back from superseded_files", withPublisher(async ctx => {
        await importAll(ctx, ALL);
        const notWritten = "rpm/fedora/42/repodata/old-primary.xml.gz";
        const supersede = ctx.db.prepare("INSERT INTO superseded_files (path, superseded_at) VALUES (?, ?)");
        for (const path of ["rpm/fedora/42/repodata/repomd.xml", "rpm/fedora/42/repodata/repomd.xml.asc", notWritten]) {
            supersede.run(path, NOW - 1);
        }

        await publishRpm(ctx);

        expect(superseded(ctx.db)).toEqual([{ path: notWritten, superseded_at: NOW - 1 }]);
    }));

    test("A metadata chunk reads only its key range", withPublisher(async ctx => {
        const prepare = jest.spyOn(ctx.db, "prepare");
        await publishRpm(ctx);
        const statements = prepare.mock.calls.map(([sql]) => sql).filter(sql => sql.includes("< coalesce("));
        prepare.mockRestore();

        expect(statements).toHaveLength(KINDS.length);
        for (const sql of statements) {
            expect(ctx.db.prepare(`EXPLAIN QUERY PLAN ${ sql }`).all().map(r => r.detail))
                .toEqual(["SEARCH rpm_packages USING INDEX rpm_packages_order (release_id=? AND sort_key>? AND sort_key<?)"]);
        }
    }));

    test("Publishes every touched release", withPublisher(async ctx => {
        await importAll(ctx, ALL);
        await importAll(ctx, [BIN], "rpm/fedora/41");

        expect(await publishRpm(ctx)).toEqual(["fedora/41", "fedora/42"]);

        expect(packageCount(await decoded(ctx, "primary", "fedora", "41"))).toBe(1);
        expect(await decoded(ctx, "primary", "fedora", "41")).toContain('<location href="Packages/s/srm-hello/srm-hello-1.0-1.fc42.x86_64.rpm"/>');
        expect(packageCount(await decoded(ctx, "primary"))).toBe(3);
        expect(indexFile(ctx.db, "primary", "fedora", "41").stored_path.startsWith("rpm/fedora/41/repodata/")).toBe(true);
        await expectSigned(ctx, "fedora", "41");
        await expectSigned(ctx);
        expect(await shadows()).toEqual([...indexFiles(ctx.db), ...indexFiles(ctx.db, "fedora", "41")].map(row => `${ row.id }-1`).sort());

        expect(await publishRpm(ctx)).toEqual([]);
    }));
});
