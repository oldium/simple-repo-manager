// noinspection DuplicatedCode

import { createFiles, withLocalTmpDir } from "../utils.ts";
import request from "supertest";
import { jest } from "@jest/globals";
import fs from "node:fs/promises";
import fsExtra from "fs-extra";
import osPath from "path";
import zlib from "node:zlib";
import { mockExecution, spawnMock } from "../mocks.ts";

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

    test("release dir exists but no repodata → 404 (not a configured target)", withLocalTmpDir(async () => {
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
        expect(res.status).toBe(404);
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

    test("wildcard version removes clevis-* files but not clevis-tang-*",
        withLocalTmpDir(async () => {
        const execCalls: { exe: string; args: string[] }[] = [];
        mockExecution(0, "", "", undefined, (exe, args) => execCalls.push({ exe, args }));

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<metadata xmlns="http://linux.duke.edu/metadata/common" xmlns:rpm="http://linux.duke.edu/metadata/rpm" packages="5">
  <package type="rpm">
    <name>clevis</name><arch>src</arch>
    <version epoch="0" ver="22" rel="1.fc41"/>
    <location href="Packages/c/clevis-22-1.fc41.src.rpm"/>
    <format><rpm:sourcerpm></rpm:sourcerpm></format>
  </package>
  <package type="rpm">
    <name>clevis</name><arch>x86_64</arch>
    <version epoch="0" ver="22" rel="1.fc41"/>
    <location href="Packages/c/clevis-22-1.fc41.x86_64.rpm"/>
    <format><rpm:sourcerpm>clevis-22-1.fc41.src.rpm</rpm:sourcerpm></format>
  </package>
  <package type="rpm">
    <name>clevis-tang</name><arch>src</arch>
    <version epoch="0" ver="1" rel="1.fc41"/>
    <location href="Packages/c/clevis-tang-1-1.fc41.src.rpm"/>
    <format><rpm:sourcerpm></rpm:sourcerpm></format>
  </package>
  <package type="rpm">
    <name>clevis-tang</name><arch>x86_64</arch>
    <version epoch="0" ver="1" rel="1.fc41"/>
    <location href="Packages/c/clevis-tang-1-1.fc41.x86_64.rpm"/>
    <format><rpm:sourcerpm>clevis-tang-1-1.fc41.src.rpm</rpm:sourcerpm></format>
  </package>
  <package type="rpm">
    <name>other</name><arch>x86_64</arch>
    <version epoch="0" ver="1" rel="1.fc41"/>
    <location href="Packages/o/other-1-1.fc41.x86_64.rpm"/>
    <format><rpm:sourcerpm>other-1-1.fc41.src.rpm</rpm:sourcerpm></format>
  </package>
</metadata>
`;
        await seedRepo(xml);
        // Seed on-disk files that the XML points at.
        await createFiles({
            "repo/rpm/fedora/41/Packages/c/clevis-tang-1-1.fc41.src.rpm": "tang-src",
            "repo/rpm/fedora/41/Packages/c/clevis-tang-1-1.fc41.x86_64.rpm": "tang-bin"
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: { incomingDir: "incoming", repoDir: "repo",
                createrepoScript: "createrepo.sh", signScript: "sign.sh" }
        });

        const res = await request(app).delete("/api/v1/repo/rpm/fedora/41/clevis/-");

        expect(res.status).toBe(200);
        const filenames = res.body.files.map((f: { filename: string }) => f.filename).sort();
        expect(filenames).toEqual([
            "clevis-22-1.fc41.src.rpm",
            "clevis-22-1.fc41.x86_64.rpm"
        ]);

        // clevis entries are gone; clevis-tang and other remain.
        await expect(fs.access("repo/rpm/fedora/41/Packages/c/clevis-22-1.fc41.src.rpm"))
            .rejects.toThrow();
        await expect(fs.access("repo/rpm/fedora/41/Packages/c/clevis-22-1.fc41.x86_64.rpm"))
            .rejects.toThrow();
        await expect(fs.access("repo/rpm/fedora/41/Packages/c/clevis-tang-1-1.fc41.src.rpm"))
            .resolves.toBeUndefined();
        await expect(fs.access("repo/rpm/fedora/41/Packages/c/clevis-tang-1-1.fc41.x86_64.rpm"))
            .resolves.toBeUndefined();

        // createrepo_c ran once at the end.
        expect(execCalls.filter(c => c.exe === "createrepo.sh")).toHaveLength(1);
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

    test("wildcard release spans two releases", withLocalTmpDir(async () => {
        mockExecution(0, "", "");
        await seedRepo();                                     // fedora/41 with clevis
        // Seed a second release with its own clevis src+bin:
        const xml = BASE_PRIMARY_XML.replace(/fc41/g, "fc42");
        const root42 = osPath.join("repo", "rpm", "fedora", "42");
        await fsExtra.ensureDir(osPath.join(root42, "repodata"));
        await fs.writeFile(osPath.join(root42, "repodata", "repomd.xml"),
            `<?xml version="1.0"?><repomd><data type="primary"><location href="repodata/hash-primary.xml.zst"/></data></repomd>`);
        await fs.writeFile(osPath.join(root42, "repodata", "hash-primary.xml.zst"),
            zlib.zstdCompressSync(Buffer.from(xml, "utf8")));
        await createFiles({
            "repo/rpm/fedora/42/Packages/c/clevis-22-1.tpm1.fc42.src.rpm": "src",
            "repo/rpm/fedora/42/Packages/c/clevis-22-1.tpm1.fc42.x86_64.rpm": "bin",
            "repo/rpm/fedora/42/Packages/o/other-1-1.fc42.x86_64.rpm": "other"
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: { incomingDir: "incoming", repoDir: "repo",
                createrepoScript: "createrepo.sh", signScript: "sign.sh" }
        });

        const res = await request(app).delete("/api/v1/repo/rpm/fedora/-/clevis/22-1.tpm1");
        expect(res.status).toBe(200);
        // Four files removed across two releases (src + bin each).
        expect(res.body.files).toHaveLength(4);
        await expect(fs.access("repo/rpm/fedora/41/Packages/c/clevis-22-1.tpm1.fc41.src.rpm"))
            .rejects.toThrow();
        await expect(fs.access("repo/rpm/fedora/42/Packages/c/clevis-22-1.tpm1.fc42.src.rpm"))
            .rejects.toThrow();
    }));

    test("404 when literal distribution has no configured rpm repo",
        withLocalTmpDir(async () => {
        mockExecution(0, "", "");
        await seedRepo();                                     // only fedora
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: { incomingDir: "incoming", repoDir: "repo",
                createrepoScript: "createrepo.sh", signScript: "sign.sh" }
        });

        const res = await request(app).delete("/api/v1/repo/rpm/centos/9/clevis/22");
        expect(res.status).toBe(404);
    }));

    test("all-wildcard with no configured rpm targets → 200 empty",
        withLocalTmpDir(async () => {
        const execCalls: unknown[] = [];
        mockExecution(0, "", "", undefined, () => execCalls.push({}));

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: { incomingDir: "incoming", repoDir: "repo",
                createrepoScript: "createrepo.sh", signScript: "sign.sh" }
        });

        const res = await request(app).delete("/api/v1/repo/rpm/-/-/clevis/-");
        expect(res.status).toBe(200);
        expect(res.body.files).toEqual([]);
        expect(execCalls).toHaveLength(0);
    }));

    test("wildcard distribution + wildcard release spans multiple distros",
        withLocalTmpDir(async () => {
        mockExecution(0, "", "");
        await seedRepo();   // fedora/41 with clevis
        // Add a centos/9 target with its own clevis src:
        const xml = BASE_PRIMARY_XML.replace(/fc41/g, "el9");
        const centosRoot = osPath.join("repo", "rpm", "centos", "9");
        await fsExtra.ensureDir(osPath.join(centosRoot, "repodata"));
        await fs.writeFile(osPath.join(centosRoot, "repodata", "repomd.xml"),
            `<?xml version="1.0"?><repomd><data type="primary"><location href="repodata/hash-primary.xml.zst"/></data></repomd>`);
        await fs.writeFile(osPath.join(centosRoot, "repodata", "hash-primary.xml.zst"),
            zlib.zstdCompressSync(Buffer.from(xml, "utf8")));
        await createFiles({
            "repo/rpm/centos/9/Packages/c/clevis-22-1.tpm1.el9.src.rpm": "src",
            "repo/rpm/centos/9/Packages/c/clevis-22-1.tpm1.el9.x86_64.rpm": "bin",
            "repo/rpm/centos/9/Packages/o/other-1-1.el9.x86_64.rpm": "other"
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: { incomingDir: "incoming", repoDir: "repo",
                createrepoScript: "createrepo.sh", signScript: "sign.sh" }
        });

        const res = await request(app).delete("/api/v1/repo/rpm/-/-/clevis/22-1.tpm1");
        expect(res.status).toBe(200);
        // Two releases (fedora/41, centos/9), each contributes two files (src + bin).
        expect(res.body.files).toHaveLength(4);
        await expect(fs.access("repo/rpm/fedora/41/Packages/c/clevis-22-1.tpm1.fc41.src.rpm"))
            .rejects.toThrow();
        await expect(fs.access("repo/rpm/centos/9/Packages/c/clevis-22-1.tpm1.el9.src.rpm"))
            .rejects.toThrow();
    }));

    test("createrepo failure under wildcard release → 500 with files still listed",
        withLocalTmpDir(async () => {
        // Files are unlinked before createrepo runs, so even when
        // createrepo returns non-zero the response lists what we removed.
        mockExecution(1, "", "boom");
        await seedRepo();

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: { incomingDir: "incoming", repoDir: "repo",
                createrepoScript: "createrepo.sh", signScript: "sign.sh" }
        });

        const res = await request(app).delete("/api/v1/repo/rpm/fedora/-/clevis/22-1.tpm1");
        expect(res.status).toBe(500);
        expect(res.body.files.length).toBeGreaterThan(0);
    }));

    test("partial failure: fedora/41 createrepo succeeds, centos/9 fails → 500 aggregates both file lists",
        withLocalTmpDir(async () => {
        const execCalls: { exe: string; args: string[] }[] = [];
        const spawn = mockExecution(0, "", "");
        spawn.mockImplementation((exe: string, args: string[]) => {
            execCalls.push({ exe, args });
            // createrepo.sh is invoked as `createrepo.sh <releaseDir> <signScript>`.
            // Fail only on centos/9's invocation. Normalise separators because
            // the handler forwards the path verbatim from path.join (which
            // uses `\` on Windows).
            const normalised = (args[0] ?? "").replace(/\\/g, "/");
            if (normalised.includes("rpm/centos/9")) {
                return spawnMock(1, "", "boom")(exe, args);
            }
            return spawnMock(0, "", "")(exe, args);
        });

        // Seed fedora/41
        await seedRepo();
        // Seed centos/9 with its own clevis src+bin
        const xml = BASE_PRIMARY_XML.replace(/fc41/g, "el9");
        const centosRoot = osPath.join("repo", "rpm", "centos", "9");
        await fsExtra.ensureDir(osPath.join(centosRoot, "repodata"));
        await fs.writeFile(osPath.join(centosRoot, "repodata", "repomd.xml"),
            `<?xml version="1.0"?><repomd><data type="primary"><location href="repodata/hash-primary.xml.zst"/></data></repomd>`);
        await fs.writeFile(osPath.join(centosRoot, "repodata", "hash-primary.xml.zst"),
            zlib.zstdCompressSync(Buffer.from(xml, "utf8")));
        await createFiles({
            "repo/rpm/centos/9/Packages/c/clevis-22-1.tpm1.el9.src.rpm": "src",
            "repo/rpm/centos/9/Packages/c/clevis-22-1.tpm1.el9.x86_64.rpm": "bin",
            "repo/rpm/centos/9/Packages/o/other-1-1.el9.x86_64.rpm": "other"
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: { incomingDir: "incoming", repoDir: "repo",
                createrepoScript: "createrepo.sh", signScript: "sign.sh" }
        });

        const res = await request(app).delete("/api/v1/repo/rpm/-/-/clevis/22-1.tpm1");
        expect(res.status).toBe(500);
        expect(res.body.message).toMatch(/one or more targets failed/);
        // Two releases × (src + bin) = 4 files. All unlinks happened before
        // createrepo.sh ran, so every entry is status "ok" regardless of which
        // target's createrepo later failed.
        expect(res.body.files).toHaveLength(4);
        expect(res.body.files.every((f: { status: string }) => f.status === "ok")).toBe(true);
        // Both releases actually invoked createrepo.sh — we only mocked the
        // per-call exit code.
        expect(execCalls).toHaveLength(2);
    }));
});
