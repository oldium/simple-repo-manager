import { withLocalTmpDir } from "../utils.ts";
import { jest } from "@jest/globals";
import crypto from "crypto";
import osPath from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import type { Database } from "node:sqlite";
import * as openpgp from "openpgp";
import { openDatabase } from "../../server/backend/db.ts";
import type { BackendContext } from "../../server/backend/context.ts";
import { DebCatalog } from "../../server/backend/deb/catalog.ts";
import { importDebian } from "../../server/backend/deb/importer.ts";
import { publishDebian, reconcileDebian } from "../../server/backend/deb/publisher.ts";
import { GC_GRACE_SECONDS } from "../../server/backend/gc.ts";
import { clearsign, detachedSignature } from "../../server/backend/pgp.ts";
import { reconcile, repairPublished } from "../../server/backend/reconcile.ts";
import type { ReconcileResult } from "../../server/backend/reconcile.ts";
import { importRpm } from "../../server/backend/rpm/importer.ts";
import { publishRpm, reconcileRpm } from "../../server/backend/rpm/publisher.ts";
import logger from "../../server/lib/logger.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const TRIXIE = osPath.join(FIXTURES, "packages", "deb", "debian", "trixie", "main");
const ARM64 = osPath.join(FIXTURES, "packages-arm64", "deb", "debian", "trixie", "main");
const RPMS = osPath.join(FIXTURES, "packages", "rpm", "fedora", "42");
const ALL_RPMS = ["srm-hello-1.0-1.fc42.src.rpm", "srm-hello-1.0-1.fc42.x86_64.rpm", "srm-hello-doc-1.0-1.fc42.noarch.rpm"];
const NOW = 1700000000;
const STALE = NOW - 2 * GC_GRACE_SECONDS;
const ENV_NAMES = ["DEB_ORIGIN", "DEB_ORIGIN_DEBIAN_TRIXIE", "DEB_DESCRIPTION", "DEB_DESCRIPTION_DEBIAN"];
const NOTHING: ReconcileResult = {
    rebuilt: [], published: [], repaired: [], restamped: [], restampedIndexes: [], superseded: [], shadows: [], staged: [], temp: [], mismatched: [],
};

type Ctx = BackendContext & { clock: { now: number } };

type Row = { id: number; kind: string; component: string; architecture: string; generation: number; stored_path: string; md5: string; sha256: string; size: number };

let key: openpgp.PrivateKey;
let otherKey: openpgp.PrivateKey;

beforeAll(async () => {
    key = (await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "t" }], format: "object" })).privateKey;
    otherKey = (await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "o" }], format: "object" })).privateKey;
});

function osJoin(...posix: string[]): string {
    return osPath.join(...posix.join("/").split("/"));
}

function withCtx(fn: (ctx: Ctx) => Promise<void>, o: { signed?: boolean } = {}) {
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

async function stageDeb(ctx: Ctx, dir: string, target = "deb/debian/trixie/main"): Promise<void> {
    const to = osJoin(ctx.paths.incomingDir, "process", target);
    await fs.mkdir(to, { recursive: true });
    for (const name of await fs.readdir(dir)) {
        await fs.copyFile(osPath.join(dir, name), osPath.join(to, name));
    }
    const result = await importDebian(ctx);
    expect(result.filter(f => f.status !== "ok")).toEqual([]);
}

async function stageRpm(ctx: Ctx, names: string[], target = "rpm/fedora/42"): Promise<void> {
    const to = osJoin(ctx.paths.incomingDir, "process", target);
    await fs.mkdir(to, { recursive: true });
    for (const name of names) {
        await fs.copyFile(osPath.join(RPMS, name), osPath.join(to, name));
    }
    const result = await importRpm(ctx);
    expect(result.filter(f => f.status !== "ok")).toEqual([]);
}

/** Both fixture sets imported and published */
async function publishAll(ctx: Ctx): Promise<void> {
    await stageDeb(ctx, TRIXIE);
    await stageRpm(ctx, ALL_RPMS);
    expect(await publishDebian(ctx)).toEqual(["debian/trixie"]);
    expect(await publishRpm(ctx)).toEqual(["fedora/42"]);
}

function rows(db: Database, distro = "debian", release = "trixie"): Row[] {
    return db.prepare(`
        SELECT i.id, i.kind, i.component, i.architecture, i.generation, i.stored_path, i.md5, i.sha256, i.size FROM index_files i
            JOIN releases r ON r.id = i.release_id WHERE r.distro = ? AND r.name = ? ORDER BY i.component, i.kind, i.architecture`).all(distro, release) as Row[];
}

function indexRow(db: Database, kind: string, architecture = "amd64", distro = "debian", release = "trixie"): Row {
    const found = rows(db, distro, release).find(r => r.kind === kind && r.architecture === architecture);
    if (found === undefined) {
        throw new Error(`No ${ kind } ${ architecture } index in ${ distro }/${ release }`);
    }
    return found;
}

function releaseRow(db: Database, distro = "debian", release = "trixie"): { published_date: number | null; origin: string | null; description: string | null } {
    return db.prepare("SELECT published_date, origin, description FROM releases WHERE distro = ? AND name = ?").get(distro, release) as
        { published_date: number | null; origin: string | null; description: string | null };
}

function superseded(db: Database): { path: string; superseded_at: number }[] {
    return db.prepare("SELECT path, superseded_at FROM superseded_files ORDER BY path").all() as { path: string; superseded_at: number }[];
}

function supersede(db: Database, ...paths: string[]): void {
    const insert = db.prepare("INSERT INTO superseded_files (path, superseded_at) VALUES (?, ?)");
    for (const path of paths) {
        insert.run(path, STALE);
    }
}

function removedAt(db: Database): (number | null)[] {
    return db.prepare("SELECT removed_at FROM pool_files ORDER BY path").all().map(r => r.removed_at as number | null);
}

function stagedRows(db: Database): string[] {
    return db.prepare("SELECT rel_path FROM staged_digests ORDER BY rel_path").all().map(r => r.rel_path as string);
}

function insertStaged(db: Database, relPath: string): void {
    db.prepare("INSERT INTO staged_digests (rel_path, size, mtime_ms, md5, sha1, sha256, sha512) VALUES (?, 1, 1, 'm', 's', 'h', 'x')").run(relPath);
}

function dirtyCount(db: Database): number {
    return (db.prepare("SELECT count(*) AS n FROM dirty_keys").get() as { n: number }).n;
}

function repoFile(ctx: Ctx, rel: string): string {
    return osJoin(ctx.paths.repoDir, rel);
}

function dists(ctx: Ctx, rel: string): string {
    return repoFile(ctx, `deb/debian/dists/trixie/${ rel }`);
}

function repodata(ctx: Ctx, rel: string): string {
    return repoFile(ctx, `rpm/fedora/42/repodata/${ rel }`);
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.stat(file);
        return true;
    } catch {
        return false;
    }
}

async function writeFile(file: string, content: string, mtime?: number): Promise<void> {
    await fs.mkdir(osPath.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    if (mtime !== undefined) {
        await fs.utimes(file, mtime, mtime);
    }
}

async function inode(file: string): Promise<bigint> {
    return (await fs.stat(file, { bigint: true })).ino;
}

/** Inode and content hash of every file below dir, keyed by relative path */
async function snapshot(dir: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const walk = async (d: string, rel: string): Promise<void> => {
        for (const entry of await fs.readdir(d, { withFileTypes: true })) {
            const file = osPath.join(d, entry.name);
            const r = rel ? `${ rel }/${ entry.name }` : entry.name;
            if (entry.isDirectory()) {
                await walk(file, r);
            } else {
                out[r] = `${ await inode(file) } ${ crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex") }`;
            }
        }
    };
    await walk(dir, "");
    return out;
}

async function shadows(): Promise<string[]> {
    return (await fs.readdir(osPath.join("state", "shadow"))).sort();
}

async function verifyClear(file: string, k: openpgp.PrivateKey): Promise<string> {
    const message = await openpgp.readCleartextMessage({ cleartextMessage: await fs.readFile(file, "utf8") });
    const result = await openpgp.verify({ message, verificationKeys: k.toPublic() });
    await expect(result.signatures[0].verified).resolves.toBe(true);
    return message.getText();
}

async function verifyDet(data: Buffer, file: string, k: openpgp.PrivateKey): Promise<void> {
    const signature = await openpgp.readSignature({ armoredSignature: await fs.readFile(file, "utf8") });
    const result = await openpgp.verify({ message: await openpgp.createMessage({ binary: data }), signature, verificationKeys: k.toPublic() });
    await expect(result.signatures[0].verified).resolves.toBe(true);
}

/** InRelease and Release.gpg verify with the key and carry the Release text */
async function expectSignedDeb(ctx: Ctx, k = key): Promise<string> {
    const text = await fs.readFile(dists(ctx, "Release"), "utf8");
    expect(await verifyClear(dists(ctx, "InRelease"), k)).toBe(text);
    await verifyDet(Buffer.from(text), dists(ctx, "Release.gpg"), k);
    return text;
}

/** repomd.xml.asc verifies with the key and covers repomd.xml */
async function expectSignedRpm(ctx: Ctx): Promise<string> {
    const text = await fs.readFile(repodata(ctx, "repomd.xml"));
    await verifyDet(text, repodata(ctx, "repomd.xml.asc"), key);
    return text.toString("utf8");
}

function withEnv(fn: () => Promise<void>): () => Promise<void> {
    return async () => {
        const saved = ENV_NAMES.map(name => process.env[name]);
        try {
            for (const name of ENV_NAMES) {
                delete process.env[name];
            }
            await fn();
        } finally {
            ENV_NAMES.forEach((name, i) => {
                if (saved[i] === undefined) {
                    delete process.env[name];
                } else {
                    process.env[name] = saved[i];
                }
            });
        }
    };
}

describe("Tests for reconcileDebian", () => {
    test("A consistent release is left byte for byte as it is", withCtx(async ctx => {
        await stageDeb(ctx, TRIXIE);
        await publishDebian(ctx);
        const before = await snapshot("repo");
        ctx.clock.now = NOW + 50;

        expect(await reconcileDebian(ctx)).toEqual([]);

        expect(await snapshot("repo")).toEqual(before);
        expect(releaseRow(ctx.db).published_date).toBe(NOW);
    }));

    test("A canonical name pointing at the previous generation is re-linked; Release stays", withCtx(async ctx => {
        await stageDeb(ctx, TRIXIE);
        await publishDebian(ctx);
        const first = indexRow(ctx.db, "packages");
        new DebCatalog(ctx.db).remove({ distro: "debian", release: "trixie", source: "srm-hello" }, NOW, false);
        await publishDebian(ctx);
        const second = indexRow(ctx.db, "packages");
        expect(second.stored_path).not.toBe(first.stored_path);
        const canonical = dists(ctx, "main/binary-amd64/Packages.gz");
        await fs.copyFile(repoFile(ctx, first.stored_path), `${ canonical }.new`);
        await fs.rename(`${ canonical }.new`, canonical);
        const release = await fs.readFile(dists(ctx, "Release"), "utf8");
        const inRelease = await fs.readFile(dists(ctx, "InRelease"), "utf8");
        ctx.clock.now = NOW + 50;

        expect(await reconcileDebian(ctx)).toEqual(["debian/trixie"]);

        expect(await inode(canonical)).toBe(await inode(repoFile(ctx, second.stored_path)));
        expect(await fs.readFile(dists(ctx, "Release"), "utf8")).toBe(release);
        expect(await fs.readFile(dists(ctx, "InRelease"), "utf8")).toBe(inRelease);
        expect(releaseRow(ctx.db).published_date).toBe(NOW + 1);
        expect(await reconcileDebian(ctx)).toEqual([]);
    }));

    test("A missing canonical name is re-linked; a copy with the same content is left alone", withCtx(async ctx => {
        await stageDeb(ctx, TRIXIE);
        await publishDebian(ctx);
        const row = indexRow(ctx.db, "packages");
        const canonical = dists(ctx, "main/binary-amd64/Packages.gz");
        const sources = dists(ctx, "main/source/Sources.gz");
        await fs.unlink(canonical);
        const copy = await fs.readFile(sources);
        await fs.unlink(sources);
        await fs.writeFile(sources, copy);
        const sourcesInode = await inode(sources);

        expect(await reconcileDebian(ctx)).toEqual(["debian/trixie"]);

        expect(await inode(canonical)).toBe(await inode(repoFile(ctx, row.stored_path)));
        expect(await inode(sources)).toBe(sourcesInode);
        expect(await reconcileDebian(ctx)).toEqual([]);
    }));

    test("A missing Release is written with a new date and signed", withCtx(async ctx => {
        await stageDeb(ctx, TRIXIE);
        await publishDebian(ctx);
        await fs.unlink(dists(ctx, "Release"));
        ctx.clock.now = NOW + 50;

        expect(await reconcileDebian(ctx)).toEqual(["debian/trixie"]);

        expect(await expectSignedDeb(ctx)).toContain("\nDate: Tue, 14 Nov 2023 22:14:10 UTC\n");
        expect(releaseRow(ctx.db).published_date).toBe(NOW + 50);
        expect(await reconcileDebian(ctx)).toEqual([]);
    }));

    test("A Release of the previous generation is rewritten", withCtx(async ctx => {
        await stageDeb(ctx, TRIXIE);
        await publishDebian(ctx);
        const first = await fs.readFile(dists(ctx, "Release"), "utf8");
        await stageDeb(ctx, ARM64);
        await publishDebian(ctx);
        await fs.writeFile(dists(ctx, "Release"), first);

        expect(await reconcileDebian(ctx)).toEqual(["debian/trixie"]);

        const text = await expectSignedDeb(ctx);
        expect(text).toContain("Architectures: amd64 arm64");
        expect(text).toContain("\nDate: Tue, 14 Nov 2023 22:13:22 UTC\n");
        expect(releaseRow(ctx.db).published_date).toBe(NOW + 2);
    }));

    test("A stale Release is rewritten and the orphan canonical name of a dropped cell removed", withCtx(async ctx => {
        await stageDeb(ctx, TRIXIE);
        await publishDebian(ctx);
        const release = await fs.readFile(dists(ctx, "Release"), "utf8");
        // As after a crash between a cell's drop and the orphan sweep: Release still lists it and its canonical name is there
        const orphan = dists(ctx, "main/binary-arm64/Packages.gz");
        await fs.mkdir(osPath.dirname(orphan));
        await fs.copyFile(dists(ctx, "main/binary-amd64/Packages.gz"), orphan);
        await fs.writeFile(dists(ctx, "Release"), release.replace("Architectures: amd64", "Architectures: amd64 arm64"));

        expect(await reconcileDebian(ctx)).toEqual(["debian/trixie"]);

        const text = await expectSignedDeb(ctx);
        expect(text).toContain("\nArchitectures: amd64\n");
        expect(text).toContain("\nDate: Tue, 14 Nov 2023 22:13:21 UTC\n");
        expect(await exists(orphan)).toBe(false);
        expect(await exists(dists(ctx, "main/binary-amd64/Packages.gz"))).toBe(true);
    }));

    test("A missing Release.gpg is signed again without a new date", withCtx(async ctx => {
        await stageDeb(ctx, TRIXIE);
        await publishDebian(ctx);
        const release = await fs.readFile(dists(ctx, "Release"), "utf8");
        await fs.unlink(dists(ctx, "Release.gpg"));
        ctx.clock.now = NOW + 50;

        expect(await reconcileDebian(ctx)).toEqual(["debian/trixie"]);

        expect(await expectSignedDeb(ctx)).toBe(release);
        expect(releaseRow(ctx.db).published_date).toBe(NOW);
        expect(await reconcileDebian(ctx)).toEqual([]);
    }));

    test("Signatures of another key are replaced", withCtx(async ctx => {
        await stageDeb(ctx, TRIXIE);
        await publishDebian(ctx);
        const release = await fs.readFile(dists(ctx, "Release"), "utf8");
        await fs.writeFile(dists(ctx, "InRelease"), await clearsign(release, otherKey));
        await fs.writeFile(dists(ctx, "Release.gpg"), await detachedSignature(release, otherKey));

        expect(await reconcileDebian(ctx)).toEqual(["debian/trixie"]);

        expect(await expectSignedDeb(ctx)).toBe(release);
        expect(await reconcileDebian(ctx)).toEqual([]);
    }));

    test("An InRelease carrying an older Release text is replaced", withCtx(async ctx => {
        await stageDeb(ctx, TRIXIE);
        await publishDebian(ctx);
        const first = await fs.readFile(dists(ctx, "InRelease"), "utf8");
        await stageDeb(ctx, ARM64);
        await publishDebian(ctx);
        await fs.writeFile(dists(ctx, "InRelease"), first);

        expect(await reconcileDebian(ctx)).toEqual(["debian/trixie"]);

        await expectSignedDeb(ctx);
        expect(await reconcileDebian(ctx)).toEqual([]);
    }));

    test("Without a key, leftover signatures are removed", withCtx(async ctx => {
        await stageDeb(ctx, TRIXIE);
        ctx.signingKey = key;
        await publishDebian(ctx);
        ctx.signingKey = undefined;
        const release = await fs.readFile(dists(ctx, "Release"), "utf8");

        expect(await reconcileDebian(ctx)).toEqual(["debian/trixie"]);

        expect(await exists(dists(ctx, "InRelease"))).toBe(false);
        expect(await exists(dists(ctx, "Release.gpg"))).toBe(false);
        expect(await fs.readFile(dists(ctx, "Release"), "utf8")).toBe(release);
        expect(await reconcileDebian(ctx)).toEqual([]);
    }, { signed: false }));

    test("A changed DEB_ORIGIN republishes Release", withCtx(ctx => withEnv(async () => {
        await stageDeb(ctx, TRIXIE);
        await publishDebian(ctx);
        expect(await reconcileDebian(ctx)).toEqual([]);
        process.env.DEB_ORIGIN = "New Origin";

        expect(await reconcileDebian(ctx)).toEqual(["debian/trixie"]);

        expect(await expectSignedDeb(ctx)).toContain("Origin: New Origin\n");
        expect(releaseRow(ctx.db)).toEqual({ published_date: NOW + 1, origin: "New Origin", description: null });
        expect(await reconcileDebian(ctx)).toEqual([]);
        expect(await publishDebian(ctx)).toEqual([]);
    })()));

    test("A release without published indexes is skipped", withCtx(async ctx => {
        await stageDeb(ctx, TRIXIE);

        expect(await reconcileDebian(ctx)).toEqual([]);

        expect(await exists(dists(ctx, "Release"))).toBe(false);
    }));

    test("Repaired names are taken back from superseded_files", withCtx(async ctx => {
        await stageDeb(ctx, TRIXIE);
        await publishDebian(ctx);
        const base = "deb/debian/dists/trixie";
        supersede(ctx.db, `${ base }/main/binary-amd64/Packages.gz`, `${ base }/Release`, `${ base }/InRelease`, `${ base }/Release.gpg`);
        await fs.unlink(dists(ctx, "main/binary-amd64/Packages.gz"));
        await fs.unlink(dists(ctx, "Release.gpg"));
        const release = await fs.readFile(dists(ctx, "Release"), "utf8");

        expect(await reconcileDebian(ctx)).toEqual(["debian/trixie"]);

        expect(await fs.readFile(dists(ctx, "Release"), "utf8")).toBe(release);
        expect(superseded(ctx.db)).toEqual([]);
    }));
});

describe("Tests for reconcileRpm", () => {
    test("A consistent release is left byte for byte as it is", withCtx(async ctx => {
        await stageRpm(ctx, ALL_RPMS);
        await publishRpm(ctx);
        const before = await snapshot("repo");
        ctx.clock.now = NOW + 50;

        expect(await reconcileRpm(ctx)).toEqual([]);

        expect(await snapshot("repo")).toEqual(before);
    }));

    test("A missing repomd.xml is written with a new revision and signed", withCtx(async ctx => {
        await stageRpm(ctx, ALL_RPMS);
        await publishRpm(ctx);
        await fs.unlink(repodata(ctx, "repomd.xml"));
        ctx.clock.now = NOW + 50;

        expect(await reconcileRpm(ctx)).toEqual(["fedora/42"]);

        expect(await expectSignedRpm(ctx)).toContain(`<revision>${ NOW + 50 }</revision>`);
        expect(await reconcileRpm(ctx)).toEqual([]);
    }));

    test("A repomd.xml of the previous generation is rewritten", withCtx(async ctx => {
        await stageRpm(ctx, ALL_RPMS.slice(0, 2));
        await publishRpm(ctx);
        const first = await fs.readFile(repodata(ctx, "repomd.xml"), "utf8");
        await stageRpm(ctx, ALL_RPMS.slice(2));
        await publishRpm(ctx);
        await fs.writeFile(repodata(ctx, "repomd.xml"), first);

        expect(await reconcileRpm(ctx)).toEqual(["fedora/42"]);

        expect(await expectSignedRpm(ctx)).toContain(`<revision>${ NOW + 2 }</revision>`);
    }));

    test("A missing repomd.xml.asc is signed again without a new revision", withCtx(async ctx => {
        await stageRpm(ctx, ALL_RPMS);
        await publishRpm(ctx);
        const text = await fs.readFile(repodata(ctx, "repomd.xml"), "utf8");
        await fs.unlink(repodata(ctx, "repomd.xml.asc"));
        ctx.clock.now = NOW + 50;

        expect(await reconcileRpm(ctx)).toEqual(["fedora/42"]);

        expect(await expectSignedRpm(ctx)).toBe(text);
        expect(await reconcileRpm(ctx)).toEqual([]);
    }));

    test("A signature of another key is replaced", withCtx(async ctx => {
        await stageRpm(ctx, ALL_RPMS);
        await publishRpm(ctx);
        const text = await fs.readFile(repodata(ctx, "repomd.xml"), "utf8");
        await fs.writeFile(repodata(ctx, "repomd.xml.asc"), await detachedSignature(text, otherKey));

        expect(await reconcileRpm(ctx)).toEqual(["fedora/42"]);

        expect(await expectSignedRpm(ctx)).toBe(text);
    }));

    test("Without a key, a leftover signature is removed", withCtx(async ctx => {
        await stageRpm(ctx, ALL_RPMS);
        ctx.signingKey = key;
        await publishRpm(ctx);
        ctx.signingKey = undefined;

        expect(await reconcileRpm(ctx)).toEqual(["fedora/42"]);

        expect(await exists(repodata(ctx, "repomd.xml.asc"))).toBe(false);
        expect(await reconcileRpm(ctx)).toEqual([]);
    }, { signed: false }));

    test("Repaired names are taken back from superseded_files", withCtx(async ctx => {
        await stageRpm(ctx, ALL_RPMS);
        await publishRpm(ctx);
        supersede(ctx.db, "rpm/fedora/42/repodata/repomd.xml", "rpm/fedora/42/repodata/repomd.xml.asc");
        await fs.unlink(repodata(ctx, "repomd.xml.asc"));

        expect(await reconcileRpm(ctx)).toEqual(["fedora/42"]);

        expect(superseded(ctx.db)).toEqual([]);
    }));
});

describe("Tests for reconcile", () => {
    test("A consistent repository is left as it is and nothing is logged", withCtx(async ctx => {
        await publishAll(ctx);
        const before = await snapshot("repo");
        const stateBefore = await snapshot("state/shadow");
        const infoSpy = jest.spyOn(logger, "info").mockReturnValue(logger);
        const warnSpy = jest.spyOn(logger, "warn").mockReturnValue(logger);
        try {
            ctx.clock.now = NOW + 50;

            expect(await reconcile(ctx)).toEqual(NOTHING);

            expect(infoSpy).not.toHaveBeenCalled();
            expect(warnSpy).not.toHaveBeenCalled();
        } finally {
            infoSpy.mockRestore();
            warnSpy.mockRestore();
        }
        expect(await snapshot("repo")).toEqual(before);
        expect(await snapshot("state/shadow")).toEqual(stateBefore);
        expect(superseded(ctx.db)).toEqual([]);
        expect(dirtyCount(ctx.db)).toBe(0);
    }));

    test("An index whose stored file is missing is rebuilt in full and its release republished", withCtx(async ctx => {
        await publishAll(ctx);
        const packages = indexRow(ctx.db, "packages");
        const primary = indexRow(ctx.db, "primary", "", "fedora", "42");
        await fs.unlink(repoFile(ctx, packages.stored_path));
        await fs.unlink(repoFile(ctx, primary.stored_path));
        const canonical = dists(ctx, "main/binary-amd64/Packages.gz");
        expect(await exists(canonical)).toBe(true);

        const result = await reconcile(ctx);

        expect(result).toEqual({
            ...NOTHING, rebuilt: ["deb/debian/trixie packages main amd64", "rpm/fedora/42 primary"], published: ["deb/debian/trixie", "rpm/fedora/42"],
        });
        expect(indexRow(ctx.db, "packages")).toMatchObject({ generation: 2, stored_path: packages.stored_path, sha256: packages.sha256 });
        expect(indexRow(ctx.db, "primary", "", "fedora", "42")).toMatchObject({ generation: 2, stored_path: primary.stored_path });
        expect(await exists(repoFile(ctx, packages.stored_path))).toBe(true);
        expect(await exists(repoFile(ctx, primary.stored_path))).toBe(true);
        expect(await inode(canonical)).toBe(await inode(repoFile(ctx, packages.stored_path)));
        expect(dirtyCount(ctx.db)).toBe(0);
        expect(await expectSignedDeb(ctx)).toContain("\nDate: Tue, 14 Nov 2023 22:13:21 UTC\n");
        expect(await expectSignedRpm(ctx)).toContain(`<revision>${ NOW + 1 }</revision>`);
        expect(await reconcile(ctx)).toEqual(NOTHING);
    }));

    test("A publish restarts the grace of the removed files: until then the indexes listed them", withCtx(async ctx => {
        await publishAll(ctx);
        // A crash between the removal's commit and its publish
        new DebCatalog(ctx.db).remove({ distro: "debian", release: "trixie", source: "srm-hello" }, NOW, false);
        const removed = (ctx.db.prepare("SELECT path FROM pool_files WHERE removed_at IS NOT NULL ORDER BY path").all() as { path: string }[]).map(r => r.path);
        expect(removed).toHaveLength(7);
        const kept = Array(3).fill(null);
        ctx.clock.now = NOW + 50;

        const result = await reconcile(ctx);

        expect(result).toEqual({ ...NOTHING, published: ["deb/debian/trixie"], restamped: removed, restampedIndexes: superseded(ctx.db).map(s => s.path) });
        expect(removedAt(ctx.db)).toEqual([...Array(7).fill(NOW + 50), ...kept]);

        ctx.clock.now = NOW + 100;
        expect(await reconcile(ctx)).toEqual(NOTHING);
        expect(removedAt(ctx.db)).toEqual([...Array(7).fill(NOW + 50), ...kept]);
    }));

    test("A repaired Release restarts the grace as well: the crash came between the commit and the Release", withCtx(async ctx => {
        await publishAll(ctx);
        const first = await fs.readFile(dists(ctx, "Release"), "utf8");
        new DebCatalog(ctx.db).remove({ distro: "debian", release: "trixie", source: "srm-hello" }, NOW, false);
        await publishDebian(ctx);
        await fs.writeFile(dists(ctx, "Release"), first);
        const listed = superseded(ctx.db);
        expect(listed).not.toEqual([]);
        ctx.clock.now = NOW + 50;

        expect((await reconcile(ctx)).repaired).toEqual(["deb/debian/trixie"]);

        expect(removedAt(ctx.db).slice(0, 7)).toEqual(Array(7).fill(NOW + 50));
        expect(superseded(ctx.db)).toEqual(listed.map(s => ({ ...s, superseded_at: NOW + 50 })));
    }));

    test("repairPublished restarts the grace only when the publishers or the repair wrote anything", withCtx(async ctx => {
        await publishAll(ctx);
        new DebCatalog(ctx.db).remove({ distro: "debian", release: "trixie", source: "srm-hello" }, NOW, false);
        await publishDebian(ctx);
        const listed = superseded(ctx.db);
        expect(listed).not.toEqual([]);
        ctx.clock.now = NOW + 50;

        await repairPublished(ctx, false);

        expect(removedAt(ctx.db).slice(0, 7)).toEqual(Array(7).fill(NOW));
        expect(superseded(ctx.db)).toEqual(listed);

        await repairPublished(ctx, true);

        expect(removedAt(ctx.db).slice(0, 7)).toEqual(Array(7).fill(NOW + 50));
        expect(superseded(ctx.db)).toEqual(listed.map(s => ({ ...s, superseded_at: NOW + 50 })));

        ctx.clock.now = NOW + 100;
        await fs.unlink(repodata(ctx, "repomd.xml"));

        await repairPublished(ctx, false);

        expect(removedAt(ctx.db).slice(0, 7)).toEqual(Array(7).fill(NOW + 100));
        expect(superseded(ctx.db)).toEqual(listed.map(s => ({ ...s, superseded_at: NOW + 100 })));
    }));

    test("Index files nothing accounts for are superseded now; listed and temp ones are not touched", withCtx(async ctx => {
        await publishAll(ctx);
        const packages = indexRow(ctx.db, "packages");
        new DebCatalog(ctx.db).remove({ distro: "debian", release: "trixie", source: "srm-hello" }, NOW, false);
        await publishDebian(ctx);
        const listed = superseded(ctx.db);
        expect(listed.map(s => s.path)).toContain(packages.stored_path);
        const strays = [
            "deb/debian/dists/trixie/main/binary-amd64/by-hash/SHA256/0000000000000000000000000000000000000000000000000000000000000000",
            "deb/debian/dists/trixie/main/by-hash/MD5Sum/00000000000000000000000000000000",
            "rpm/fedora/42/repodata/0000000000000000000000000000000000000000000000000000000000000000-primary.xml.zst",
        ];
        const kept = ["deb/debian/dists/trixie/main/binary-amd64/by-hash/SHA256/x.tmp-1", "deb/debian/dists/trixie/main/binary-amd64/Packages.bz2", "rpm/fedora/42/other.txt"];
        for (const rel of [...strays, ...kept]) {
            await writeFile(repoFile(ctx, rel), rel);
        }
        ctx.clock.now = NOW + 50;

        const result = await reconcile(ctx);

        expect(result).toEqual({ ...NOTHING, superseded: strays });
        expect(superseded(ctx.db)).toEqual([...listed, ...strays.map(path => ({ path, superseded_at: NOW + 50 }))].sort((a, b) => a.path < b.path ? -1 : 1));
        for (const rel of [...strays, ...kept, "rpm/fedora/42/repodata/repomd.xml", "rpm/fedora/42/repodata/repomd.xml.asc"]) {
            expect(await exists(repoFile(ctx, rel))).toBe(true);
        }
        expect(await reconcile(ctx)).toEqual(NOTHING);
    }));

    test("Shadows of unknown generations are removed", withCtx(async ctx => {
        await publishAll(ctx);
        const current = await shadows();
        const packages = indexRow(ctx.db, "packages");
        await writeFile(osPath.join("state", "shadow", `${ packages.id }-0`), "old");
        await writeFile(osPath.join("state", "shadow", "999-1"), "gone");

        const result = await reconcile(ctx);

        expect(result).toEqual({ ...NOTHING, shadows: [`${ packages.id }-0`, "999-1"] });
        expect(await shadows()).toEqual(current);
    }));

    test("Staged digests of vanished files are dropped", withCtx(async ctx => {
        const staging = "deb/debian/trixie/main/a_1.0-1_amd64.deb";
        const processing = "rpm/fedora/42/b-1.0-1.fc42.x86_64.rpm";
        const gone = "deb/debian/trixie/main/c_1.0-1_amd64.changes";
        await writeFile(osJoin(ctx.paths.incomingDir, "staging", staging), "a");
        await writeFile(osJoin(ctx.paths.incomingDir, "process", processing), "b");
        for (const rel of [staging, processing, gone]) {
            insertStaged(ctx.db, rel);
        }

        const result = await reconcile(ctx);

        expect(result).toEqual({ ...NOTHING, staged: [gone] });
        expect(stagedRows(ctx.db)).toEqual([staging, processing].sort());
    }));

    test("Temp files past the grace are deleted below the repository and the state tmp dir is emptied", withCtx(async ctx => {
        await publishAll(ctx);
        const stale = [repoFile(ctx, "deb/debian/dists/trixie/Release.tmp-123"), repoFile(ctx, "rpm/fedora/42/repodata/repomd.xml.tmp-7")];
        const stateTmp = [osPath.join("state", "tmp", "3.gz"), osPath.join("state", "tmp", "4.zst")];
        const fresh = [repoFile(ctx, "deb/debian/dists/trixie/InRelease.tmp-123")];
        // Not what tempName produces: .tmp- inside a name, a name without digits, a tmp- prefix
        const other = [
            repoFile(ctx, "deb/debian/dists/trixie/foo.tmp-1.gz"), repoFile(ctx, "deb/debian/dists/trixie/Release.tmp-"),
            repoFile(ctx, "deb/debian/dists/trixie/main/tmp-notes"),
        ];
        for (const file of [...stale, ...other, stateTmp[0]]) {
            await writeFile(file, "old", STALE);
        }
        for (const file of [...fresh, stateTmp[1]]) {
            await writeFile(file, "new", NOW - GC_GRACE_SECONDS + 1);
        }

        const result = await reconcile(ctx);

        expect(result).toEqual({ ...NOTHING, temp: [...stale, ...stateTmp].sort() });
        for (const file of [...stale, ...stateTmp]) {
            expect(await exists(file)).toBe(false);
        }
        for (const file of [...fresh, ...other]) {
            expect(await exists(file)).toBe(true);
        }
        expect(await fs.readdir(osPath.join("state", "tmp"))).toEqual([]);
    }));

    test("The walk stays out of the pools, so their stale temp files stay too", withCtx(async ctx => {
        await publishAll(ctx);
        const pools = [repoFile(ctx, "deb/debian/pool"), repoFile(ctx, "rpm/fedora/42/Packages")];
        const temps = [
            repoFile(ctx, "deb/debian/pool/main/s/srm-hello/srm-hello_1.0-1_amd64.deb.tmp-5"),
            repoFile(ctx, "rpm/fedora/42/Packages/s/srm-hello/srm-hello-1.0-1.fc42.x86_64.rpm.tmp-5"),
        ];
        for (const file of temps) {
            await writeFile(file, "old", STALE);
        }

        const readdir = jest.spyOn(fs, "readdir");
        let read: string[];
        let result: ReconcileResult;
        try {
            result = await reconcile(ctx);
            read = readdir.mock.calls.map(([dir]) => String(dir));
        } finally {
            readdir.mockRestore();
        }

        expect(result).toEqual(NOTHING);
        expect(read).toContain(repoFile(ctx, "deb/debian"));
        expect(read).toContain(repoFile(ctx, "rpm/fedora/42"));
        expect(read.filter(dir => pools.some(pool => dir.startsWith(pool)))).toEqual([]);
        for (const file of temps) {
            expect(await exists(file)).toBe(true);
        }
    }));

    test("Without a key configured, leftover signatures are removed", withCtx(async ctx => {
        await publishAll(ctx);
        ctx.signingKey = undefined;

        const result = await reconcile(ctx);

        expect(result).toEqual({ ...NOTHING, repaired: ["deb/debian/trixie", "rpm/fedora/42"] });
        for (const file of [dists(ctx, "InRelease"), dists(ctx, "Release.gpg"), repodata(ctx, "repomd.xml.asc")]) {
            expect(await exists(file)).toBe(false);
        }
        expect(await reconcile(ctx)).toEqual(NOTHING);
    }));

    test("Two indexes sharing one missing stored file are both rebuilt", withCtx(async ctx => {
        await stageDeb(ctx, TRIXIE);
        await stageDeb(ctx, ARM64);
        await publishDebian(ctx);
        const amd64 = indexRow(ctx.db, "contents");
        const arm64 = indexRow(ctx.db, "contents", "arm64");
        expect(arm64.stored_path).toBe(amd64.stored_path);
        await fs.unlink(repoFile(ctx, amd64.stored_path));

        const result = await reconcile(ctx);

        expect(result).toEqual({
            ...NOTHING, rebuilt: ["deb/debian/trixie contents main amd64", "deb/debian/trixie contents main arm64"], published: ["deb/debian/trixie"],
        });
        for (const row of [indexRow(ctx.db, "contents"), indexRow(ctx.db, "contents", "arm64")]) {
            expect(row).toMatchObject({ generation: 2, stored_path: amd64.stored_path, sha256: amd64.sha256 });
        }
        for (const name of ["main/Contents-amd64.gz", "main/Contents-arm64.gz"]) {
            expect(await inode(dists(ctx, name))).toBe(await inode(repoFile(ctx, amd64.stored_path)));
        }
        expect(superseded(ctx.db)).toEqual([]);
        expect(await reconcile(ctx)).toEqual(NOTHING);
    }));

    test("RPM pool files whose size differs from their row are reported, not changed", withCtx(async ctx => {
        await publishAll(ctx);
        const truncated = "rpm/fedora/42/Packages/s/srm-hello/srm-hello-1.0-1.fc42.x86_64.rpm";
        const missing = "rpm/fedora/42/Packages/s/srm-hello/srm-hello-doc-1.0-1.fc42.noarch.rpm";
        const deb = "deb/debian/pool/main/s/srm-hello/srm-hello_1.0-1_amd64.deb";
        await fs.truncate(repoFile(ctx, truncated), 10);
        await fs.unlink(repoFile(ctx, missing));
        await fs.truncate(repoFile(ctx, deb), 10);
        const warnSpy = jest.spyOn(logger, "warn").mockReturnValue(logger);
        try {
            const result = await reconcile(ctx);

            expect(result).toEqual({ ...NOTHING, mismatched: [truncated, missing].sort() });
            expect(warnSpy.mock.calls.map(([message]) => message)).toEqual([expect.stringContaining(truncated), expect.stringContaining(missing)]);
        } finally {
            warnSpy.mockRestore();
        }
        expect((await fs.stat(repoFile(ctx, truncated))).size).toBe(10);
        expect(await exists(repoFile(ctx, missing))).toBe(false);
    }));
});
