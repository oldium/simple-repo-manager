// noinspection DuplicatedCode,JSJQueryEfficiency

import { createFiles, sendRawHttp, uploadFileByPost, withLocalTmpDir } from "../utils.ts";
import createTestApp from "../testapp.ts";
import request from "supertest";
import * as cheerio from "cheerio";
import dedent from "dedent";
import net from "net";
import type { Application } from "express";
import fs from "node:fs/promises";
import osPath from "path";
import { fileURLToPath } from "url";
import { jest } from "@jest/globals";
import logger from "../../server/lib/logger.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/packages/", import.meta.url));

async function uploadBundle(app: Application, dir: string, target = dir) {
    const names = await fs.readdir(osPath.join(FIXTURES, dir));
    const files = await Promise.all(names.map(async name => ({ name, content: await fs.readFile(osPath.join(FIXTURES, dir, name)) })));
    expect((await uploadFileByPost(app, `/api/v1/upload/${ target }`, files)).status).toBe(201);
}

describe("Test of files reading API", () => {
    test("A repository file cannot run as a page of this origin", withLocalTmpDir(async () => {
        await createFiles({ "repo/deb/debian/pool/main/e/evil/evil_1.tar.html": "<script>alert(1)</script>" });
        const app = await createTestApp({ paths: { repoDir: "repo" } });

        const res = await request(app).get("/deb/debian/pool/main/e/evil/evil_1.tar.html");

        expect(res.status).toBe(200);
        expect(res.headers["content-security-policy"]).toBe("sandbox");
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
    }));

    test("Check that directories are read correctly", withLocalTmpDir(async () => {
        // noinspection SpellCheckingInspection
        await createFiles({
            "repo/deb/debian/dists/bookworm/Release": "",
            "repo/rpm/centos/10/repodata/repomd.xml": "",
        });

        const app = await createTestApp({
            paths: {
                repoDir: "repo",
            }
        });

        const res = await request(app).get("/");
        expect(res.status).toBe(200);

        const $ = cheerio.load(res.text);
        expect($('li')).toHaveLength(2);
        expect($('li').eq(0).find('span.name').text()).toBe("deb");
        expect($('li').eq(1).find('span.name').text()).toBe("rpm");
    }));

    test("Check that an empty repository shows the empty page", withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                repoDir: "repo",
            }
        });

        const res = await request(app).get("/");
        expect(res.status).toBe(200);

        const $ = cheerio.load(res.text);
        expect($('li')).toHaveLength(0);
        expect($('.view-empty .title').text()).toBe("The repository is empty");
    }));

    test("Home page lists configs for imported fixtures", withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                repoDir: "repo",
            }
        });
        await uploadBundle(app, "deb/debian/trixie/main");
        await uploadBundle(app, "deb/debian/trixie/main", "deb/debian/trixie/main/sub");
        await uploadBundle(app, "rpm/fedora/42");
        expect((await request(app).post("/api/v1/repo/import")).status).toBe(200);

        const res = await request(app).get("/");
        expect(res.status).toBe(200);

        const $ = cheerio.load(res.text);
        expect($('a[href="#cfg:deb-debian-trixie"]')).toHaveLength(1);
        expect($('a[href="#cfg:rpm-fedora-42"]')).toHaveLength(1);
        const debConfig = $("section#deb-debian-trixie pre").text();
        expect(debConfig).toContain("Components: main main/sub");
        expect(debConfig).toMatch(/^URIs: http:\/\/127\.0\.0\.1:\d+\/deb\/debian$/m);
    }));

    test("A configured but missing key file writes no keyring and warns once", withLocalTmpDir(async () => {
        const warnSpy = jest.spyOn(logger, "warn");
        try {
            await createTestApp({
                paths: {
                    repoDir: "repo",
                },
                gpg: {
                    gpgRepoPrivateKeyFile: "missing-key.asc",
                }
            });

            expect(osPath.join("repo", "deb", "archive-keyring.asc")).not.toPathExist();
            expect(osPath.join("repo", "rpm", "RPM-GPG-KEY.asc")).not.toPathExist();
            expect(warnSpy.mock.calls.filter(([message]) => message === "GPG key file missing-key.asc does not exist.")).toHaveLength(1);
        } finally {
            warnSpy.mockRestore();
        }
    }));

    test("Check that directories with files are read correctly", withLocalTmpDir(async () => {
        await createFiles({
            "repo/deb/debian/dists/bookworm/Release": "",
            "repo/deb/debian/dists/bookworm/main/source/Release": "",
        });

        const app = await createTestApp({
            paths: {
                repoDir: "repo",
            }
        });

        const res = await request(app).get("/deb/debian/dists/bookworm/");
        expect(res.status).toBe(200);

        const $ = cheerio.load(res.text);
        expect($('li')).toHaveLength(3);
        expect($('li').eq(0).find('span.icon').attr("class")).toStartWith("icon icon-directory icon-up");
        expect($('li').eq(0).find('span.name').text()).toBe("..");
        expect($('li').eq(1).find('span.icon').attr("class")).toStartWith("icon icon-directory");
        expect($('li').eq(1).find('span.name').text()).toBe("main");
        expect($('li').eq(2).find('span.icon').attr("class")).toStartWith("icon icon-file");
        expect($('li').eq(2).find('span.name').text()).toBe("Release");
    }));

    test("Check that file is read correctly", withLocalTmpDir(async () => {
        // noinspection SpellCheckingInspection
        await createFiles({
            "repo/deb/debian/dists/bookworm/Release": "Version: 1.0",
            "repo/rpm/centos/10/repodata/old-primary.xml": "<metadata/>",
        });

        const app = await createTestApp({
            paths: {
                repoDir: "repo",
            }
        });

        const res1 = await request(app).get("/deb/debian/dists/bookworm/Release");
        expect(res1.status).toBe(200);
        expect(res1.text).toBe("Version: 1.0");

        // noinspection SpellCheckingInspection
        const res2 = await request(app).get("/rpm/centos/10/repodata/old-primary.xml");
        expect(res2.status).toBe(200);
        expect(res2.text).toBe("<metadata/>");
    }));

    test("Check that file names are escaped in the listing", withLocalTmpDir(async () => {
        // Windows file names cannot hold " or <
        const [name, escaped] = process.platform === "win32"
            ? ["a&b'c.deb", "a&amp;b&#39;c.deb"]
            : ['"><img src=x>.deb', "&quot;&gt;&lt;img src=x&gt;.deb"];
        await createFiles({ [`repo/deb/debian/${ name }`]: "" });

        const app = await createTestApp({
            paths: {
                repoDir: "repo",
            }
        });

        const res = await request(app).get("/deb/debian/");
        expect(res.status).toBe(200);
        expect(res.text).toContain(`title="${ escaped }"`);
        expect(cheerio.load(res.text)("img")).toHaveLength(0);
    }));

    test("Check that directories starting with dots are ignored", withLocalTmpDir(async () => {
        await createFiles({
            "repo/deb/debian/dists/bookworm/Release": "",
            "repo/.hidden/secret.txt": "",
            "repo/rpm/.config/settings.xml": "",
        });

        const app = await createTestApp({
            paths: {
                repoDir: "repo",
            }
        });

        const res = await request(app).get("/");
        expect(res.status).toBe(200);

        const $ = cheerio.load(res.text);
        expect($('li')).toHaveLength(2);
        expect($('li').eq(0).find('span.name').text()).toBe("deb");
        expect($('li').eq(1).find('span.name').text()).toBe("rpm");

        const resHidden = await request(app).get("/.hidden/secret.txt");
        expect(resHidden.status).toBe(404);

        const resConfig = await request(app).get("/rpm/.config/settings.xml");
        expect(resConfig.status).toBe(404);
    }));

    test("Check that two dots in path does not escape the directory context", withLocalTmpDir(async () => {
        await createFiles({
            "repo/deb/debian/dists/bookworm/Release": "Version: 1.0",
            "outside.txt": "secret",
        });

        const app = await createTestApp({
            paths: {
                repoDir: "repo",
            }
        });

        const server = app.listen(0);
        try {
            const res1 = await sendRawHttp(server, {
                headers: dedent`
                    GET /../outside.txt HTTP/1.1
                    Host: localhost:${ (server.address() as net.AddressInfo).port }\n\n
                    `
            });
            expect(res1).toMatch(/^HTTP\/1\.1 404 Not Found/);

            const res2 = await sendRawHttp(server, {
                headers: dedent`
                    GET /../ HTTP/1.1
                    Host: localhost:${ (server.address() as net.AddressInfo).port }\n\n
                    `
                });
            expect(res2).toMatch(/^HTTP\/1\.1 404 Not Found/);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }));
});
