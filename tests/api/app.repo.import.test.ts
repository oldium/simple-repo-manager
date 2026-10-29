import request from "supertest";
import type { Application } from "express";
import _ from "lodash";
import crypto from "node:crypto";
import osPath from "path";
import dedent from "dedent";
import createTestApp from "../testapp.ts";
import { uploadFileByPut, withLocalTmpDir } from "../utils.ts";
import { fixtureNames, uploadFixtureFile, uploadFixtureTree } from "../fixture-upload.ts";
import { listFiles } from "../../server/backend/publish-fs.ts";
import type { ImportFile, ImportResult } from "../../server/lib/repo-service.ts";

const TRIXIE = "deb/debian/trixie/main";
const BOOKWORM = "deb/debian/bookworm/main";
const NOBLE = "deb/ubuntu/noble/universe";
const FEDORA = "rpm/fedora/42";
const SKIPPED = "no .changes file references it";

async function mcpImport(app: Application): Promise<ImportResult> {
    const res = await request(app)
        .post("/api/v1/mcp")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "import_repository", arguments: {} } });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeFalsy();
    return res.body.result.structuredContent;
}

function imported(dir: string, names: string[], status: ImportFile["status"], reason?: unknown) {
    return names.map(filename => ({ filename, path: `${ dir }/${ filename }`, status, reason }));
}

/** The correlation id differs per request */
function failedReason(cause: string) {
    return expect.stringMatching(new RegExp(`^import failed, correlation id=[0-9a-f]+: ${ _.escapeRegExp(cause) }$`));
}

function byPath<T extends { path: string }>(files: T[]): T[] {
    return _.sortBy(files, "path");
}

async function processed(...dir: string[]): Promise<string[]> {
    return (await listFiles(osPath.join("incoming", "process", ...dir))).sort();
}

describe("Import through MCP reports every staged file", () => {
    test("Reports ok, skipped and failed files of one import together", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const trixie = await fixtureNames(`packages/${ TRIXIE }`);
        const arm64Deb = "srm-hello_1.0-1_arm64.deb";
        const bookworm = (await fixtureNames(`packages/${ BOOKWORM }`)).filter(name => !name.endsWith(".changes"));
        const ddeb = "srm-zst-dbgsym_3.0-1_amd64.ddeb";
        const noble = (await fixtureNames(`packages/${ NOBLE }`)).filter(name => name !== ddeb);
        await uploadFixtureTree(app, `packages/${ TRIXIE }`);
        await uploadFixtureFile(app, `packages-arm64/${ TRIXIE }/${ arm64Deb }`);
        for (const name of bookworm) {
            await uploadFixtureFile(app, `packages/${ BOOKWORM }/${ name }`);
        }
        for (const name of noble) {
            await uploadFixtureFile(app, `packages/${ NOBLE }/${ name }`);
        }

        const result = await mcpImport(app);

        expect(result.ok).toBe(false);
        expect(byPath(result.files)).toEqual(byPath([
            ...imported(TRIXIE, trixie, "ok"),
            ...imported(TRIXIE, [arm64Deb], "skipped", SKIPPED),
            ...imported(BOOKWORM, bookworm, "skipped", SKIPPED),
            ...imported(NOBLE, noble, "failed", failedReason(`${ ddeb } is neither uploaded nor in the pool`)),
        ]));
        expect(await processed()).toEqual([
            ...bookworm.map(name => `deb/debian/bookworm/main/${ name }`),
            `deb/debian/trixie/main/${ arm64Deb }`,
            ...noble.map(name => `deb/ubuntu/noble/universe/${ name }`),
        ]);
    }));

    test("RPM files import with status ok", withLocalTmpDir(async () => {
        const app = await createTestApp();
        await uploadFixtureTree(app, `packages/${ FEDORA }`);

        expect(await mcpImport(app)).toEqual({ ok: true, files: imported(FEDORA, await fixtureNames(`packages/${ FEDORA }`), "ok") });
        expect(await processed()).toEqual([]);
    }));

    test("An unreadable rpm fails and stays staged while the others import", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const broken = "srm-broken-1.0-1.fc42.x86_64.rpm";
        await uploadFixtureTree(app, `packages/${ FEDORA }`);
        const upload = await uploadFileByPut(app, `/api/v1/upload/${ FEDORA }/${ broken }`, Buffer.from("not an rpm package\n".repeat(10)));
        expect(upload.status).toBe(201);

        const result = await mcpImport(app);

        expect(result.ok).toBe(false);
        expect(byPath(result.files)).toEqual(byPath([
            ...imported(FEDORA, [broken], "failed", failedReason(`${ broken } is not an rpm package`)),
            ...imported(FEDORA, await fixtureNames(`packages/${ FEDORA }`), "ok"),
        ]));
        expect(await processed()).toEqual([`${ FEDORA }/${ broken }`]);
    }));

    test("A corrupt .deb fails with a reason naming the file, not its server path", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const deb = "srm-hello_1.0-1_amd64.deb";
        const changes = "srm-hello_1.0-1_amd64.changes";
        const content = Buffer.from("not a debian package\n".repeat(10));
        const digest = (algorithm: string): string => crypto.createHash(algorithm).update(content).digest("hex");
        // Matching checksums let the import get as far as reading the package
        const changesText = dedent`
            Source: srm-hello
            Version: 1.0-1
            Distribution: trixie
            Architecture: amd64
            Checksums-Sha256:
             ${ digest("sha256") } ${ content.length } ${ deb }
            Files:
             ${ digest("md5") } ${ content.length } utils optional ${ deb }\n
        `;
        expect((await uploadFileByPut(app, `/api/v1/upload/${ TRIXIE }/${ deb }`, content)).status).toBe(201);
        expect((await uploadFileByPut(app, `/api/v1/upload/${ TRIXIE }/${ changes }`, Buffer.from(changesText))).status).toBe(201);

        const result = await mcpImport(app);

        expect(result.ok).toBe(false);
        expect(byPath(result.files)).toEqual(byPath(imported(TRIXIE, [changes, deb], "failed", failedReason(`${ deb } is not an ar archive`))));
    }));
});

describe("Import through REST", () => {
    test("POST /repo/import answers 200 and moves every release to the pool", withLocalTmpDir(async () => {
        const app = await createTestApp();
        await uploadFixtureTree(app, "packages");

        const res = await request(app).post("/api/v1/repo/import");

        expect(res.status).toBe(200);
        expect(res.body.message).toBe("Repository import finished successfully");
        expect(await listFiles(osPath.join("incoming", "staging"))).toEqual([]);
        expect(await processed()).toEqual([]);
        const pooled = async (dir: string): Promise<string[]> => (await listFiles(osPath.join("repo", ...dir.split("/")))).sort();
        expect(await pooled("deb/debian/pool")).toEqual([
            ...(await fixtureNames(`packages/${ BOOKWORM }`)).map(name => `main/s/srm-gz/${ name }`),
            ...(await fixtureNames(`packages/${ TRIXIE }`)).map(name => `main/s/srm-hello/${ name }`),
        ]);
        expect(await pooled("deb/ubuntu/pool")).toEqual((await fixtureNames(`packages/${ NOBLE }`)).map(name => `universe/s/srm-zst/${ name }`));
        expect(await pooled(`${ FEDORA }/Packages`)).toEqual((await fixtureNames(`packages/${ FEDORA }`)).map(name => `s/srm-hello/${ name }`));
        for (const [distro, release, component] of [["debian", "bookworm", "main"], ["debian", "trixie", "main"], ["ubuntu", "noble", "universe"]]) {
            const published = await request(app).get(`/deb/${ distro }/dists/${ release }/Release`);
            expect(published.status).toBe(200);
            expect(published.text).toMatch(new RegExp(`^Suite: ${ release }$`, "m"));
            expect(published.text).toMatch(new RegExp(`^Codename: ${ release }$`, "m"));
            expect(published.text).toMatch(new RegExp(`^Components: ${ component }$`, "m"));
        }
        expect((await request(app).get(`/${ FEDORA }/repodata/repomd.xml`)).status).toBe(200);
    }));

    test("POST /repo/import answers 500 when a file fails and leaves the files in incoming/process", withLocalTmpDir(async () => {
        const app = await createTestApp();
        // The .changes names trixie in its Distribution field
        const trixie = await fixtureNames(`packages/${ TRIXIE }`);
        for (const name of trixie) {
            await uploadFixtureFile(app, `packages/${ TRIXIE }/${ name }`, BOOKWORM);
        }

        const res = await request(app).post("/api/v1/repo/import");

        expect(res.status).toBe(500);
        expect(res.body.message).toBe("Repository import failed. See server logs for details");
        expect(await listFiles(osPath.join("incoming", "staging"))).toEqual([]);
        expect(await processed()).toEqual(trixie.map(name => `${ BOOKWORM }/${ name }`));
    }));

    test("POST /repo/import with nothing staged answers 200 and keeps the published release", withLocalTmpDir(async () => {
        const app = await createTestApp();
        await uploadFixtureTree(app, `packages/${ TRIXIE }`);
        expect((await request(app).post("/api/v1/repo/import")).status).toBe(200);

        expect((await request(app).post("/api/v1/repo/import")).status).toBe(200);
        expect((await request(app).get("/deb/debian/dists/trixie/Release")).status).toBe(200);
    }));

    test("Absolute data directories work", withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: { incomingDir: osPath.resolve("incoming"), repoStateDir: osPath.resolve("repo-state"), repoDir: osPath.resolve("repo") },
        });
        await uploadFixtureTree(app, `packages/${ TRIXIE }`);

        expect((await request(app).post("/api/v1/repo/import")).status).toBe(200);
        expect(await listFiles(osPath.resolve("repo", "deb", "debian", "pool", "main", "s", "srm-hello")))
            .toEqual(await fixtureNames(`packages/${ TRIXIE }`));
        expect(await processed()).toEqual([]);
    }));
});

describe("Import into a published release", () => {
    test("A binary-only arm64 bundle uploaded after amd64 joins the release", withLocalTmpDir(async () => {
        const app = await createTestApp();
        await uploadFixtureTree(app, `packages/${ TRIXIE }`);
        expect((await mcpImport(app)).ok).toBe(true);
        await uploadFixtureTree(app, `packages-arm64/${ TRIXIE }`);

        expect(await mcpImport(app)).toEqual({ ok: true, files: imported(TRIXIE, await fixtureNames(`packages-arm64/${ TRIXIE }`), "ok") });
        expect((await request(app).get("/deb/debian/dists/trixie/Release")).text).toMatch(/^Architectures: amd64 arm64$/m);
    }));

    test("Re-uploading an imported bundle imports it again", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const trixie = await fixtureNames(`packages/${ TRIXIE }`);
        await uploadFixtureTree(app, `packages/${ TRIXIE }`);
        expect((await mcpImport(app)).ok).toBe(true);
        await uploadFixtureTree(app, `packages/${ TRIXIE }`);

        expect(await mcpImport(app)).toEqual({ ok: true, files: imported(TRIXIE, trixie, "ok") });
        expect(await processed()).toEqual([]);
        expect((await request(app).get("/api/v1/repo/deb/debian/trixie/srm-hello")).body.files).toHaveLength(trixie.length);
    }));
});
