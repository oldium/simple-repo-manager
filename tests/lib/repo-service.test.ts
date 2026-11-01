import { poolRemovedAt, withLocalTmpDir } from "../utils.ts";
import { RepoService } from "../../server/lib/repo-service.ts";
import fs from "fs/promises";
import osPath from "path";
import { fileURLToPath } from "url";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const TRIXIE = { dir: osPath.join(FIXTURES, "packages", "deb", "debian", "trixie", "main"), target: "deb/debian/trixie/main" };
const RPMS = { dir: osPath.join(FIXTURES, "packages", "rpm", "fedora", "42"), target: "rpm/fedora/42" };
const PATHS = { incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo" };
const DEB_POOL = "deb/debian/pool/main/s/srm-hello";
const RPM_POOL = "rpm/fedora/42/Packages/s/srm-hello";
const DEB_REF = { format: "deb", distribution: "debian", release: "trixie" };
const RPM_REF = { format: "rpm", distribution: "fedora", release: "42" };
const DEB_SOURCE = { ...DEB_REF, source: "srm-hello", version: "1.0-1" };
const RPM_SOURCE = { ...RPM_REF, source: "srm-hello", version: "1.0-1.fc42" };

function service(sizeLimit?: number): RepoService {
    return new RepoService(PATHS, {}, { publicRead: false, postField: "package", sizeLimit });
}

function osJoin(...posix: string[]): string {
    return osPath.join(...posix.join("/").split("/"));
}

/** Copies a fixture bundle into incoming/staging below its upload path; returns its file names */
async function stage(bundle: { dir: string; target: string }): Promise<string[]> {
    const to = osJoin(PATHS.incomingDir, "staging", bundle.target);
    await fs.mkdir(to, { recursive: true });
    const names = (await fs.readdir(bundle.dir)).sort();
    for (const name of names) {
        await fs.copyFile(osPath.join(bundle.dir, name), osPath.join(to, name));
    }
    return names;
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.stat(file);
        return true;
    } catch {
        return false;
    }
}

describe("RepoService.importRepository", () => {
    test("Imports the staged bundles and reports every file", withLocalTmpDir(async () => {
        const debNames = await stage(TRIXIE);
        const rpmNames = await stage(RPMS);
        const result = await service().importRepository();
        expect(result.ok).toBe(true);
        expect(result.files.map(f => `${ f.path } ${ f.status }`).sort()).toEqual([
            ...debNames.map(n => `${ TRIXIE.target }/${ n } ok`), ...rpmNames.map(n => `${ RPMS.target }/${ n } ok`),
        ].sort());
        expect(await exists(osJoin(PATHS.incomingDir, "staging", TRIXIE.target, debNames[0]))).toBe(false);
        expect(await exists(osJoin(PATHS.repoDir, DEB_POOL, debNames[0]))).toBe(true);
        expect(await exists(osJoin(PATHS.repoDir, RPM_POOL, rpmNames[0]))).toBe(true);
    }));

});

describe("RepoService.listRepositories", () => {
    test("Lists the imported repositories", withLocalTmpDir(async () => {
        await stage(TRIXIE);
        await stage(RPMS);
        const svc = service();
        await svc.importRepository();
        expect(await svc.listRepositories()).toEqual([DEB_REF, RPM_REF]);
        expect(await svc.listRepositories({ format: "rpm" })).toEqual([RPM_REF]);
        expect(await svc.listRepositories({ distribution: "ubuntu" })).toEqual([]);
    }));

    test("Rejects unknown format", withLocalTmpDir(async () => {
        // @ts-expect-error testing bad input
        await expect(service().listRepositories({ format: "iso" })).rejects.toThrow("Unknown format");
    }));

});

describe("RepoService.listSourcePackages", () => {
    test("Filters by source name and keeps ver-rel", withLocalTmpDir(async () => {
        await stage(TRIXIE);
        await stage(RPMS);
        const svc = service();
        await svc.importRepository();
        expect(await svc.listSourcePackages({ format: "rpm", source: "srm-hello" })).toEqual({ items: [RPM_SOURCE] });
        expect(await svc.listSourcePackages({ source: "srm-hello" })).toEqual({ items: [DEB_SOURCE, RPM_SOURCE] });
        expect(await svc.listSourcePackages({ source: "other" })).toEqual({ items: [] });
    }));

    test("Pages with a cursor", withLocalTmpDir(async () => {
        await stage(TRIXIE);
        await stage(RPMS);
        const svc = service();
        await svc.importRepository();
        const first = await svc.listSourcePackages({}, { limit: 1 });
        expect(first.items).toEqual([DEB_SOURCE]);
        expect(first.nextCursor).toBeDefined();
        expect(await svc.listSourcePackages({}, { limit: 1, cursor: first.nextCursor })).toEqual({ items: [RPM_SOURCE] });
    }));

});

describe("RepoService.prepareUpload", () => {
    test("Returns PUT slots for deb component", withLocalTmpDir(async () => {
        const slots = service(1024).prepareUpload(
            { format: "deb", distribution: "debian", release: "bookworm", component: "main" },
            ["clevis_21-1.dsc", "clevis_21-1_amd64.deb"]
        );
        expect(slots).toEqual([
            { filename: "clevis_21-1.dsc", relativePath: "/api/v1/upload/deb/debian/bookworm/main/clevis_21-1.dsc", maxBytes: 1024 },
            { filename: "clevis_21-1_amd64.deb", relativePath: "/api/v1/upload/deb/debian/bookworm/main/clevis_21-1_amd64.deb", maxBytes: 1024 },
        ]);
    }));

    test("Omits maxBytes when size limit is not configured", withLocalTmpDir(async () => {
        const slots = service().prepareUpload({ format: "rpm", distribution: "fedora", release: "40" }, ["clevis-21-1.src.rpm"]);
        expect(slots[0]).toEqual({
            filename: "clevis-21-1.src.rpm",
            relativePath: "/api/v1/upload/rpm/fedora/40/clevis-21-1.src.rpm",
        });
    }));

    test("Rejects component on rpm target", withLocalTmpDir(async () => {
        expect(() => service().prepareUpload(
            { format: "rpm", distribution: "fedora", release: "40", component: "main" },
            ["a.rpm"]
        )).toThrow(/component\/subcomponent/);
    }));

    test("Rejects invalid filename", withLocalTmpDir(async () => {
        expect(() => service().prepareUpload(
            { format: "deb", distribution: "debian", release: "bookworm", component: "main" },
            ["not allowed.deb"]
        )).toThrow(/Invalid filename/);
    }));

    test("Offers no slot Windows would refuse, on Windows only", withLocalTmpDir(async () => {
        const refusedName = () => service().prepareUpload({ format: "deb", distribution: "debian", release: "bookworm", component: "main" }, ["x.tar.a:b"]);
        const reservedDistro = () => service().prepareUpload({ format: "deb", distribution: "aux", release: "bookworm", component: "main" }, ["x.deb"]);
        if (process.platform === "win32") {
            expect(refusedName).toThrow('Invalid filename: x.tar.a:b: "x.tar.a:b" holds a character or an ending that Windows refuses in a file name');
            expect(reservedDistro).toThrow('Unknown or invalid distro: deb/aux/bookworm/main: "aux" is a reserved name on Windows');
        } else {
            expect(refusedName()).toHaveLength(1);
            expect(reservedDistro()).toHaveLength(1);
        }
    }));

    test("Offers a slot for a device name with an extension on any OS", withLocalTmpDir(async () => {
        expect(service().prepareUpload({ format: "deb", distribution: "debian", release: "bookworm", component: "main" }, ["con.deb"])).toHaveLength(1);
    }));
});

describe("RepoService.getStatus", () => {
    test("reports both formats", () => {
        expect(service().getStatus()).toEqual({
            message: "Package repository API is running",
            api: {
                deb: { enabled: true },
                rpm: { enabled: true },
            },
        });
    });

    test("is synchronous and never throws", () => {
        expect(() => service().getStatus()).not.toThrow();
    });
});

describe("RepoService.listPackageFiles", () => {
    test("requires source", withLocalTmpDir(async () => {
        // @ts-expect-error testing missing source
        await expect(service().listPackageFiles({})).rejects.toThrow(/source is required/);
    }));

    test("404 on explicit distribution/release with no matching targets", withLocalTmpDir(async () => {
        await expect(service().listPackageFiles({
            format: "rpm", distribution: "nope", release: "0", source: "clevis",
        })).rejects.toThrow(/No such repository/);
    }));

    test("happy path: aggregates files across every matching triple", withLocalTmpDir(async () => {
        const debNames = await stage(TRIXIE);
        const rpmNames = await stage(RPMS);
        const svc = service();
        await svc.importRepository();
        expect(await svc.listPackageFiles({ source: "srm-hello" })).toEqual({
            touchedTargets: 2,
            files: [
                ...debNames.map(n => ({ filename: n, path: `${ DEB_POOL }/${ n }` })),
                ...rpmNames.map(n => ({ filename: n, path: `${ RPM_POOL }/${ n }` })),
            ],
        });
        expect((await svc.listPackageFiles({ format: "rpm", source: "srm-hello", version: "1.0-1.fc42" })).files).toHaveLength(3);
        expect(await svc.listPackageFiles({ source: "nothing", distribution: "debian" })).toEqual({ files: [], touchedTargets: 0 });
        const page = await svc.listPackageFiles({ source: "srm-hello" }, { limit: 2 });
        expect(page.files).toEqual(debNames.slice(0, 2).map(n => ({ filename: n, path: `${ DEB_POOL }/${ n }` })));
        expect(page.touchedTargets).toBe(1);
        expect(page.nextCursor).toBeDefined();
    }));
});

describe("RepoService.removePackage", () => {
    test("requires source", withLocalTmpDir(async () => {
        await expect(service().removePackage({ source: "" })).rejects.toThrow(/source is required/);
    }));

    test("404 on explicit distribution/release with no matching targets", withLocalTmpDir(async () => {
        await stage(TRIXIE);
        const svc = service();
        await svc.importRepository();
        await expect(svc.removePackage({ distribution: "debian", release: "bookworm", source: "srm-hello" })).rejects.toThrow(/No such repository/);
        expect(await svc.listSourcePackages({})).toEqual({ items: [DEB_SOURCE] });
    }));

    test("removePackage immediate deletes files at once", withLocalTmpDir(async () => {
        const debNames = await stage(TRIXIE);
        const svc = service();
        await svc.importRepository();
        const result = await svc.removePackage({ source: "srm-hello", immediate: true });
        expect(result.touchedTargets).toBe(1);
        expect(result.files.map(f => `${ f.path } ${ f.status }`).sort()).toEqual(debNames.map(n => `${ DEB_POOL }/${ n } ok`));
        for (const name of debNames) {
            expect(await exists(osJoin(PATHS.repoDir, DEB_POOL, name))).toBe(false);
        }
        expect(poolRemovedAt()).toEqual({});
        expect(await svc.listSourcePackages({})).toEqual({ items: [] });
    }));

    test("removePackage default keeps files until GC", withLocalTmpDir(async () => {
        const debNames = await stage(TRIXIE);
        const svc = service();
        await svc.importRepository();
        const result = await svc.removePackage({ source: "srm-hello" });
        expect(result.touchedTargets).toBe(1);
        expect(result.files.map(f => `${ f.path } ${ f.status }`).sort()).toEqual(debNames.map(n => `${ DEB_POOL }/${ n } ok`));
        for (const name of debNames) {
            expect(await exists(osJoin(PATHS.repoDir, DEB_POOL, name))).toBe(true);
        }
        expect(poolRemovedAt()).toEqual(Object.fromEntries(debNames.map(n => [`${ DEB_POOL }/${ n }`, expect.any(Number)])));
        expect(await svc.listSourcePackages({})).toEqual({ items: [] });
        expect(await svc.listPackageFiles({ source: "srm-hello" })).toEqual({ files: [], touchedTargets: 0 });
    }));
});
