import request from "supertest";
import fsExtra from "fs-extra/esm";
import fs from "node:fs/promises";
import osPath from "path";
import zlib from "node:zlib";
import { jest } from "@jest/globals";

import { withLocalTmpDir } from "../utils.ts";

afterEach(() => {
    jest.resetModules();
});

describe("DELETE /api/v1/repo cross-format + no-version", () => {
    test("Missing version segment is equivalent to version '-'", withLocalTmpDir(async () => {
        const releaseRoot = osPath.join("repo", "rpm", "fedora", "40");
        await fsExtra.ensureDir(osPath.join(releaseRoot, "repodata"));
        const primaryHref = "repodata/hash-primary.xml.zst";
        await fs.writeFile(osPath.join(releaseRoot, "repodata", "repomd.xml"),
            `<?xml version="1.0"?><repomd><data type="primary"><location href="${ primaryHref }"/></data></repomd>`);
        await fs.writeFile(osPath.join(releaseRoot, primaryHref),
            zlib.zstdCompressSync(Buffer.from(
                `<?xml version="1.0" encoding="UTF-8"?><metadata xmlns="http://linux.duke.edu/metadata/common" packages="0"></metadata>`,
                "utf8")));
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({ paths: { createrepoScript: "scripts/createrepo.sh" } });
        const response = await request(app).delete("/api/v1/repo/rpm/fedora/40/clevis");
        expect(response.status).toBe(200);
        expect(response.body.message).toMatch(/No packages matched/);
    }));

    test("Cross-format wildcard '-' enumerates every backend", withLocalTmpDir(async () => {
        await fsExtra.ensureDir(osPath.join("repo", "rpm", "fedora", "40"));
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp();
        const response = await request(app).delete("/api/v1/repo/-/-/-/clevis/-");
        expect(response.status).toBe(200);
        expect(response.body.message).toMatch(/No packages matched/);
    }));

    test("Invalid source token still rejected with 400", withLocalTmpDir(async () => {
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp();
        const response = await request(app).delete("/api/v1/repo/deb/bookworm/main/%2Fbad");
        expect(response.status).toBe(400);
    }));
});
