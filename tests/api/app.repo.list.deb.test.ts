// noinspection DuplicatedCode

import { createFiles, withLocalTmpDir } from "../utils.ts";
import request from "supertest";
import { clearMockSpawn, installSpawnProxy, setMockSpawn } from "../mocks.ts";

installSpawnProxy();
const createTestApp = (await import("../testapp.ts")).default;

afterEach(() => {
    clearMockSpawn();
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

async function seedTrixieDistributionsConf() {
    await createFiles({
        "repo-state/deb-debian/conf/distributions": [
            "Codename: trixie",
            "Suite: trixie",
            "Components: main",
            "Architectures: amd64 source",
            "Tracking: minimal includechanges includebuildinfos",
            "Limit: 0",
            ""
        ].join("\n")
    });
}

async function seedNobleDistributionsConf() {
    await createFiles({
        "repo-state/deb-ubuntu/conf/distributions": [
            "Codename: noble",
            "Suite: noble",
            "Components: universe",
            "Architectures: amd64 source",
            "Tracking: minimal includechanges includebuildinfos",
            "Limit: 0",
            ""
        ].join("\n")
    });
}

/**
 * Seed a pool directory with empty files matching the real fixture's names.
 * We only care about the names so directory-discovery can surface them; reprepro
 * stdout is mocked so we don't need the binary blobs to be valid.
 */
async function seedPoolFiles(poolDirAbs: string, filenames: string[]) {
    const entries: Record<string, string> = {};
    for (const name of filenames) {
        entries[`${ poolDirAbs }/${ name }`] = "";
    }
    await createFiles(entries);
}

describe("GET deb package files", () => {
    test("200 returns files with absolute downloadUrls, no removal exec", withLocalTmpDir(async () => {
        const execCalls: { exe: string; args: string[] }[] = [];
        // LISTFILTER_FORMAT: ${$type}\t${Filename}\t${Directory}\t${Files}\0
        const listfilterStdout =
            "deb\tpool/main/c/clevis/clevis_21-1+tpm1u8+deb12_amd64.deb\t\t\0" +
            "dsc\t\tpool/main/c/clevis\t"
                + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 100 clevis_21-1+tpm1u8+deb12.dsc"
                + "\0";
        setMockSpawn(0, listfilterStdout, "", undefined, (exe, args) => {
            execCalls.push({ exe, args });
        });

        await seedDistributionsConf();

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
        setMockSpawn(0, "", "", undefined, () => {});
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
        const app = await createTestApp();
        const res = await request(app).get("/api/v1/repo/deb/debian/bookworm/$bad$");
        expect(res.status).toBe(400);
    }));

    test("200 with wildcards enumerates all matching targets", withLocalTmpDir(async () => {
        const listfilterStdout =
            "dsc\t\tpool/main/c/clevis\t"
            + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 100 clevis_21-1.dsc\0";
        setMockSpawn(0, listfilterStdout, "", undefined, () => {});
        await seedDistributionsConf();
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

    test("200 returns source tarballs alongside the dsc", withLocalTmpDir(async () => {
        // LISTFILTER_FORMAT: ${$type}\t${Filename}\t${Directory}\t${Files}\0
        // Mirrors reprepro's output for the trixie/main clevis bundle: the
        // .deb row lists the amd64 binary; the dsc row's Files block names
        // the dsc, the orig tarball, and the debian tarball.
        const dscFiles = [
            " aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 100 clevis_22-1+tpm1u0+deb13.dsc",
            " bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 200 clevis_22.orig.tar.gz",
            " cccccccccccccccccccccccccccccccc 300 clevis_22-1+tpm1u0+deb13.debian.tar.xz",
        ].join("\n");
        const listfilterStdout =
            "deb\tpool/main/c/clevis/clevis_22-1+tpm1u0+deb13_amd64.deb\t\t\0"
            + `dsc\t\tpool/main/c/clevis\t${ dscFiles }\0`;
        setMockSpawn(0, listfilterStdout, "", undefined, () => {});

        await seedTrixieDistributionsConf();
        // Seed the pool dir so directory-discovery sees the tracked files.
        // The tarballs and dsc come through listfilter; .changes/.buildinfo
        // come from the disk scan (test 3 asserts those).
        await seedPoolFiles("repo/deb/debian/pool/main/c/clevis", [
            "clevis_22-1+tpm1u0+deb13.dsc",
            "clevis_22.orig.tar.gz",
            "clevis_22-1+tpm1u0+deb13.debian.tar.xz",
            "clevis_22-1+tpm1u0+deb13_amd64.deb",
            "clevis_22-1+tpm1u0+deb13_source+amd64.changes",
            "clevis_22-1+tpm1u0+deb13_amd64.buildinfo",
        ]);

        const app = await createTestApp({
            paths: {
                incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo",
                repreproBin: "reprepro"
            }
        });

        const res = await request(app)
            .get("/api/v1/repo/deb/debian/trixie/clevis/22-1%2Btpm1u0%2Bdeb13");

        expect(res.status).toBe(200);
        const filenames = new Set(
            (res.body.files as { filename: string }[]).map(f => f.filename));
        expect(filenames.has("clevis_22-1+tpm1u0+deb13.dsc")).toBe(true);
        expect(filenames.has("clevis_22.orig.tar.gz")).toBe(true);
        expect(filenames.has("clevis_22-1+tpm1u0+deb13.debian.tar.xz")).toBe(true);
        expect(filenames.has("clevis_22-1+tpm1u0+deb13_amd64.deb")).toBe(true);
    }));

    test("200 parses ddeb rows with the right type and pool path", withLocalTmpDir(async () => {
        // Ubuntu/noble/universe fixture shape: 10 .deb + 4 .ddeb + dsc
        // + source tarballs. We mirror reprepro's listfilter output for the
        // 4 .ddeb rows to check they pass through with status "ok" and a
        // pool-relative path under pool/universe/c/clevis/.
        const ddebFilenames = [
            "clevis-dbgsym_22-1+tpm1u0+ubuntu24.04_amd64.ddeb",
            "clevis-luks-dbgsym_22-1+tpm1u0+ubuntu24.04_amd64.ddeb",
            "clevis-tpm2-dbgsym_22-1+tpm1u0+ubuntu24.04_amd64.ddeb",
            "clevis-udisks2-dbgsym_22-1+tpm1u0+ubuntu24.04_amd64.ddeb",
        ];
        const dscFiles = [
            " aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 100 clevis_22-1+tpm1u0+ubuntu24.04.dsc",
            " bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 200 clevis_22.orig.tar.gz",
            " cccccccccccccccccccccccccccccccc 300 clevis_22-1+tpm1u0+ubuntu24.04.debian.tar.xz",
        ].join("\n");
        const records: string[] = [
            ...ddebFilenames.map(
                n => `ddeb\tpool/universe/c/clevis/${ n }\t\t`),
            "deb\tpool/universe/c/clevis/clevis_22-1+tpm1u0+ubuntu24.04_amd64.deb\t\t",
            `dsc\t\tpool/universe/c/clevis\t${ dscFiles }`,
        ];
        const listfilterStdout = records.join("\0") + "\0";
        setMockSpawn(0, listfilterStdout, "", undefined, () => {});

        await seedNobleDistributionsConf();
        await seedPoolFiles("repo/deb/ubuntu/pool/universe/c/clevis", [
            "clevis_22-1+tpm1u0+ubuntu24.04.dsc",
            "clevis_22.orig.tar.gz",
            "clevis_22-1+tpm1u0+ubuntu24.04.debian.tar.xz",
            "clevis_22-1+tpm1u0+ubuntu24.04_amd64.deb",
            ...ddebFilenames,
        ]);

        const app = await createTestApp({
            paths: {
                incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo",
                repreproBin: "reprepro"
            }
        });

        const res = await request(app)
            .get("/api/v1/repo/deb/ubuntu/noble/clevis/22-1%2Btpm1u0%2Bubuntu24.04");

        expect(res.status).toBe(200);
        // REST list response shape: { filename, path, downloadUrl } — list
        // results carry no `status` field (that lives on RemovalFile, used
        // only by removePackage). Presence of downloadUrl confirms the entry
        // made it through as ok.
        const ddebs = (res.body.files as { filename: string; path: string; downloadUrl: string }[])
            .filter(f => f.filename.endsWith(".ddeb"));
        expect(ddebs).toHaveLength(4);
        for (const f of ddebs) {
            expect(f.path).toMatch(/pool\/universe\/c\/clevis\/.*\.ddeb$/);
            expect(f.downloadUrl).toMatch(/^https?:\/\/.+\/deb\/ubuntu\/pool\/universe\/c\/clevis\/.*\.ddeb$/);
        }
    }));

    test("200 returns .changes and .buildinfo when tracking preserves them", withLocalTmpDir(async () => {
        // Same trixie-shaped listfilter stdout — the .changes/.buildinfo are
        // NOT in packages.db, so they appear only via the pool scan.
        const dscFiles = [
            " aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 100 clevis_22-1+tpm1u0+deb13.dsc",
            " bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 200 clevis_22.orig.tar.gz",
            " cccccccccccccccccccccccccccccccc 300 clevis_22-1+tpm1u0+deb13.debian.tar.xz",
        ].join("\n");
        const listfilterStdout =
            "deb\tpool/main/c/clevis/clevis_22-1+tpm1u0+deb13_amd64.deb\t\t\0"
            + `dsc\t\tpool/main/c/clevis\t${ dscFiles }\0`;
        setMockSpawn(0, listfilterStdout, "", undefined, () => {});

        await seedTrixieDistributionsConf();
        await seedPoolFiles("repo/deb/debian/pool/main/c/clevis", [
            "clevis_22-1+tpm1u0+deb13.dsc",
            "clevis_22.orig.tar.gz",
            "clevis_22-1+tpm1u0+deb13.debian.tar.xz",
            "clevis_22-1+tpm1u0+deb13_amd64.deb",
            // Reprepro joins the .changes arch-chunk with '+' — robust check
            // uses endsWith, but seed the canonical reprepro filename.
            "clevis_22-1+tpm1u0+deb13_source+amd64.changes",
            "clevis_22-1+tpm1u0+deb13_amd64.buildinfo",
        ]);

        const app = await createTestApp({
            paths: {
                incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo",
                repreproBin: "reprepro"
            }
        });

        const res = await request(app)
            .get("/api/v1/repo/deb/debian/trixie/clevis/22-1%2Btpm1u0%2Bdeb13");

        expect(res.status).toBe(200);
        const filenames = (res.body.files as { filename: string }[]).map(f => f.filename);
        expect(filenames.some(n => n.endsWith(".changes"))).toBe(true);
        expect(filenames.some(n => n.endsWith(".buildinfo"))).toBe(true);
    }));
});
