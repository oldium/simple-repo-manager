import { withLocalTmpDir } from "../../utils.ts";
import { jest } from "@jest/globals";
import crypto from "crypto";
import type { Database } from "node:sqlite";
import { openDatabase } from "../../../server/backend/db.ts";
import { DebCatalog, MAX_PAGE_SIZE } from "../../../server/backend/deb/catalog.ts";
import type { DebBinaryInput, DebUploadInput, PoolFile } from "../../../server/backend/deb/catalog.ts";
import type { PackageQuery } from "../../../server/backend/paging.ts";
import { binarySortKey, poolDirectory, sourceSortKey } from "../../../server/backend/deb/stanzas.ts";
import { RepoValidationError } from "../../../server/lib/errors.ts";

const NOW = 1700000000;

type Target = { distro?: string; release?: string; component?: string; source?: string };

type UploadSpec = Target & {
    version?: string;
    scope?: string[];
    binaries?: DebBinaryInput[];
    /** Changes the digests of the .dsc, debian tarball, .changes and .buildinfo */
    variant?: string;
    origVariant?: string;
};

/** Digests of fake content, so another variant changes every hash */
function poolFile(path: string, variant = ""): PoolFile {
    const content = Buffer.from(`${ path }#${ variant }`);
    const digest = (name: string) => crypto.createHash(name).update(content).digest("hex");
    return { path, size: content.length, md5: digest("md5"), sha1: digest("sha1"), sha256: digest("sha256"), sha512: digest("sha512") };
}

function poolDir(t: Target): string {
    return `deb/${ t.distro ?? "debian" }/${ poolDirectory(t.component ?? "main", t.source ?? "srm-hello") }`;
}

function binary(pkg: string, version: string, arch: string, o: Target & { kind?: DebBinaryInput["kind"]; variant?: string; section?: string } = {}): DebBinaryInput {
    const kind = o.kind ?? "deb";
    return {
        kind, package: pkg, version, architecture: arch, section: o.section ?? (kind === "ddeb" ? "debug" : "utils"),
        stanza: `Package: ${ pkg }\nVersion: ${ version }\n`,
        file: poolFile(`${ poolDir(o) }/${ pkg }_${ version }_${ arch }.${ kind }`, o.variant),
        paths: [`usr/bin/${ pkg }`],
    };
}

/** A dput bundle: .changes + .buildinfo, the source package when "source" is in scope, and the binaries */
function upload(o: UploadSpec = {}): DebUploadInput {
    const distro = o.distro ?? "debian";
    const release = o.release ?? "trixie";
    const component = o.component ?? "main";
    const source = o.source ?? "srm-hello";
    const version = o.version ?? "1.0-1";
    const binaries = o.binaries ?? [];
    const scope = o.scope ?? ["source", ...new Set(binaries.map(b => b.architecture))];
    const dir = poolDir({ distro, component, source });
    const changesArch = binaries[0]?.architecture ?? "source";
    const base = `${ dir }/${ source }_${ version }`;
    const upstream = version.split("-")[0];
    return {
        distro, release, component, source, version, scope,
        changesName: `${ source }_${ version }_${ changesArch }.changes`,
        trackedFiles: [poolFile(`${ base }_${ changesArch }.changes`, o.variant), poolFile(`${ base }_${ changesArch }.buildinfo`, o.variant)],
        sourcePackage: scope.includes("source") ? {
            stanza: `Package: ${ source }\nVersion: ${ version }\n`,
            files: [
                poolFile(`${ base }.dsc`, o.variant),
                poolFile(`${ dir }/${ source }_${ upstream }.orig.tar.gz`, o.origVariant),
                poolFile(`${ base }.debian.tar.xz`, o.variant),
            ],
        } : undefined,
        binaries,
    };
}

function paths(u: DebUploadInput): string[] {
    return [...u.trackedFiles, ...(u.sourcePackage?.files ?? []), ...u.binaries.map(b => b.file)].map(f => f.path).sort();
}

type PoolRow = { path: string; sha256: string; removed_at: number | null };

function poolRows(db: Database): PoolRow[] {
    return db.prepare("SELECT path, sha256, removed_at FROM pool_files ORDER BY path").all() as PoolRow[];
}

function poolRow(db: Database, path: string): PoolRow | undefined {
    return poolRows(db).find(r => r.path === path);
}

function binaries(db: Database): string[] {
    return db.prepare("SELECT component || ' ' || kind || ' ' || package || ' ' || version || ' ' || architecture AS b FROM deb_binaries ORDER BY b")
        .all().map(r => r.b as string);
}

function sources(db: Database): string[] {
    return db.prepare("SELECT component || ' ' || source || ' ' || version AS s FROM deb_sources ORDER BY s").all().map(r => r.s as string);
}

function uploads(db: Database): string[] {
    return db.prepare("SELECT changes_name || ': ' || architectures AS u FROM deb_uploads ORDER BY u").all().map(r => r.u as string);
}

function indexFiles(db: Database, distro = "debian", release = "trixie"): string[] {
    return db.prepare(`
        SELECT i.kind || ' ' || i.component || ' ' || i.architecture || ' ' || i.generation AS f FROM index_files i
        JOIN releases r ON r.id = i.release_id WHERE r.distro = ? AND r.name = ? ORDER BY f`).all(distro, release).map(r => r.f as string);
}

function dirtyKeys(db: Database, kind: string, component: string, architecture: string, distro = "debian", release = "trixie"): string[] {
    return db.prepare(`
        SELECT d.key FROM dirty_keys d JOIN index_files i ON i.id = d.index_file_id JOIN releases r ON r.id = i.release_id
        WHERE r.distro = ? AND r.name = ? AND i.kind = ? AND i.component = ? AND i.architecture = ? ORDER BY d.key`)
        .all(distro, release, kind, component, architecture).map(r => r.key as string);
}

function count(db: Database, table: string): number {
    return (db.prepare(`SELECT count(*) AS n FROM ${ table }`).get() as { n: number }).n;
}

function withCatalog(fn: (db: Database, catalog: DebCatalog) => void) {
    return withLocalTmpDir(async () => {
        const db = openDatabase("repo.db");
        try {
            fn(db, new DebCatalog(db));
        } finally {
            db.close();
        }
    });
}

const HELLO_KEY = binarySortKey("srm-hello", "srm-hello", "1.0-1", "amd64");

describe("Tests for DebCatalog.applyUpload", () => {
    test("Binary-only arm64 upload keeps the amd64 binaries and the source", withCatalog((db, catalog) => {
        const full = upload({ binaries: [binary("srm-hello", "1.0-1", "amd64"), binary("srm-hello-doc", "1.0-1", "all")] });
        expect(catalog.applyUpload(full, NOW)).toEqual({ ok: true, unreferenced: [] });
        const arm64 = upload({ scope: ["arm64"], binaries: [binary("srm-hello", "1.0-1", "arm64")] });
        expect(arm64.sourcePackage).toBeUndefined();
        expect(catalog.applyUpload(arm64, NOW + 1)).toEqual({ ok: true, unreferenced: [] });

        expect(binaries(db)).toEqual([
            "main deb srm-hello 1.0-1 amd64", "main deb srm-hello 1.0-1 arm64", "main deb srm-hello-doc 1.0-1 all",
        ]);
        expect(sources(db)).toEqual(["main srm-hello 1.0-1"]);
        expect(uploads(db)).toEqual(["srm-hello_1.0-1_amd64.changes: all amd64 source", "srm-hello_1.0-1_arm64.changes: arm64"]);
        expect(poolRows(db).map(r => r.removed_at)).toEqual(Array(10).fill(null));
        expect(catalog.listFiles({ source: "srm-hello" }, {}).items.map(i => i.path)).toEqual([...paths(full), ...paths(arm64)].sort());
        expect(indexFiles(db)).toEqual([
            "contents main amd64 0", "contents main arm64 0", "packages main amd64 0", "packages main arm64 0", "sources main  0",
        ]);
        expect(dirtyKeys(db, "packages", "main", "arm64")).toEqual([binarySortKey("srm-hello", "srm-hello", "1.0-1", "arm64")]);
        expect(catalog.releases()).toEqual([{ distro: "debian", release: "trixie", components: ["main"], architectures: ["amd64", "arm64"] }]);
    }));

    test("Full rebuild replaces its own upload and keeps the binary-only one", withCatalog((db, catalog) => {
        catalog.applyUpload(upload({ binaries: [binary("srm-hello", "1.0-1", "amd64")] }), NOW);
        catalog.applyUpload(upload({ scope: ["arm64"], binaries: [binary("srm-hello", "1.0-1", "arm64")] }), NOW + 1);
        const rebuilt = upload({ variant: "rebuilt", binaries: [binary("srm-hello", "1.0-1", "amd64", { variant: "rebuilt" })] });
        expect(catalog.applyUpload(rebuilt, NOW + 2)).toEqual({ ok: true, unreferenced: [] });

        expect(binaries(db)).toEqual(["main deb srm-hello 1.0-1 amd64", "main deb srm-hello 1.0-1 arm64"]);
        expect(uploads(db)).toEqual(["srm-hello_1.0-1_amd64.changes: amd64 source", "srm-hello_1.0-1_arm64.changes: arm64"]);
        expect(count(db, "deb_sources")).toBe(1);
        expect(count(db, "deb_upload_files")).toBe(4);
        expect(poolRow(db, rebuilt.binaries[0].file.path)?.sha256).toBe(rebuilt.binaries[0].file.sha256);
        expect(poolRow(db, rebuilt.trackedFiles[0].path)?.sha256).toBe(rebuilt.trackedFiles[0].sha256);
    }));

    test("Path rows carry the release and component of their binary, and go with it", withCatalog((db, catalog) => {
        const contrib = { component: "contrib", source: "srm-contrib" };
        catalog.applyUpload(upload({ binaries: [binary("srm-hello", "1.0-1", "amd64")] }), NOW);
        catalog.applyUpload(upload({ ...contrib, binaries: [binary("srm-contrib", "1.0-1", "amd64", contrib)] }), NOW);
        catalog.applyUpload(upload({ release: "bookworm", binaries: [binary("srm-hello", "1.0-1", "amd64")] }), NOW);
        const rows = () => db.prepare(`
            SELECT r.name AS release, p.component, p.path FROM deb_binary_paths p JOIN releases r ON r.id = p.release_id
                JOIN deb_binaries b ON b.id = p.binary_id AND b.release_id = p.release_id AND b.component = p.component ORDER BY 1, 2, 3`).all().map(row => ({ ...row }));

        expect(rows()).toEqual([
            { release: "bookworm", component: "main", path: "usr/bin/srm-hello" },
            { release: "trixie", component: "contrib", path: "usr/bin/srm-contrib" },
            { release: "trixie", component: "main", path: "usr/bin/srm-hello" },
        ]);

        catalog.remove({ release: "trixie", source: "srm-hello" }, NOW + 1, false);

        expect(rows()).toEqual([
            { release: "bookworm", component: "main", path: "usr/bin/srm-hello" },
            { release: "trixie", component: "contrib", path: "usr/bin/srm-contrib" },
        ]);
    }));

    test("Full rebuild drops a binary missing from the new set and marks its file removed_at", withCatalog((db, catalog) => {
        const first = upload({ binaries: [binary("srm-hello", "1.0-1", "amd64"), binary("srm-hello-extra", "1.0-1", "amd64")] });
        expect(catalog.applyUpload(first, NOW)).toEqual({ ok: true, unreferenced: [] });
        const second = upload({ variant: "rebuilt", binaries: [binary("srm-hello", "1.0-1", "amd64", { variant: "rebuilt" })] });
        const extra = first.binaries[1].file.path;
        expect(catalog.applyUpload(second, NOW + 1)).toEqual({ ok: true, unreferenced: [extra] });

        expect(binaries(db)).toEqual(["main deb srm-hello 1.0-1 amd64"]);
        expect(count(db, "deb_binary_paths")).toBe(1);
        expect(poolRow(db, extra)).toEqual({ path: extra, sha256: first.binaries[1].file.sha256, removed_at: NOW + 1 });
        expect(poolRows(db).filter(r => r.path !== extra).map(r => r.removed_at)).toEqual(Array(6).fill(null));
        // Same name, different digest and no reference outside the scope: overwritten in place
        expect(poolRow(db, second.binaries[0].file.path)?.sha256).toBe(second.binaries[0].file.sha256);
        expect(poolRow(db, second.sourcePackage!.files[0].path)?.sha256).toBe(second.sourcePackage!.files[0].sha256);
        expect(dirtyKeys(db, "packages", "main", "amd64")).toEqual([HELLO_KEY, binarySortKey("srm-hello", "srm-hello-extra", "1.0-1", "amd64")]);
        expect(dirtyKeys(db, "contents", "main", "amd64")).toEqual(["usr/bin/srm-hello", "usr/bin/srm-hello-extra"]);
        expect(dirtyKeys(db, "sources", "main", "")).toEqual([sourceSortKey("srm-hello", "1.0-1")]);
    }));

    test("Same name with different digest referenced by another release is a conflict and writes nothing", withCatalog((db, catalog) => {
        const trixie = upload({ binaries: [binary("srm-hello", "1.0-1", "amd64")] });
        catalog.applyUpload(trixie, NOW);
        const before = poolRows(db);
        const bookworm = upload({ release: "bookworm", origVariant: "other", binaries: [binary("srm-hello", "1.0-1", "amd64")] });
        const orig = bookworm.sourcePackage!.files[1].path;
        expect(orig).toBe(trixie.sourcePackage!.files[1].path);

        expect(catalog.applyUpload(bookworm, NOW + 1)).toEqual({ ok: false, conflicts: [orig] });

        expect(poolRows(db)).toEqual(before);
        expect(count(db, "releases")).toBe(1);
        expect(sources(db)).toEqual(["main srm-hello 1.0-1"]);
        expect(uploads(db)).toEqual(["srm-hello_1.0-1_amd64.changes: amd64 source"]);
        expect(indexFiles(db, "debian", "bookworm")).toEqual([]);
        expect(dirtyKeys(db, "packages", "main", "amd64")).toEqual([HELLO_KEY]);
    }));

    test("A binary name owned by another source is a conflict and writes nothing", withCatalog((db, catalog) => {
        catalog.applyUpload(upload({ binaries: [binary("srm-hello", "1.0-1", "amd64"), binary("srm-common", "1.0-1", "amd64")] }), NOW);
        const before = { pool: poolRows(db), binaries: binaries(db) };
        const other = { source: "srm-other" };
        const u = upload({ ...other, binaries: [binary("srm-other", "1.0-1", "amd64", other), binary("srm-common", "1.0-1", "amd64", other)] });

        expect(catalog.applyUpload(u, NOW + 1))
            .toEqual({ ok: false, conflicts: ["srm-common_1.0-1_amd64 (deb) is already provided by source srm-hello 1.0-1"] });

        expect(poolRows(db)).toEqual(before.pool);
        expect(binaries(db)).toEqual(before.binaries);
        expect(sources(db)).toEqual(["main srm-hello 1.0-1"]);
        expect(dirtyKeys(db, "sources", "main", "")).toEqual([sourceSortKey("srm-hello", "1.0-1")]);
    }));

    test("A binary-only upload creates the Sources index of its component", withCatalog((db, catalog) => {
        const u = upload({ component: "contrib", scope: ["arm64"], binaries: [binary("srm-hello", "1.0-1", "arm64", { component: "contrib" })] });
        expect(u.sourcePackage).toBeUndefined();
        expect(catalog.applyUpload(u, NOW)).toEqual({ ok: true, unreferenced: [] });
        expect(indexFiles(db)).toEqual(["contents contrib arm64 0", "packages contrib arm64 0", "sources contrib  0"]);
        expect(dirtyKeys(db, "sources", "contrib", "")).toEqual([]);
        expect(catalog.releases()).toEqual([{ distro: "debian", release: "trixie", components: ["contrib"], architectures: ["arm64"] }]);
    }));

    test("Same digest shared by another release is kept", withCatalog((db, catalog) => {
        catalog.applyUpload(upload({ binaries: [binary("srm-hello", "1.0-1", "amd64")] }), NOW);
        const bookworm = upload({ release: "bookworm", binaries: [binary("srm-hello", "1.0-1", "amd64")] });
        expect(catalog.applyUpload(bookworm, NOW + 1)).toEqual({ ok: true, unreferenced: [] });
        expect(count(db, "pool_files")).toBe(6);
        expect(count(db, "deb_binaries")).toBe(2);
        expect(catalog.releases("debian").map(r => r.release)).toEqual(["bookworm", "trixie"]);
    }));

    test("Re-referencing a removed file clears removed_at", withCatalog((db, catalog) => {
        const u = upload({ binaries: [binary("srm-hello", "1.0-1", "amd64")] });
        catalog.applyUpload(u, NOW);
        expect(catalog.remove({ source: "srm-hello" }, NOW + 1, false)).toEqual({ removed: paths(u), deleteNow: [] });
        expect(poolRows(db).map(r => r.removed_at)).toEqual(Array(6).fill(NOW + 1));
        expect(count(db, "deb_binaries") + count(db, "deb_sources") + count(db, "deb_uploads")).toBe(0);
        expect(count(db, "deb_binary_paths") + count(db, "deb_source_files") + count(db, "deb_upload_files")).toBe(0);
        expect(dirtyKeys(db, "packages", "main", "amd64")).toEqual([HELLO_KEY]);
        expect(dirtyKeys(db, "sources", "main", "")).toEqual([sourceSortKey("srm-hello", "1.0-1")]);

        expect(catalog.applyUpload(u, NOW + 2)).toEqual({ ok: true, unreferenced: [] });
        expect(poolRows(db).map(r => r.removed_at)).toEqual(Array(6).fill(null));
        expect(count(db, "pool_files")).toBe(6);
    }));

    test("A removed file re-uploaded with another digest is overwritten", withCatalog((db, catalog) => {
        catalog.applyUpload(upload({ binaries: [binary("srm-hello", "1.0-1", "amd64")] }), NOW);
        catalog.remove({ source: "srm-hello" }, NOW + 1, false);
        const again = upload({ variant: "v2", origVariant: "v2", binaries: [binary("srm-hello", "1.0-1", "amd64", { variant: "v2" })] });
        expect(catalog.applyUpload(again, NOW + 2)).toEqual({ ok: true, unreferenced: [] });
        expect(poolRows(db)).toEqual([...again.trackedFiles, ...again.sourcePackage!.files, again.binaries[0].file]
            .map(f => ({ path: f.path, sha256: f.sha256, removed_at: null })).sort((a, b) => a.path < b.path ? -1 : 1));
    }));

    test("Arch all binary marks every concrete architecture's Packages dirty", withCatalog((db, catalog) => {
        catalog.applyUpload(upload({ binaries: [binary("srm-hello", "1.0-1", "amd64")] }), NOW);
        catalog.applyUpload(upload({ scope: ["arm64"], binaries: [binary("srm-hello", "1.0-1", "arm64")] }), NOW + 1);
        db.exec("DELETE FROM dirty_keys");
        const doc = upload({ source: "srm-doc", version: "2.0-1", binaries: [binary("srm-doc", "2.0-1", "all", { source: "srm-doc" })] });
        expect(catalog.applyUpload(doc, NOW + 2)).toEqual({ ok: true, unreferenced: [] });

        const key = binarySortKey("srm-doc", "srm-doc", "2.0-1", "all");
        expect(dirtyKeys(db, "packages", "main", "amd64")).toEqual([key]);
        expect(dirtyKeys(db, "packages", "main", "arm64")).toEqual([key]);
        expect(dirtyKeys(db, "contents", "main", "amd64")).toEqual(["usr/bin/srm-doc"]);
        expect(dirtyKeys(db, "contents", "main", "arm64")).toEqual(["usr/bin/srm-doc"]);
        expect(dirtyKeys(db, "sources", "main", "")).toEqual([sourceSortKey("srm-doc", "2.0-1")]);
        expect(indexFiles(db).filter(f => f.includes(" all "))).toEqual([]);
        expect(catalog.releases()[0].architectures).toEqual(["amd64", "arm64"]);
    }));

    test("A release with only arch all binaries uses all until a concrete architecture arrives", withCatalog((db, catalog) => {
        const doc = upload({ source: "srm-doc", version: "2.0-1", binaries: [binary("srm-doc", "2.0-1", "all", { source: "srm-doc" })] });
        catalog.applyUpload(doc, NOW);
        expect(indexFiles(db)).toEqual(["contents main all 0", "packages main all 0", "sources main  0"]);
        expect(dirtyKeys(db, "packages", "main", "all")).toEqual([binarySortKey("srm-doc", "srm-doc", "2.0-1", "all")]);
        expect(catalog.releases()).toEqual([{ distro: "debian", release: "trixie", components: ["main"], architectures: ["all"] }]);
        db.exec("UPDATE index_files SET generation = 1, stored_path = 'deb/debian/dists/trixie/main/binary-all/by-hash/SHA256/x' WHERE kind = 'packages'");

        catalog.applyUpload(upload({ binaries: [binary("srm-hello", "1.0-1", "amd64")] }), NOW + 1);

        expect(indexFiles(db)).toEqual(["contents main amd64 0", "packages main amd64 0", "sources main  0"]);
        expect(db.prepare("SELECT path, superseded_at FROM superseded_files").all())
            .toEqual([{ path: "deb/debian/dists/trixie/main/binary-all/by-hash/SHA256/x", superseded_at: NOW + 1 }]);
        expect(catalog.releases()[0].architectures).toEqual(["amd64"]);
        expect(dirtyKeys(db, "packages", "main", "amd64")).toEqual([HELLO_KEY]);
    }));

    test("ddeb goes to debug, udeb to installer and Contents-udeb", withCatalog((db, catalog) => {
        const target = { distro: "ubuntu", release: "noble", component: "universe", source: "srm-zst" };
        const u = upload({
            ...target, version: "2:3.0-1", binaries: [
                binary("srm-zst", "2:3.0-1", "amd64", target),
                binary("srm-zst-dbgsym", "2:3.0-1", "amd64", { ...target, kind: "ddeb" }),
                binary("srm-zst-udeb", "2:3.0-1", "amd64", { ...target, kind: "udeb" }),
            ],
        });
        expect(catalog.applyUpload(u, NOW)).toEqual({ ok: true, unreferenced: [] });
        expect(indexFiles(db, "ubuntu", "noble")).toEqual([
            "contents universe amd64 0", "contents-udeb universe amd64 0", "debug universe amd64 0", "installer universe amd64 0",
            "packages universe amd64 0", "sources universe  0",
        ]);
        const key = (pkg: string) => binarySortKey("srm-zst", pkg, "2:3.0-1", "amd64");
        expect(dirtyKeys(db, "packages", "universe", "amd64", "ubuntu", "noble")).toEqual([key("srm-zst")]);
        expect(dirtyKeys(db, "debug", "universe", "amd64", "ubuntu", "noble")).toEqual([key("srm-zst-dbgsym")]);
        expect(dirtyKeys(db, "installer", "universe", "amd64", "ubuntu", "noble")).toEqual([key("srm-zst-udeb")]);
        expect(dirtyKeys(db, "contents", "universe", "amd64", "ubuntu", "noble")).toEqual(["usr/bin/srm-zst"]);
        expect(dirtyKeys(db, "contents-udeb", "universe", "amd64", "ubuntu", "noble")).toEqual(["usr/bin/srm-zst-udeb"]);
        expect(catalog.listSources({}, {}).items).toEqual([{ distro: "ubuntu", release: "noble", source: "srm-zst", version: "2:3.0-1" }]);
    }));
});

describe("Tests for DebCatalog.ensureCell", () => {
    const CELL = { distro: "debian", release: "trixie", component: "main" };

    test("A cell without packages gets its release and the grid an upload would build", withCatalog((db, catalog) => {
        catalog.ensureCell({ ...CELL, kind: "deb", architecture: "amd64" }, NOW);

        expect(catalog.releases()).toEqual([{ distro: "debian", release: "trixie", components: ["main"], architectures: ["amd64"] }]);
        expect(indexFiles(db)).toEqual(["contents main amd64 0", "packages main amd64 0", "sources main  0"]);

        catalog.ensureCell({ ...CELL, kind: "udeb", architecture: "amd64" }, NOW);
        catalog.ensureCell({ ...CELL, kind: "ddeb", architecture: "arm64" }, NOW);

        expect(indexFiles(db)).toEqual([
            "contents main amd64 0", "contents main arm64 0", "contents-udeb main amd64 0", "contents-udeb main arm64 0", "debug main amd64 0", "debug main arm64 0",
            "installer main amd64 0", "installer main arm64 0", "packages main amd64 0", "packages main arm64 0", "sources main  0",
        ]);
        expect(count(db, "dirty_keys")).toBe(0);
    }));

    test("A source cell alone names no architecture; a concrete architecture retires all", withCatalog((db, catalog) => {
        catalog.ensureCell({ ...CELL, kind: "source", architecture: "" }, NOW);

        expect(catalog.releases()).toEqual([{ distro: "debian", release: "trixie", components: ["main"], architectures: [] }]);
        expect(indexFiles(db)).toEqual(["sources main  0"]);

        catalog.ensureCell({ ...CELL, kind: "deb", architecture: "all" }, NOW);
        expect(indexFiles(db)).toEqual(["contents main all 0", "packages main all 0", "sources main  0"]);

        catalog.ensureCell({ ...CELL, kind: "deb", architecture: "amd64" }, NOW);
        expect(indexFiles(db)).toEqual(["contents main amd64 0", "packages main amd64 0", "sources main  0"]);
    }));
});

describe("Tests for DebCatalog.remove", () => {
    test("Immediate removal returns unreferenced paths, marks them removed and keeps the shared orig tarball", withCatalog((db, catalog) => {
        const v1 = upload({ version: "1.0-1", binaries: [binary("srm-hello", "1.0-1", "amd64")] });
        const v2 = upload({ version: "1.0-2", binaries: [binary("srm-hello", "1.0-2", "amd64")] });
        catalog.applyUpload(v1, NOW);
        expect(catalog.applyUpload(v2, NOW + 1)).toEqual({ ok: true, unreferenced: [] });
        const orig = v2.sourcePackage!.files[1].path;
        expect(paths(v1)).toContain(orig);

        const freed = paths(v2).filter(p => p !== orig);
        expect(catalog.remove({ source: "srm-hello", version: "1.0-2" }, NOW + 2, true)).toEqual({ removed: paths(v2), deleteNow: freed });

        // The rows stay, marked as in GC mode, until the files are deleted
        const rows = poolRows(db);
        expect(rows.filter(r => r.removed_at === null)).toEqual([...v1.trackedFiles, ...v1.sourcePackage!.files, v1.binaries[0].file]
            .map(f => ({ path: f.path, sha256: f.sha256, removed_at: null })).sort((a, b) => a.path < b.path ? -1 : 1));
        expect(rows.filter(r => r.removed_at !== null).map(r => [r.path, r.removed_at])).toEqual(freed.map(p => [p, NOW + 2]));
        expect(sources(db)).toEqual(["main srm-hello 1.0-1"]);
        expect(binaries(db)).toEqual(["main deb srm-hello 1.0-1 amd64"]);
        expect(uploads(db)).toEqual(["srm-hello_1.0-1_amd64.changes: amd64 source"]);
        expect(dirtyKeys(db, "packages", "main", "amd64")).toContain(binarySortKey("srm-hello", "srm-hello", "1.0-2", "amd64"));
        expect(dirtyKeys(db, "sources", "main", "")).toContain(sourceSortKey("srm-hello", "1.0-2"));
    }));

    test("Removal by release keeps files shared with another release", withCatalog((db, catalog) => {
        const trixie = upload({ binaries: [binary("srm-hello", "1.0-1", "amd64")] });
        catalog.applyUpload(trixie, NOW);
        catalog.applyUpload(upload({ release: "bookworm", binaries: [binary("srm-hello", "1.0-1", "amd64")] }), NOW);
        expect(catalog.remove({ release: "sid", source: "srm-hello" }, NOW + 1, true)).toEqual({ removed: [], deleteNow: [] });

        expect(catalog.remove({ distro: "debian", release: "bookworm", source: "srm-hello" }, NOW + 1, true))
            .toEqual({ removed: paths(trixie), deleteNow: [] });
        expect(poolRows(db).map(r => r.removed_at)).toEqual(Array(6).fill(null));
        expect(catalog.listSources({}, {}).items).toEqual([{ distro: "debian", release: "trixie", source: "srm-hello", version: "1.0-1" }]);
        expect(catalog.releases("debian", "bookworm")).toEqual([{ distro: "debian", release: "bookworm", components: ["main"], architectures: ["amd64"] }]);
    }));
});

describe("Tests for DebCatalog listing", () => {
    test("The version filters compare as dpkg does, by the parts asked for, and latest keeps the newest of them", withCatalog((_db, catalog) => {
        catalog.applyUpload(upload({ version: "1.0-1", binaries: [binary("srm-hello", "1.0-1", "amd64"), binary("srm-hello", "1.0-1", "arm64")] }), NOW);
        for (const version of ["1.0-2", "1.1-1", "2:0.9-1"]) {
            catalog.applyUpload(upload({ version, binaries: [binary("srm-hello", version, "amd64")] }), NOW);
        }
        const found = (q: Partial<PackageQuery>) => catalog.searchFiles({ name: "srm-hello", ...q }, {}).items
            .map(i => `${ i.kind } ${ i.version } ${ i.architecture }`);

        expect(found({ version: "1.0" })).toEqual(["binary 1.0-1 amd64", "binary 1.0-1 arm64", "source 1.0-1 source", "binary 1.0-2 amd64", "source 1.0-2 source"]);
        expect(found({ version: "0:1.0-2" })).toEqual(["binary 1.0-2 amd64", "source 1.0-2 source"]);
        expect(found({ version: "0.9" })).toEqual(["binary 2:0.9-1 amd64", "source 2:0.9-1 source"]);
        expect(found({ version: "1:0.9" })).toEqual([]);
        expect(found({ latest: true })).toEqual(["binary 1.0-1 arm64", "binary 2:0.9-1 amd64", "source 2:0.9-1 source"]);
        expect(found({ latest: true, version: "1.0" })).toEqual(["binary 1.0-1 arm64", "binary 1.0-2 amd64", "source 1.0-2 source"]);
        expect(found({ latest: true, architectures: ["arm64"] })).toEqual(["binary 1.0-1 arm64"]);
    }));

    test("Each package once, with its versions newest first as dpkg orders them and the architectures of each", withCatalog((_db, catalog) => {
        for (const [version, arches] of [["1.0-9", ["amd64", "arm64"]], ["1.0-10", ["amd64"]], ["1.0~rc1-1", ["arm64"]]] as const) {
            catalog.applyUpload(upload({ version, binaries: arches.map(arch => binary("srm-hello", version, arch)) }), NOW);
        }

        expect(catalog.searchPackages({ name: "srm-hello" }, {}).items).toEqual([
            { distro: "debian", release: "trixie", kind: "binary", package: "srm-hello", source: "srm-hello",
                versions: [{ version: "1.0-10", architectures: ["amd64"] }, { version: "1.0-9", architectures: ["amd64", "arm64"] },
                    { version: "1.0~rc1-1", architectures: ["arm64"] }] },
            { distro: "debian", release: "trixie", kind: "source", package: "srm-hello", source: "srm-hello",
                versions: ["1.0-10", "1.0-9", "1.0~rc1-1"].map(version => ({ version, architectures: ["source"] })) },
        ]);
        expect(catalog.searchPackages({ name: "srm-hello", kinds: ["binary"], latest: true }, {}).items.map(i => i.versions))
            .toEqual([[{ version: "1.0-10", architectures: ["amd64"] }, { version: "1.0-9", architectures: ["arm64"] }]]);
    }));

    test("A package in section debug is a debug package, a .deb as Debian ships them or a .ddeb", withCatalog((_db, catalog) => {
        catalog.applyUpload(upload({
            binaries: [
                binary("srm-hello", "1.0-1", "amd64"),
                binary("srm-hello-dbgsym", "1.0-1", "amd64", { section: "debug" }),
                binary("srm-hello-doc-dbgsym", "1.0-1", "amd64", { kind: "ddeb" }),
            ],
        }), NOW);

        expect(catalog.searchFiles({ source: "srm-hello" }, {}).items.map(i => `${ i.kind } ${ i.package }`)).toEqual([
            "binary srm-hello",
            "source srm-hello",
            "debug srm-hello-dbgsym",
            "debug srm-hello-doc-dbgsym",
        ]);
    }));

    test("listSources pages with a cursor", withCatalog((db, catalog) => {
        for (const source of ["srm-c", "srm-a", "srm-b"]) {
            catalog.applyUpload(upload({ source, binaries: [binary(source, "1.0-1", "amd64", { source })] }), NOW);
        }
        const first = catalog.listSources({}, { limit: 2 });
        expect(first.items).toEqual([
            { distro: "debian", release: "trixie", source: "srm-a", version: "1.0-1" },
            { distro: "debian", release: "trixie", source: "srm-b", version: "1.0-1" },
        ]);
        expect(first.nextCursor).toEqual(expect.any(String));
        const second = catalog.listSources({}, { limit: 2, cursor: first.nextCursor });
        expect(second).toEqual({ items: [{ distro: "debian", release: "trixie", source: "srm-c", version: "1.0-1" }] });

        expect(catalog.listSources({ source: "srm-b" }, {}).items.map(i => i.source)).toEqual(["srm-b"]);
        expect(catalog.listSources({ distro: "ubuntu" }, {})).toEqual({ items: [] });
        expect(() => catalog.listSources({}, { cursor: "not-a-cursor" })).toThrow(RepoValidationError);
        expect(() => catalog.listSources({}, { limit: 0 })).toThrow(RepoValidationError);
        expect(MAX_PAGE_SIZE).toBe(1000);
    }));

    test("A source filter pages through its versions and seeks to them", withCatalog((db, catalog) => {
        for (const [source, version] of [["srm-a", "1.0-1"], ["srm-b", "1.0-1"], ["srm-b", "1.0-2"], ["srm-b", "1.0-3"], ["srm-c", "1.0-1"]]) {
            catalog.applyUpload(upload({ source, version, binaries: [binary(source, version, "amd64", { source })] }), NOW);
        }
        catalog.applyUpload(upload({ release: "bookworm", source: "srm-b", binaries: [binary("srm-b", "1.0-1", "amd64", { source: "srm-b" })] }), NOW);

        const first = catalog.listSources({ source: "srm-b" }, { limit: 2 });
        expect(first.items.map(i => `${ i.release } ${ i.source } ${ i.version }`)).toEqual(["bookworm srm-b 1.0-1", "trixie srm-b 1.0-1"]);
        const second = catalog.listSources({ source: "srm-b" }, { limit: 1, cursor: first.nextCursor });
        expect(second.items.map(i => i.version)).toEqual(["1.0-2"]);
        expect(catalog.listSources({ source: "srm-b" }, { cursor: second.nextCursor })).toEqual({ items: [{ distro: "debian", release: "trixie", source: "srm-b", version: "1.0-3" }] });
        expect(catalog.listSources({ source: "srm-z" }, {})).toEqual({ items: [] });

        const prepare = jest.spyOn(db, "prepare");
        new DebCatalog(db);
        const sql = prepare.mock.calls.map(([s]) => s).find(s => s.includes("source = ?4"))!;
        prepare.mockRestore();
        expect(db.prepare(`EXPLAIN QUERY PLAN ${ sql }`).all().map(r => r.detail))
            .toEqual(["SEARCH deb_sources USING COVERING INDEX sqlite_autoindex_deb_sources_1 (release_id=? AND source=?)"]);
    }));

    test("listFiles pages across releases with a cursor", withCatalog((db, catalog) => {
        const trixie = upload({ binaries: [binary("srm-hello", "1.0-1", "amd64")] });
        catalog.applyUpload(trixie, NOW);
        catalog.applyUpload(upload({ release: "bookworm", binaries: [binary("srm-hello", "1.0-1", "amd64")] }), NOW);
        const expected = [
            ...paths(trixie).map(path => ({ distro: "debian", release: "bookworm", path })),
            ...paths(trixie).map(path => ({ distro: "debian", release: "trixie", path })),
        ];

        const first = catalog.listFiles({ source: "srm-hello" }, { limit: 8 });
        expect(first.items).toEqual(expected.slice(0, 8));
        const second = catalog.listFiles({ source: "srm-hello" }, { limit: 8, cursor: first.nextCursor });
        expect(second).toEqual({ items: expected.slice(8) });

        expect(catalog.listFiles({ release: "trixie", source: "srm-hello", version: "1.0-1" }, {}).items).toEqual(expected.slice(6));
        expect(catalog.listFiles({ source: "srm-hello", version: "9.9-9" }, {})).toEqual({ items: [] });
    }));

    test("releases() reports components and architectures without 'all'", withCatalog((db, catalog) => {
        catalog.applyUpload(upload({ binaries: [binary("srm-hello", "1.0-1", "amd64"), binary("srm-hello-doc", "1.0-1", "all")] }), NOW);
        const contrib = { component: "contrib", source: "srm-contrib" };
        catalog.applyUpload(upload({ ...contrib, binaries: [binary("srm-contrib", "1.0-1", "arm64", contrib)] }), NOW);
        catalog.applyUpload(upload({ release: "bookworm", binaries: [binary("srm-hello", "1.0-1", "amd64")] }), NOW);
        const noble = { distro: "ubuntu", release: "noble", component: "universe", source: "srm-zst" };
        catalog.applyUpload(upload({ ...noble, binaries: [binary("srm-zst", "3.0-1", "amd64", noble)] }), NOW);

        expect(catalog.releases()).toEqual([
            { distro: "debian", release: "bookworm", components: ["main"], architectures: ["amd64"] },
            { distro: "debian", release: "trixie", components: ["contrib", "main"], architectures: ["amd64", "arm64"] },
            { distro: "ubuntu", release: "noble", components: ["universe"], architectures: ["amd64"] },
        ]);
        expect(catalog.releases("debian").map(r => r.release)).toEqual(["bookworm", "trixie"]);
        expect(catalog.releases("debian", "trixie").map(r => r.release)).toEqual(["trixie"]);
        expect(catalog.releases("ubuntu", "trixie")).toEqual([]);
        // Every component gets the index files of every architecture of the release
        expect(indexFiles(db)).toEqual([
            "contents contrib amd64 0", "contents contrib arm64 0", "contents main amd64 0", "contents main arm64 0",
            "packages contrib amd64 0", "packages contrib arm64 0", "packages main amd64 0", "packages main arm64 0",
            "sources contrib  0", "sources main  0",
        ]);
    }));
});
