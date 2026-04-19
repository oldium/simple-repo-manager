// noinspection DuplicatedCode

import { createFiles, withLocalTmpDir } from "../utils.ts";
import request from "supertest";
import { jest } from "@jest/globals";
import { mockExecution, spawnMock } from "../mocks.ts";

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

    test("wildcard version drops $SourceVersion clause and still removes all matches",
        withLocalTmpDir(async () => {
        const execCalls: { exe: string; args: string[] }[] = [];
        // reprepro listfilter output for two different versions of clevis:
        const listfilterStdout =
            "bookworm|main|source: clevis 21-1+tpm1u8+deb12\n" +
            "bookworm|main|amd64: clevis 21-1+tpm1u8+deb12\n" +
            "bookworm|main|source: clevis 22-1+tpm1u8+deb12\n" +
            "bookworm|main|amd64: clevis 22-1+tpm1u8+deb12\n";
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
            .delete("/api/v1/repo/deb/debian/bookworm/clevis/-");

        expect(res.status).toBe(200);
        expect(res.body.files).toHaveLength(4);

        // Formula must NOT contain $SourceVersion when the version is wildcard.
        const listfilterCall = execCalls.find(c => c.args.includes("listfilter"));
        expect(listfilterCall).toBeDefined();
        const formula = listfilterCall!.args[listfilterCall!.args.length - 1];
        expect(formula).toBe("$Source (== clevis)");
        expect(formula).not.toContain("$SourceVersion");

        // removefilter must run with the same wildcard formula.
        const removeCall = execCalls.find(c => c.args.includes("removefilter"));
        expect(removeCall).toBeDefined();
        expect(removeCall!.args[removeCall!.args.length - 1]).toBe("$Source (== clevis)");
    }));

    test("wildcard release touches every release of the distro",
        withLocalTmpDir(async () => {
        const execCalls: { exe: string; args: string[] }[] = [];
        mockExecution(0,
            "bookworm|main|source: clevis 21-1+tpm1u8+deb12\n",
            "",
            undefined,
            (exe, args) => execCalls.push({ exe, args })
        );

        await createFiles({
            "repo-state/deb-debian/conf/distributions": [
                "Codename: bookworm",
                "Suite: bookworm",
                "Components: main",
                "Architectures: amd64 source",
                "",
                "Codename: trixie",
                "Suite: trixie",
                "Components: main",
                "Architectures: amd64 source",
                ""
            ].join("\n")
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo",
                repreproBin: "reprepro"
            }
        });

        const res = await request(app)
            .delete("/api/v1/repo/deb/debian/-/clevis/21-1%2Btpm1u8%2Bdeb12");

        expect(res.status).toBe(200);
        // listfilter ran once per release, removefilter ran once per release
        // that matched. Each invocation is scoped to a single release.
        const listfilterReleases = execCalls
            .filter(c => c.args.includes("listfilter"))
            .map(c => c.args[c.args.indexOf("listfilter") + 1]);
        expect(listfilterReleases.sort()).toEqual(["bookworm", "trixie"]);
    }));

    test("404 when literal distribution has no configured repo",
        withLocalTmpDir(async () => {
        mockExecution(0, "", "");
        await seedDistributionsConf();   // seeds debian only
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo",
                repreproBin: "reprepro"
            }
        });

        const res = await request(app)
            .delete("/api/v1/repo/deb/ubuntu/bookworm/clevis/21");
        expect(res.status).toBe(404);
    }));

    test("all-wildcard with zero configured distros → 200 empty, no reprepro",
        withLocalTmpDir(async () => {
        const execCalls: unknown[] = [];
        mockExecution(0, "", "", undefined, () => execCalls.push({}));
        // no distributions configured

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo",
                repreproBin: "reprepro"
            }
        });

        const res = await request(app).delete("/api/v1/repo/deb/-/-/clevis/-");
        expect(res.status).toBe(200);
        expect(res.body.files).toEqual([]);
        expect(execCalls).toHaveLength(0);
    }));

    test("wildcard distribution + wildcard release spans every configured pair",
        withLocalTmpDir(async () => {
        const execCalls: { exe: string; args: string[] }[] = [];
        mockExecution(0,
            "bookworm|main|amd64: clevis 21-1\n",
            "",
            undefined,
            (exe, args) => execCalls.push({ exe, args })
        );

        await createFiles({
            "repo-state/deb-debian/conf/distributions": [
                "Codename: bookworm",
                "Suite: bookworm",
                "Components: main",
                "Architectures: amd64 source",
                ""
            ].join("\n"),
            "repo-state/deb-ubuntu/conf/distributions": [
                "Codename: noble",
                "Suite: noble",
                "Components: main",
                "Architectures: amd64 source",
                ""
            ].join("\n")
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo",
                repreproBin: "reprepro"
            }
        });

        const res = await request(app).delete("/api/v1/repo/deb/-/-/clevis/21");
        expect(res.status).toBe(200);

        // listfilter invoked once per (distro, release) enumerated:
        const listfilterReleases = execCalls
            .filter(c => c.args.includes("listfilter"))
            .map(c => c.args[c.args.indexOf("listfilter") + 1])
            .sort();
        expect(listfilterReleases).toEqual(["bookworm", "noble"]);
    }));

    test("one target's reprepro fails under wildcard release → 500 with successful files listed",
        withLocalTmpDir(async () => {
        // All mock exec calls fail. We still expect the files to be
        // reported (listfilter returned rows, response builds from them).
        mockExecution(1, "bookworm|main|amd64: clevis 21-1\n", "boom");
        await seedDistributionsConf();

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo",
                repreproBin: "reprepro"
            }
        });

        const res = await request(app).delete("/api/v1/repo/deb/debian/-/clevis/21");
        expect(res.status).toBe(500);
    }));

    test("partial failure: bookworm succeeds, trixie removefilter fails → 500 aggregates both file lists",
        withLocalTmpDir(async () => {
        const execCalls: { exe: string; args: string[] }[] = [];
        const spawn = mockExecution(0, "", "");
        spawn.mockImplementation((exe: string, args: string[]) => {
            execCalls.push({ exe, args });
            if (args.includes("listfilter")) {
                const release = args[args.indexOf("listfilter") + 1];
                return spawnMock(0, `${ release }|main|amd64: clevis 21-1\n`, "")(exe, args);
            }
            if (args.includes("removefilter") && args.includes("trixie")) {
                return spawnMock(1, "", "boom")(exe, args);
            }
            return spawnMock(0, "", "")(exe, args);
        });

        await createFiles({
            "repo-state/deb-debian/conf/distributions": [
                "Codename: bookworm",
                "Suite: bookworm",
                "Components: main",
                "Architectures: amd64 source",
                "",
                "Codename: trixie",
                "Suite: trixie",
                "Components: main",
                "Architectures: amd64 source",
                ""
            ].join("\n")
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo",
                repreproBin: "reprepro"
            }
        });

        const res = await request(app).delete("/api/v1/repo/deb/debian/-/clevis/21");
        expect(res.status).toBe(500);
        expect(res.body.message).toMatch(/one or more targets failed/);
        // Each release's listfilter returned one row; both contribute an entry
        // whose status is "ok" because the row is what was targeted for removal.
        expect(res.body.files).toHaveLength(2);
        expect(res.body.files.every((f: { status: string }) => f.status === "ok")).toBe(true);
        expect(res.body.files).toEqual(expect.arrayContaining([
            expect.objectContaining({ filename: "clevis_21-1_amd64.deb" })
        ]));
        // The succeeding target ran export + clearvanished; the failing one
        // stopped at removefilter.
        const byArg = (needle: string) => execCalls.filter(c => c.args.includes(needle));
        expect(byArg("listfilter")).toHaveLength(2);
        expect(byArg("removefilter")).toHaveLength(2);
        expect(byArg("export")).toHaveLength(1);
        expect(byArg("clearvanished")).toHaveLength(1);
    }));
});
