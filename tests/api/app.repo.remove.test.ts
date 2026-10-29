import request from "supertest";
import type { Application } from "express";
import _ from "lodash";
import fs from "node:fs/promises";
import osPath from "path";
import path from "path/posix";
import zlib from "node:zlib";
import createTestApp from "../testapp.ts";
import { poolRemovedAt, servedStatuses, uploadFileByPut, withLocalTmpDir } from "../utils.ts";
import { fixtureNames, importedApp, readFixture, uploadFixtureFile, uploadSecondVersion } from "../fixture-upload.ts";
import { listFiles } from "../../server/backend/publish-fs.ts";

const TRIXIE = "deb/debian/trixie/main";
const BOOKWORM = "deb/debian/bookworm/main";
const NOBLE = "deb/ubuntu/noble/universe";
const FEDORA = "rpm/fedora/42";
const HELLO_POOL = "deb/debian/pool/main/s/srm-hello";
const GZ_POOL = "deb/debian/pool/main/s/srm-gz";
const ZST_POOL = "deb/ubuntu/pool/universe/s/srm-zst";
const ORIG = `${ HELLO_POOL }/srm-hello_1.0.orig.tar.gz`;
const RPM_VERSION = "1.0-1.fc42";

/** Pool paths of the fixture files in tests/fixtures/packages/<dir>, sorted */
async function poolPaths(dir: string, poolDir: string): Promise<string[]> {
    return (await fixtureNames(`packages/${ dir }`)).map(name => `${ poolDir }/${ name }`);
}

function rpmPool(target: string): string {
    return `${ target }/Packages/s/srm-hello`;
}

function removed(paths: string[], failed?: string) {
    return paths.map(p => ({ filename: path.basename(p), path: p, status: p === failed ? "failed" : "ok" }));
}

function byPath<T extends { path: string }>(files: T[]): T[] {
    return _.sortBy(files, "path");
}

async function listedPaths(app: Application, url: string): Promise<string[]> {
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    return res.body.files.map((f: { path: string }) => f.path).sort();
}

async function importStaged(app: Application): Promise<void> {
    expect((await request(app).post("/api/v1/repo/import")).status).toBe(200);
}

/** The trixie srm-hello bundle uploaded to ubuntu noble, its .changes naming that release */
async function uploadHelloToNoble(app: Application): Promise<void> {
    for (const name of await fixtureNames(`packages/${ TRIXIE }`)) {
        const content = await readFixture(`packages/${ TRIXIE }/${ name }`);
        const upload = name.endsWith(".changes") ? Buffer.from(content.toString("utf8").replace("Distribution: trixie", "Distribution: noble")) : content;
        expect((await uploadFileByPut(app, `/api/v1/upload/${ NOBLE }/${ name }`, upload)).status).toBe(201);
    }
}

async function uploadRpmsTo(app: Application, target: string): Promise<void> {
    for (const name of await fixtureNames(`packages/${ FEDORA }`)) {
        await uploadFixtureFile(app, `packages/${ FEDORA }/${ name }`, target);
    }
}

/** A directory in place of the pool file, which unlink cannot delete */
async function blockDeletion(poolPath: string): Promise<void> {
    const file = osPath.join("repo", ...poolPath.split("/"));
    await fs.rm(file);
    await fs.mkdir(file);
}

async function debIndex(distro: string, release: string, index: string): Promise<string> {
    return zlib.gunzipSync(await fs.readFile(osPath.join("repo", "deb", distro, "dists", release, ...index.split("/")))).toString("utf8");
}

/** The primary.xml the published repomd.xml names */
async function rpmPrimary(target: string): Promise<string> {
    const dir = osPath.join("repo", ...target.split("/"));
    const repomd = await fs.readFile(osPath.join(dir, "repodata", "repomd.xml"), "utf8");
    const entry = repomd.slice(repomd.indexOf('<data type="primary">'));
    const from = entry.indexOf('<location href="') + '<location href="'.length;
    return zlib.zstdDecompressSync(await fs.readFile(osPath.join(dir, ...entry.slice(from, entry.indexOf('"', from)).split("/")))).toString("utf8");
}

describe("DELETE deb package", () => {
    test("200 lists every file of the version and republishes the release without it", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb");
        const paths = await poolPaths(TRIXIE, HELLO_POOL);
        const url = "/api/v1/repo/deb/debian/trixie/srm-hello/1.0-1";
        expect(await listedPaths(app, url)).toEqual(paths);

        const res = await request(app).delete(url);

        expect(res.status).toBe(200);
        expect(res.body.message).toBe("Removed 7 file(s) across 1 release(s)");
        expect(byPath(res.body.files)).toEqual(removed(paths));
        expect(await listedPaths(app, url)).toEqual([]);
        expect(await debIndex("debian", "trixie", "main/binary-amd64/Packages.gz")).not.toContain("srm-hello");
        expect(await debIndex("debian", "trixie", "main/source/Sources.gz")).not.toContain("srm-hello");
        expect(await listedPaths(app, "/api/v1/repo/deb/-/-/srm-gz")).toEqual(await poolPaths(BOOKWORM, GZ_POOL));
        expect(await listedPaths(app, "/api/v1/repo/deb/-/-/srm-zst")).toEqual(await poolPaths(NOBLE, ZST_POOL));
    }));

    test("No match answers 200 with no files and leaves the release untouched", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian");
        const release = await fs.readFile(osPath.join("repo", "deb", "debian", "dists", "trixie", "Release"));

        const res = await request(app).delete("/api/v1/repo/deb/debian/trixie/srm-gz/0.1-1");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ message: "No packages matched srm-gz/0.1-1 in deb/debian/trixie", files: [] });
        expect(await fs.readFile(osPath.join("repo", "deb", "debian", "dists", "trixie", "Release"))).toEqual(release);
        expect(await listedPaths(app, "/api/v1/repo/deb/debian/bookworm/srm-gz")).toEqual(await poolPaths(BOOKWORM, GZ_POOL));
    }));

    test.each([
        ["version -", "/-"],
        ["no version segment", ""],
    ])("%s removes every version of the source", (_label, version) => withLocalTmpDir(async () => {
        const app = await importedApp(`packages/${ TRIXIE }`);
        const second = (await uploadSecondVersion(app)).map(name => `${ HELLO_POOL }/${ name }`);
        await importStaged(app);
        const paths = [...await poolPaths(TRIXIE, HELLO_POOL), ...second].sort();

        const res = await request(app).delete(`/api/v1/repo/deb/debian/trixie/srm-hello${ version }`);

        expect(res.status).toBe(200);
        expect(res.body.message).toBe("Removed 10 file(s) across 1 release(s)");
        expect(byPath(res.body.files)).toEqual(removed(paths));
        expect(await listedPaths(app, "/api/v1/repo/deb/debian/trixie/srm-hello")).toEqual([]);
    })());

    test("Wildcard release removes the source from every release of the distribution", withLocalTmpDir(async () => {
        const app = await importedApp(`packages/${ TRIXIE }`);
        const second = (await uploadSecondVersion(app, "bookworm")).map(name => `${ HELLO_POOL }/${ name }`);
        await importStaged(app);
        const paths = [...await poolPaths(TRIXIE, HELLO_POOL), ...second].sort();

        const res = await request(app).delete("/api/v1/repo/deb/debian/-/srm-hello/-");

        expect(res.status).toBe(200);
        expect(res.body.message).toBe("Removed 10 file(s) across 2 release(s)");
        expect(byPath(res.body.files)).toEqual(removed(paths));
        expect(await listedPaths(app, "/api/v1/repo/deb/debian/-/srm-hello")).toEqual([]);
    }));

    test("Wildcard distribution and release remove the source from every distribution", withLocalTmpDir(async () => {
        const app = await importedApp(`packages/${ TRIXIE }`);
        await uploadHelloToNoble(app);
        await importStaged(app);
        const paths = [...await poolPaths(TRIXIE, HELLO_POOL), ...await poolPaths(TRIXIE, "deb/ubuntu/pool/universe/s/srm-hello")].sort();

        const res = await request(app).delete("/api/v1/repo/deb/-/-/srm-hello/1.0-1");

        expect(res.status).toBe(200);
        expect(res.body.message).toBe("Removed 14 file(s) across 2 release(s)");
        expect(byPath(res.body.files)).toEqual(removed(paths));
        expect(await listedPaths(app, "/api/v1/repo/deb/-/-/srm-hello")).toEqual([]);
    }));

    test("A version with an epoch given URL-encoded is removed", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/ubuntu");
        const paths = await poolPaths(NOBLE, ZST_POOL);

        const res = await request(app).delete("/api/v1/repo/deb/ubuntu/noble/srm-zst/2%3A3.0-1");

        expect(res.status).toBe(200);
        expect(byPath(res.body.files)).toEqual(removed(paths));
        expect(await listedPaths(app, "/api/v1/repo/deb/ubuntu/noble/srm-zst")).toEqual([]);
    }));

    test("A publish failure answers 500 and deletes nothing", withLocalTmpDir(async () => {
        const app = await importedApp(`packages/${ TRIXIE }`);
        const paths = await poolPaths(TRIXIE, HELLO_POOL);
        const release = osPath.join("repo", "deb", "debian", "dists", "trixie", "Release");
        const published = await fs.readFile(release);
        // A file where the publisher's temp directory belongs
        await fs.rm(osPath.join("repo-state", "tmp"), { recursive: true, force: true });
        await fs.writeFile(osPath.join("repo-state", "tmp"), "");

        const res = await request(app).delete("/api/v1/repo/deb/debian/trixie/srm-hello?immediate=true");

        expect(res.status).toBe(500);
        expect(res.body.message).toBe("Package removal failed. See server logs for details");
        expect(await servedStatuses(app, paths)).toEqual(paths.map(() => 200));
        expect(await fs.readFile(release)).toEqual(published);
        // Their rows await GC, which deletes the files after the grace
        expect(poolRemovedAt()).toEqual(Object.fromEntries(paths.map(p => [p, expect.any(Number)])));
    }));

    test("A pool file that cannot be deleted answers 500 and lists the files of every release", withLocalTmpDir(async () => {
        const app = await importedApp(`packages/${ TRIXIE }`);
        const second = (await uploadSecondVersion(app, "bookworm")).map(name => `${ HELLO_POOL }/${ name }`);
        await importStaged(app);
        const paths = [...await poolPaths(TRIXIE, HELLO_POOL), ...second].sort();
        const blocked = `${ HELLO_POOL }/srm-hello_1.0-1_amd64.deb`;
        await blockDeletion(blocked);

        const res = await request(app).delete("/api/v1/repo/deb/debian/-/srm-hello?immediate=true");

        expect(res.status).toBe(500);
        expect(res.body.message).toBe("Removed 10 entries; 1 file(s) could not be deleted. See server logs for details");
        expect(byPath(res.body.files)).toEqual(removed(paths, blocked));
        const deleted = paths.filter(p => p !== blocked);
        expect(await servedStatuses(app, deleted)).toEqual(deleted.map(() => 404));
        expect(await listedPaths(app, "/api/v1/repo/deb/debian/-/srm-hello")).toEqual([]);
        expect(poolRemovedAt()).toEqual({ [blocked]: expect.any(Number) });
    }));
});

describe("DELETE rpm package", () => {
    test("200 removes the source rpm and its binaries and republishes the release without them", withLocalTmpDir(async () => {
        const app = await importedApp("packages");
        const paths = await poolPaths(FEDORA, rpmPool(FEDORA));
        const deb = await poolPaths(TRIXIE, HELLO_POOL);

        const res = await request(app).delete(`/api/v1/repo/rpm/fedora/42/srm-hello/${ RPM_VERSION }?immediate=true`);

        expect(res.status).toBe(200);
        expect(res.body.message).toBe("Removed 3 file(s) across 1 release(s)");
        expect(byPath(res.body.files)).toEqual(removed(paths));
        expect(await servedStatuses(app, paths)).toEqual(paths.map(() => 404));
        expect(await rpmPrimary(FEDORA)).not.toContain("<package ");
        expect(await servedStatuses(app, deb)).toEqual(deb.map(() => 200));
        expect(await listedPaths(app, "/api/v1/repo/deb/debian/trixie/srm-hello")).toEqual(deb);
    }));

    test("A version without the dist tag matches the source rpm", withLocalTmpDir(async () => {
        const app = await importedApp("packages/rpm");
        const paths = await poolPaths(FEDORA, rpmPool(FEDORA));

        const res = await request(app).delete("/api/v1/repo/rpm/fedora/42/srm-hello/1.0-1?immediate=true");

        expect(res.status).toBe(200);
        expect(byPath(res.body.files)).toEqual(removed(paths));
        expect(await servedStatuses(app, paths)).toEqual(paths.map(() => 404));
        expect(await rpmPrimary(FEDORA)).not.toContain("<package ");
    }));

    test("Immediate removal deletes the source directory it empties", withLocalTmpDir(async () => {
        const app = await importedApp("packages/rpm");
        const dirs = [`${ rpmPool(FEDORA) }/`, `${ FEDORA }/Packages/s/`, `${ FEDORA }/Packages/`];
        expect(await servedStatuses(app, dirs)).toEqual([200, 200, 200]);

        expect((await request(app).delete("/api/v1/repo/rpm/fedora/42/srm-hello?immediate=true")).status).toBe(200);

        expect(await servedStatuses(app, dirs)).toEqual([404, 404, 200]);
    }));

    test("200 removes binaries uploaded without their .src.rpm", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const binaries = (await fixtureNames(`packages/${ FEDORA }`)).filter(name => !name.endsWith(".src.rpm"));
        for (const name of binaries) {
            await uploadFixtureFile(app, `packages/${ FEDORA }/${ name }`);
        }
        await importStaged(app);

        const res = await request(app).delete("/api/v1/repo/rpm/fedora/42/srm-hello");

        expect(res.status).toBe(200);
        expect(byPath(res.body.files)).toEqual(removed(binaries.map(name => `${ rpmPool(FEDORA) }/${ name }`)));
    }));

    test("No match answers 200 with no files and leaves repodata untouched", withLocalTmpDir(async () => {
        const app = await importedApp("packages/rpm");
        const repomd = await fs.readFile(osPath.join("repo", "rpm", "fedora", "42", "repodata", "repomd.xml"));

        const res = await request(app).delete("/api/v1/repo/rpm/fedora/42/srm-zst/3.0-1");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ message: "No packages matched srm-zst/3.0-1 in rpm/fedora/42", files: [] });
        expect(await fs.readFile(osPath.join("repo", "rpm", "fedora", "42", "repodata", "repomd.xml"))).toEqual(repomd);
        expect(await listedPaths(app, "/api/v1/repo/rpm/fedora/42/srm-hello")).toEqual(await poolPaths(FEDORA, rpmPool(FEDORA)));
    }));

    test("A release directory the database does not know is not a target", withLocalTmpDir(async () => {
        const app = await importedApp("packages/rpm");
        const stray = `${ rpmPool("rpm/fedora/41") }/srm-hello-${ RPM_VERSION }.src.rpm`;
        await fs.mkdir(osPath.join("repo", ...path.dirname(stray).split("/")), { recursive: true });
        await fs.writeFile(osPath.join("repo", ...stray.split("/")), await readFixture(`packages/${ FEDORA }/srm-hello-${ RPM_VERSION }.src.rpm`));

        const res = await request(app).delete("/api/v1/repo/rpm/fedora/41/srm-hello/-");

        expect(res.status).toBe(404);
        expect(await servedStatuses(app, [stray])).toEqual([200]);
    }));

    test.each([
        ["release", "rpm/fedora/41", "rpm/fedora/-", RPM_VERSION],
        ["distribution and release, version without the dist tag,", "rpm/centos/9", "rpm/-/-", "1.0-1"],
    ])("Wildcard %s removes the source from every matching release", (_label, other, scope, version) => withLocalTmpDir(async () => {
        const app = await importedApp("packages/rpm");
        await uploadRpmsTo(app, other);
        await importStaged(app);
        const paths = [...await poolPaths(FEDORA, rpmPool(FEDORA)), ...await poolPaths(FEDORA, rpmPool(other))].sort();

        const res = await request(app).delete(`/api/v1/repo/${ scope }/srm-hello/${ version }?immediate=true`);

        expect(res.status).toBe(200);
        expect(res.body.message).toBe("Removed 6 file(s) across 2 release(s)");
        expect(byPath(res.body.files)).toEqual(removed(paths));
        expect(await servedStatuses(app, paths)).toEqual(paths.map(() => 404));
    })());

    test("A pool file that cannot be deleted answers 500 and lists the files of every release", withLocalTmpDir(async () => {
        const app = await importedApp("packages/rpm");
        await uploadRpmsTo(app, "rpm/centos/9");
        await importStaged(app);
        const paths = [...await poolPaths(FEDORA, rpmPool(FEDORA)), ...await poolPaths(FEDORA, rpmPool("rpm/centos/9"))].sort();
        const blocked = `${ rpmPool("rpm/centos/9") }/srm-hello-${ RPM_VERSION }.x86_64.rpm`;
        await blockDeletion(blocked);

        const res = await request(app).delete(`/api/v1/repo/rpm/-/-/srm-hello/${ RPM_VERSION }?immediate=true`);

        expect(res.status).toBe(500);
        expect(res.body.message).toBe("Removed 6 entries; 1 file(s) could not be deleted. See server logs for details");
        expect(byPath(res.body.files)).toEqual(removed(paths, blocked));
        const deleted = paths.filter(p => p !== blocked);
        expect(await servedStatuses(app, deleted)).toEqual(deleted.map(() => 404));
        expect(await rpmPrimary(FEDORA)).not.toContain("<package ");
        expect(await rpmPrimary("rpm/centos/9")).not.toContain("<package ");
    }));
});

describe("DELETE removal modes", () => {
    test("DELETE ?immediate=true removes pool files at once", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian");
        const hello = await poolPaths(TRIXIE, HELLO_POOL);
        const gz = await poolPaths(BOOKWORM, GZ_POOL);
        expect(await servedStatuses(app, hello)).toEqual(hello.map(() => 200));

        const res = await request(app).delete("/api/v1/repo/deb/debian/trixie/srm-hello?immediate=true");

        expect(res.status).toBe(200);
        expect(byPath(res.body.files)).toEqual(removed(hello));
        expect(await servedStatuses(app, hello)).toEqual(hello.map(() => 404));
        expect(poolRemovedAt()).toEqual(Object.fromEntries(gz.map(p => [p, null])));
        expect(await servedStatuses(app, gz)).toEqual(gz.map(() => 200));
    }));

    test("DELETE without immediate keeps files and sets removed_at", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian");
        const hello = await poolPaths(TRIXIE, HELLO_POOL);
        const gz = await poolPaths(BOOKWORM, GZ_POOL);
        const before = Math.floor(Date.now() / 1000);

        const res = await request(app).delete("/api/v1/repo/deb/debian/trixie/srm-hello");

        const after = Math.floor(Date.now() / 1000);
        expect(res.status).toBe(200);
        expect(byPath(res.body.files)).toEqual(removed(hello));
        expect(await servedStatuses(app, hello)).toEqual(hello.map(() => 200));
        const removedAt = poolRemovedAt();
        expect(Object.keys(removedAt)).toEqual([...gz, ...hello]);
        expect(gz.map(p => removedAt[p])).toEqual(gz.map(() => null));
        for (const p of hello) {
            expect(removedAt[p]).toBeGreaterThanOrEqual(before);
            expect(removedAt[p]).toBeLessThanOrEqual(after);
        }
    }));

    test("Removing one release keeps the orig tarball shared with another", withLocalTmpDir(async () => {
        const app = await importedApp(`packages/${ TRIXIE }`);
        const second = (await uploadSecondVersion(app, "bookworm")).map(name => `${ HELLO_POOL }/${ name }`);
        await importStaged(app);
        const hello = await poolPaths(TRIXIE, HELLO_POOL);
        const bookworm = [...second, ORIG].sort();

        const res = await request(app).delete("/api/v1/repo/deb/debian/trixie/srm-hello?immediate=true");

        expect(res.status).toBe(200);
        expect(byPath(res.body.files)).toEqual(removed(hello));
        const deleted = hello.filter(p => p !== ORIG);
        expect(await servedStatuses(app, deleted)).toEqual(deleted.map(() => 404));
        expect(await servedStatuses(app, [ORIG])).toEqual([200]);
        expect(poolRemovedAt()).toEqual(Object.fromEntries(bookworm.map(p => [p, null])));
        expect(await listedPaths(app, "/api/v1/repo/deb/debian/bookworm/srm-hello")).toEqual(bookworm);
    }));

    test("DELETE /api/v1/repo/-/-/-/<source>/- removes from every format", withLocalTmpDir(async () => {
        const app = await importedApp("packages");
        const paths = [...await poolPaths(TRIXIE, HELLO_POOL), ...await poolPaths(FEDORA, rpmPool(FEDORA))];

        const res = await request(app).delete("/api/v1/repo/-/-/-/srm-hello/-");

        expect(res.status).toBe(200);
        expect(res.body.message).toBe("Removed 10 file(s) across 2 release(s)");
        expect(byPath(res.body.files)).toEqual(removed(paths));
        expect(await listedPaths(app, "/api/v1/repo/-/-/-/srm-hello")).toEqual([]);
        expect(await debIndex("debian", "trixie", "main/binary-amd64/Packages.gz")).not.toContain("srm-hello");
        expect(await rpmPrimary(FEDORA)).not.toContain("<package ");
        expect(await listedPaths(app, "/api/v1/repo/-/-/-/srm-gz")).toEqual(await poolPaths(BOOKWORM, GZ_POOL));
    }));
});

describe("DELETE selection", () => {
    test("404 for a distribution or release that is not configured", withLocalTmpDir(async () => {
        const app = await importedApp("packages");

        for (const url of [
            "deb/debian/sid/srm-hello/1.0-1",
            "deb/raspbian/bookworm/srm-hello",
            "deb/raspbian/-/srm-hello/-",
            "rpm/fedora/41/srm-hello/1.0-1.fc42",
            "rpm/centos/9/srm-hello",
            "rpm/-/41/srm-hello/-",
        ]) {
            const res = await request(app).delete(`/api/v1/repo/${ url }`);
            expect(res.status).toBe(404);
            expect(res.body.message).toMatch(/^No such repository /);
        }
        expect(await listedPaths(app, "/api/v1/repo/-/-/-/srm-hello")).toEqual([
            ...await poolPaths(TRIXIE, HELLO_POOL), ...await poolPaths(FEDORA, rpmPool(FEDORA)),
        ]);
    }));

    test("The source name matches exactly, not as a prefix", withLocalTmpDir(async () => {
        const app = await importedApp("packages");
        const before = await listedPaths(app, "/api/v1/repo/-/-/-/srm-hello");

        const res = await request(app).delete("/api/v1/repo/-/-/-/srm/-");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ message: "No packages matched srm/- in -/-/-", files: [] });
        expect(await listedPaths(app, "/api/v1/repo/-/-/-/srm-hello")).toEqual(before);
    }));

    test.each(["deb/-/-", "rpm/-/-", "-/-/-"])("%s with nothing imported answers 200 with no files", scope => withLocalTmpDir(async () => {
        const app = await createTestApp();

        const res = await request(app).delete(`/api/v1/repo/${ scope }/srm-hello/-`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ message: `No packages matched srm-hello/- in ${ scope }`, files: [] });
        expect(await listFiles("repo")).toEqual([]);
    })());
});
