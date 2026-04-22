import { jest } from "@jest/globals";
import { withLocalTmpDir } from "../utils.ts";
import { RepoService } from "../../server/lib/repo-service.ts";
import fsExtra from "fs-extra/esm";
import fs from "fs/promises";
import osPath from "path";
import type { PackageInfo } from "../../server/lib/rpm-metadata.ts";

function paths() {
    return {
        incomingDir: "incoming",
        repoStateDir: "repo-state",
        repoDir: "repo",
        createrepoScript: "scripts/createrepo.sh",
        repreproBin: "reprepro",
    };
}

describe("RepoService.listRepositories (rpm)", () => {
    test("Enumerates rpm repos from disk", withLocalTmpDir(async () => {
        for (const release of ["40", "41"]) {
            await fsExtra.ensureDir(osPath.join("repo", "rpm", "fedora", release, "repodata"));
            await fs.writeFile(
                osPath.join("repo", "rpm", "fedora", release, "repodata", "repomd.xml"),
                `<?xml version="1.0"?><repomd/>`);
        }
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: false, rpm: true },
            postField: "package",
        });
        const result = await svc.listRepositories();
        const sorted = [...result].sort((a, b) => a.release.localeCompare(b.release));
        expect(sorted).toEqual([
            { format: "rpm", distribution: "fedora", release: "40" },
            { format: "rpm", distribution: "fedora", release: "41" },
        ]);
    }));

    test("Rejects unknown format", withLocalTmpDir(async () => {
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: true, rpm: true },
            postField: "package",
        });
        // @ts-expect-error testing bad input
        await expect(svc.listRepositories({ format: "iso" })).rejects.toThrow("Unknown format");
    }));
});

describe("RepoService.listSourcePackages (rpm via mock)", () => {
    test("Filters by source name and keeps ver-rel", withLocalTmpDir(async () => {
        jest.resetModules();
        const actual = await import("../../server/lib/rpm-metadata.ts");
        jest.unstable_mockModule("../../server/lib/rpm-metadata.ts", () => ({
            __esModule: true,
            ...actual,
            streamPackages: jest.fn(async function* (): AsyncGenerator<PackageInfo> {
                yield { name: "clevis", arch: "src", ver: "21", rel: "1", href: "s/clevis-21-1.src.rpm", sourcerpm: "" };
                yield { name: "clevis", arch: "x86_64", ver: "21", rel: "1", href: "c/clevis-21-1.x86_64.rpm", sourcerpm: "clevis-21-1.src.rpm" };
                yield { name: "other", arch: "src", ver: "1", rel: "0", href: "o/other-1-0.src.rpm", sourcerpm: "" };
            }),
        }));
        await fsExtra.ensureDir(osPath.join("repo", "rpm", "fedora", "40", "repodata"));
        await fs.writeFile(
            osPath.join("repo", "rpm", "fedora", "40", "repodata", "repomd.xml"),
            `<?xml version="1.0"?><repomd/>`);
        const { RepoService } = await import("../../server/lib/repo-service.ts");
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: false, rpm: true },
            postField: "package",
        });
        const result = await svc.listSourcePackages({ format: "rpm", source: "clevis" });
        expect(result).toEqual([
            { format: "rpm", distribution: "fedora", release: "40", source: "clevis", version: "21-1" },
        ]);
    }));
});

describe("RepoService.prepareUpload", () => {
    test("Returns PUT slots for deb component", withLocalTmpDir(async () => {
        const { RepoService } = await import("../../server/lib/repo-service.ts");
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: true, rpm: true },
            postField: "package",
            sizeLimit: 1024,
        });
        const slots = svc.prepareUpload(
            { format: "deb", distribution: "debian", release: "bookworm", component: "main" },
            ["clevis_21-1.dsc", "clevis_21-1_amd64.deb"]
        );
        expect(slots).toEqual([
            { filename: "clevis_21-1.dsc", relativePath: "/api/v1/upload/deb/debian/bookworm/main/clevis_21-1.dsc", maxBytes: 1024 },
            { filename: "clevis_21-1_amd64.deb", relativePath: "/api/v1/upload/deb/debian/bookworm/main/clevis_21-1_amd64.deb", maxBytes: 1024 },
        ]);
    }));

    test("Omits maxBytes when size limit is not configured", withLocalTmpDir(async () => {
        const { RepoService } = await import("../../server/lib/repo-service.ts");
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { rpm: true, deb: true },
            postField: "package",
        });
        const slots = svc.prepareUpload(
            { format: "rpm", distribution: "fedora", release: "40" },
            ["clevis-21-1.src.rpm"]
        );
        expect(slots[0]).toEqual({
            filename: "clevis-21-1.src.rpm",
            relativePath: "/api/v1/upload/rpm/fedora/40/clevis-21-1.src.rpm",
        });
    }));

    test("Rejects component on rpm target", withLocalTmpDir(async () => {
        const { RepoService } = await import("../../server/lib/repo-service.ts");
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { rpm: true, deb: true },
            postField: "package",
        });
        expect(() => svc.prepareUpload(
            { format: "rpm", distribution: "fedora", release: "40", component: "main" },
            ["a.rpm"]
        )).toThrow(/component\/subcomponent/);
    }));

    test("Rejects invalid filename", withLocalTmpDir(async () => {
        const { RepoService } = await import("../../server/lib/repo-service.ts");
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: true, rpm: true },
            postField: "package",
        });
        expect(() => svc.prepareUpload(
            { format: "deb", distribution: "debian", release: "bookworm", component: "main" },
            ["not allowed.deb"]
        )).toThrow(/Invalid filename/);
    }));
});

describe("RepoServiceUnavailableError carries format", () => {
    test("prepareUpload with deb disabled throws with format='deb'", withLocalTmpDir(async () => {
        const { RepoService } = await import("../../server/lib/repo-service.ts");
        const { RepoServiceUnavailableError } = await import("../../server/lib/errors.ts");
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: false, rpm: true },
            postField: "package",
        });
        try {
            svc.prepareUpload({ format: "deb", distribution: "debian", release: "bookworm", component: "main" }, ["x.deb"]);
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(RepoServiceUnavailableError);
            expect((err as InstanceType<typeof RepoServiceUnavailableError>).format).toBe("deb");
        }
    }));

    test("prepareUpload with rpm disabled throws with format='rpm'", withLocalTmpDir(async () => {
        const { RepoService } = await import("../../server/lib/repo-service.ts");
        const { RepoServiceUnavailableError } = await import("../../server/lib/errors.ts");
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: true, rpm: false },
            postField: "package",
        });
        try {
            svc.prepareUpload({ format: "rpm", distribution: "fedora", release: "40" }, ["x.rpm"]);
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(RepoServiceUnavailableError);
            expect((err as InstanceType<typeof RepoServiceUnavailableError>).format).toBe("rpm");
        }
    }));
});

describe("RepoService.listRepositories enabled-check", () => {
    test("throws when both backends disabled and no filter", withLocalTmpDir(async () => {
        const { RepoService } = await import("../../server/lib/repo-service.ts");
        const { RepoServiceUnavailableError } = await import("../../server/lib/errors.ts");
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: false, rpm: false },
            postField: "package",
        });
        await expect(svc.listRepositories()).rejects.toBeInstanceOf(RepoServiceUnavailableError);
    }));
});

describe("RepoService.listSourcePackages enabled-check", () => {
    test("throws when both backends disabled and no filter", withLocalTmpDir(async () => {
        const { RepoService } = await import("../../server/lib/repo-service.ts");
        const { RepoServiceUnavailableError } = await import("../../server/lib/errors.ts");
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: false, rpm: false },
            postField: "package",
        });
        await expect(svc.listSourcePackages({})).rejects.toBeInstanceOf(RepoServiceUnavailableError);
    }));

    test("throws when filter.format names disabled backend", withLocalTmpDir(async () => {
        const { RepoService } = await import("../../server/lib/repo-service.ts");
        const { RepoServiceUnavailableError } = await import("../../server/lib/errors.ts");
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: false, rpm: true },
            postField: "package",
        });
        await expect(svc.listSourcePackages({ format: "deb" })).rejects.toBeInstanceOf(RepoServiceUnavailableError);
    }));
});

describe("RepoService.removePackage enabled-check", () => {
    test("throws when both backends disabled and no format filter", withLocalTmpDir(async () => {
        const { RepoService } = await import("../../server/lib/repo-service.ts");
        const { RepoServiceUnavailableError } = await import("../../server/lib/errors.ts");
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: false, rpm: false },
            postField: "package",
        });
        await expect(svc.removePackage({ source: "clevis" })).rejects.toBeInstanceOf(RepoServiceUnavailableError);
    }));
});

describe("RepoService.getStatus", () => {
    test("reports enabled flags for both-on state", () => {
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: true, rpm: true },
            postField: "package",
        });
        expect(svc.getStatus()).toEqual({
            message: "Package repository API is running",
            api: {
                deb: { enabled: true },
                rpm: { enabled: true },
            },
        });
    });

    test("reports enabled flags for both-off state", () => {
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: false, rpm: false },
            postField: "package",
        });
        expect(svc.getStatus()).toEqual({
            message: "Package repository API is running",
            api: {
                deb: { enabled: false },
                rpm: { enabled: false },
            },
        });
    });

    test("is synchronous and never throws", () => {
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: false, rpm: true },
            postField: "package",
        });
        expect(() => svc.getStatus()).not.toThrow();
    });
});

describe("RepoService.listPackageFiles", () => {
    test("requires source", withLocalTmpDir(async () => {
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: false, rpm: true },
            postField: "package",
        });
        // @ts-expect-error testing missing source
        await expect(svc.listPackageFiles({})).rejects.toThrow(/source is required/);
    }));

    test("503s when no backend is enabled", withLocalTmpDir(async () => {
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: false, rpm: false },
            postField: "package",
        });
        await expect(svc.listPackageFiles({ source: "clevis" })).rejects.toThrow(
            /No repository tool available/
        );
    }));

    test("503s for disabled format filter", withLocalTmpDir(async () => {
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: true, rpm: false },
            postField: "package",
        });
        await expect(svc.listPackageFiles({ format: "rpm", source: "clevis" })).rejects.toThrow(
            /Repository tool for rpm is not available/
        );
    }));

    test("404 on explicit distribution/release with no matching targets", withLocalTmpDir(async () => {
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: false, rpm: true },
            postField: "package",
        });
        await expect(svc.listPackageFiles({
            format: "rpm", distribution: "nope", release: "0", source: "clevis",
        })).rejects.toThrow(/No such repository/);
    }));

    test("happy path: aggregates files across every matching rpm triple", withLocalTmpDir(async () => {
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
        const { RepoService } = await import("../../server/lib/repo-service.ts");
        const svc = new RepoService(paths(), { gpgBin: "gpg" }, {
            enabledApi: { deb: false, rpm: true },
            postField: "package",
        });
        const result = await svc.listPackageFiles({ source: "clevis" });
        expect(result.touchedTargets).toBe(1);
        expect(result.files).toEqual(expect.arrayContaining([
            expect.objectContaining({ filename: "clevis-21-1.src.rpm",
                path: "rpm/fedora/40/Packages/c/clevis-21-1.src.rpm" }),
            expect.objectContaining({ filename: "clevis-21-1.x86_64.rpm",
                path: "rpm/fedora/40/Packages/c/clevis-21-1.x86_64.rpm" }),
        ]));
    }));
});

describe("rpm.listPackageFiles (direct)", () => {
    test("returns src.rpm + matching binary rpms, matches removePackage's enumeration", withLocalTmpDir(async () => {
        jest.resetModules();
        const actual = await import("../../server/lib/rpm-metadata.ts");
        jest.unstable_mockModule("../../server/lib/rpm-metadata.ts", () => ({
            __esModule: true,
            ...actual,
            streamPackages: jest.fn(async function* (): AsyncGenerator<PackageInfo> {
                yield { name: "clevis", arch: "src", ver: "21", rel: "1", href: "Packages/c/clevis-21-1.src.rpm", sourcerpm: "" };
                yield { name: "clevis", arch: "x86_64", ver: "21", rel: "1", href: "Packages/c/clevis-21-1.x86_64.rpm", sourcerpm: "clevis-21-1.src.rpm" };
                yield { name: "other", arch: "src", ver: "1", rel: "0", href: "Packages/o/other-1-0.src.rpm", sourcerpm: "" };
            }),
        }));
        // Reset again so the mock-registry cache populated by the `actual`
        // import above is discarded and our freshly-registered factory runs.
        jest.resetModules();
        await fsExtra.ensureDir(osPath.join("repo", "rpm", "fedora", "40"));
        const rpm = await import("../../server/lib/rpm.ts");
        const result = await rpm.listPackageFiles(
            paths() as never,
            "fedora", "40", "clevis", { any: true }
        );
        expect(result).toMatchObject({
            notFound: false,
            files: expect.arrayContaining([
                expect.objectContaining({
                    filename: "clevis-21-1.src.rpm",
                    path: "rpm/fedora/40/Packages/c/clevis-21-1.src.rpm",
                }),
                expect.objectContaining({
                    filename: "clevis-21-1.x86_64.rpm",
                    path: "rpm/fedora/40/Packages/c/clevis-21-1.x86_64.rpm",
                }),
            ]),
        });
    }));

    test("returns notFound when release dir is absent", withLocalTmpDir(async () => {
        const rpm = await import("../../server/lib/rpm.ts");
        const result = await rpm.listPackageFiles(
            paths() as never, "fedora", "40", "clevis", { any: true }
        );
        expect(result).toEqual({ notFound: true });
    }));
});
