import request from "supertest";
import type { Application } from "express";
import _ from "lodash";
import createTestApp from "../testapp.ts";
import { servedStatuses, withLocalTmpDir } from "../utils.ts";
import { importFixtures, importedApp, uploadFixtureFile, uploadSecondVersion } from "../fixture-upload.ts";

const TRIXIE_POOL = "deb/debian/pool/main/s/srm-hello";
const ORIG = "srm-hello_1.0.orig.tar.gz";
const TRIXIE_FILES = [
    "srm-hello-doc_1.0-1_all.deb",
    "srm-hello_1.0-1.debian.tar.xz",
    "srm-hello_1.0-1.dsc",
    "srm-hello_1.0-1_amd64.buildinfo",
    "srm-hello_1.0-1_amd64.changes",
    "srm-hello_1.0-1_amd64.deb",
    "srm-hello_1.0.orig.tar.gz",
];
const ARM64_FILES = ["srm-hello_1.0-1_arm64.buildinfo", "srm-hello_1.0-1_arm64.changes", "srm-hello_1.0-1_arm64.deb"];
const BOOKWORM_POOL = "deb/debian/pool/main/s/srm-gz";
const BOOKWORM_FILES = [
    "srm-gz_0.1-1.debian.tar.gz",
    "srm-gz_0.1-1.dsc",
    "srm-gz_0.1-1_amd64.buildinfo",
    "srm-gz_0.1-1_amd64.changes",
    "srm-gz_0.1-1_amd64.deb",
    "srm-gz_0.1.orig.tar.gz",
];
const NOBLE_POOL = "deb/ubuntu/pool/universe/s/srm-zst";
const NOBLE_FILES = [
    "srm-zst-dbgsym_3.0-1_amd64.ddeb",
    "srm-zst_3.0-1.debian.tar.xz",
    "srm-zst_3.0-1.dsc",
    "srm-zst_3.0-1_amd64.buildinfo",
    "srm-zst_3.0-1_amd64.changes",
    "srm-zst_3.0-1_amd64.deb",
    "srm-zst_3.0.orig.tar.xz",
];
const RPM_POOL = "rpm/fedora/42/Packages/s/srm-hello";
const RPM_SOURCE = "srm-hello-1.0-1.fc42.src.rpm";
const RPM_BINARIES = ["srm-hello-1.0-1.fc42.x86_64.rpm", "srm-hello-doc-1.0-1.fc42.noarch.rpm"];
const RPM_FILES = [RPM_SOURCE, ...RPM_BINARIES];

function listed(poolDir: string, names: string[]) {
    return names.map(filename => ({
        filename,
        path: `${ poolDir }/${ filename }`,
        downloadUrl: expect.stringMatching(new RegExp(`^https?://[^/]+/${ _.escapeRegExp(`${ poolDir }/${ filename }`) }$`)),
    }));
}

async function expectServed(app: Application, files: { downloadUrl: string }[]): Promise<void> {
    for (const { downloadUrl } of files) {
        expect((await request(app).get(new URL(downloadUrl).pathname)).status).toBe(200);
    }
}

describe("GET deb package files", () => {
    test("200 returns every file of the version with absolute downloadUrls", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb");

        const res = await request(app).get("/api/v1/repo/deb/debian/trixie/srm-hello/1.0-1");

        expect(res.status).toBe(200);
        expect(res.body.touchedTargets).toBe(1);
        expect(res.body.files).toEqual(listed(TRIXIE_POOL, TRIXIE_FILES));
        await expectServed(app, res.body.files);
    }));

    test("200 lists ddeb files in the component's pool directory", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb");

        const res = await request(app).get("/api/v1/repo/deb/ubuntu/noble/srm-zst");

        expect(res.status).toBe(200);
        expect(res.body.files).toEqual(listed(NOBLE_POOL, NOBLE_FILES));
    }));

    test("200 lists the files of both uploads of a version once", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian/trixie");
        await importFixtures(app, "packages-arm64");

        const res = await request(app).get("/api/v1/repo/deb/debian/trixie/srm-hello");

        expect(res.status).toBe(200);
        expect(res.body.touchedTargets).toBe(1);
        expect(res.body.files).toEqual(listed(TRIXIE_POOL, [...TRIXIE_FILES, ...ARM64_FILES].sort()));
    }));

    test("200 lists the files of every version once", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian/trixie");
        const second = await uploadSecondVersion(app);
        expect((await request(app).post("/api/v1/repo/import")).status).toBe(200);

        const res = await request(app).get("/api/v1/repo/deb/debian/trixie/srm-hello");

        expect(res.status).toBe(200);
        expect(res.body.files).toEqual(listed(TRIXIE_POOL, [...TRIXIE_FILES, ...second].sort()));
        expect((await request(app).get("/api/v1/repo/deb/debian/trixie/srm-hello/1.0-2")).body.files)
            .toEqual(listed(TRIXIE_POOL, [...second, ORIG].sort()));
    }));

    test("200 matches a version with an epoch given URL-encoded", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb");

        const res = await request(app).get("/api/v1/repo/deb/ubuntu/noble/srm-zst/2%3A3.0-1");

        expect(res.status).toBe(200);
        expect(res.body.files).toEqual(listed(NOBLE_POOL, NOBLE_FILES));
    }));

    test("404 on unknown distro or release with explicit literal filter", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb");

        for (const url of ["/api/v1/repo/deb/nope/0/srm-hello", "/api/v1/repo/deb/debian/sid/srm-hello"]) {
            const res = await request(app).get(url);
            expect(res.status).toBe(404);
            expect(res.body.message).toMatch(/^No such repository /);
        }
    }));

    test("400 on invalid path segment", withLocalTmpDir(async () => {
        const app = await createTestApp();

        const res = await request(app).get("/api/v1/repo/deb/debian/bookworm/$bad$");

        expect(res.status).toBe(400);
        expect(res.body.message).toBe("Invalid characters in path segment");
    }));
});

describe("GET rpm package files", () => {
    test("200 returns files under Packages/s/srm-hello/ with absolute downloadUrls", withLocalTmpDir(async () => {
        const app = await importedApp("packages/rpm");

        const res = await request(app).get("/api/v1/repo/rpm/fedora/42/srm-hello");

        expect(res.status).toBe(200);
        expect(res.body.touchedTargets).toBe(1);
        expect(res.body.files).toEqual(listed(RPM_POOL, RPM_FILES));
        await expectServed(app, res.body.files);
        expect((await request(app).get("/api/v1/repo/rpm/fedora/42/srm-hello/1.0-1.fc42")).body.files).toEqual(listed(RPM_POOL, RPM_FILES));
    }));

    test("200 lists binaries uploaded without their .src.rpm under their source", withLocalTmpDir(async () => {
        const app = await createTestApp();
        for (const name of RPM_BINARIES) {
            await uploadFixtureFile(app, `packages/rpm/fedora/42/${ name }`);
        }
        expect((await request(app).post("/api/v1/repo/import")).status).toBe(200);

        const res = await request(app).get("/api/v1/repo/rpm/fedora/42/srm-hello/1.0-1.fc42");

        expect(res.status).toBe(200);
        expect(res.body.files).toEqual(listed(RPM_POOL, RPM_BINARIES));
    }));
});

describe("GET package files across formats", () => {
    test("200 with wildcards enumerates all matching targets", withLocalTmpDir(async () => {
        const app = await importedApp("packages");

        const all = await request(app).get("/api/v1/repo/-/-/-/srm-hello");
        expect(all.status).toBe(200);
        expect(all.body.touchedTargets).toBe(2);
        expect(all.body.files).toEqual([...listed(TRIXIE_POOL, TRIXIE_FILES), ...listed(RPM_POOL, RPM_FILES)]);

        const deb = await request(app).get("/api/v1/repo/deb/-/-/srm-hello");
        expect(deb.body.touchedTargets).toBe(1);
        expect(deb.body.files).toEqual(listed(TRIXIE_POOL, TRIXIE_FILES));

        const anyVersion = await request(app).get("/api/v1/repo/deb/debian/-/srm-gz/-");
        expect(anyVersion.body.touchedTargets).toBe(1);
        expect(anyVersion.body.files).toEqual(listed(BOOKWORM_POOL, BOOKWORM_FILES));
    }));
});

const LIMIT_MESSAGE = "limit must be an integer from 1 to 1000";
const IMMEDIATE_MESSAGE = "immediate must be true or false";

describe("GET package files by page", () => {
    test("GET with limit=1 returns nextCursor and the next page", withLocalTmpDir(async () => {
        const app = await importedApp("packages");
        const url = "/api/v1/repo/-/-/-/srm-hello";
        const all = [...listed(TRIXIE_POOL, TRIXIE_FILES), ...listed(RPM_POOL, RPM_FILES)];

        const first = await request(app).get(`${ url }?limit=1`);
        expect(first.status).toBe(200);
        expect(first.body.touchedTargets).toBe(1);
        expect(first.body.files).toEqual(all.slice(0, 1));
        expect(first.body.nextCursor).toEqual(expect.any(String));

        const second = await request(app).get(url).query({ limit: 1, cursor: first.body.nextCursor });
        expect(second.status).toBe(200);
        expect(second.body.files).toEqual(all.slice(1, 2));

        const pages = [first.body, second.body];
        while (pages.at(-1).nextCursor !== undefined && pages.length <= all.length) {
            pages.push((await request(app).get(url).query({ limit: 1, cursor: pages.at(-1).nextCursor })).body);
        }
        expect(pages.map(p => p.files.length)).toEqual(all.map(() => 1));
        expect(pages.flatMap(p => p.files)).toEqual(all);
        expect(pages.at(-1)).not.toHaveProperty("nextCursor");
    }));

    test("GET without limit answers one page without nextCursor", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian/trixie");

        const res = await request(app).get("/api/v1/repo/deb/debian/trixie/srm-hello");

        expect(res.status).toBe(200);
        expect(Object.keys(res.body)).toEqual(["message", "files", "touchedTargets"]);
    }));

    test("limit=1000 is the largest page", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian/trixie");

        const res = await request(app).get("/api/v1/repo/deb/debian/trixie/srm-hello?limit=1000");

        expect(res.status).toBe(200);
        expect(res.body.files).toEqual(listed(TRIXIE_POOL, TRIXIE_FILES));
        expect(res.body).not.toHaveProperty("nextCursor");
    }));

    test("limit=0 is 400", withLocalTmpDir(async () => {
        const app = await createTestApp();

        const res = await request(app).get("/api/v1/repo/-/-/-/srm-hello?limit=0");

        expect(res.status).toBe(400);
        expect(res.body.message).toBe(LIMIT_MESSAGE);
    }));

    test.each([
        ["limit=1001", LIMIT_MESSAGE],
        ["limit=-1", LIMIT_MESSAGE],
        ["limit=1.5", LIMIT_MESSAGE],
        ["limit=1e2", LIMIT_MESSAGE],
        ["limit=0x10", LIMIT_MESSAGE],
        ["limit=%205", LIMIT_MESSAGE],
        ["limit=", LIMIT_MESSAGE],
        ["limit", LIMIT_MESSAGE],
        ["limit=1&limit=1", "limit must be given once"],
        ["cursor=a&cursor=b", "cursor must be given once"],
    ])("%s is 400", (query, message) => withLocalTmpDir(async () => {
        const app = await createTestApp();

        const res = await request(app).get(`/api/v1/repo/-/-/-/srm-hello?${ query }`);

        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
    })());

    test("An invalid cursor is 400", withLocalTmpDir(async () => {
        const app = await createTestApp();

        const res = await request(app).get("/api/v1/repo/-/-/-/srm-hello?cursor=bogus");

        expect(res.status).toBe(400);
        expect(res.body.message).toBe("Invalid cursor");
    }));
});

describe("DELETE with immediate", () => {
    const paths = TRIXIE_FILES.map(name => `${ TRIXIE_POOL }/${ name }`);

    test("DELETE with immediate=true removes the pool files before it responds", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian/trixie");
        expect(await servedStatuses(app, paths)).toEqual(paths.map(() => 200));

        const res = await request(app).delete("/api/v1/repo/deb/debian/trixie/srm-hello?immediate=true");

        expect(res.status).toBe(200);
        expect(res.body.files.map((f: { path: string }) => f.path).sort()).toEqual(paths);
        expect(await servedStatuses(app, paths)).toEqual(paths.map(() => 404));
    }));

    test.each([
        ["without immediate", ""],
        ["with immediate=false", "?immediate=false"],
    ])("DELETE %s keeps the pool files", (_label, query) => withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian/trixie");

        const res = await request(app).delete(`/api/v1/repo/deb/debian/trixie/srm-hello${ query }`);

        expect(res.status).toBe(200);
        expect(res.body.files.map((f: { path: string }) => f.path).sort()).toEqual(paths);
        expect(await servedStatuses(app, paths)).toEqual(paths.map(() => 200));
    })());

    test("immediate=maybe is 400", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian/trixie");

        const res = await request(app).delete("/api/v1/repo/deb/debian/trixie/srm-hello?immediate=maybe");

        expect(res.status).toBe(400);
        expect(res.body.message).toBe(IMMEDIATE_MESSAGE);
        expect((await request(app).get("/api/v1/repo/deb/debian/trixie/srm-hello")).body.files).toEqual(listed(TRIXIE_POOL, TRIXIE_FILES));
    }));

    test.each([
        ["immediate=TRUE", IMMEDIATE_MESSAGE],
        ["immediate=1", IMMEDIATE_MESSAGE],
        ["immediate=", IMMEDIATE_MESSAGE],
        ["immediate", IMMEDIATE_MESSAGE],
        ["immediate=true&immediate=true", "immediate must be given once"],
    ])("%s is 400", (query, message) => withLocalTmpDir(async () => {
        const app = await createTestApp();

        const res = await request(app).delete(`/api/v1/repo/-/-/-/srm-hello?${ query }`);

        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
    })());
});
