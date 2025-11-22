// noinspection DuplicatedCode

import { createFiles, withLocalTmpDir } from "../utils.ts";
import request from "supertest";
import { jest } from "@jest/globals";
import fs from "fs/promises";
import osPath from "path";
import { mockExecution } from "../mocks.ts";
import { glob } from "glob";
import assert from "node:assert";
import _ from "lodash";

type CapturedState = {
    executable: string,
    args: string[],
    files: Record<string, string>
}

async function captureCreaterepoState(executable: string, args: string[]): Promise<CapturedState> {
    const capturedFiles: Record<string, string> = {};
    if (args.length > 1 && args[0]) {
        const targetDir = osPath.join(args[0], "Packages");
        if (targetDir) {
            const files = await glob("**/*", { cwd: targetDir, posix: true, nodir: true });
            await Promise.all(files.map(
                async (file) => {
                    capturedFiles[file] = await fs.readFile(osPath.join(targetDir, file), "utf8");
                }));
        }
    }
    return {
        executable,
        args,
        files: capturedFiles
    }
}

afterEach(() => {
    jest.resetModules();
})

describe('Test repository build scripts for RedHat', () => {
    test('Check that RedHat incoming package is moved to repo', withLocalTmpDir(async () => {
        let createrepoSpawn: CapturedState | undefined;

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            if (!createrepoSpawn) {
                createrepoSpawn = await captureCreaterepoState(executable, args);
            }
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoDir: "repo",
                createrepoScript: "createrepo.sh",
                signScript: "sign.sh"
            }
        });

        await createFiles({
            "incoming/staging/rpm/fedora/41/test.rpm": ""
        })

        const res = await request(app).post("/api/v1/repo/import");
        expect(res.status).toBe(200);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'rpm', 'fedora', '41'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'rpm', 'fedora', '41'))).toHaveLength(0);

        expect(createrepoSpawn).toBeDefined();
        assert(createrepoSpawn);
        expect(createrepoSpawn.executable).toBe("createrepo.sh");
        expect(createrepoSpawn.args).toHaveLength(2);
        expect(createrepoSpawn.args[0]).toEqual("repo/rpm/fedora/41");
        expect(createrepoSpawn.args[1]).toEqual("sign.sh");

        expect(Object.keys(createrepoSpawn.files)).toHaveLength(1);
        expect(createrepoSpawn.files["t/test.rpm"]).toBeDefined();
    }));

    test('Check that RedHat incoming package is moved to repo when Debian reprepro tool is unavailable', withLocalTmpDir(async () => {
        const createrepoSpawn: CapturedState[] = [];

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            createrepoSpawn.push(await captureCreaterepoState(executable, args));
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoDir: "repo",
                createrepoScript: "createrepo.sh",
                signScript: "sign.sh",
                repreproBin: null,
            },
            upload: {
                enabledApi: {
                    deb: false,
                }
            }
        });

        await createFiles({
            "incoming/staging/rpm/fedora/41/test.rpm": ""
        })

        const res = await request(app).post("/api/v1/repo/import");
        expect(res.status).toBe(200);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'rpm', 'fedora', '41'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'rpm', 'fedora', '41'))).toHaveLength(0);

        expect(createrepoSpawn).toHaveLength(1);
    }));

    test('Check RedHat createrepo script arguments with no GPG key', withLocalTmpDir(async () => {
        let createrepoSpawn: CapturedState | undefined;

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            if (!createrepoSpawn) {
                createrepoSpawn = await captureCreaterepoState(executable, args);
            }
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoDir: "repo",
                createrepoScript: "createrepo.sh",
            }
        });

        await createFiles({
            "incoming/staging/rpm/fedora/41/test.rpm": ""
        })

        const res = await request(app).post("/api/v1/repo/import");
        expect(res.status).toBe(200);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'rpm', 'fedora', '41'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'rpm', 'fedora', '41'))).toHaveLength(0);

        expect(createrepoSpawn).toBeDefined();
        assert(createrepoSpawn);
        expect(createrepoSpawn.executable).toBe("createrepo.sh");
        expect(createrepoSpawn.args).toHaveLength(2);
        expect(createrepoSpawn.args[0]).toEqual("repo/rpm/fedora/41");
        expect(createrepoSpawn.args[1]).toEqual("");

        expect(Object.keys(createrepoSpawn.files)).toHaveLength(1);
        expect(createrepoSpawn.files["t/test.rpm"]).toBeDefined();
    }));

    test('Check that multiple RedHat incoming package are moved to repo', withLocalTmpDir(async () => {
        let createrepoSpawn: CapturedState | undefined;

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            if (!createrepoSpawn) {
                createrepoSpawn = await captureCreaterepoState(executable, args);
            }
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoDir: "repo",
                createrepoScript: "createrepo.sh",
                signScript: "sign.sh"
            }
        });

        await createFiles({
            "incoming/staging/rpm/fedora/41/test1.rpm": "",
            "incoming/staging/rpm/fedora/41/rest2.rpm": "",
            "incoming/staging/rpm/fedora/41/fest3.rpm": "",
        })

        const res = await request(app).post("/api/v1/repo/import");
        expect(res.status).toBe(200);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'rpm', 'fedora', '41'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'rpm', 'fedora', '41'))).toHaveLength(0)

        expect(createrepoSpawn).toBeDefined();
        assert(createrepoSpawn);
        expect(createrepoSpawn.executable).toBe("createrepo.sh");
        expect(createrepoSpawn.args).toHaveLength(2);
        expect(createrepoSpawn.args[0]).toEqual("repo/rpm/fedora/41");
        expect(createrepoSpawn.args[1]).toEqual("sign.sh");

        expect(Object.keys(createrepoSpawn.files)).toHaveLength(3);
        expect(Object.keys(createrepoSpawn.files)).toIncludeSameMembers(["t/test1.rpm", "r/rest2.rpm", "f/fest3.rpm"]);
    }));

    test('Check that multiple RedHat incoming package from multiple distributions are moved to repo', withLocalTmpDir(async () => {
        const createrepoSpawn: CapturedState[] = [];

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            createrepoSpawn.push(await captureCreaterepoState(executable, args));
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoDir: "repo",
                createrepoScript: "createrepo.sh",
                signScript: "sign.sh"
            }
        });

        await createFiles({
            "incoming/staging/rpm/fedora/41/test1.rpm": "",
            "incoming/staging/rpm/fedora/42/rest2.rpm": "",
            "incoming/staging/rpm/centos/9/fest3.rpm": "",
        })

        const res = await request(app).post("/api/v1/repo/import");
        expect(res.status).toBe(200);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'rpm', 'fedora', '41'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'rpm', 'fedora', '41'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'staging', 'rpm', 'fedora', '42'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'rpm', 'fedora', '42'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'staging', 'rpm', 'centos', '9'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'rpm', 'centos', '9'))).toHaveLength(0);


        expect(createrepoSpawn).toHaveLength(3);
        expect(createrepoSpawn.map(v => v.executable)).toEqual(["createrepo.sh", "createrepo.sh", "createrepo.sh"]);
        expect(createrepoSpawn.map(v => v.args.length)).toEqual([2, 2, 2]);
        expect(createrepoSpawn.map(v => v.args[1])).toEqual(["sign.sh", "sign.sh", "sign.sh"]);

        const fileContents: Record<string, Record<string, string>> = _.fromPairs(
            createrepoSpawn.map(v => [v.args[0], v.files]));
        expect(fileContents["repo/rpm/fedora/41"]).toBeDefined();
        expect(fileContents["repo/rpm/fedora/42"]).toBeDefined();
        expect(fileContents["repo/rpm/centos/9"]).toBeDefined();

        expect(Object.keys(fileContents["repo/rpm/fedora/41"])).toEqual(["t/test1.rpm"]);
        expect(Object.keys(fileContents["repo/rpm/fedora/42"])).toEqual(["r/rest2.rpm"]);
        expect(Object.keys(fileContents["repo/rpm/centos/9"])).toEqual(["f/fest3.rpm"]);
    }));

    test('Check that error is returned when RedHat createrepo tool startup fails', withLocalTmpDir(async () => {
        mockExecution(1, "", "", new Error("Cannot start script!"));

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoDir: "repo",
                createrepoScript: "createrepo.sh",
                signScript: "sign.sh"
            }
        });

        await createFiles({
            "incoming/staging/rpm/fedora/41/test.rpm": ""
        })

        const res = await request(app).post("/api/v1/repo/import");
        expect(res.status).toBe(500);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'rpm', 'fedora', '41'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'rpm', 'fedora', '41'))).toHaveLength(0);
    }));

    test('Check that error is returned when RedHat createrepo tool execution fails', withLocalTmpDir(async () => {
        mockExecution(1, "", "Script execution failed!");

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoDir: "repo",
                createrepoScript: "createrepo.sh",
                signScript: "sign.sh"
            }
        });

        await createFiles({
            "incoming/staging/rpm/fedora/41/test.rpm": ""
        })

        const res = await request(app).post("/api/v1/repo/import");
        expect(res.status).toBe(500);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'rpm', 'fedora', '41'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'rpm', 'fedora', '41'))).toHaveLength(0);
    }));
});
