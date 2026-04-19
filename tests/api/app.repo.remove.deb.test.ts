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

describe("DELETE deb package", () => {
    test("200 happy path runs reprepro listfilter + removefilter + export + clearvanished", withLocalTmpDir(async () => {
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
            .delete("/api/v1/repo/deb/debian/bookworm/clevis/21-1%2Btpm1u8%2Bdeb12");

        expect(res.status).toBe(200);
        expect(res.body.files).toEqual(expect.arrayContaining([
            expect.objectContaining({
                filename: "clevis_21-1+tpm1u8+deb12.dsc",
                status: "ok",
                path: "deb/debian/pool/main/c/clevis/clevis_21-1+tpm1u8+deb12.dsc"
            }),
            expect.objectContaining({
                filename: "clevis_21-1+tpm1u8+deb12_amd64.deb",
                status: "ok",
                path: "deb/debian/pool/main/c/clevis/clevis_21-1+tpm1u8+deb12_amd64.deb"
            })
        ]));
        expect(execCalls.filter(c => c.args.includes("listfilter"))).toHaveLength(1);
        expect(execCalls.filter(c => c.args.includes("removefilter"))).toHaveLength(1);
        expect(execCalls.filter(c => c.args.includes("export"))).toHaveLength(1);
        expect(execCalls.filter(c => c.args.includes("clearvanished"))).toHaveLength(1);
    }));

    test("no match 200 empty files; removefilter not called", withLocalTmpDir(async () => {
        const execCalls: { exe: string; args: string[] }[] = [];
        mockExecution(0, "", "", undefined, (exe, args) => execCalls.push({ exe, args }));

        await seedDistributionsConf();

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo",
                repreproBin: "reprepro"
            }
        });

        const res = await request(app)
            .delete("/api/v1/repo/deb/debian/bookworm/nosuch/1");

        expect(res.status).toBe(200);
        expect(res.body.files).toEqual([]);
        expect(execCalls.filter(c => c.args.includes("removefilter"))).toHaveLength(0);
        expect(execCalls.filter(c => c.args.includes("listfilter"))).toHaveLength(1);
    }));

    test("404 when distribution not configured", withLocalTmpDir(async () => {
        mockExecution(0, "", "");
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo",
                repreproBin: "reprepro"
            }
        });

        const res = await request(app)
            .delete("/api/v1/repo/deb/debian/bookworm/clevis/21");
        expect(res.status).toBe(404);
    }));

    test("404 when release not configured", withLocalTmpDir(async () => {
        mockExecution(0, "", "");
        await seedDistributionsConf();
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo",
                repreproBin: "reprepro"
            }
        });

        const res = await request(app)
            .delete("/api/v1/repo/deb/debian/trixie/clevis/21");
        expect(res.status).toBe(404);
    }));
});
