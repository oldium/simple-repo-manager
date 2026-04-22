// noinspection DuplicatedCode

import { createFiles, withLocalTmpDir } from "../utils.ts";
import request from "supertest";
import { jest } from "@jest/globals";
import { mockExecution } from "../mocks.ts";

afterEach(() => {
    jest.resetModules();
});

async function seedDistributionsConf() {
    await createFiles({
        "repo-state/deb-debian/conf/distributions": [
            "Codename: bookworm",
            "Suite: bookworm",
            "Components: main",
            "Architectures: amd64 source",
            "Tracking: minimal",
            "Limit: 0",
            ""
        ].join("\n")
    });
}

describe("GET deb package files", () => {
    test("200 returns files with absolute downloadUrls, no removal exec", withLocalTmpDir(async () => {
        const execCalls: { exe: string; args: string[] }[] = [];
        const listfilterStdout =
            "bookworm|main|source: clevis 21-1+tpm1u8+deb12\n" +
            "bookworm|main|amd64: clevis 21-1+tpm1u8+deb12\n";
        mockExecution(0, listfilterStdout, "", undefined, (exe, args) => {
            execCalls.push({ exe, args });
        });

        await seedDistributionsConf();

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo",
                repreproBin: "reprepro"
            }
        });

        const res = await request(app)
            .get("/api/v1/repo/deb/debian/bookworm/clevis/21-1%2Btpm1u8%2Bdeb12");

        expect(res.status).toBe(200);
        expect(res.body.touchedTargets).toBe(1);
        expect(res.body.files).toEqual(expect.arrayContaining([
            expect.objectContaining({
                filename: "clevis_21-1+tpm1u8+deb12.dsc",
                path: "deb/debian/pool/main/c/clevis/clevis_21-1+tpm1u8+deb12.dsc",
                downloadUrl: expect.stringMatching(
                    /^https?:\/\/.+\/deb\/debian\/pool\/main\/c\/clevis\/clevis_21-1\+tpm1u8\+deb12\.dsc$/),
            }),
            expect.objectContaining({
                filename: "clevis_21-1+tpm1u8+deb12_amd64.deb",
                downloadUrl: expect.stringMatching(
                    /^https?:\/\/.+\/deb\/debian\/pool\/main\/c\/clevis\/clevis_21-1\+tpm1u8\+deb12_amd64\.deb$/),
            }),
        ]));
        // Critical: no destructive exec ran
        expect(execCalls.filter(c => c.args.includes("removefilter"))).toHaveLength(0);
        expect(execCalls.filter(c => c.args.includes("listfilter"))).toHaveLength(1);
    }));

    test("404 on unknown distro with explicit literal filter", withLocalTmpDir(async () => {
        mockExecution(0, "", "", undefined, () => {});
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo",
                repreproBin: "reprepro"
            }
        });
        const res = await request(app).get("/api/v1/repo/deb/nope/0/clevis");
        expect(res.status).toBe(404);
    }));

    test("400 on invalid path segment", withLocalTmpDir(async () => {
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp();
        const res = await request(app).get("/api/v1/repo/deb/debian/bookworm/$bad$");
        expect(res.status).toBe(400);
    }));

    test("200 with wildcards enumerates all matching targets", withLocalTmpDir(async () => {
        const listfilterStdout = "bookworm|main|source: clevis 21-1\n";
        mockExecution(0, listfilterStdout, "", undefined, () => {});
        await seedDistributionsConf();
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo",
                repreproBin: "reprepro"
            }
        });
        const res = await request(app).get("/api/v1/repo/deb/-/-/clevis");
        expect(res.status).toBe(200);
        expect(res.body.files.length).toBeGreaterThan(0);
    }));
});
