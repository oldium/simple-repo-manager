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

describe('Test repository build scripts', () => {
    test('Check that Debian build config is correctly prepared for first package', withLocalTmpDir(async () => {
        let repreproSpawn: CapturedState | undefined;

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            if (!repreproSpawn) {
                repreproSpawn = await captureRepreproState(executable, args);
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
            `
        })

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(200);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'deb', 'debian', 'bookworm', 'main'))).toEqual(['test.changes']);

        expect(repreproSpawn).toBeDefined();
        assert(repreproSpawn);
        expect(repreproSpawn.executable).toBe("reprepro");

        const confDirIndex = repreproSpawn.args.indexOf("--confdir");
        expect(confDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn.args[confDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");

        const processIncomingIndex = repreproSpawn.args.indexOf("processincoming");
        expect(processIncomingIndex).toBeGreaterThan(-1);
        expect(repreproSpawn.args[processIncomingIndex + 1]).toBe("debian");

        expect(repreproSpawn.files["distributions"]).toBeDefined();
        expect(repreproSpawn.files["incoming"]).toBeDefined();
        expect(repreproSpawn.files["options"]).toBeDefined();
        expect(repreproSpawn.files["override"]).toBeDefined();

        expect(repreproSpawn.files["distributions"]).toIncludeRepeated("Codename:", 1);
        expect(repreproSpawn.files["distributions"]).toMatch(/^Codename: bookworm$/m);
        expect(repreproSpawn.files["distributions"]).toMatch(/^Suite: bookworm$/m);
        expect(repreproSpawn.files["distributions"]).toMatch(/^Components: .+/m);
        const components = repreproSpawn.files["distributions"].match(/^Components: (.+)$/m)![1].split(/\s+/);
        expect(components).toIncludeSameMembers(["main"]);
        expect(repreproSpawn.files["distributions"]).toMatch(/^Architectures: .+/m);
        const architectures = repreproSpawn.files["distributions"].match(/^Architectures: (.+)$/m)![1].split(/\s+/);
        expect(architectures).toIncludeSameMembers(["source", "amd64"]);
        expect(repreproSpawn.files["distributions"]).toMatch(/^SignWith: !\+b\/sign\.sh$/m);

        expect(repreproSpawn.files["incoming"]).toMatch(/^IncomingDir: incoming\/process\/deb\/debian\/bookworm\/main$/m);
        expect(repreproSpawn.files["incoming"]).toMatch(/^TempDir: repo-state\/deb-debian\/tmp-bookworm$/m);
        expect(repreproSpawn.files["incoming"]).toMatch(/^Allow: bookworm$/m);

        expect(repreproSpawn.files["options"]).toMatch(/^outdir \+b\/repo\/deb\/debian$/m);
        expect(repreproSpawn.files["options"]).toMatch(/^dbdir \+b\/repo-state\/deb-debian\/db$/m);

        expect(repreproSpawn.files["override"]).toMatch(/\$Component main$/m);
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

        expect(repreproSpawn).toHaveLength(2);
    }));

    test('Check Debian build config with no GPG key', withLocalTmpDir(async () => {
        let repreproSpawn: CapturedState | undefined;

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            if (!repreproSpawn) {
                repreproSpawn = await captureRepreproState(executable, args);
            }
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

        expect(repreproSpawn).toBeDefined();
        assert(repreproSpawn);
        expect(repreproSpawn.executable).toBe("reprepro");

        const confDirIndex = repreproSpawn.args.indexOf("--confdir");
        expect(confDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn.args[confDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");

        const processIncomingIndex = repreproSpawn.args.indexOf("processincoming");
        expect(processIncomingIndex).toBeGreaterThan(-1);
        expect(repreproSpawn.args[processIncomingIndex + 1]).toBe("debian");

        expect(repreproSpawn.files["distributions"]).toBeDefined();
        expect(repreproSpawn.files["incoming"]).toBeDefined();
        expect(repreproSpawn.files["options"]).toBeDefined();
        expect(repreproSpawn.files["override"]).toBeDefined();

        expect(repreproSpawn.files["distributions"]).toIncludeRepeated("Codename:", 1);
        expect(repreproSpawn.files["distributions"]).toMatch(/^Codename: bookworm$/m);
        expect(repreproSpawn.files["distributions"]).toMatch(/^Suite: bookworm$/m);
        expect(repreproSpawn.files["distributions"]).toMatch(/^Components: .+/m);
        const components = repreproSpawn.files["distributions"].match(/^Components: (.+)$/m)![1].split(/\s+/);
        expect(components).toIncludeSameMembers(["main"]);
        expect(repreproSpawn.files["distributions"]).toMatch(/^Architectures: .+/m);
        const architectures = repreproSpawn.files["distributions"].match(/^Architectures: (.+)$/m)![1].split(/\s+/);
        expect(architectures).toIncludeSameMembers(["source", "amd64"]);
        expect(repreproSpawn.files["distributions"]).not.toMatch(/^SignWith:.*$/m);

        expect(repreproSpawn.files["incoming"]).toMatch(/^IncomingDir: incoming\/process\/deb\/debian\/bookworm\/main$/m);
        expect(repreproSpawn.files["incoming"]).toMatch(/^TempDir: repo-state\/deb-debian\/tmp-bookworm$/m);
        expect(repreproSpawn.files["incoming"]).toMatch(/^Allow: bookworm$/m);

        expect(repreproSpawn.files["options"]).toMatch(/^outdir \+b\/repo\/deb\/debian$/m);
        expect(repreproSpawn.files["options"]).toMatch(/^dbdir \+b\/repo-state\/deb-debian\/db$/m);

        expect(repreproSpawn.files["override"]).toMatch(/\$Component main$/m);
    }));

    test('Check that Debian build config is correctly prepared for absolute paths', withLocalTmpDir(async () => {
        let repreproSpawn: CapturedState | undefined;

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            if (!repreproSpawn) {
                repreproSpawn = await captureRepreproState(executable, args);
            }
        });

        jest.unstable_mockModule("./server/api/files", () => ({
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

        expect(repreproSpawn).toBeDefined();
        assert(repreproSpawn);
        expect(repreproSpawn.executable).toBe("reprepro");

        const confDirIndex = repreproSpawn.args.indexOf("--confdir");
        expect(confDirIndex).toBeGreaterThan(-1);
        expect(repreproSpawn.args[confDirIndex + 1]).toEqual("/repo-state/deb-debian/conf");

        const processIncomingIndex = repreproSpawn.args.indexOf("processincoming");
        expect(processIncomingIndex).toBeGreaterThan(-1);
        expect(repreproSpawn.args[processIncomingIndex + 1]).toBe("debian");

        expect(repreproSpawn.files["distributions"]).toBeDefined();
        expect(repreproSpawn.files["incoming"]).toBeDefined();
        expect(repreproSpawn.files["options"]).toBeDefined();
        expect(repreproSpawn.files["override"]).toBeDefined();

        expect(repreproSpawn.files["distributions"]).toIncludeRepeated("Codename:", 1);
        expect(repreproSpawn.files["distributions"]).toMatch(/^Codename: bookworm$/m);
        expect(repreproSpawn.files["distributions"]).toMatch(/^Suite: bookworm$/m);
        expect(repreproSpawn.files["distributions"]).toMatch(/^Components: .+/m);
        const components = repreproSpawn.files["distributions"].match(/^Components: (.+)$/m)![1].split(/\s+/);
        expect(components).toIncludeSameMembers(["main"]);
        expect(repreproSpawn.files["distributions"]).toMatch(/^Architectures: .+$/m);
        const architectures = repreproSpawn.files["distributions"].match(/^Architectures: (.*)$/m)![1].split(/\s+/);
        expect(architectures).toIncludeSameMembers(["source", "amd64"]);
        expect(repreproSpawn.files["distributions"]).toMatch(/^SignWith: !\/sign\.sh$/m);

        expect(repreproSpawn.files["incoming"]).toMatch(/^IncomingDir: \/incoming\/process\/deb\/debian\/bookworm\/main$/m);
        expect(repreproSpawn.files["incoming"]).toMatch(/^TempDir: \/repo-state\/deb-debian\/tmp-bookworm$/m);
        expect(repreproSpawn.files["incoming"]).toMatch(/^Allow: bookworm$/m);

        expect(repreproSpawn.files["options"]).toMatch(/^outdir \/repo\/deb\/debian$/m);
        expect(repreproSpawn.files["options"]).toMatch(/^dbdir \/repo-state\/deb-debian\/db$/m);

        expect(repreproSpawn.files["override"]).toMatch(/\$Component main$/m);
    }));

    test('Check that Debian build config is correctly updated when distribution files exist',
        withLocalTmpDir(async () => {
            let repreproSpawn: CapturedState | undefined;

            mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
                if (!repreproSpawn) {
                    repreproSpawn = await captureRepreproState(executable, args);
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
                "incoming/staging/deb/debian/bookworm/update/test.changes": dedent`
                Architecture: source amd64\n
            `,
                "repo/deb/debian/dists/bookworm/Release": dedent`
                Architectures: source armhf
                Components: main\n
            `
            })

            const res = await request(app).post("/upload/build-repo");
            expect(res.status).toBe(200);

            expect(await fs.readdir(osPath.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'update'))).toHaveLength(0);
            expect(await fs.readdir(osPath.join('incoming', 'process', 'deb', 'debian', 'bookworm', 'update'))).toEqual(['test.changes']);

            expect(repreproSpawn).toBeDefined();
            assert(repreproSpawn);
            expect(repreproSpawn.executable).toBe("reprepro");

            const confDirIndex = repreproSpawn.args.indexOf("--confdir");
            expect(confDirIndex).toBeGreaterThan(-1);
            expect(repreproSpawn.args[confDirIndex + 1]).toMatchGlob("+b/repo-state/deb-debian/conf");

            const processIncomingIndex = repreproSpawn.args.indexOf("processincoming");
            expect(processIncomingIndex).toBeGreaterThan(-1);
            expect(repreproSpawn.args[processIncomingIndex + 1]).toBe("debian");

            expect(repreproSpawn.files["distributions"]).toBeDefined();
            expect(repreproSpawn.files["incoming"]).toBeDefined();
            expect(repreproSpawn.files["options"]).toBeDefined();
            expect(repreproSpawn.files["override"]).toBeDefined();

            expect(repreproSpawn.files["distributions"]).toIncludeRepeated("Codename:", 1);
            expect(repreproSpawn.files["distributions"]).toMatch(/^Codename: bookworm$/m);
            expect(repreproSpawn.files["distributions"]).toMatch(/^Suite: bookworm$/m);
            expect(repreproSpawn.files["distributions"]).toMatch(/^Components: .+/m);
            const components = repreproSpawn.files["distributions"].match(/^Components: (.+)$/m)![1].split(/\s+/);
            expect(components).toIncludeSameMembers(["main", "update"]);
            expect(repreproSpawn.files["distributions"]).toMatch(/^Architectures: .+/m);
            const architectures = repreproSpawn.files["distributions"].match(/^Architectures: (.+)$/m)![1].split(/\s+/);
            expect(architectures).toIncludeSameMembers(["source", "amd64", "armhf"]);
            expect(repreproSpawn.files["distributions"]).toMatch(/^SignWith: !\+b\/sign\.sh$/m);

            expect(repreproSpawn.files["incoming"]).toMatch(/^IncomingDir: incoming\/process\/deb\/debian\/bookworm\/update$/m);
            expect(repreproSpawn.files["incoming"]).toMatch(/^TempDir: repo-state\/deb-debian\/tmp-bookworm$/m);
            expect(repreproSpawn.files["incoming"]).toMatch(/^Allow: bookworm$/m);

            expect(repreproSpawn.files["options"]).toMatch(/^outdir \+b\/repo\/deb\/debian$/m);
            expect(repreproSpawn.files["options"]).toMatch(/^dbdir \+b\/repo-state\/deb-debian\/db$/m);

            expect(repreproSpawn.files["override"]).toMatch(/\$Component update$/m);
        }));

    test('Check that Debian build config is correctly updated when distribution files exist for multiple releases',
        withLocalTmpDir(async () => {
            let repreproSpawn: CapturedState | undefined;

            mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
                if (!repreproSpawn) {
                    repreproSpawn = await captureRepreproState(executable, args);
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
                "incoming/staging/deb/debian/bookworm/update/test.changes": dedent`
                Architecture: source amd64\n
            `,
                "repo/deb/debian/dists/bookworm/Release": dedent`
                Architectures: source armhf
                Components: main\n
            `,
                "repo/deb/debian/dists/bullseye/Release": dedent`
                Architectures: arm64 i386
                Components: test extra\n
            `
            })

            const res = await request(app).post("/upload/build-repo");
            expect(res.status).toBe(200);

            expect(await fs.readdir(osPath.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'update'))).toHaveLength(0);
            expect(await fs.readdir(osPath.join('incoming', 'process', 'deb', 'debian', 'bookworm', 'update'))).toEqual(['test.changes']);

            expect(repreproSpawn).toBeDefined();
            assert(repreproSpawn);
            expect(repreproSpawn.executable).toBe("reprepro");

            const confDirIndex = repreproSpawn.args.indexOf("--confdir");
            expect(confDirIndex).toBeGreaterThan(-1);
            expect(repreproSpawn.args[confDirIndex + 1]).toEqual("+b/repo-state/deb-debian/conf");

            const processIncomingIndex = repreproSpawn.args.indexOf("processincoming");
            expect(processIncomingIndex).toBeGreaterThan(-1);
            expect(repreproSpawn.args[processIncomingIndex + 1]).toBe("debian");

            expect(repreproSpawn.files["distributions"]).toBeDefined();
            expect(repreproSpawn.files["incoming"]).toBeDefined();
            expect(repreproSpawn.files["options"]).toBeDefined();
            expect(repreproSpawn.files["override"]).toBeDefined();

            expect(repreproSpawn.files["distributions"]).toIncludeRepeated("Codename:", 2);
            const releases = parseDistributionsFile(repreproSpawn);

            expect(releases["bookworm"]).toBeDefined();
            expect(releases["bookworm"]).toMatch(/^Codename: bookworm$/m);
            expect(releases["bookworm"]).toMatch(/^Suite: bookworm$/m);
            expect(releases["bookworm"]).toMatch(/^Components: .+/m);
            const bookwormComponents = releases["bookworm"].match(/^Components: (.+)$/m)![1].split(/\s+/);
            expect(bookwormComponents).toIncludeSameMembers(["main", "update"]);
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
            expect(releases["bullseye"]).toMatch(/^Architectures: .+$/m);
            const bullseyeArchitectures = releases["bullseye"].match(/^Architectures: (.*)$/m)![1].split(/\s+/);
            expect(bullseyeArchitectures).toIncludeSameMembers(["arm64", "i386"]);
            expect(releases["bullseye"]).toMatch(/^SignWith: !\+b\/sign\.sh$/m);

            expect(repreproSpawn.files["incoming"]).toMatch(/^IncomingDir: incoming\/process\/deb\/debian\/bookworm\/update$/m);
            expect(repreproSpawn.files["incoming"]).toMatch(/^TempDir: repo-state\/deb-debian\/tmp-bookworm$/m);
            expect(repreproSpawn.files["incoming"]).toMatch(/^Allow: bookworm$/m);

            expect(repreproSpawn.files["options"]).toMatch(/^outdir \+b\/repo\/deb\/debian$/m);
            expect(repreproSpawn.files["options"]).toMatch(/^dbdir \+b\/repo-state\/deb-debian\/db$/m);

            expect(repreproSpawn.files["override"]).toMatch(/\$Component update$/m);
        }));

    test('Check that Debian build config is correctly updated when distribution files exist for multiple distributions',
        withLocalTmpDir(async () => {
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
                .toEqual([expect.toBeArrayOfSize(5), expect.toBeArrayOfSize(5)]);
            expect(Object.values(repreproSpawn).map(v => v.args))
                .toEqual([expect.toContainValue("--confdir"), expect.toContainValue("--confdir")]);

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

        const res = await request(app).post("/upload/build-repo");
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

        const res = await request(app).post("/upload/build-repo");
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

        const res = await request(app).post("/upload/build-repo");
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

        const res = await request(app).post("/upload/build-repo");
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

    test('Check that multiple RedHat incoming package from multiple distributions are moved to repo',
        withLocalTmpDir(async () => {
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

            const res = await request(app).post("/upload/build-repo");
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

        const res = await request(app).post("/upload/build-repo");
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

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(500);

        expect(await fs.readdir(osPath.join('incoming', 'staging', 'rpm', 'fedora', '41'))).toHaveLength(0);
        expect(await fs.readdir(osPath.join('incoming', 'process', 'rpm', 'fedora', '41'))).toHaveLength(0);
    }));

    test('Check that repo endpoint is unavailable when the tools are unavailable', withLocalTmpDir(async () => {
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoStateDir: "repo-state",
                repoDir: "repo",
                repreproBin: null,
                createrepoScript: null,
            },
            upload: {
                enabledApi: {
                    deb: false,
                    rpm: false,
                }
            }
        });

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(503);
    }));
});
