// noinspection DuplicatedCode

import { withLocalTmpDir } from "../utils.ts";
import fsExtra from "fs-extra/esm";
import fs from "node:fs/promises";
import osPath from "path";
import request from "supertest";
import { jest } from "@jest/globals";
import type { PackageInfo } from "../../server/lib/rpm-metadata.ts";

afterEach(() => {
    jest.resetModules();
});

describe("GET rpm package files", () => {
    test("200 returns files with downloadUrls for rpm", withLocalTmpDir(async () => {
        jest.resetModules();
        const actual = await import("../../server/lib/rpm-metadata.ts");
        jest.unstable_mockModule("../../server/lib/rpm-metadata.ts", () => ({
            __esModule: true,
            ...actual,
            streamPackages: jest.fn(async function* (): AsyncGenerator<PackageInfo> {
                yield { name: "clevis", arch: "src", ver: "21", rel: "1",
                    href: "Packages/c/clevis-21-1.src.rpm", sourcerpm: "" };
                yield { name: "clevis", arch: "x86_64", ver: "21", rel: "1",
                    href: "Packages/c/clevis-21-1.x86_64.rpm",
                    sourcerpm: "clevis-21-1.src.rpm" };
            }),
        }));
        jest.resetModules();
        await fsExtra.ensureDir(osPath.join("repo", "rpm", "fedora", "40", "repodata"));
        await fs.writeFile(
            osPath.join("repo", "rpm", "fedora", "40", "repodata", "repomd.xml"),
            `<?xml version="1.0"?><repomd/>`);
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp();
        const res = await request(app).get("/api/v1/repo/rpm/fedora/40/clevis");
        expect(res.status).toBe(200);
        expect(res.body.touchedTargets).toBe(1);
        expect(res.body.files).toEqual(expect.arrayContaining([
            expect.objectContaining({
                filename: "clevis-21-1.src.rpm",
                path: "rpm/fedora/40/Packages/c/clevis-21-1.src.rpm",
                downloadUrl: expect.stringMatching(
                    /^https?:\/\/.+\/rpm\/fedora\/40\/Packages\/c\/clevis-21-1\.src\.rpm$/),
            }),
        ]));
    }));
});
