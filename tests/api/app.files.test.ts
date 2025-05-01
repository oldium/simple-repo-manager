// noinspection DuplicatedCode,JSJQueryEfficiency

import { createFiles, sendRawHttp, withLocalTmpDir } from "../utils.ts";
import createTestApp from "../testapp.ts";
import request from "supertest";
import * as cheerio from "cheerio";
import dedent from "dedent";
import net from "net";

describe("Test of files reading API", () => {
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
            "repo/rpm/centos/10/repodata/repomd.xml": "<repomd/>",
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
        const res2 = await request(app).get("/rpm/centos/10/repodata/repomd.xml");
        expect(res2.status).toBe(200);
        expect(res2.text).toBe("<repomd/>");
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
            expect(res1).toMatch(/^HTTP\/1\.1 403 Forbidden/);

            const res2 = await sendRawHttp(server, {
                headers: dedent`
                    GET /../ HTTP/1.1
                    Host: localhost:${ (server.address() as net.AddressInfo).port }\n\n
                    `
                });
            expect(res2).toMatch(/^HTTP\/1\.1 403 Forbidden/);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }));
});
