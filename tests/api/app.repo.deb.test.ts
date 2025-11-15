// noinspection DuplicatedCode

import { createFiles, withLocalTmpDir } from "../utils.ts";
import request from "supertest";
import { jest } from "@jest/globals";
import fs from "fs/promises";
import osPath from "path";
import dedent from "dedent";
import { mockExecution } from "../mocks.ts";
import { glob } from "glob";
import assert from "node:assert";
import _ from "lodash";
import mockFs from "mock-fs";
import type { NextFunction, Request, RequestHandler, Response } from "express";

type CapturedState = {
    executable: string,
    args: string[],
    files: Record<string, string>
}

async function captureRepreproState(executable: string, args: string[]): Promise<CapturedState> {
    const capturedFiles: Record<string, string> = {};
    const confDirIndex = args.indexOf("--confdir");
    if (confDirIndex >= 0 && confDirIndex < args.length - 1) {
        let confDir = args[confDirIndex + 1];
        if (confDir.startsWith("+b/")) {
            confDir = confDir.slice(3);
        }
        const files = await glob("*", { cwd: confDir, nodir: true });
        await Promise.all(files.map(
            async (file) => {
                capturedFiles[file] = await fs.readFile(osPath.join(confDir, file), "utf8");
            }));
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

function parseDistributionsFile(repreproSpawn: CapturedState) {
    return _.fromPairs(repreproSpawn.files["distributions"].split(/\r?\n\r?\n/).map(
        (content) => {
            const match = content.match(/^Codename: (.*)$/m);
            expect(match).toBeTruthy();
            assert(match);
            expect(match[1]).toBeTruthy();
            return [match[1], content];
        }
    ));
}

describe('Test repository build scripts for Debian', () => {
    test('Check that Debian build config is correctly prepared for first package', withLocalTmpDir(async () => {
        const repreproSpawn: CapturedState[] = [];

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            repreproSpawn.push(await captureRepreproState(executable, args));
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoStateDir: "repo-state",
                repoDir: "repo",
                signScript: "sign.sh"
            }
        });

        await createFiles({
            "incoming/staging/deb/debian/bookworm/main/test.changes": dedent`
                Architecture: source amd64\n
            `
        })

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(200);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'deb', 'debian', 'bookworm', 'main'))).toEqual(['test.changes']);

        expect(repreproSpawn).toHaveLength(3);
        expect(repreproSpawn[0].executable).toBe("reprepro");

        const spawn0ConfDirIndex = repreproSpawn[0].args.indexOf("--confdir");
        expect(spawn0ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[0].args[spawn0ConfDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");

        const spawn0ProcessIncomingIndex = repreproSpawn[0].args.indexOf("processincoming");
        expect(spawn0ProcessIncomingIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[0].args[spawn0ProcessIncomingIndex + 1]).toBe("debian");

        expect(repreproSpawn[0].files["distributions"]).toBeDefined();
        expect(repreproSpawn[0].files["incoming"]).toBeDefined();
        expect(repreproSpawn[0].files["options"]).toBeDefined();
        expect(repreproSpawn[0].files["override"]).toBeDefined();

        expect(repreproSpawn[0].files["distributions"]).toIncludeRepeated("Codename:", 1);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Codename: bookworm$/m);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Suite: bookworm$/m);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Components: .+/m);
        const components = repreproSpawn[0].files["distributions"].match(/^Components: (.+)$/m)![1].split(/\s+/);
        expect(components).toIncludeSameMembers(["main"]);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Architectures: .+/m);
        const architectures = repreproSpawn[0].files["distributions"].match(/^Architectures: (.+)$/m)![1].split(/\s+/);
        expect(architectures).toIncludeSameMembers(["source", "amd64"]);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^SignWith: !\+b\/sign\.sh$/m);
        expect(repreproSpawn[0].files["distributions"]).not.toMatch(/^DDebComponents: .+/m);

        expect(repreproSpawn[0].files["incoming"]).toMatch(/^IncomingDir: incoming\/process\/deb\/debian\/bookworm\/main$/m);
        expect(repreproSpawn[0].files["incoming"]).toMatch(/^TempDir: repo-state\/deb-debian\/tmp-bookworm$/m);
        expect(repreproSpawn[0].files["incoming"]).toMatch(/^Allow: bookworm$/m);

        expect(repreproSpawn[0].files["options"]).toMatch(/^outdir \+b\/repo\/deb\/debian$/m);
        expect(repreproSpawn[0].files["options"]).toMatch(/^dbdir \+b\/repo-state\/deb-debian\/db$/m);

        expect(repreproSpawn[0].files["override"]).toMatch(/\$Component main$/m);

        const spawn1ConfDirIndex = repreproSpawn[1].args.indexOf("--confdir");
        expect(spawn1ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[1].args[spawn1ConfDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");
        expect(repreproSpawn[1].args).toIncludeAllMembers(["export"]);

        const spawn2ConfDirIndex = repreproSpawn[2].args.indexOf("--confdir");
        expect(spawn2ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[2].args[spawn2ConfDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");
        expect(repreproSpawn[2].args).toIncludeAllMembers(["clearvanished"]);
    }));

    test('Check that Debian build config is correctly prepared for first package also with ddeb file', withLocalTmpDir(async () => {
        const repreproSpawn: CapturedState[] = [];

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            repreproSpawn.push(await captureRepreproState(executable, args));
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoStateDir: "repo-state",
                repoDir: "repo",
                signScript: "sign.sh"
            }
        });

        await createFiles({
            "incoming/staging/deb/debian/bookworm/main/test.changes": dedent`
                Architecture: source amd64
                Files:
                 somepkg_1.0_amd64.ddeb\n
            `
        })

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(200);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'deb', 'debian', 'bookworm', 'main'))).toEqual(['test.changes']);

        expect(repreproSpawn).toHaveLength(3);
        expect(repreproSpawn[0].executable).toBe("reprepro");

        const confDirIndex = repreproSpawn[0].args.indexOf("--confdir");
        expect(confDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[0].args[confDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");

        const processIncomingIndex = repreproSpawn[0].args.indexOf("processincoming");
        expect(processIncomingIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[0].args[processIncomingIndex + 1]).toBe("debian");

        expect(repreproSpawn[0].files["distributions"]).toBeDefined();
        expect(repreproSpawn[0].files["incoming"]).toBeDefined();
        expect(repreproSpawn[0].files["options"]).toBeDefined();
        expect(repreproSpawn[0].files["override"]).toBeDefined();

        expect(repreproSpawn[0].files["distributions"]).toIncludeRepeated("Codename:", 1);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Codename: bookworm$/m);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Suite: bookworm$/m);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Components: .+/m);
        const components = repreproSpawn[0].files["distributions"].match(/^Components: (.+)$/m)![1].split(/\s+/);
        expect(components).toIncludeSameMembers(["main"]);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^DDebComponents: .+/m);
        const ddebComponents = repreproSpawn[0].files["distributions"].match(/^DDebComponents: (.+)$/m)![1].split(/\s+/);
        expect(ddebComponents).toIncludeSameMembers(["main"]);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Architectures: .+/m);
        const architectures = repreproSpawn[0].files["distributions"].match(/^Architectures: (.+)$/m)![1].split(/\s+/);
        expect(architectures).toIncludeSameMembers(["source", "amd64"]);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^SignWith: !\+b\/sign\.sh$/m);

        expect(repreproSpawn[0].files["incoming"]).toMatch(/^IncomingDir: incoming\/process\/deb\/debian\/bookworm\/main$/m);
        expect(repreproSpawn[0].files["incoming"]).toMatch(/^TempDir: repo-state\/deb-debian\/tmp-bookworm$/m);
        expect(repreproSpawn[0].files["incoming"]).toMatch(/^Allow: bookworm$/m);

        expect(repreproSpawn[0].files["options"]).toMatch(/^outdir \+b\/repo\/deb\/debian$/m);
        expect(repreproSpawn[0].files["options"]).toMatch(/^dbdir \+b\/repo-state\/deb-debian\/db$/m);

        expect(repreproSpawn[0].files["override"]).toMatch(/\$Component main$/m);

        const spawn1ConfDirIndex = repreproSpawn[1].args.indexOf("--confdir");
        expect(spawn1ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[1].args[spawn1ConfDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");
        expect(repreproSpawn[1].args).toIncludeAllMembers(["export"]);

        const spawn2ConfDirIndex = repreproSpawn[2].args.indexOf("--confdir");
        expect(spawn2ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[2].args[spawn2ConfDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");
        expect(repreproSpawn[2].args).toIncludeAllMembers(["clearvanished"]);
    }));

    test('Check that Debian build config is prepared when RedHat createrepo_c is unavailable', withLocalTmpDir(async () => {
        const repreproSpawn: CapturedState[] = [];

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            repreproSpawn.push(await captureRepreproState(executable, args));
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoStateDir: "repo-state",
                repoDir: "repo",
                signScript: "sign.sh"
            }
        });

        await createFiles({
            "incoming/staging/deb/debian/bookworm/main/test.changes": dedent`
                Architecture: source amd64\n
            `
        })

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(200);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'deb', 'debian', 'bookworm', 'main'))).toEqual(['test.changes']);

        expect(repreproSpawn).toHaveLength(3);
    }));

    test('Check Debian build config with no GPG key', withLocalTmpDir(async () => {
        const repreproSpawn: CapturedState[] = [];

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            repreproSpawn.push(await captureRepreproState(executable, args));
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoStateDir: "repo-state",
                repoDir: "repo",
            }
        });

        await createFiles({
            "incoming/staging/deb/debian/bookworm/main/test.changes": dedent`
                Architecture: source amd64\n
            `
        })

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(200);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'deb', 'debian', 'bookworm', 'main'))).toEqual(['test.changes']);

        expect(repreproSpawn).toHaveLength(3);
        expect(repreproSpawn[0].executable).toBe("reprepro");

        const confDirIndex = repreproSpawn[0].args.indexOf("--confdir");
        expect(confDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[0].args[confDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");

        const processIncomingIndex = repreproSpawn[0].args.indexOf("processincoming");
        expect(processIncomingIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[0].args[processIncomingIndex + 1]).toBe("debian");

        expect(repreproSpawn[0].files["distributions"]).toBeDefined();
        expect(repreproSpawn[0].files["incoming"]).toBeDefined();
        expect(repreproSpawn[0].files["options"]).toBeDefined();
        expect(repreproSpawn[0].files["override"]).toBeDefined();

        expect(repreproSpawn[0].files["distributions"]).toIncludeRepeated("Codename:", 1);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Codename: bookworm$/m);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Suite: bookworm$/m);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Components: .+/m);
        const components = repreproSpawn[0].files["distributions"].match(/^Components: (.+)$/m)![1].split(/\s+/);
        expect(components).toIncludeSameMembers(["main"]);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Architectures: .+/m);
        const architectures = repreproSpawn[0].files["distributions"].match(/^Architectures: (.+)$/m)![1].split(/\s+/);
        expect(architectures).toIncludeSameMembers(["source", "amd64"]);
        expect(repreproSpawn[0].files["distributions"]).not.toMatch(/^SignWith:.*$/m);
        expect(repreproSpawn[0].files["distributions"]).not.toMatch(/^DDebComponents: .+/m);

        expect(repreproSpawn[0].files["incoming"]).toMatch(/^IncomingDir: incoming\/process\/deb\/debian\/bookworm\/main$/m);
        expect(repreproSpawn[0].files["incoming"]).toMatch(/^TempDir: repo-state\/deb-debian\/tmp-bookworm$/m);
        expect(repreproSpawn[0].files["incoming"]).toMatch(/^Allow: bookworm$/m);

        expect(repreproSpawn[0].files["options"]).toMatch(/^outdir \+b\/repo\/deb\/debian$/m);
        expect(repreproSpawn[0].files["options"]).toMatch(/^dbdir \+b\/repo-state\/deb-debian\/db$/m);

        expect(repreproSpawn[0].files["override"]).toMatch(/\$Component main$/m);

        const spawn1ConfDirIndex = repreproSpawn[1].args.indexOf("--confdir");
        expect(spawn1ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[1].args[spawn1ConfDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");
        expect(repreproSpawn[1].args).toIncludeAllMembers(["export"]);

        const spawn2ConfDirIndex = repreproSpawn[2].args.indexOf("--confdir");
        expect(spawn2ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[2].args[spawn2ConfDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");
        expect(repreproSpawn[2].args).toIncludeAllMembers(["clearvanished"]);
    }));

    test('Check that Debian build config is correctly prepared for absolute paths', withLocalTmpDir(async () => {
        const repreproSpawn: CapturedState[] = [];

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            repreproSpawn.push(await captureRepreproState(executable, args));
        });

        jest.unstable_mockModule("../../server/api/files", () => ({
            default: jest.fn(
                (): RequestHandler => { return async (_req: Request, _res: Response, next: NextFunction) => next() })
        }));

        const createTestApp = (await import("../testapp.ts")).default;

        let res;
        try {
            mockFs({
                "/incoming/staging/deb/debian/bookworm/main/test.changes": dedent`
                Architecture: source amd64\n
            `
            });

            const app = await createTestApp({
                paths: {
                    incomingDir: "/incoming",
                    repoStateDir: "/repo-state",
                    repoDir: "/repo",
                    signScript: "/sign.sh"
                }
            });

            res = await request(app).post("/upload/build-repo");

            expect(res.status).toBe(200);

            expect(await fs.readdir(osPath.join('/incoming', 'staging', 'deb', 'debian', 'bookworm', 'main'))).toHaveLength(0);
            expect(await fs.readdir(osPath.join('/incoming', 'process', 'deb', 'debian', 'bookworm', 'main'))).toEqual(['test.changes']);
        } finally {
            mockFs.restore();
        }

        expect(repreproSpawn).toHaveLength(3);
        expect(repreproSpawn[0].executable).toBe("reprepro");

        const confDirIndex = repreproSpawn[0].args.indexOf("--confdir");
        expect(confDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[0].args[confDirIndex + 1]).toEqual("/repo-state/deb-debian/conf");

        const processIncomingIndex = repreproSpawn[0].args.indexOf("processincoming");
        expect(processIncomingIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[0].args[processIncomingIndex + 1]).toBe("debian");

        expect(repreproSpawn[0].files["distributions"]).toBeDefined();
        expect(repreproSpawn[0].files["incoming"]).toBeDefined();
        expect(repreproSpawn[0].files["options"]).toBeDefined();
        expect(repreproSpawn[0].files["override"]).toBeDefined();

        expect(repreproSpawn[0].files["distributions"]).toIncludeRepeated("Codename:", 1);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Codename: bookworm$/m);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Suite: bookworm$/m);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Components: .+/m);
        const components = repreproSpawn[0].files["distributions"].match(/^Components: (.+)$/m)![1].split(/\s+/);
        expect(components).toIncludeSameMembers(["main"]);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Architectures: .+$/m);
        const architectures = repreproSpawn[0].files["distributions"].match(/^Architectures: (.*)$/m)![1].split(/\s+/);
        expect(architectures).toIncludeSameMembers(["source", "amd64"]);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^SignWith: !\/sign\.sh$/m);

        expect(repreproSpawn[0].files["incoming"]).toMatch(/^IncomingDir: \/incoming\/process\/deb\/debian\/bookworm\/main$/m);
        expect(repreproSpawn[0].files["incoming"]).toMatch(/^TempDir: \/repo-state\/deb-debian\/tmp-bookworm$/m);
        expect(repreproSpawn[0].files["incoming"]).toMatch(/^Allow: bookworm$/m);

        expect(repreproSpawn[0].files["options"]).toMatch(/^outdir \/repo\/deb\/debian$/m);
        expect(repreproSpawn[0].files["options"]).toMatch(/^dbdir \/repo-state\/deb-debian\/db$/m);

        expect(repreproSpawn[0].files["override"]).toMatch(/\$Component main$/m);

        const spawn1ConfDirIndex = repreproSpawn[1].args.indexOf("--confdir");
        expect(spawn1ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[1].args[spawn1ConfDirIndex + 1]).toEqual("/repo-state/deb-debian/conf");
        expect(repreproSpawn[1].args).toIncludeAllMembers(["export"]);

        const spawn2ConfDirIndex = repreproSpawn[2].args.indexOf("--confdir");
        expect(spawn2ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[2].args[spawn2ConfDirIndex + 1]).toEqual("/repo-state/deb-debian/conf");
        expect(repreproSpawn[2].args).toIncludeAllMembers(["clearvanished"]);
    }));

    test('Check that Debian build config is correctly updated when distribution files exist', withLocalTmpDir(async () => {
        const repreproSpawn: CapturedState[] = [];

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            repreproSpawn.push(await captureRepreproState(executable, args));
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoStateDir: "repo-state",
                repoDir: "repo",
                signScript: "sign.sh"
            }
        });

        await createFiles({
            "incoming/staging/deb/debian/bookworm/update/test.changes": dedent`
            Architecture: source amd64\n
        `,
            "repo-state/deb-debian/conf/distributions": dedent`
            Codename: bookworm
            Suite: bookworm
            Architectures: source armhf
            Components: main\n
        `
        })

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(200);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'update'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'deb', 'debian', 'bookworm', 'update'))).toEqual(['test.changes']);

        expect(repreproSpawn).toHaveLength(3);
        expect(repreproSpawn[0].executable).toBe("reprepro");

        const confDirIndex = repreproSpawn[0].args.indexOf("--confdir");
        expect(confDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[0].args[confDirIndex + 1]).toMatchGlob("+b/repo-state/deb-debian/conf");

        const processIncomingIndex = repreproSpawn[0].args.indexOf("processincoming");
        expect(processIncomingIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[0].args[processIncomingIndex + 1]).toBe("debian");

        expect(repreproSpawn[0].files["distributions"]).toBeDefined();
        expect(repreproSpawn[0].files["incoming"]).toBeDefined();
        expect(repreproSpawn[0].files["options"]).toBeDefined();
        expect(repreproSpawn[0].files["override"]).toBeDefined();

        expect(repreproSpawn[0].files["distributions"]).toIncludeRepeated("Codename:", 1);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Codename: bookworm$/m);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Suite: bookworm$/m);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Components: .+/m);
        const components = repreproSpawn[0].files["distributions"].match(/^Components: (.+)$/m)![1].split(/\s+/);
        expect(components).toIncludeSameMembers(["main", "update"]);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^Architectures: .+/m);
        const architectures = repreproSpawn[0].files["distributions"].match(/^Architectures: (.+)$/m)![1].split(/\s+/);
        expect(architectures).toIncludeSameMembers(["source", "amd64", "armhf"]);
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^SignWith: !\+b\/sign\.sh$/m);

        expect(repreproSpawn[0].files["incoming"]).toMatch(/^IncomingDir: incoming\/process\/deb\/debian\/bookworm\/update$/m);
        expect(repreproSpawn[0].files["incoming"]).toMatch(/^TempDir: repo-state\/deb-debian\/tmp-bookworm$/m);
        expect(repreproSpawn[0].files["incoming"]).toMatch(/^Allow: bookworm$/m);

        expect(repreproSpawn[0].files["options"]).toMatch(/^outdir \+b\/repo\/deb\/debian$/m);
        expect(repreproSpawn[0].files["options"]).toMatch(/^dbdir \+b\/repo-state\/deb-debian\/db$/m);

        expect(repreproSpawn[0].files["override"]).toMatch(/\$Component update$/m);

        const spawn1ConfDirIndex = repreproSpawn[1].args.indexOf("--confdir");
        expect(spawn1ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[1].args[spawn1ConfDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");
        expect(repreproSpawn[1].args).toIncludeAllMembers(["export"]);

        const spawn2ConfDirIndex = repreproSpawn[2].args.indexOf("--confdir");
        expect(spawn2ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[2].args[spawn2ConfDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");
        expect(repreproSpawn[2].args).toIncludeAllMembers(["clearvanished"]);
    }));

    test('Check that Debian build config is correctly updated when distribution files exist for multiple releases', withLocalTmpDir(async () => {
        const repreproSpawn: CapturedState[] = [];

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            repreproSpawn.push(await captureRepreproState(executable, args));
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoStateDir: "repo-state",
                repoDir: "repo",
                signScript: "sign.sh"
            }
        });

        await createFiles({
            "incoming/staging/deb/debian/bookworm/update/test.changes": dedent`
            Architecture: source amd64
            Files:
             somepkg_1.0_amd64.ddeb\n
        `,
            "repo-state/deb-debian/conf/distributions": dedent`
            Codename: bookworm
            Suite: bookworm
            Architectures: source armhf
            Components: main\n

            Codename: bullseye
            Suite: bullseye
            Architectures: arm64 i386
            Components: test extra
            DDebComponents: extra\n
        `
        })

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(200);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'update'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'deb', 'debian', 'bookworm', 'update'))).toEqual(['test.changes']);

        expect(repreproSpawn).toHaveLength(3);
        expect(repreproSpawn[0].executable).toBe("reprepro");

        const confDirIndex = repreproSpawn[0].args.indexOf("--confdir");
        expect(confDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[0].args[confDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");

        const processIncomingIndex = repreproSpawn[0].args.indexOf("processincoming");
        expect(processIncomingIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[0].args[processIncomingIndex + 1]).toBe("debian");

        expect(repreproSpawn[0].files["distributions"]).toBeDefined();
        expect(repreproSpawn[0].files["incoming"]).toBeDefined();
        expect(repreproSpawn[0].files["options"]).toBeDefined();
        expect(repreproSpawn[0].files["override"]).toBeDefined();

        expect(repreproSpawn[0].files["distributions"]).toIncludeRepeated("Codename:", 2);
        const releases = parseDistributionsFile(repreproSpawn[0]);

        expect(releases["bookworm"]).toBeDefined();
        expect(releases["bookworm"]).toMatch(/^Codename: bookworm$/m);
        expect(releases["bookworm"]).toMatch(/^Suite: bookworm$/m);
        expect(releases["bookworm"]).toMatch(/^Components: .+/m);
        const bookwormComponents = releases["bookworm"].match(/^Components: (.+)$/m)![1].split(/\s+/);
        expect(bookwormComponents).toIncludeSameMembers(["main", "update"]);
        expect(releases["bookworm"]).toMatch(/^DDebComponents: .+/m);
        const bookwormDdeb = releases["bookworm"].match(/^DDebComponents: (.+)$/m)![1].split(/\s+/);
        expect(bookwormDdeb).toIncludeSameMembers(["update"]);
        expect(releases["bookworm"]).toMatch(/^Architectures: .+$/m);
        const bookwormArchitectures = releases["bookworm"].match(/^Architectures: (.*)$/m)![1].split(/\s+/);
        expect(bookwormArchitectures).toIncludeSameMembers(["source", "amd64", "armhf"]);
        expect(releases["bookworm"]).toMatch(/^SignWith: !\+b\/sign\.sh$/m);

        expect(releases["bullseye"]).toBeDefined();
        expect(releases["bullseye"]).toMatch(/^Codename: bullseye$/m);
        expect(releases["bullseye"]).toMatch(/^Suite: bullseye$/m);
        expect(releases["bullseye"]).toMatch(/^Components: .+/m);
        const bullseyeComponents = releases["bullseye"].match(/^Components: (.*)$/m)![1].split(/\s+/);
        expect(bullseyeComponents).toIncludeSameMembers(["test", "extra"]);
        expect(releases["bullseye"]).toMatch(/^DDebComponents: .+/m);
        const bullseyeDdeb = releases["bullseye"].match(/^DDebComponents: (.+)$/m)![1].split(/\s+/);
        expect(bullseyeDdeb).toIncludeSameMembers(["extra"]);
        expect(releases["bullseye"]).toMatch(/^Architectures: .+$/m);
        const bullseyeArchitectures = releases["bullseye"].match(/^Architectures: (.*)$/m)![1].split(/\s+/);
        expect(bullseyeArchitectures).toIncludeSameMembers(["arm64", "i386"]);
        expect(releases["bullseye"]).toMatch(/^SignWith: !\+b\/sign\.sh$/m);

        expect(repreproSpawn[0].files["incoming"]).toMatch(/^IncomingDir: incoming\/process\/deb\/debian\/bookworm\/update$/m);
        expect(repreproSpawn[0].files["incoming"]).toMatch(/^TempDir: repo-state\/deb-debian\/tmp-bookworm$/m);
        expect(repreproSpawn[0].files["incoming"]).toMatch(/^Allow: bookworm$/m);

        expect(repreproSpawn[0].files["options"]).toMatch(/^outdir \+b\/repo\/deb\/debian$/m);
        expect(repreproSpawn[0].files["options"]).toMatch(/^dbdir \+b\/repo-state\/deb-debian\/db$/m);

        expect(repreproSpawn[0].files["override"]).toMatch(/\$Component update$/m);

        const spawn1ConfDirIndex = repreproSpawn[1].args.indexOf("--confdir");
        expect(spawn1ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[1].args[spawn1ConfDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");
        expect(repreproSpawn[1].args).toIncludeAllMembers(["export"]);

        const spawn2ConfDirIndex = repreproSpawn[2].args.indexOf("--confdir");
        expect(spawn2ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[2].args[spawn2ConfDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");
        expect(repreproSpawn[2].args).toIncludeAllMembers(["clearvanished"]);
    }));

    test('Check that Debian build config is correctly updated when distribution files exist for multiple distributions', withLocalTmpDir(async () => {
        const repreproSpawn: Record<string, CapturedState> = {};

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            const confDirIndex = args.indexOf("--confdir");
            if (confDirIndex >= 0 && confDirIndex < args.length - 1) {
                const confDir = args[confDirIndex + 1];
                if (!repreproSpawn[confDir]) {
                    repreproSpawn[confDir] = await captureRepreproState(executable, args);
                }
            }
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoStateDir: "repo-state",
                repoDir: "repo",
                signScript: "sign.sh"
            }
        });

        await createFiles({
            "incoming/staging/deb/debian/bookworm/main/test.changes": dedent`
            Architecture: source amd64\n
        `,
            "incoming/staging/deb/ubuntu/noble/universe/test.changes": dedent`
            Architecture: source amd64\n
        `,
        })

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(200);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'deb', 'debian', 'bookworm', 'main'))).toEqual(['test.changes']);
        expect(await fs.readdir(osPath.join('incoming', 'staging', 'deb', 'ubuntu', 'noble', 'universe'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'deb', 'ubuntu', 'noble', 'universe'))).toEqual(['test.changes']);

        expect(Object.keys(repreproSpawn)).toHaveLength(2);
        expect(repreproSpawn["+b/repo-state/deb-debian/conf"]).toBeDefined();
        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"]).toBeDefined();
        expect(Object.values(repreproSpawn).map(v => v.executable)).toEqual(["reprepro", "reprepro"]);
        expect(Object.values(repreproSpawn).map(v => v.args))
            .toEqual([expect.toBeArrayOfSize(6), expect.toBeArrayOfSize(6)]);
        expect(Object.values(repreproSpawn).map(v => v.args))
            .toEqual([expect.toIncludeAllMembers(["--confdir"]), expect.toIncludeAllMembers(["--confdir"])]);

        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].args).toContain("debian");
        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].args).toContain("ubuntu");

        // Test Debian values
        const debianProcessIncomingIndex = repreproSpawn["+b/repo-state/deb-debian/conf"].args.indexOf(
            "processincoming");
        expect(debianProcessIncomingIndex).toBeGreaterThan(-1);
        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].args[debianProcessIncomingIndex + 1]).toBe("debian");

        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].files["distributions"]).toBeDefined();
        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].files["incoming"]).toBeDefined();
        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].files["options"]).toBeDefined();
        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].files["override"]).toBeDefined();

        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].files["distributions"])
            .toIncludeRepeated("Codename:", 1);
        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].files["distributions"])
            .toMatch(/^Codename: bookworm$/m);
        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].files["distributions"]).toMatch(/^Suite: bookworm$/m);
        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].files["distributions"]).toMatch(/^Components: .+/m);
        const debianComponents = repreproSpawn["+b/repo-state/deb-debian/conf"].files["distributions"].match(
            /^Components: (.+)$/m)![1].split(/\s+/);
        expect(debianComponents).toEqual(["main"]);
        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].files["distributions"])
            .toMatch(/^Architectures: .+/m);
        const debianArchitectures = repreproSpawn["+b/repo-state/deb-debian/conf"].files["distributions"].match(
            /^Architectures: (.+)$/m)![1].split(/\s+/);
        expect(debianArchitectures).toIncludeSameMembers(["source", "amd64"]);
        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].files["distributions"])
            .toMatch(/^SignWith: !\+b\/sign\.sh$/m);

        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].files["incoming"])
            .toMatch(/^IncomingDir: incoming\/process\/deb\/debian\/bookworm\/main$/m);
        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].files["incoming"])
            .toMatch(/^TempDir: repo-state\/deb-debian\/tmp-bookworm$/m);
        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].files["incoming"]).toMatch(/^Allow: bookworm$/m);

        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].files["options"])
            .toMatch(/^outdir \+b\/repo\/deb\/debian$/m);
        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].files["options"])
            .toMatch(/^dbdir \+b\/repo-state\/deb-debian\/db$/m);

        expect(repreproSpawn["+b/repo-state/deb-debian/conf"].files["override"]).toMatch(/\$Component main$/m);

        // Test Ubuntu values
        const processIncomingIndex = repreproSpawn["+b/repo-state/deb-ubuntu/conf"].args.indexOf("processincoming");
        expect(processIncomingIndex).toBeGreaterThan(-1);
        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].args[processIncomingIndex + 1]).toBe("ubuntu");

        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["distributions"]).toBeDefined();
        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["incoming"]).toBeDefined();
        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["options"]).toBeDefined();
        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["override"]).toBeDefined();

        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["distributions"])
            .toIncludeRepeated("Codename:", 1);
        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["distributions"]).toMatch(/^Codename: noble$/m);
        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["distributions"]).toMatch(/^Suite: noble$/m);
        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["distributions"]).toMatch(/^Components: .+/m);
        const ubuntuComponents = repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["distributions"].match(
            /^Components: (.+)$/m)![1].split(/\s+/);
        expect(ubuntuComponents).toEqual(["universe"]);
        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["distributions"])
            .toMatch(/^Architectures: .+/m);
        const ubuntuArchitectures = repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["distributions"].match(
            /^Architectures: (.+)$/m)![1].split(/\s+/);
        expect(ubuntuArchitectures).toIncludeSameMembers(["source", "amd64"]);
        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["distributions"])
            .toMatch(/^SignWith: !\+b\/sign\.sh$/m);

        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["incoming"])
            .toMatch(/^IncomingDir: incoming\/process\/deb\/ubuntu\/noble\/universe$/m);
        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["incoming"])
            .toMatch(/^TempDir: repo-state\/deb-ubuntu\/tmp-noble$/m);
        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["incoming"]).toMatch(/^Allow: noble$/m);

        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["options"])
            .toMatch(/^outdir \+b\/repo\/deb\/ubuntu$/m);
        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["options"])
            .toMatch(/^dbdir \+b\/repo-state\/deb-ubuntu\/db$/m);

        expect(repreproSpawn["+b/repo-state/deb-ubuntu/conf"].files["override"]).toMatch(/\$Component universe$/m);
    }));

    test('Check that DDebComponents is correctly updated when ddeb is the last file without newline', withLocalTmpDir(async () => {
        const repreproSpawn: CapturedState[] = [];

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            repreproSpawn.push(await captureRepreproState(executable, args));
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoStateDir: "repo-state",
                repoDir: "repo",
                signScript: "sign.sh"
            }
        });

        await createFiles({
            "incoming/staging/deb/debian/bookworm/main/test.changes": dedent`
                Architecture: source amd64
                Files:
                 somepkg_1.0_amd64.deb
                 somepkg_1.0_amd64.ddeb
            `
        })

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(200);

        expect(repreproSpawn).toHaveLength(3);
        expect(repreproSpawn[0].files).toBeDefined();
        expect(repreproSpawn[0].files["distributions"]).toBeDefined();
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^DDebComponents: .+/m);
        const ddebComponents = repreproSpawn[0].files["distributions"].match(/^DDebComponents: (.+)$/m)![1].split(/\s+/);
        expect(ddebComponents).toIncludeSameMembers(["main"]);
    }));

    test('Check that DDebComponents is correctly updated when ddeb is the first file', withLocalTmpDir(async () => {
        const repreproSpawn: CapturedState[] = [];

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            repreproSpawn.push(await captureRepreproState(executable, args));
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoStateDir: "repo-state",
                repoDir: "repo",
                signScript: "sign.sh"
            }
        });

        await createFiles({
            "incoming/staging/deb/debian/bookworm/main/test.changes": dedent`
                Architecture: source amd64
                Files:
                 somepkg_1.0_amd64.ddeb
                 somepkg_1.0_amd64.deb\n
            `
        })

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(200);

        expect(repreproSpawn).toHaveLength(3);
        expect(repreproSpawn[0].files).toBeDefined();
        expect(repreproSpawn[0].files["distributions"]).toBeDefined();
        expect(repreproSpawn[0].files["distributions"]).toMatch(/^DDebComponents: .+/m);
        const ddebComponents = repreproSpawn[0].files["distributions"].match(/^DDebComponents: (.+)$/m)![1].split(/\s+/);
        expect(ddebComponents).toIncludeSameMembers(["main"]);
    }));

    test('Check that export and clearvanished are called when distributions exist and no incoming files', withLocalTmpDir(async () => {
        const repreproSpawn: CapturedState[] = [];

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            repreproSpawn.push(await captureRepreproState(executable, args));
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoStateDir: "repo-state",
                repoDir: "repo",
                signScript: "sign.sh"
            }
        });

        await createFiles({
            "repo-state/deb-debian/conf/distributions": dedent`
                Codename: bookworm
                Suite: bookworm
                Components: main
                Architectures: source amd64
            `
        });

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(200);

        await expect(fs.readdir(osPath.join("incoming", "process", "deb"))).resolves.toEqual([]);

        expect(repreproSpawn).toHaveLength(2);

        const spawn0ConfDirIndex = repreproSpawn[0].args.indexOf("--confdir");
        expect(spawn0ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[0].args[spawn0ConfDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");
        expect(repreproSpawn[0].args).toIncludeAllMembers(["export"]);

        const spawn1ConfDirIndex = repreproSpawn[1].args.indexOf("--confdir");
        expect(spawn1ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[1].args[spawn1ConfDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");
        expect(repreproSpawn[1].args).toIncludeAllMembers(["clearvanished"]);
    }));

    test('Check that export and clearvanished are called on multiple distributions (debian, ubuntu) when no incoming files exist', withLocalTmpDir(async () => {
        const repreproSpawn: CapturedState[] = [];

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            repreproSpawn.push(await captureRepreproState(executable, args));
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoStateDir: "repo-state",
                repoDir: "repo",
                signScript: "sign.sh"
            }
        });

        // Prepare existing distribution configuration for Debian and Ubuntu, but no incoming .changes files
        await createFiles({
            "repo-state/deb-debian/conf/distributions": dedent`
                Codename: bookworm
                Suite: bookworm
                Components: main
                Architectures: source amd64
            `,
            "repo-state/deb-ubuntu/conf/distributions": dedent`
                Codename: noble
                Suite: noble
                Components: universe
                Architectures: source amd64
            `
        });

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(200);

        await expect(fs.readdir(osPath.join("incoming", "process", "deb"))).resolves.toEqual([]);

        expect(repreproSpawn).toHaveLength(4);

        const expectedConfDirs = ["+b/repo-state/deb-debian/conf", "+b/repo-state/deb-ubuntu/conf"];

        const spawn0ConfDirIndex = repreproSpawn[0].args.indexOf("--confdir");
        expect(spawn0ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[0].args[spawn0ConfDirIndex + 1]).toBeOneOf(expectedConfDirs);
        expect(repreproSpawn[0].args).toIncludeAllMembers(["export"]);

        const spawn1ConfDirIndex = repreproSpawn[1].args.indexOf("--confdir");
        expect(spawn1ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[1].args[spawn1ConfDirIndex + 1]).toEqual(repreproSpawn[0].args[spawn0ConfDirIndex + 1]);
        expect(repreproSpawn[1].args).toIncludeAllMembers(["clearvanished"]);

        expectedConfDirs.splice(expectedConfDirs.indexOf(repreproSpawn[0].args[spawn0ConfDirIndex + 1]), 1);

        const spawn2ConfDirIndex = repreproSpawn[2].args.indexOf("--confdir");
        expect(spawn2ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[2].args[spawn2ConfDirIndex + 1]).toBeOneOf(expectedConfDirs);
        expect(repreproSpawn[2].args).toIncludeAllMembers(["export"]);

        const spawn3ConfDirIndex = repreproSpawn[3].args.indexOf("--confdir");
        expect(spawn3ConfDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn[3].args[spawn3ConfDirIndex + 1]).toEqual(repreproSpawn[2].args[spawn2ConfDirIndex + 1]);
        expect(repreproSpawn[3].args).toIncludeAllMembers(["clearvanished"]);

    }));

    test('Check that error is returned when Debian reprepro tool startup fails', withLocalTmpDir(async () => {
        mockExecution(0, "", "", new Error("Cannot start script!"));

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoStateDir: "repo-state",
                repoDir: "repo",
                signScript: "sign.sh"
            }
        });

        await createFiles({
            "incoming/staging/deb/debian/bookworm/main/test.changes": dedent`
                Architecture: source amd64\n
            `
        })

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(500);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'deb', 'debian', 'bookworm', 'main'))).toEqual(['test.changes']);
    }));

    test('Check that error is returned when Debian reprepro tool execution fails', withLocalTmpDir(async () => {
        mockExecution(1, "", "Script execution failed!");

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoStateDir: "repo-state",
                repoDir: "repo",
                signScript: "sign.sh"
            }
        });

        await createFiles({
            "incoming/staging/deb/debian/bookworm/main/test.changes": dedent`
                Architecture: source amd64\n
            `
        })

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(500);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'deb', 'debian', 'bookworm', 'main'))).toEqual(['test.changes']);
    }));

});
