import * as cheerio from "cheerio";
import { createFiles, sendRawHttp, uploadFileByPost, uploadFileByPut, withLocalTmpDir } from "../utils.ts";
import { importFixtures } from "../fixture-upload.ts";
import createTestApp from "../testapp.ts";
import { resetFileNaming, setFileNaming } from "../../server/lib/file-naming.ts";
import { jest } from "@jest/globals";
import type { Application } from "express";
import fsNode from "node:fs";
import fs from "node:fs/promises";
import osPath from "path";
import request from "supertest";
import { fileURLToPath } from "url";

const windows = process.platform === "win32";
const windowsTest = windows ? test : test.skip;
const notWindowsTest = windows ? test.skip : test;

const CONTENT = Buffer.from("Hello World");

/** A request sent byte for byte: an HTTP client would normalize the dots and slashes away */
async function rawRequest(app: Application, url: string): Promise<{ status: number; head: string; body: string }> {
    const server = app.listen(0);
    try {
        const response = await sendRawHttp(server, { headers: `GET ${ url } HTTP/1.1\nHost: localhost\n\n` });
        const end = response.indexOf("\r\n\r\n");
        return { status: Number(response.split(" ")[1]), head: response.slice(0, end), body: response.slice(end + 4) };
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

async function rawGet(app: Application, url: string): Promise<number> {
    return (await rawRequest(app, url)).status;
}

async function repoApp(): Promise<Application> {
    await createFiles({
        "repo/deb/debian/dists/trixie/Release": "Version: 1.0",
        "repo/rpm/fedora/42/repodata/repomd.xml": "<repomd/>",
        "outside.txt": "secret",
    });
    return createTestApp({ paths: { repoDir: "repo" } });
}

/** The status of the URL, with what it did on the disk */
async function statted(app: Application, url: string): Promise<{ status: number; touched: number }> {
    const stat = jest.spyOn(fsNode, "stat");
    try {
        const status = await rawGet(app, url);
        return { status, touched: stat.mock.calls.length };
    } finally {
        stat.mockRestore();
    }
}

async function stagedFiles(): Promise<string[]> {
    const entries = await fs.readdir(osPath.join("incoming", "staging"), { recursive: true, withFileTypes: true });
    return entries.filter(entry => entry.isFile()).map(entry => entry.name);
}

async function uploadApp(): Promise<Application> {
    return createTestApp({ paths: { incomingDir: "incoming" } });
}

async function expectNothingLeft(): Promise<void> {
    expect(await stagedFiles()).toEqual([]);
    expect(await fs.readdir(osPath.join("incoming", "tmp"))).toEqual([]);
}

describe("Test URL paths on the file server", () => {
    test("Real paths are served and do reach the disk", withLocalTmpDir(async () => {
        const app = await repoApp();
        for (const url of ["/", "/deb/", "/deb/debian/dists/trixie/", "/deb/debian/dists/trixie/Release"]) {
            const { status, touched } = await statted(app, url);
            expect({ url, status }).toEqual({ url, status: 200 });
            expect(touched).toBeGreaterThan(0);
        }
    }));

    test.each([
        ["//deb/debian/dists/trixie/Release", "/deb/debian/dists/trixie/Release"],
        ["/deb//debian/dists/trixie/Release", "/deb/debian/dists/trixie/Release"],
        ["///deb///debian///dists///trixie///Release", "/deb/debian/dists/trixie/Release"],
        ["/rpm//fedora/42/repodata/repomd.xml", "/rpm/fedora/42/repodata/repomd.xml"],
    ])("%s serves the file of %s", (url, single) => withLocalTmpDir(async () => {
        const app = await repoApp();
        const { status, body } = await rawRequest(app, single);
        expect(status).toBe(200);
        expect(body.length).toBeGreaterThan(0);

        expect(await rawRequest(app, url)).toEqual(expect.objectContaining({ status: 200, body }));
    })());

    test.each(["//", "//deb/", "/deb//", "/deb//debian/", "//rpm//fedora/42/"])("%s lists the directory a single slash names", url => withLocalTmpDir(async () => {
        const app = await repoApp();
        expect(await rawGet(app, url)).toBe(200);
    })());

    test.each([["//deb", "/deb/"], ["/deb//debian", "/deb//debian/"]])("%s redirects to %s, never to another host", (url, location) => withLocalTmpDir(async () => {
        const app = await repoApp();
        const { status, head } = await rawRequest(app, url);
        expect(status).toBe(301);
        expect(head).toContain(`\r\nLocation: ${ location }\r\n`);
    })());

    test.each(["//..//..//outside.txt", "/deb//..//..//outside.txt", "//C:/Windows/win.ini", "//localhost/c$/Windows/win.ini", "//localhost/c$/outside.txt"])("%s escapes nothing", url => withLocalTmpDir(async () => {
        const app = await repoApp();
        const { status, body } = await rawRequest(app, url);
        expect(status).toBe(404);
        expect(body).not.toContain("secret");
    })());

    test.each(["//rpm/fedora/42/", "/rpm//fedora/42/", "/rpm/fedora//42/"])("The browse page of %s shows the install instructions and the breadcrumb of one slash", url => withLocalTmpDir(async () => {
        const app = await createTestApp();
        await importFixtures(app, "packages/rpm/fedora/42");

        const { status, body } = await rawRequest(app, url);

        expect(status).toBe(200);
        const $ = cheerio.load(body);
        expect($("title").text()).toBe("Listing /rpm/fedora/42");
        expect($("section").attr("id")).toBe("rpm-fedora-42");
        expect($("h1.breadcrumb a").slice(1).map((_, link) => $(link).attr("href")).get()).toEqual(["/rpm/", "/rpm/fedora/", "/rpm/fedora/42/"]);
    })());

    test.each(["/..", "/../", "/../outside.txt", "/deb/../../outside.txt", "/deb/../rpm/", "/deb/..", "/.", "/./", "/./deb/", "/deb/./", "/deb/.", "/...", "/.../", "/deb/...", "/deb/.../x", "/....", "//..//..//outside.txt", "/deb//..//..//outside.txt", "//.", "//deb/..",
        "/..%5Coutside.txt", "/..%5C..%5Coutside.txt", "/deb%5Cdebian/", "/%5C%5Cserver%5Cshare/", "/%5C%5C%3F%5CC:%5CWindows/", "/C:%5CWindows/", "/..%2Foutside.txt", "/deb/..%2F..%2Foutside.txt",
        "/%2E%2E/outside.txt", "/%2e%2e%2foutside.txt", "/deb/%00", "/deb/debian/dists/trixie/Release%00", "/deb/debian/dists/trixie/Release%00.txt", "/deb/%0A", "/deb/%7F", "/deb/debian/dists/trixie/Release%C2%85",
    ])("%s answers 404 on any OS before touching the disk", url => withLocalTmpDir(async () => {
        const app = await repoApp();
        expect(await statted(app, url)).toEqual({ status: 404, touched: 0 });
    })());

    const TRIXIE = "/deb/debian/dists/trixie";

    windowsTest.each([`${ TRIXIE }/Release::$DATA`, `${ TRIXIE }/Release:$DATA`, `${ TRIXIE }/Release:stream`, `${ TRIXIE }/Release.`, `${ TRIXIE }/Release...`, `${ TRIXIE }/Release%20`, `${ TRIXIE }/Release.%20`,
        `${ TRIXIE }/con`, `${ TRIXIE }/CON`, `${ TRIXIE }/con.`, `${ TRIXIE }/con%20`, `${ TRIXIE }/con.txt.`, `${ TRIXIE }/NuL`, `${ TRIXIE }/com1`, `${ TRIXIE }/lpt%C2%B9`, `${ TRIXIE }/conin$`, "/aux/", "/con/x",
        "/.env::$DATA", `${ TRIXIE }/RELEAS~1`, `${ TRIXIE }/FOO~1.RPM`, "/git~1", "/git~1/", "/HIDDEN~1/secret.txt",
        "/C:", "/C:/", "/C:/Windows", `${ TRIXIE }/a:b`, `${ TRIXIE }/a%3Ab`, `${ TRIXIE }/a%3Fb`, `${ TRIXIE }/a*b`, `${ TRIXIE }/a%3Cb`, `${ TRIXIE }/a%3Eb`, `${ TRIXIE }/a%7Cb`, `${ TRIXIE }/a%22b`,
    ])("%s answers 404 on Windows before touching the disk", url => withLocalTmpDir(async () => {
        const app = await repoApp();
        expect(await statted(app, url)).toEqual({ status: 404, touched: 0 });
    })());

    test("A segment over the length limit answers 404 before touching the disk", withLocalTmpDir(async () => {
        const app = await repoApp();
        expect(await statted(app, `/deb/${ "a".repeat(241) }`)).toEqual({ status: 404, touched: 0 });
    }));

    windowsTest("A stream, a short name and a trailing dot answer 404 before the disk, although they would open the file", withLocalTmpDir(async () => {
        await createFiles({
            "repo/.env": "secret",
            "repo/.hidden-directory/secret.txt": "secret",
            "repo/deb/debian/dists/trixie/Release-with-a-long-name": "long",
        });
        const app = await repoApp();
        expect(await fs.readFile("repo/.env::$DATA", "utf8")).toBe("secret");

        expect(await statted(app, "/.env::$DATA")).toEqual({ status: 404, touched: 0 });
        expect(await statted(app, `${ TRIXIE }/RELEAS~1`)).toEqual({ status: 404, touched: 0 });
        expect(await statted(app, `${ TRIXIE }/Release.`)).toEqual({ status: 404, touched: 0 });
        expect(await statted(app, "/HIDDEN~1/secret.txt")).toEqual({ status: 404, touched: 0 });

        expect(await rawGet(app, `${ TRIXIE }/Release`)).toBe(200);
        expect(await rawGet(app, `${ TRIXIE }/Release-with-a-long-name`)).toBe(200);
    }));

    test("A real name with a tilde is served on any OS", withLocalTmpDir(async () => {
        const names = ["srm-hello_1.0~1_amd64.deb", "clevis_22~rc1-1_amd64.deb", "abcdefg~1"];
        await createFiles(Object.fromEntries(names.map(name => [`repo/deb/${ name }`, "x"])));
        const app = await repoApp();
        for (const name of names) {
            expect({ name, status: await rawGet(app, `/deb/${ name }`) }).toEqual({ name, status: 200 });
        }
    }));

    test("A device name with an extension is served on any OS", withLocalTmpDir(async () => {
        const names = ["con.tar.gz", "CON.txt", "aux.deb", "nul.txt", "com1.rpm", "lpt1.a.b"];
        await createFiles(Object.fromEntries(names.map(name => [`repo/deb/${ name }`, "x"])));
        const app = await repoApp();
        for (const name of names) {
            expect({ name, status: await rawGet(app, `/deb/${ name }`) }).toEqual({ name, status: 200 });
        }
    }));

    test("Malformed percent-encoding answers 404 before touching the disk", withLocalTmpDir(async () => {
        const app = await repoApp();
        expect(await statted(app, "/%E0%A4%A")).toEqual({ status: 404, touched: 0 });
    }));

    windowsTest("A case alias stays on Windows, the files are public", withLocalTmpDir(async () => {
        const app = await repoApp();
        expect(await rawGet(app, `${ TRIXIE }/RELEASE`)).toBe(200);
    }));

    notWindowsTest("Off Windows, what only Windows refuses is a name like any", withLocalTmpDir(async () => {
        await createFiles({ "repo/deb/a:b.deb": "x", "repo/deb/con": "x", "repo/deb/dot.": "x" });
        const app = await repoApp();
        for (const url of ["/deb/a:b.deb", "/deb/a%3Ab.deb", "/deb/con", "/deb/dot."]) {
            expect({ url, status: await rawGet(app, url) }).toEqual({ url, status: 200 });
        }
    }));
});

describe("Test names at upload", () => {
    const WITH_EXTENSION = [...["con.deb", "aux.tar.gz", "nul.changes", "com1.dsc", "lpt9.buildinfo", "prn.ddeb", "com0.udeb"].map(name => ["deb/debian/trixie/main", name]),
        ...["CON.rpm", "Aux.src.rpm", "nul.x86_64.rpm", "LPT1.rpm"].map(name => ["rpm/fedora/42", name])];
    // Only a name the .tar.* rule lets through can reach the Windows check at all
    const WINDOWS_REFUSED = [["x.tar.a:b", "x.tar.a:b"], ["x.tar.a%3Fb", "x.tar.a?b"], ["x.tar.a%20", "x.tar.a "], ["x.tar.a*", "x.tar.a*"]];
    const SHORT_NAMES = ["foo~1.deb", "git~1.dsc", "a~12.deb"];
    const TARGETS = ["deb/aux/trixie/main", "deb/debian/con/main", "deb/debian/trixie/nul", "deb/debian/trixie/com1", "deb/debian/trixie/main/lpt1", "rpm/prn/42"];

    /** On Windows a 400 that says why and no file; elsewhere the upload goes through as before */
    async function expectRefusedOnWindowsOnly(res: { status: number; body: { message: string } }, name: string, problem: string): Promise<void> {
        if (windows) {
            expect(res.status).toBe(400);
            expect(res.body.message).toContain(problem);
            await expectNothingLeft();
        } else {
            expect(res.status).toBe(201);
            expect(await stagedFiles()).toEqual([name]);
        }
    }

    test.each(WITH_EXTENSION)("PUT to %s of %s goes through on any OS", (target, name) => withLocalTmpDir(async () => {
        const res = await uploadFileByPut(await uploadApp(), `/api/v1/upload/${ target }/${ name }`, CONTENT);
        expect(res.status).toBe(201);
        expect(await stagedFiles()).toEqual([name]);
    })());

    test.each(WITH_EXTENSION)("POST to %s of %s goes through on any OS", (target, name) => withLocalTmpDir(async () => {
        const res = await uploadFileByPost(await uploadApp(), `/api/v1/upload/${ target }`, [{ name, content: CONTENT }]);
        expect(res.status).toBe(201);
        expect(await stagedFiles()).toEqual([name]);
    })());

    const REFUSED_CHARACTERS = "holds a character or an ending that Windows refuses in a file name";

    test.each(WINDOWS_REFUSED)("PUT of %s is refused on Windows only", (encoded, name) => withLocalTmpDir(async () => {
        const res = await uploadFileByPut(await uploadApp(), `/api/v1/upload/deb/debian/trixie/main/${ encoded }`, CONTENT);
        await expectRefusedOnWindowsOnly(res, name, `${ JSON.stringify(name) } ${ REFUSED_CHARACTERS }`);
    })());

    test.each(WINDOWS_REFUSED)("POST of %s is refused on Windows only", (_, name) => withLocalTmpDir(async () => {
        const res = await uploadFileByPost(await uploadApp(), "/api/v1/upload/deb/debian/trixie/main", [{ name, content: CONTENT }]);
        await expectRefusedOnWindowsOnly(res, name, `${ JSON.stringify(name) } ${ REFUSED_CHARACTERS }`);
    })());

    test.each(SHORT_NAMES)("PUT of %s is refused on Windows only", name => withLocalTmpDir(async () => {
        const res = await uploadFileByPut(await uploadApp(), `/api/v1/upload/deb/debian/trixie/main/${ name }`, CONTENT);
        await expectRefusedOnWindowsOnly(res, name, `${ JSON.stringify(name) } has the shape of a Windows 8.3 short name`);
    })());

    test.each(SHORT_NAMES)("POST of %s is refused on Windows only", name => withLocalTmpDir(async () => {
        const res = await uploadFileByPost(await uploadApp(), "/api/v1/upload/deb/debian/trixie/main", [{ name, content: CONTENT }]);
        await expectRefusedOnWindowsOnly(res, name, `${ JSON.stringify(name) } has the shape of a Windows 8.3 short name`);
    })());

    const reservedIn = (target: string): string => `"${ target.split("/").find(s => /^(aux|con|nul|com1|lpt1|prn)$/.test(s)) as string }" is a reserved name on Windows`;

    test.each(TARGETS)("PUT to %s is refused on Windows only", target => withLocalTmpDir(async () => {
        const name = target.startsWith("rpm") ? "x.rpm" : "x.deb";
        const res = await uploadFileByPut(await uploadApp(), `/api/v1/upload/${ target }/${ name }`, CONTENT);
        await expectRefusedOnWindowsOnly(res, name, reservedIn(target));
    })());

    test.each(TARGETS)("POST to %s is refused on Windows only", target => withLocalTmpDir(async () => {
        const name = target.startsWith("rpm") ? "x.rpm" : "x.deb";
        const res = await uploadFileByPost(await uploadApp(), `/api/v1/upload/${ target }`, [{ name, content: CONTENT }]);
        await expectRefusedOnWindowsOnly(res, name, reservedIn(target));
    })());

    windowsTest("A POST keeps the good files of a batch and names the refused one", withLocalTmpDir(async () => {
        const res = await uploadFileByPost(await uploadApp(), "/api/v1/upload/deb/debian/trixie/main",
            [{ name: "good.deb", content: CONTENT }, { name: "x.tar.a:b", content: CONTENT }]);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(`One or more files failed to upload: Invalid filename: x.tar.a:b: "x.tar.a:b" ${ REFUSED_CHARACTERS }`);
        expect(res.body.files).toEqual([
            { filename: "good.deb", path: "deb/debian/trixie/main/good.deb", status: "ok" },
            { filename: "x.tar.a:b", path: "deb/debian/trixie/main/x.tar.a:b", status: "failed" },
        ]);
        expect(await stagedFiles()).toEqual(["good.deb"]);
        expect(await fs.readdir(osPath.join("incoming", "tmp"))).toEqual([]);
    }));

    // The .tar.* rule of the shape check takes anything but a dot
    test.each(["x.tar.a%5Cb", "x.tar.a%2Fb", "x.tar.%2E%2E%2F%2E%2E%2Fb", "x.tar.a%00", "x.tar.a%0Ab", "..%5Cevil.deb", "x.tar.%5C%5Cserver%5Cshare"])(
        "PUT of %s is refused on any OS", name => withLocalTmpDir(async () => {
            const res = await uploadFileByPut(await uploadApp(), `/api/v1/upload/deb/debian/trixie/main/${ name }`, CONTENT);
            expect(res.status).toBe(400);
            await expectNothingLeft();
        })());

    test.each(["deb/..%5Cdebian/trixie/main", "deb/C:/trixie/main", "deb/debian/%5C%5Cserver/main", "deb/debian/trixie/%00"])(
        "An upload to %s is refused on any OS", target => withLocalTmpDir(async () => {
            const app = await uploadApp();
            expect((await uploadFileByPut(app, `/api/v1/upload/${ target }/x.deb`, CONTENT)).status).toBe(400);
            expect((await uploadFileByPost(app, `/api/v1/upload/${ target }`, [{ name: "x.deb", content: CONTENT }])).status).toBe(400);
            await expectNothingLeft();
        })());

    test("A name that ends in a dot leaves no temp file behind a POST", withLocalTmpDir(async () => {
        const res = await uploadFileByPost(await uploadApp(), "/api/v1/upload/deb/debian/trixie/main", [{ name: "x.deb.", content: CONTENT }]);
        expect(res.status).toBe(400);
        await expectNothingLeft();
    }));

    const BIN = "srm-hello-1.0-1.fc42.x86_64.rpm";
    const BIN_IN_OTHER_CASE = "SRM-hello-1.0-1.fc42.x86_64.rpm";
    const RPM_TARGET = "rpm/fedora/42";
    const OTHER_CONTENT = Buffer.from("Other content, shorter or longer than none");
    const CONTENTS: Record<string, Buffer> = { [BIN]: CONTENT, [BIN_IN_OTHER_CASE]: OTHER_CONTENT };

    function conflictOf(name: string, other: string): string {
        return `${ RPM_TARGET }/${ name } differs only in case from ${ RPM_TARGET }/${ other }, which this file system cannot keep apart`;
    }

    /** The one staged file holds exactly the content of its own upload */
    async function expectStagedIntact(name: string): Promise<void> {
        expect(await stagedFiles()).toEqual([name]);
        expect(await fs.readFile(osPath.join("incoming", "staging", ...RPM_TARGET.split("/"), name))).toEqual(CONTENTS[name]);
        expect(await fs.readdir(osPath.join("incoming", "tmp"))).toEqual([]);
    }

    windowsTest("One POST of two names differing only in case stages one intact and refuses the other", withLocalTmpDir(async () => {
        const res = await uploadFileByPost(await uploadApp(), `/api/v1/upload/${ RPM_TARGET }`,
            [{ name: BIN, content: CONTENT }, { name: BIN_IN_OTHER_CASE, content: OTHER_CONTENT }]);

        expect(res.status).toBe(400);
        const files = res.body.files as { filename: string; status: string }[];
        const accepted = files.find(file => file.status === "ok")!.filename;
        const refused = files.find(file => file.status === "failed")!.filename;
        expect([accepted, refused].sort()).toEqual([BIN_IN_OTHER_CASE, BIN]);
        expect(res.body.message).toBe(`One or more files failed to upload: ${ conflictOf(refused, accepted) }`);
        await expectStagedIntact(accepted);
    }));

    windowsTest.each<[string, (app: Application) => Promise<{ status: number; body: { message: string } }>, string]>([
        ["PUT", app => uploadFileByPut(app, `/api/v1/upload/${ RPM_TARGET }/${ BIN_IN_OTHER_CASE }`, OTHER_CONTENT), conflictOf(BIN_IN_OTHER_CASE, BIN)],
        ["POST", app => uploadFileByPost(app, `/api/v1/upload/${ RPM_TARGET }`, [{ name: BIN_IN_OTHER_CASE, content: OTHER_CONTENT }]), `One or more files failed to upload: ${ conflictOf(BIN_IN_OTHER_CASE, BIN) }`],
    ])("A later %s differing only in case from a staged file is refused and the file stays", (_, upload, message) => withLocalTmpDir(async () => {
        const app = await uploadApp();
        expect((await uploadFileByPut(app, `/api/v1/upload/${ RPM_TARGET }/${ BIN }`, CONTENT)).status).toBe(201);

        const res = await upload(app);

        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
        await expectStagedIntact(BIN);
    })());

    windowsTest("Concurrent uploads of two names differing only in case leave one intact", withLocalTmpDir(async () => {
        const app = await uploadApp();
        const names = [BIN, BIN_IN_OTHER_CASE];

        const responses = await Promise.all(names.map(name => uploadFileByPut(app, `/api/v1/upload/${ RPM_TARGET }/${ name }`, CONTENTS[name])));

        expect(responses.map(res => res.status).sort()).toEqual([201, 400]);
        await expectStagedIntact(names[responses.findIndex(res => res.status === 201)]);
    }));

    windowsTest("A refused file waiting for the next import is replaced by an upload under the existing name", withLocalTmpDir(async () => {
        const app = await createTestApp({ paths: { incomingDir: "incoming", repoDir: "repo", repoStateDir: "repo-state" } });
        const content = await fs.readFile(fileURLToPath(new URL(`../fixtures/packages/${ RPM_TARGET }/${ BIN }`, import.meta.url)));
        const mcpImport = async (): Promise<{ status: string; filename: string }[]> => (await request(app).post("/api/v1/mcp")
            .set("Content-Type", "application/json").set("Accept", "application/json, text/event-stream")
            .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "import_repository", arguments: {} } })).body.result.structuredContent.files;
        expect((await uploadFileByPut(app, `/api/v1/upload/${ RPM_TARGET }/${ BIN }`, content)).status).toBe(201);
        expect((await mcpImport()).map(file => file.status)).toEqual(["ok"]);
        expect((await uploadFileByPut(app, `/api/v1/upload/${ RPM_TARGET }/${ BIN_IN_OTHER_CASE }`, content)).status).toBe(201);
        expect((await mcpImport()).map(file => file.status)).toEqual(["failed"]);

        expect((await uploadFileByPut(app, `/api/v1/upload/${ RPM_TARGET }/${ BIN }`, content)).status).toBe(201);

        expect(await mcpImport()).toEqual([expect.objectContaining({ filename: BIN, status: "ok" })]);
        expect(await fs.readdir(osPath.join("incoming", "process", "rpm"))).toEqual([]);
    }));

    notWindowsTest("Off Windows two names differing only in case are both staged", withLocalTmpDir(async () => {
        const res = await uploadFileByPost(await uploadApp(), `/api/v1/upload/${ RPM_TARGET }`,
            [{ name: BIN, content: CONTENT }, { name: BIN_IN_OTHER_CASE, content: OTHER_CONTENT }]);

        expect(res.status).toBe(201);
        expect((await stagedFiles()).sort()).toEqual([BIN_IN_OTHER_CASE, BIN]);
    }));

    test("Real names go through", withLocalTmpDir(async () => {
        const names = ["clevis_21-1+tpm1u8+deb12.dsc", "clevis_22~rc1-1_amd64.deb", "srm-hello_1.0~1_amd64.deb", "console_1.0-1_all.deb", "aux_1.0-1_all.deb", "con-tools_1.0.orig.tar.gz"];
        const app = await uploadApp();
        for (const name of names) {
            expect((await uploadFileByPut(app, `/api/v1/upload/deb/debian/trixie/main/${ name }`, CONTENT)).status).toBe(201);
        }
        expect((await stagedFiles()).sort()).toEqual([...names].sort());
    }));
});

describe("Test the 8.3 rule according to the file naming", () => {
    afterEach(resetFileNaming);

    const MAIN = "deb/debian/trixie/main";
    const REAL = "srm-hello_1.0-1_amd64.deb";
    const REAL_SHORT = "SRM-HE~1.DEB";
    const POOL = "deb/debian/pool/main/s/srm-hello";

    const problemOf = (name: string): string => `${ JSON.stringify(name) } has the shape of a Windows 8.3 short name`;

    test("Turned on, on any OS, a URL answers 404 before the disk and an upload is refused", withLocalTmpDir(async () => {
        const app = await createTestApp({ fileNaming: { shortNames: true } });
        await createFiles({ "repo/deb/git~1": "x" });

        expect(await statted(app, "/deb/git~1")).toEqual({ status: 404, touched: 0 });

        for (const res of [
            await uploadFileByPut(app, `/api/v1/upload/${ MAIN }/foo~1.deb`, CONTENT),
            await uploadFileByPost(app, `/api/v1/upload/${ MAIN }`, [{ name: "foo~1.deb", content: CONTENT }]),
        ]) {
            expect(res.status).toBe(400);
            expect(res.body.message).toContain(problemOf("foo~1.deb"));
        }
        await expectNothingLeft();
    }));

    test("Turned off, on any OS, the same names are served and uploaded", withLocalTmpDir(async () => {
        const app = await createTestApp({ fileNaming: { shortNames: false } });
        await createFiles({ "repo/deb/git~1": "x" });

        expect(await rawGet(app, "/deb/git~1")).toBe(200);

        expect((await uploadFileByPut(app, `/api/v1/upload/${ MAIN }/foo~1.deb`, CONTENT)).status).toBe(201);
        expect((await uploadFileByPost(app, `/api/v1/upload/${ MAIN }`, [{ name: "git~1.dsc", content: CONTENT }])).status).toBe(201);
        expect((await stagedFiles()).sort()).toEqual(["foo~1.deb", "git~1.dsc"]);
    }));

    test.each([true, false])("With short names %s the names of a real bundle go through", shortNames => withLocalTmpDir(async () => {
        const names = await fs.readdir(fileURLToPath(new URL(`../fixtures/packages/${ MAIN }/`, import.meta.url)));
        expect(names).toContain(REAL);
        const app = await createTestApp({ fileNaming: { shortNames } });

        for (const name of names) {
            expect({ name, status: (await uploadFileByPut(app, `/api/v1/upload/${ MAIN }/${ name }`, CONTENT)).status }).toEqual({ name, status: 201 });
        }

        expect((await stagedFiles()).sort()).toEqual([...names].sort());
    })());

    test("It holds before the backend opens: a rebuild at the start checks names under it", withLocalTmpDir(async () => {
        await createFiles({ "repo/deb/git~1": "x" });

        await expect(createTestApp({ fileNaming: { shortNames: true } })).rejects.toThrow("Rebuild found 1 problem(s) in the published tree");

        await createTestApp({ fileNaming: { shortNames: false } });
    }));

    windowsTest("On this volume a URL with the short name of a real file answers according to the state", withLocalTmpDir(async () => {
        const app = await createTestApp({ fileNaming: { shortNames: true } });
        await createFiles({ [`repo/${ POOL }/${ REAL }`]: "x" });
        // A volume with 8.3 names off generates none
        const aliasWorks = await fs.access(`repo/${ POOL }/${ REAL_SHORT }`).then(() => true, () => false);

        expect(await statted(app, `/${ POOL }/${ REAL_SHORT }`)).toEqual({ status: 404, touched: 0 });

        setFileNaming({ caseSensitive: false, shortNames: false });
        expect(await rawGet(app, `/${ POOL }/${ REAL_SHORT }`)).toBe(aliasWorks ? 200 : 404);
    }));

    windowsTest("On this volume an upload with the short name of a real file is refused or accepted according to the state", withLocalTmpDir(async () => {
        const app = await createTestApp({ fileNaming: { shortNames: true } });
        const staged = (name: string): string => osPath.join("incoming", "staging", ...MAIN.split("/"), name);
        const alias = REAL_SHORT.toLowerCase();
        const other = Buffer.from("Other content");
        expect((await uploadFileByPut(app, `/api/v1/upload/${ MAIN }/${ REAL }`, CONTENT)).status).toBe(201);

        const refused = await uploadFileByPut(app, `/api/v1/upload/${ MAIN }/${ alias }`, other);

        expect(refused.status).toBe(400);
        expect(refused.body.message).toContain(problemOf(alias));
        expect(await fs.readFile(staged(REAL))).toEqual(CONTENT);

        setFileNaming({ caseSensitive: false, shortNames: false });
        const accepted = await uploadFileByPut(app, `/api/v1/upload/${ MAIN }/${ alias }`, other);

        expect(accepted.status).toBe(201);
        expect(await fs.readFile(staged(alias))).toEqual(other);
    }));
});
