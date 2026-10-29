import type { Database } from "node:sqlite";
import { transaction } from "../db.ts";
import { KEY_SEP } from "../deb/stanzas.ts";
import { collectPage } from "../paging.ts";
import type { FileListing, Page, SourceListing } from "../paging.ts";
import { Pool } from "../pool.ts";
import type { PoolFile } from "../pool.ts";
import type { MetadataKind } from "./xml.ts";
import { RepoValidationError } from "../../lib/errors.ts";

export type RpmPackageInput = {
    distro: string;
    release: string;
    filename: string;
    name: string;
    epoch: number;
    version: string;
    rel: string;
    arch: string;
    /** Name and ver-rel of the source: a .src.rpm's own, a binary's from SOURCERPM */
    sourceName: string;
    sourceVersion: string;
    file: PoolFile;
    primaryXml: string;
    filelistsXml: string;
    otherXml: string;
};

export type RpmReleaseView = { distro: string; release: string };

export const REFERENCING_TABLES = ["rpm_packages"];

const METADATA_KINDS: MetadataKind[] = ["primary", "filelists", "other"];

type PackageRow = { id: number; sort_key: string; file_id: number };

/** Location of a package below the release directory, as primary.xml's href */
export function rpmHref(sourceName: string, filename: string): string {
    if (sourceName.length === 0) {
        throw new RepoValidationError("Empty source package name");
    }
    // Lower case: on a case-insensitive volume N and n, or two spellings of a source, would be one directory
    const directory = sourceName.toLowerCase();
    return `Packages/${ directory[0] }/${ directory }/${ filename }`;
}

/** Pool path relative to repoDir */
export function rpmPoolPath(distro: string, release: string, sourceName: string, filename: string): string {
    return `rpm/${ distro }/${ release }/${ rpmHref(sourceName, filename) }`;
}

/** Ordered by source, package, version and arch; the file name makes the key unique within a release */
export function rpmSortKey(sourceName: string, name: string, epoch: number, version: string, rel: string, arch: string, filename: string): string {
    return [sourceName, name, `${ epoch }:${ version }-${ rel }`, arch, filename].join(KEY_SEP);
}

/** The dot and the code points of JavaScript's \s: a dist tag holds none of them */
const NOT_IN_DIST_TAG = [
    0x2e, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

/** ver-rel, or ver-rel plus one dist tag; not LIKE, whose _ and % are wildcards */
const VERSION_MATCHES = `(?3 IS NULL OR source_version = ?3 OR (substr(source_version, 1, length(?3) + 1) = ?3 || '.'
    AND length(source_version) > length(?3) + 1
    AND substr(source_version, length(?3) + 2) NOT GLOB ('*[' || char(${ NOT_IN_DIST_TAG.join(", ") }) || ']*')))`;

function prepareStatements(db: Database) {
    return {
        selectPackage: db.prepare("SELECT id, sort_key, file_id FROM rpm_packages WHERE release_id = ? AND filename = ?"),
        selectPackages: db.prepare(`
            SELECT id, sort_key, file_id FROM rpm_packages WHERE release_id = ?1 AND source_name = ?2 AND ${ VERSION_MATCHES }`),
        insertPackage: db.prepare(`
            INSERT INTO rpm_packages (release_id, filename, name, epoch, version, rel, arch, source_name, source_version, sort_key, file_id,
                primary_xml, filelists_xml, other_xml) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        deletePackage: db.prepare("DELETE FROM rpm_packages WHERE id = ?"),

        listSources: db.prepare(`
            SELECT DISTINCT source_name, source_version FROM rpm_packages WHERE release_id = ?1 AND (source_name, source_version) > (?2, ?3)
                ORDER BY source_name, source_version LIMIT ?4`),
        listSource: db.prepare(`
            SELECT DISTINCT source_name, source_version FROM rpm_packages WHERE release_id = ?1 AND source_name = ?4
                AND (source_name, source_version) > (?2, ?3) ORDER BY source_name, source_version LIMIT ?5`),
        listFiles: db.prepare(`
            SELECT path FROM pool_files WHERE path > ?4 AND id IN (
                SELECT file_id FROM rpm_packages WHERE release_id = ?1 AND source_name = ?2 AND ${ VERSION_MATCHES })
                ORDER BY path LIMIT ?5`),
    };
}

/**
 * The RPM table: one row per (release, file name) with its rendered metadata, the pool file it references, and the dirty
 * keys that tell the publisher which releases to regenerate. Every write is one transaction.
 */
export class RpmCatalog {
    private readonly db: Database;
    private readonly pool: Pool;
    private readonly s: ReturnType<typeof prepareStatements>;

    constructor(db: Database) {
        this.db = db;
        this.pool = new Pool(db, "rpm", REFERENCING_TABLES);
        this.s = prepareStatements(db);
    }

    /**
     * Adds the package, replacing the row of the same file name in the release. `replacedPath` is that row's pool file:
     * overwritten in place when the path is the same, otherwise left to GC unless something else references it.
     */
    applyPackage(p: RpmPackageInput, now: number): { replacedPath?: string } {
        return transaction(this.db, () => {
            const releaseId = this.pool.ensureRelease(p.distro, p.release);
            const old = this.s.selectPackage.get(releaseId, p.filename) as PackageRow | undefined;
            if (old !== undefined) {
                this.s.deletePackage.run(old.id);
            }
            const sortKey = rpmSortKey(p.sourceName, p.name, p.epoch, p.version, p.rel, p.arch, p.filename);
            this.s.insertPackage.run(releaseId, p.filename, p.name, p.epoch, p.version, p.rel, p.arch, p.sourceName, p.sourceVersion, sortKey,
                this.pool.upsertPoolFile(p.file), p.primaryXml, p.filelistsXml, p.otherXml);
            if (old === undefined) {
                this.markDirty(releaseId, [sortKey]);
                return {};
            }
            this.markDirty(releaseId, [sortKey, old.sort_key]);
            const [replacedPath] = this.pool.poolPaths([old.file_id]);
            this.pool.retire([old.file_id], now);
            return { replacedPath };
        });
    }

    /**
     * Removes the packages of the source (its .src.rpm and the binaries built from it). `removed` lists every file they
     * referenced; those nothing references any more get removed_at, and with `immediate` are also returned in `deleteNow`
     * for deletion from disk.
     */
    remove(f: { distro?: string; release?: string; source: string; version?: string }, now: number, immediate: boolean):
        { removed: string[]; deleteNow: string[] } {

        return transaction(this.db, () => {
            const fileIds: number[] = [];
            for (const r of this.pool.releaseRows(f.distro, f.release)) {
                const rows = this.s.selectPackages.all(r.id, f.source, f.version ?? null) as PackageRow[];
                this.markDirty(r.id, rows.map(row => row.sort_key));
                for (const row of rows) {
                    this.s.deletePackage.run(row.id);
                    fileIds.push(row.file_id);
                }
            }
            return this.pool.removeFiles(fileIds, now, immediate);
        });
    }

    /** A release and its metadata, which stay published with no package in them */
    ensureRelease(distro: string, release: string): void {
        transaction(this.db, () => {
            const releaseId = this.pool.ensureRelease(distro, release);
            for (const kind of METADATA_KINDS) {
                this.pool.ensureIndexFile(releaseId, kind, "", "");
            }
        });
    }

    /** Every source a .src.rpm or a binary's SOURCERPM names; version is ver-rel without the epoch */
    listSources(f: { distro?: string; release?: string; source?: string }, page: Page): SourceListing {
        return collectPage(page, 2, from => this.pool.releaseRows(f.distro, f.release, from), (r, after, limit) => {
            const from = [r.id, after?.[0] ?? "", after?.[1] ?? ""];
            const rows = f.source === undefined ? this.s.listSources.all(...from, limit) : this.s.listSource.all(...from, f.source, limit);
            return (rows as { source_name: string; source_version: string }[])
                .map(row => ({ distro: r.distro, release: r.name, source: row.source_name, version: row.source_version }));
        }, i => [i.source, i.version]);
    }

    listFiles(f: { distro?: string; release?: string; source: string; version?: string }, page: Page): FileListing {
        return collectPage(page, 1, from => this.pool.releaseRows(f.distro, f.release, from),
            (r, after, limit) => (this.s.listFiles.all(r.id, f.source, f.version ?? null, after?.[0] ?? "", limit) as { path: string }[])
                .map(row => ({ distro: r.distro, release: r.name, path: row.path })),
            i => [i.path]);
    }

    releases(distro?: string, release?: string): RpmReleaseView[] {
        return this.pool.releaseRows(distro, release).map(r => ({ distro: r.distro, release: r.name }));
    }

    /** Every change touches the release's three metadata files */
    private markDirty(releaseId: number, keys: string[]): void {
        for (const kind of METADATA_KINDS) {
            this.pool.markDirty(releaseId, kind, "", "", keys);
        }
    }
}
