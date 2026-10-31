import * as cheerio from "cheerio";
import type { Application } from "express";
import fs from "node:fs/promises";
import osPath from "path";
import request from "supertest";
import type { DirectoryNaming } from "../../server/backend/win-volume.ts";
import { resetFileNaming, setFileNaming } from "../../server/lib/file-naming.ts";
import { fixtureNames, importFixtures, readFixture, uploadFixtureFile } from "../fixture-upload.ts";
import createTestApp from "../testapp.ts";
import { uploadFileByPost, uploadFileByPut, withLocalTmpDir } from "../utils.ts";

const windowsTest = process.platform === "win32" ? test : test.skip;

const INSENSITIVE: DirectoryNaming = { caseSensitive: false, shortNames: false };
const SENSITIVE: DirectoryNaming = { caseSensitive: true, shortNames: false };

const CONTENT = Buffer.from("Hello World");
const NETWORK_MANAGER = "NetworkManager-1.56.0-1.fc44.x86_64.rpm";
const NETWORK_MANAGER_IN_OTHER_CASE = "networkmanager-1.56.0-1.fc44.x86_64.rpm";
const HELLO_DEB = "srm-hello_1.0-1_amd64.deb";
const HELLO_RPM = "srm-hello-1.0-1.fc42.x86_64.rpm";
const TRIXIE = "packages/deb/debian/trixie/main";
const FEDORA = "packages/rpm/fedora/42";
const DEB_POOL = "deb/debian/pool/main/s/srm-hello";
const RPM_POOL = "rpm/fedora/42/Packages/s/srm-hello";
const DEB_REPOSITORY = { format: "deb", distribution: "debian", release: "trixie" };
const RPM_REPOSITORY = { format: "rpm", distribution: "fedora", release: "42" };
const DEB_PACKAGE = { ...DEB_REPOSITORY, source: "srm-hello", version: "1.0-1" };
const RPM_PACKAGE = { ...RPM_REPOSITORY, source: "srm-hello", version: "1.0-1.fc42" };

/** An upload directory in another spelling, as the repository holds it, and a file for it */
const DIRECTORIES = [
    ["rpm/Fedora/44", "rpm/fedora/44", NETWORK_MANAGER],
    ["deb/Debian/Trixie/Main", "deb/debian/trixie/main", HELLO_DEB],
    ["deb/UBUNTU/NOBLE/UNIVERSE", "deb/ubuntu/noble/universe", "srm-zst_3.0-1_amd64.deb"],
    ["deb/debian/Bookworm-Security/Updates/Main", "deb/debian/bookworm-security/updates/main", HELLO_DEB],
];

afterEach(resetFileNaming);

async function appWhere(naming: DirectoryNaming): Promise<Application> {
    const app = await createTestApp();
    setFileNaming(naming);
    return app;
}

async function importedWhere(naming: DirectoryNaming): Promise<Application> {
    const app = await createTestApp();
    await importFixtures(app, "packages/deb/debian/trixie");
    await importFixtures(app, FEDORA);
    setFileNaming(naming);
    return app;
}

/** The staged files as the disk spells them, relative to the staging root */
async function stagedFiles(): Promise<string[]> {
    const root = osPath.join("incoming", "staging");
    const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
    return entries.filter(entry => entry.isFile())
        .map(entry => osPath.relative(root, osPath.join(entry.parentPath, entry.name)).split(osPath.sep).join("/"))
        .sort();
}

async function expectNothingStaged(): Promise<void> {
    expect(await stagedFiles()).toEqual([]);
    expect(await fs.readdir(osPath.join("incoming", "tmp"))).toEqual([]);
}

async function callTool(app: Application, name: string, args: Record<string, unknown>) {
    const res = await request(app)
        .post("/api/v1/mcp")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    expect(res.status).toBe(200);
    return res.body.result;
}

async function poolPaths(fixtureDir: string, pool: string): Promise<string[]> {
    return (await fixtureNames(fixtureDir)).map(name => `${ pool }/${ name }`);
}

function pathsOf(files: { path: string }[]): string[] {
    return files.map(file => file.path).sort();
}

describe("Uploads where case does not count", () => {
    test.each(DIRECTORIES)("A PUT to %s stores into %s", (dir, stored, name) => withLocalTmpDir(async () => {
        const app = await appWhere(INSENSITIVE);

        const res = await uploadFileByPut(app, `/api/v1/upload/${ dir }/${ name }`, CONTENT);

        expect(res.status).toBe(201);
        expect(res.body.files).toEqual([{ filename: name, path: `${ stored }/${ name }`, status: "ok" }]);
        expect(await stagedFiles()).toEqual([`${ stored }/${ name }`]);
    })());

    test.each(DIRECTORIES)("A POST to %s stores into %s", (dir, stored, name) => withLocalTmpDir(async () => {
        const app = await appWhere(INSENSITIVE);

        const res = await uploadFileByPost(app, `/api/v1/upload/${ dir }`, [{ name, content: CONTENT }]);

        expect(res.status).toBe(201);
        expect(res.body.files).toEqual([{ filename: name, path: `${ stored }/${ name }`, status: "ok" }]);
        expect(await stagedFiles()).toEqual([`${ stored }/${ name }`]);
    })());

    test("Uploads in several spellings land in one directory", withLocalTmpDir(async () => {
        const app = await appWhere(INSENSITIVE);

        expect((await uploadFileByPut(app, `/api/v1/upload/rpm/Fedora/44/${ NETWORK_MANAGER }`, CONTENT)).status).toBe(201);
        expect((await uploadFileByPut(app, `/api/v1/upload/rpm/fedora/44/${ HELLO_RPM }`, CONTENT)).status).toBe(201);

        expect(await stagedFiles()).toEqual([`rpm/fedora/44/${ NETWORK_MANAGER }`, `rpm/fedora/44/${ HELLO_RPM }`]);
    }));

    test("A Debian file name in upper case is taken, only the directories go to lower case", withLocalTmpDir(async () => {
        const app = await appWhere(INSENSITIVE);
        const name = "Srm-hello_1.0A-1_amd64.deb";

        for (const res of [
            await uploadFileByPut(app, `/api/v1/upload/deb/Debian/Trixie/Main/${ name }`, CONTENT),
            await uploadFileByPost(app, "/api/v1/upload/deb/Debian/Trixie/Main", [{ name, content: CONTENT }]),
        ]) {
            expect(res.status).toBe(201);
        }
        expect(await stagedFiles()).toEqual([`deb/debian/trixie/main/${ name }`]);
    }));

    test.each(["srm-hello-1.0~rc1-1.fc42.x86_64.rpm", "srm-hello-1.0^git1-1.fc42.x86_64.rpm"])("The RPM %s is taken", name => withLocalTmpDir(async () => {
        const app = await appWhere(INSENSITIVE);

        expect((await uploadFileByPut(app, `/api/v1/upload/rpm/fedora/42/${ encodeURIComponent(name) }`, CONTENT)).status).toBe(201);

        expect(await stagedFiles()).toEqual([`rpm/fedora/42/${ name }`]);
    })());

    test("A PUT over the size limit names the path as sent", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { sizeLimit: 1 } });
        setFileNaming(INSENSITIVE);

        const res = await uploadFileByPut(app, `/api/v1/upload/rpm/Fedora/44/${ NETWORK_MANAGER }`, CONTENT);

        expect(res.status).toBe(413);
        expect(res.body.files).toEqual([{ filename: NETWORK_MANAGER, path: `rpm/Fedora/44/${ NETWORK_MANAGER }`, status: "failed" }]);
    }));

    /** The message of a file name differing only in case from a staged one, the refused path as sent */
    function conflictOf(sent: string, stored: string): string {
        return `${ sent } differs only in case from ${ stored }, which this file system cannot keep apart`;
    }

    test("A PUT differing only in case from a staged file is refused, naming its path as sent and the other as stored", withLocalTmpDir(async () => {
        const app = await appWhere(INSENSITIVE);
        const stored = `rpm/fedora/44/${ NETWORK_MANAGER }`;
        const sent = `rpm/Fedora/44/${ NETWORK_MANAGER_IN_OTHER_CASE }`;
        expect((await uploadFileByPut(app, `/api/v1/upload/${ stored }`, CONTENT)).status).toBe(201);

        const res = await uploadFileByPut(app, `/api/v1/upload/${ sent }`, CONTENT);

        expect(res.status).toBe(400);
        expect(res.body.message).toBe(conflictOf(sent, stored));
        expect(res.body.files).toEqual([{ filename: NETWORK_MANAGER_IN_OTHER_CASE, path: sent, status: "failed" }]);
        expect(await stagedFiles()).toEqual([stored]);
    }));

    test("One POST names the refused file as sent and the accepted one as stored", withLocalTmpDir(async () => {
        const app = await appWhere(INSENSITIVE);
        const stored = `rpm/fedora/44/${ NETWORK_MANAGER }`;
        const sent = `rpm/Fedora/44/${ NETWORK_MANAGER_IN_OTHER_CASE }`;

        const res = await uploadFileByPost(app, "/api/v1/upload/rpm/Fedora/44", [{ name: NETWORK_MANAGER, content: CONTENT }, { name: NETWORK_MANAGER_IN_OTHER_CASE, content: CONTENT }]);

        expect(res.status).toBe(400);
        expect(res.body.message).toBe(`One or more files failed to upload: ${ conflictOf(sent, stored) }`);
        expect(res.body.files).toEqual([
            { filename: NETWORK_MANAGER, path: stored, status: "ok" },
            { filename: NETWORK_MANAGER_IN_OTHER_CASE, path: sent, status: "failed" },
        ]);
        expect(await stagedFiles()).toEqual([stored]);
    }));

    test.each(["rpm/fedora/44", "rpm/Fedora/44"])("A hand-placed rpm/Fedora in staging lets a PUT to %s through", dir => withLocalTmpDir(async () => {
        const app = await appWhere(INSENSITIVE);
        await fs.mkdir(osPath.join("incoming", "staging", "rpm", "Fedora"), { recursive: true });

        const res = await uploadFileByPut(app, `/api/v1/upload/${ dir }/${ NETWORK_MANAGER }`, CONTENT);

        expect(res.status).toBe(201);
        expect(res.body.files).toEqual([{ filename: NETWORK_MANAGER, path: `rpm/fedora/44/${ NETWORK_MANAGER }`, status: "ok" }]);
    })());

    test("Uploads next to a hand-placed rpm/Fedora in staging are imported into lower case", withLocalTmpDir(async () => {
        const app = await appWhere(INSENSITIVE);
        await fs.mkdir(osPath.join("incoming", "staging", "rpm", "Fedora"), { recursive: true });
        const names = await fixtureNames(FEDORA);
        for (const name of names) {
            await uploadFixtureFile(app, `${ FEDORA }/${ name }`, "rpm/fedora/42");
        }

        expect((await callTool(app, "import_repository", {})).structuredContent.ok).toBe(true);

        expect(await fs.readdir(osPath.join("repo", "rpm"))).toEqual(["fedora"]);
        expect((await fs.readdir(osPath.join("repo", ...RPM_POOL.split("/")))).sort()).toEqual(names);
    }));

    test("A real upload in another spelling is imported into lower case", withLocalTmpDir(async () => {
        const app = await appWhere(INSENSITIVE);
        const rpmNames = await fixtureNames(FEDORA);
        const debNames = await fixtureNames(TRIXIE);
        for (const name of rpmNames) {
            await uploadFixtureFile(app, `${ FEDORA }/${ name }`, "rpm/Fedora/42");
        }
        const files = await Promise.all(debNames.map(async name => ({ name, content: await readFixture(`${ TRIXIE }/${ name }`) })));
        expect((await uploadFileByPost(app, "/api/v1/upload/deb/Debian/Trixie/Main", files)).status).toBe(201);

        const result = (await callTool(app, "import_repository", {})).structuredContent;

        expect(result.ok).toBe(true);
        expect(pathsOf(result.files)).toEqual([...debNames.map(name => `deb/debian/trixie/main/${ name }`), ...rpmNames.map(name => `rpm/fedora/42/${ name }`)].sort());
        expect(await fs.readdir(osPath.join("repo", "deb"))).toEqual(["debian"]);
        expect(await fs.readdir(osPath.join("repo", "rpm"))).toEqual(["fedora"]);
        expect((await fs.readdir(osPath.join("repo", ...RPM_POOL.split("/")))).sort()).toEqual(rpmNames);
        expect((await fs.readdir(osPath.join("repo", ...DEB_POOL.split("/")))).sort()).toEqual(debNames);
    }));

    windowsTest("A device name in upper case stays refused", withLocalTmpDir(async () => {
        const app = await appWhere(INSENSITIVE);

        const res = await uploadFileByPut(app, `/api/v1/upload/rpm/AUX/44/${ NETWORK_MANAGER }`, CONTENT);

        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Unknown or invalid distro: rpm/AUX/44: "AUX" is a reserved name on Windows');
        await expectNothingStaged();
    }));

    test.each([
        ["deb/debian/trixie/release", "release"],
        ["deb/debian/trixie/Release", "Release"],
        ["deb/debian/trixie/inrelease", "inrelease"],
        ["deb/debian/trixie/INRELEASE", "INRELEASE"],
        ["deb/debian/trixie/release/main", "release"],
        ["deb/debian/trixie/Release/Main", "Release"],
    ])("%s has a file of that name in its release, so it is refused, named as sent", (dir, component) => withLocalTmpDir(async () => {
        const app = await appWhere(INSENSITIVE);

        for (const res of [
            await uploadFileByPut(app, `/api/v1/upload/${ dir }/${ HELLO_DEB }`, CONTENT),
            await uploadFileByPost(app, `/api/v1/upload/${ dir }`, [{ name: HELLO_DEB, content: CONTENT }]),
        ]) {
            expect(res.status).toBe(400);
            expect(res.body.message).toBe(`Unknown or invalid distro: ${ dir }: "${ component }" cannot be a component, the release has a file of that name`);
        }
        await expectNothingStaged();
    })());

    test.each<[Record<string, string>, string, string]>([
        [{ format: "deb", distribution: "debian", release: "trixie", component: "release" }, "deb/debian/trixie/release", "release"],
        [{ format: "deb", distribution: "Debian", release: "Trixie", component: "InRelease" }, "deb/Debian/Trixie/InRelease", "InRelease"],
        [{ format: "deb", distribution: "debian", release: "trixie", component: "Release", subcomponent: "Main" }, "deb/debian/trixie/Release/Main", "Release"],
    ])("prepare_upload refuses %j, named as sent", (target, sent, component) => withLocalTmpDir(async () => {
        const app = await appWhere(INSENSITIVE);

        const result = await callTool(app, "prepare_upload", { ...target, filenames: HELLO_DEB });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe(`Invalid argument: Unknown or invalid distro: ${ sent }: "${ component }" cannot be a component, the release has a file of that name`);
    })());
});

describe("Names the server itself writes", () => {
    describe.each([INSENSITIVE, SENSITIVE])("With %j", naming => {
        test.each(["source", "by-hash", "debug", "debian-installer", "binary-amd64"])("The sub-component %s is refused, named", name => withLocalTmpDir(async () => {
            const app = await appWhere(naming);
            const dir = `deb/debian/trixie/main/${ name }`;
            const reason = `Unknown or invalid distro: ${ dir }: "${ name }" cannot be a component, the publish writes that name below a component`;

            for (const res of [
                await uploadFileByPut(app, `/api/v1/upload/${ dir }/${ HELLO_DEB }`, CONTENT),
                await uploadFileByPost(app, `/api/v1/upload/${ dir }`, [{ name: HELLO_DEB, content: CONTENT }]),
            ]) {
                expect(res.status).toBe(400);
                expect(res.body.message).toBe(reason);
            }
            const result = await callTool(app, "prepare_upload", { format: "deb", distribution: "debian", release: "trixie", component: "main", subcomponent: name, filenames: HELLO_DEB });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toBe(`Invalid argument: ${ reason }`);
            await expectNothingStaged();
        })());

        test("The first-level component debug is refused too, a rebuild could not read it", () => withLocalTmpDir(async () => {
            const app = await appWhere(naming);

            const res = await uploadFileByPut(app, `/api/v1/upload/deb/debian/trixie/debug/${ HELLO_DEB }`, CONTENT);

            expect(res.status).toBe(400);
            await expectNothingStaged();
        })());
    });

    test("Where case does not count, the sub-component Source is refused, named as sent", withLocalTmpDir(async () => {
        const app = await appWhere(INSENSITIVE);

        const res = await uploadFileByPut(app, `/api/v1/upload/deb/debian/trixie/main/Source/${ HELLO_DEB }`, CONTENT);

        expect(res.status).toBe(400);
        expect(res.body.message).toContain('"Source" cannot be a component');
        await expectNothingStaged();
    }));
});

describe("Uploads where case counts", () => {
    test.each(DIRECTORIES.map(([dir, , name]) => [dir, name]))("%s stays refused", (dir, name) => withLocalTmpDir(async () => {
        const app = await appWhere(SENSITIVE);

        for (const res of [
            await uploadFileByPut(app, `/api/v1/upload/${ dir }/${ name }`, CONTENT),
            await uploadFileByPost(app, `/api/v1/upload/${ dir }`, [{ name, content: CONTENT }]),
        ]) {
            expect(res.status).toBe(400);
            expect(res.body.message).toBe(`Unknown or invalid distro: ${ dir }`);
        }
        await expectNothingStaged();
    })());

    test("A component named release is allowed", withLocalTmpDir(async () => {
        const app = await appWhere(SENSITIVE);

        expect((await uploadFileByPut(app, `/api/v1/upload/deb/debian/trixie/release/${ HELLO_DEB }`, CONTENT)).status).toBe(201);

        const result = await callTool(app, "prepare_upload", { format: "deb", distribution: "debian", release: "trixie", component: "inrelease", filenames: HELLO_DEB });
        expect(result.isError).toBeFalsy();
    }));
});

describe.each([INSENSITIVE, SENSITIVE])("Uploads with %j", naming => {
    test.each(DIRECTORIES.map(([, stored, name]) => [stored, name]))("%s is stored as it is", (stored, name) => withLocalTmpDir(async () => {
        const app = await appWhere(naming);

        const res = await uploadFileByPut(app, `/api/v1/upload/${ stored }/${ name }`, CONTENT);

        expect(res.status).toBe(201);
        expect(await stagedFiles()).toEqual([`${ stored }/${ name }`]);
    })());

    test.each(["deb/debian/trixie/main/release", "deb/debian/trixie/main/inrelease"])("%s is no file of the release, so it is allowed", dir => withLocalTmpDir(async () => {
        const app = await appWhere(naming);

        expect((await uploadFileByPut(app, `/api/v1/upload/${ dir }/${ HELLO_DEB }`, CONTENT)).status).toBe(201);
        expect((await uploadFileByPost(app, `/api/v1/upload/${ dir }`, [{ name: "srm-zst_3.0-1_amd64.deb", content: CONTENT }])).status).toBe(201);

        expect(await stagedFiles()).toEqual([`${ dir }/${ HELLO_DEB }`, `${ dir }/srm-zst_3.0-1_amd64.deb`]);
    })());

    test.each([
        ["rpm/Fedora_39/42", NETWORK_MANAGER],
        ["rpm/Fedora/F42", NETWORK_MANAGER],
        ["rpm/Fedora/Rawhide", NETWORK_MANAGER],
        ["rpm/%E2%84%AAali/42", NETWORK_MANAGER],
        ["deb/Debian_12/Trixie/Main", HELLO_DEB],
        ["deb/Debian/Trixie_1/Main", HELLO_DEB],
        ["deb/Debian/Trixie/Ma.in", HELLO_DEB],
    ])("%s stays refused by its shape, named as sent", (dir, name) => withLocalTmpDir(async () => {
        const app = await appWhere(naming);

        for (const res of [
            await uploadFileByPut(app, `/api/v1/upload/${ dir }/${ name }`, CONTENT),
            await uploadFileByPost(app, `/api/v1/upload/${ dir }`, [{ name, content: CONTENT }]),
        ]) {
            expect(res.status).toBe(400);
            expect(res.body.message).toBe(`Unknown or invalid distro: ${ decodeURI(dir) }`);
        }
        await expectNothingStaged();
    })());

    test.each<[Record<string, string>, string]>([
        [{ format: "rpm", distribution: "Fedora_39", release: "42" }, "rpm/Fedora_39/42"],
        [{ format: "deb", distribution: "Debian_12", release: "Trixie", component: "Main", subcomponent: "Sub" }, "deb/Debian_12/Trixie/Main/Sub"],
    ])("prepare_upload refuses %j, named as sent", (target, sent) => withLocalTmpDir(async () => {
        const app = await appWhere(naming);

        const result = await callTool(app, "prepare_upload", { ...target, filenames: NETWORK_MANAGER });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe(`Invalid argument: Unknown or invalid distro: ${ sent }`);
    })());
});

describe("prepare_upload", () => {
    const TARGETS: [Record<string, string>, string, string][] = [
        [{ format: "rpm", distribution: "Fedora", release: "44" }, "rpm/fedora/44", NETWORK_MANAGER],
        [{ format: "deb", distribution: "Debian", release: "Trixie", component: "Main" }, "deb/debian/trixie/main", HELLO_DEB],
        [{ format: "deb", distribution: "debian", release: "Bookworm-Security", component: "Updates", subcomponent: "Main" }, "deb/debian/bookworm-security/updates/main", HELLO_DEB],
    ];

    test.each(TARGETS)("Where case does not count %j gets a slot in %s", (target, stored, name) => withLocalTmpDir(async () => {
        const app = await appWhere(INSENSITIVE);

        const result = await callTool(app, "prepare_upload", { ...target, filenames: name });

        expect(result.isError).toBeFalsy();
        const [slot] = result.structuredContent.slots;
        const url = new URL(slot.uploadUrl).pathname;
        expect(slot.filename).toBe(name);
        expect(url).toBe(`/api/v1/upload/${ stored }/${ name }`);
        expect((await uploadFileByPut(app, url, CONTENT)).status).toBe(201);
        expect(await stagedFiles()).toEqual([`${ stored }/${ name }`]);
    })());

    test.each(TARGETS.map(([target, , name]) => [target, name] as const))("Where case counts %j gets none", (target, name) => withLocalTmpDir(async () => {
        const app = await appWhere(SENSITIVE);

        const result = await callTool(app, "prepare_upload", { ...target, filenames: name });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Unknown or invalid distro");
    })());
});

describe("Filters of list and remove", () => {
    const LISTINGS = [
        ["/api/v1/repo/rpm/Fedora/42/srm-hello", FEDORA, RPM_POOL],
        ["/api/v1/repo/-/FEDORA/-/srm-hello", FEDORA, RPM_POOL],
        ["/api/v1/repo/deb/Debian/Trixie/srm-hello/1.0-1", TRIXIE, DEB_POOL],
        ["/api/v1/repo/-/-/TRIXIE/srm-hello", TRIXIE, DEB_POOL],
    ];

    test.each(LISTINGS)("Where case does not count GET %s finds the files", (url, fixtureDir, pool) => withLocalTmpDir(async () => {
        const app = await importedWhere(INSENSITIVE);

        const res = await request(app).get(url);

        expect(res.status).toBe(200);
        expect(pathsOf(res.body.files)).toEqual(await poolPaths(fixtureDir, pool));
    })());

    test.each(LISTINGS.map(([url]) => [url]))("Where case counts GET %s finds no such repository", url => withLocalTmpDir(async () => {
        const app = await importedWhere(SENSITIVE);

        const res = await request(app).get(url);

        expect(res.status).toBe(404);
        expect(res.body.message).toContain("No such repository");
    })());

    test("Where case does not count a listing and a removal matching nothing name the target as sent", withLocalTmpDir(async () => {
        const app = await importedWhere(INSENSITIVE);

        for (const res of [await request(app).get("/api/v1/repo/rpm/Fedora/42/clevis"), await request(app).delete("/api/v1/repo/rpm/Fedora/42/clevis")]) {
            expect(res.status).toBe(200);
            expect(res.body.message).toBe("No packages matched clevis/- in rpm/Fedora/42");
        }
        for (const res of [await request(app).get("/api/v1/repo/deb/Debian/Trixie/clevis/1.0-1"), await request(app).delete("/api/v1/repo/deb/Debian/Trixie/clevis/1.0-1")]) {
            expect(res.status).toBe(200);
            expect(res.body.message).toBe("No packages matched clevis/1.0-1 in deb/Debian/Trixie");
        }
    }));

    test.each([
        ["rpm/Fedora/41", "rpm/Fedora/41"],
        ["deb/Debian/Bookworm", "deb/Debian/Bookworm"],
        ["-/FEDORA/41", "-/FEDORA/41"],
        ["-/Arch/-", "-/Arch/-"],
    ])("Where case does not count a repository not found by REST names %s as sent", (target, sent) => withLocalTmpDir(async () => {
        const app = await importedWhere(INSENSITIVE);

        for (const res of [await request(app).get(`/api/v1/repo/${ target }/srm-hello`), await request(app).delete(`/api/v1/repo/${ target }/srm-hello`)]) {
            expect(res.status).toBe(404);
            expect(res.body.message).toBe(`No such repository ${ sent }`);
        }
    })());

    test.each<[string, Record<string, string>, string]>([
        ["list_package_files", { format: "rpm", distribution: "Fedora", release: "41" }, "rpm/Fedora/41"],
        ["list_package_files", { distribution: "FEDORA", release: "41" }, "-/FEDORA/41"],
        ["remove_package", { format: "deb", distribution: "Debian", release: "Bookworm" }, "deb/Debian/Bookworm"],
        ["remove_package", { distribution: "Arch" }, "-/Arch/-"],
    ])("Where case does not count a repository not found by %s %j is named as sent", (tool, filter, sent) => withLocalTmpDir(async () => {
        const app = await importedWhere(INSENSITIVE);

        const result = await callTool(app, tool, { ...filter, source: "srm-hello" });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe(`Not found: No such repository ${ sent }`);
    })());

    test.each(["list_package_files", "remove_package"])("Where case does not count %s matching nothing names the source as sent", tool => withLocalTmpDir(async () => {
        const app = await importedWhere(INSENSITIVE);

        const result = await callTool(app, tool, { distribution: "Fedora", release: "42", source: "SRM-Hello" });

        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toBe("No packages matched SRM-Hello.");
    })());

    test("Where case does not count a listing that finds something reports the stored paths", withLocalTmpDir(async () => {
        const app = await importedWhere(INSENSITIVE);

        const res = await request(app).get("/api/v1/repo/rpm/Fedora/42/srm-hello");

        expect(res.body.message).toMatch(/^Found /);
        expect(pathsOf(res.body.files)).toEqual(await poolPaths(FEDORA, RPM_POOL));
    }));

    test("Where case does not count the MCP list tools find the repository", withLocalTmpDir(async () => {
        const app = await importedWhere(INSENSITIVE);

        expect((await callTool(app, "list_repositories", { distribution: "Fedora" })).structuredContent.repositories).toEqual([RPM_REPOSITORY]);
        expect((await callTool(app, "list_repositories", { release: "Trixie" })).structuredContent.repositories).toEqual([DEB_REPOSITORY]);
        expect((await callTool(app, "list_source_packages", { distribution: "Debian", release: "TRIXIE" })).structuredContent.packages).toEqual([DEB_PACKAGE]);
        const listed = await callTool(app, "list_package_files", { distribution: "Fedora", release: "42", source: "srm-hello" });
        expect(pathsOf(listed.structuredContent.files)).toEqual(await poolPaths(FEDORA, RPM_POOL));
    }));

    test("Where case counts the MCP list tools stay exact", withLocalTmpDir(async () => {
        const app = await importedWhere(SENSITIVE);

        expect((await callTool(app, "list_repositories", { distribution: "Fedora" })).structuredContent.repositories).toEqual([]);
        expect((await callTool(app, "list_repositories", { distribution: "fedora" })).structuredContent.repositories).toEqual([RPM_REPOSITORY]);
        expect((await callTool(app, "list_source_packages", { distribution: "Debian", release: "TRIXIE" })).structuredContent.packages).toEqual([]);
        expect((await callTool(app, "list_package_files", { distribution: "Fedora", release: "42", source: "srm-hello" })).isError).toBe(true);
    }));

    test("Where case does not count a removal in another spelling removes", withLocalTmpDir(async () => {
        const app = await importedWhere(INSENSITIVE);

        const res = await request(app).delete("/api/v1/repo/rpm/Fedora/42/srm-hello");
        const removed = await callTool(app, "remove_package", { distribution: "DEBIAN", release: "Trixie", source: "srm-hello" });

        expect(res.status).toBe(200);
        expect(pathsOf(res.body.files)).toEqual(await poolPaths(FEDORA, RPM_POOL));
        expect(pathsOf(removed.structuredContent.files)).toEqual(await poolPaths(TRIXIE, DEB_POOL));
        expect((await callTool(app, "list_source_packages", {})).structuredContent.packages).toEqual([]);
    }));

    test("Where case counts a removal in another spelling removes nothing", withLocalTmpDir(async () => {
        const app = await importedWhere(SENSITIVE);

        const res = await request(app).delete("/api/v1/repo/rpm/Fedora/42/srm-hello");
        const removed = await callTool(app, "remove_package", { distribution: "DEBIAN", release: "Trixie", source: "srm-hello" });

        expect(res.status).toBe(404);
        expect(removed.isError).toBe(true);
        expect((await callTool(app, "list_source_packages", {})).structuredContent.packages).toEqual([DEB_PACKAGE, RPM_PACKAGE]);
    }));
});

describe("Browse pages in another spelling", () => {
    const RPM_PAGE = { section: "rpm-fedora-42", instructions: /baseurl=\S+\/rpm\/fedora\/42\n/ };
    const DEB_PAGE = { section: "deb-debian-trixie", instructions: /URIs: \S+\/deb\/debian\nSuites: trixie\nComponents: main\n/ };
    const PAGES: [string, typeof RPM_PAGE][] = [
        ["/rpm/Fedora/42/", RPM_PAGE],
        ["/rpm/FEDORA/", RPM_PAGE],
        ["/RPM/fedora/42/", RPM_PAGE],
        ["/deb/Debian/dists/Trixie/", DEB_PAGE],
        ["/deb/Debian/", DEB_PAGE],
        ["/DEB/DEBIAN/DISTS/TRIXIE/", DEB_PAGE],
    ];

    /** A case-sensitive file system reaches the page only when this spelling exists; on another this changes nothing */
    async function reachable(url: string): Promise<void> {
        await fs.mkdir(osPath.join("repo", ...url.split("/")), { recursive: true });
    }

    test.each(PAGES)("Where case does not count %s shows the install instructions and keeps its breadcrumb", (url, page) => withLocalTmpDir(async () => {
        const app = await importedWhere(INSENSITIVE);
        await reachable(url);

        const res = await request(app).get(url);

        expect(res.status).toBe(200);
        const $ = cheerio.load(res.text);
        expect($("section").attr("id")).toBe(page.section);
        expect($("section pre").text()).toMatch(page.instructions);
        expect($("h1.breadcrumb a").slice(1).map((_, link) => $(link).text()).get()).toEqual(url.split("/").filter(Boolean));
    })());

    test.each(PAGES.map(([url]) => [url]))("Where case counts %s shows none", url => withLocalTmpDir(async () => {
        const app = await importedWhere(SENSITIVE);
        await reachable(url);

        const res = await request(app).get(url);

        expect(res.status).toBe(200);
        expect(cheerio.load(res.text)(".config")).toHaveLength(0);
    })());

    test.each([INSENSITIVE, SENSITIVE])("With %j the lower-case spelling shows them", naming => withLocalTmpDir(async () => {
        const app = await importedWhere(naming);

        for (const [url, section] of [["/rpm/fedora/42/", RPM_PAGE.section], ["/deb/debian/dists/trixie/", DEB_PAGE.section]]) {
            expect(cheerio.load((await request(app).get(url)).text)("section").attr("id")).toBe(section);
        }
    })());

    windowsTest("On this volume another spelling reaches the real pages and files", withLocalTmpDir(async () => {
        const app = await importedWhere(INSENSITIVE);

        for (const [url, section] of [["/rpm/Fedora/42/", RPM_PAGE.section], ["/deb/Debian/dists/Trixie/", DEB_PAGE.section]]) {
            const res = await request(app).get(url);
            expect(res.status).toBe(200);
            expect(cheerio.load(res.text)("section").attr("id")).toBe(section);
        }
        const redirect = await request(app).get("/rpm/Fedora/42");
        expect(redirect.status).toBe(301);
        expect(redirect.headers.location).toBe("/rpm/Fedora/42/");

        const file = await request(app).get(`/rpm/Fedora/42/Packages/s/srm-hello/${ HELLO_RPM }`);
        expect(file.status).toBe(200);
        expect(Number(file.headers["content-length"])).toBe((await readFixture(`${ FEDORA }/${ HELLO_RPM }`)).length);
        expect((await request(app).get("/deb/Debian/dists/Trixie/Release")).status).toBe(200);

        expect(await fs.readdir(osPath.join("repo", "rpm"))).toEqual(["fedora"]);
        expect(await fs.readdir(osPath.join("repo", "deb"))).toEqual(["debian"]);
    }));
});
