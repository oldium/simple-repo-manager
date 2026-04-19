// noinspection DuplicatedCode

import { createFiles, withLocalTmpDir } from "../utils.ts";
import request from "supertest";
import { jest } from "@jest/globals";
import fs from "node:fs/promises";
import fsExtra from "fs-extra";
import osPath from "path";
import zlib from "node:zlib";
import { mockExecution } from "../mocks.ts";

const BASE_PRIMARY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<metadata xmlns="http://linux.duke.edu/metadata/common" xmlns:rpm="http://linux.duke.edu/metadata/rpm" packages="3">
  <package type="rpm">
    <name>clevis</name><arch>src</arch>
    <version epoch="0" ver="22" rel="1.tpm1.fc41"/>
    <location href="Packages/c/clevis-22-1.tpm1.fc41.src.rpm"/>
    <format><rpm:sourcerpm></rpm:sourcerpm></format>
  </package>
  <package type="rpm">
    <name>clevis</name><arch>x86_64</arch>
    <version epoch="0" ver="22" rel="1.tpm1.fc41"/>
    <location href="Packages/c/clevis-22-1.tpm1.fc41.x86_64.rpm"/>
    <format><rpm:sourcerpm>clevis-22-1.tpm1.fc41.src.rpm</rpm:sourcerpm></format>
  </package>
  <package type="rpm">
    <name>other</name><arch>x86_64</arch>
    <version epoch="0" ver="1" rel="1.fc41"/>
    <location href="Packages/o/other-1-1.fc41.x86_64.rpm"/>
    <format><rpm:sourcerpm>other-1-1.fc41.src.rpm</rpm:sourcerpm></format>
  </package>
</metadata>
`;

async function seedRepo(xml = BASE_PRIMARY_XML) {
    const root = osPath.join("repo", "rpm", "fedora", "41");
    await fsExtra.ensureDir(osPath.join(root, "repodata"));
    const primaryHref = "repodata/hash-primary.xml.zst";
    await fs.writeFile(osPath.join(root, "repodata", "repomd.xml"),
        `<?xml version="1.0"?><repomd><data type="primary"><location href="${ primaryHref }"/></data></repomd>`);
    await fs.writeFile(osPath.join(root, primaryHref),
        zlib.zstdCompressSync(Buffer.from(xml, "utf8")));
    await createFiles({
        "repo/rpm/fedora/41/Packages/c/clevis-22-1.tpm1.fc41.src.rpm": "src",
        "repo/rpm/fedora/41/Packages/c/clevis-22-1.tpm1.fc41.x86_64.rpm": "bin",
        "repo/rpm/fedora/41/Packages/o/other-1-1.fc41.x86_64.rpm": "other"
    });
}

afterEach(() => {
    jest.resetModules();
});

describe("DELETE rpm package", () => {
    test("removes src rpm + matching binaries and runs createrepo", withLocalTmpDir(async () => {
        const execCalls: { exe: string; args: string[] }[] = [];
        mockExecution(0, "", "", undefined, (executable, args) => {
            execCalls.push({ exe: executable, args });
        });

        await seedRepo();

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: { incomingDir: "incoming", repoDir: "repo",
                createrepoScript: "createrepo.sh", signScript: "sign.sh" }
        });

        const res = await request(app).delete("/api/v1/repo/rpm/fedora/41/clevis/22-1.tpm1");

        expect(res.status).toBe(200);
        expect(res.body.files).toEqual(expect.arrayContaining([
            expect.objectContaining({ filename: "clevis-22-1.tpm1.fc41.src.rpm", status: "ok" }),
            expect.objectContaining({ filename: "clevis-22-1.tpm1.fc41.x86_64.rpm", status: "ok" })
        ]));
        expect(res.body.files).toHaveLength(2);

        await expect(fs.access("repo/rpm/fedora/41/Packages/c/clevis-22-1.tpm1.fc41.src.rpm")).rejects.toThrow();
        await expect(fs.access("repo/rpm/fedora/41/Packages/c/clevis-22-1.tpm1.fc41.x86_64.rpm")).rejects.toThrow();
        await expect(fs.access("repo/rpm/fedora/41/Packages/o/other-1-1.fc41.x86_64.rpm")).resolves.toBeUndefined();
        // Packages/c became empty → removed
        await expect(fs.access("repo/rpm/fedora/41/Packages/c")).rejects.toThrow();

        expect(execCalls).toHaveLength(1);
        expect(execCalls[0].exe).toBe("createrepo.sh");
        expect(execCalls[0].args).toEqual(["repo/rpm/fedora/41", "sign.sh"]);
    }));
});

describe("DELETE rpm edge cases", () => {
    test("no match → 200 with empty files; createrepo not invoked", withLocalTmpDir(async () => {
        const execCalls: { exe: string; args: string[] }[] = [];
        mockExecution(0, "", "", undefined, (exe, args) => { execCalls.push({ exe, args }); });

        await seedRepo();
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: { incomingDir: "incoming", repoDir: "repo",
                createrepoScript: "createrepo.sh", signScript: "sign.sh" }
        });

        const res = await request(app).delete("/api/v1/repo/rpm/fedora/41/nosuch/99");
        expect(res.status).toBe(200);
        expect(res.body.files).toEqual([]);
        expect(execCalls).toHaveLength(0);
    }));

    test("404 when release dir does not exist", withLocalTmpDir(async () => {
        mockExecution(0, "", "");
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: { incomingDir: "incoming", repoDir: "repo",
                createrepoScript: "createrepo.sh", signScript: "sign.sh" }
        });

        const res = await request(app).delete("/api/v1/repo/rpm/fedora/99/clevis/22-1.tpm1");
        expect(res.status).toBe(404);
    }));

    test("release dir exists but no repodata → treat as no match", withLocalTmpDir(async () => {
        const execCalls: unknown[] = [];
        mockExecution(0, "", "", undefined, () => { execCalls.push({}); });

        await fsExtra.ensureDir("repo/rpm/fedora/41/Packages/c");
        await fs.writeFile("repo/rpm/fedora/41/Packages/c/clevis-22-1.tpm1.fc41.src.rpm", "src");

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: { incomingDir: "incoming", repoDir: "repo",
                createrepoScript: "createrepo.sh", signScript: "sign.sh" }
        });

        const res = await request(app).delete("/api/v1/repo/rpm/fedora/41/clevis/22-1.tpm1");
        expect(res.status).toBe(200);
        expect(res.body.files).toEqual([]);
        expect(execCalls).toHaveLength(0);
    }));

    test("retains other packages under same letter dir", withLocalTmpDir(async () => {
        mockExecution(0, "", "");
        const xml = BASE_PRIMARY_XML.replace(
            "<location href=\"Packages/o/other-1-1.fc41.x86_64.rpm\"/>",
            "<location href=\"Packages/c/cousin-1-1.fc41.x86_64.rpm\"/>"
        ).replace(
            "<name>other</name>",
            "<name>cousin</name>"
        ).replace(
            "other-1-1.fc41.src.rpm",
            "cousin-1-1.fc41.src.rpm"
        );
        await seedRepo(xml);
        // Replace on-disk layout to match the rewritten XML
        await fs.unlink("repo/rpm/fedora/41/Packages/o/other-1-1.fc41.x86_64.rpm");
        await fs.rmdir("repo/rpm/fedora/41/Packages/o");
        await fs.writeFile("repo/rpm/fedora/41/Packages/c/cousin-1-1.fc41.x86_64.rpm", "cousin");

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: { incomingDir: "incoming", repoDir: "repo",
                createrepoScript: "createrepo.sh", signScript: "sign.sh" }
        });

        const res = await request(app).delete("/api/v1/repo/rpm/fedora/41/clevis/22-1.tpm1");
        expect(res.status).toBe(200);
        expect(res.body.files).toHaveLength(2);
        await expect(fs.access("repo/rpm/fedora/41/Packages/c/cousin-1-1.fc41.x86_64.rpm")).resolves.toBeUndefined();
        // Packages/c kept because cousin remains
        await expect(fs.access("repo/rpm/fedora/41/Packages/c")).resolves.toBeUndefined();
    }));

    test("createrepo failure → 500", withLocalTmpDir(async () => {
        mockExecution(1, "", "boom", undefined);
        await seedRepo();

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: { incomingDir: "incoming", repoDir: "repo",
                createrepoScript: "createrepo.sh", signScript: "sign.sh" }
        });

        const res = await request(app).delete("/api/v1/repo/rpm/fedora/41/clevis/22-1.tpm1");
        expect(res.status).toBe(500);
    }));
});
