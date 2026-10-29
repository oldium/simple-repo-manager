import type { Database } from "node:sqlite";
import { transaction } from "../db.ts";
import { collectPage } from "../paging.ts";
import type { FileListing, Page, SourceListing } from "../paging.ts";
import { Pool } from "../pool.ts";
import type { PoolFile } from "../pool.ts";
import { binarySortKey, sourceSortKey } from "./stanzas.ts";

export { MAX_PAGE_SIZE } from "../paging.ts";
export type { FileListing, Page, SourceListing } from "../paging.ts";
export type { PoolFile } from "../pool.ts";

export type DebBinaryInput = {
    kind: "deb" | "ddeb" | "udeb";
    package: string;
    version: string;
    architecture: string;
    section: string;
    stanza: string;
    file: PoolFile;
    paths: string[];
};

export type DebUploadInput = {
    distro: string;
    release: string;
    component: string;
    source: string;
    version: string;
    /** The .changes Architecture list: "source", "all" and concrete architectures */
    scope: string[];
    changesName: string;
    /** Files owned by the upload itself: the .changes and .buildinfo */
    trackedFiles: PoolFile[];
    sourcePackage?: { stanza: string; files: PoolFile[] };
    binaries: DebBinaryInput[];
};

export type UploadOutcome = { ok: true; unreferenced: string[] } | { ok: false; conflicts: string[] };

export type DebReleaseView = { distro: string; release: string; components: string[]; architectures: string[] };

export type DebCell = { distro: string; release: string; component: string; architecture: string; kind: DebBinaryInput["kind"] | "source" };

type SourceRow = { id: number; component: string; sort_key: string };
type BinaryRow = { id: number; component: string; kind: DebBinaryInput["kind"]; architecture: string; sort_key: string; file_id: number };
type UploadRow = { id: number; changes_name: string; architectures: string };
type PoolRow = { id: number; sha256: string };

export const REFERENCING_TABLES = ["deb_binaries", "deb_source_files", "deb_upload_files"];

const INDEX_KINDS: Record<DebBinaryInput["kind"], { packages: string; contents?: string }> = {
    deb: { packages: "packages", contents: "contents" },
    ddeb: { packages: "debug" },
    udeb: { packages: "installer", contents: "contents-udeb" },
};

/** Thrown inside the upload transaction, so the rollback leaves nothing written */
class UploadConflicts {
    readonly paths: string[];

    constructor(paths: string[]) {
        this.paths = paths;
    }
}

function prepareStatements(db: Database) {
    return {
        selectSources: db.prepare(`
            SELECT id, component, sort_key FROM deb_sources WHERE release_id = ?1 AND source = ?2 AND (?3 IS NULL OR version = ?3)`),
        selectBinaries: db.prepare(`
            SELECT id, component, kind, architecture, sort_key, file_id FROM deb_binaries
                WHERE release_id = ?1 AND source = ?2 AND (?3 IS NULL OR source_version = ?3)`),
        selectUploads: db.prepare(`
            SELECT id, changes_name, architectures FROM deb_uploads WHERE release_id = ?1 AND source = ?2 AND (?3 IS NULL OR version = ?3)`),
        selectBinaryOwner: db.prepare(`
            SELECT source, source_version FROM deb_binaries
                WHERE release_id = ? AND kind = ? AND package = ? AND version = ? AND architecture = ?`),
        sourceFileIds: db.prepare("SELECT file_id FROM deb_source_files WHERE source_id = ?"),
        binaryPaths: db.prepare("SELECT path FROM deb_binary_paths WHERE binary_id = ?"),
        uploadFileIds: db.prepare("SELECT file_id FROM deb_upload_files WHERE upload_id = ?"),
        deleteSource: db.prepare("DELETE FROM deb_sources WHERE id = ?"),
        deleteBinary: db.prepare("DELETE FROM deb_binaries WHERE id = ?"),
        deleteUpload: db.prepare("DELETE FROM deb_uploads WHERE id = ?"),

        selectPoolFile: db.prepare("SELECT id, sha256 FROM pool_files WHERE path = ?"),

        insertSource: db.prepare(`
            INSERT INTO deb_sources (release_id, component, source, version, sort_key, stanza) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`),
        insertSourceFile: db.prepare("INSERT OR IGNORE INTO deb_source_files (source_id, file_id) VALUES (?, ?)"),
        insertBinary: db.prepare(`
            INSERT INTO deb_binaries (release_id, component, kind, package, version, architecture, source, source_version, section,
                sort_key, file_id, stanza) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`),
        insertBinaryPath: db.prepare("INSERT OR IGNORE INTO deb_binary_paths (release_id, component, path, binary_id) VALUES (?, ?, ?, ?)"),
        insertUpload: db.prepare(`
            INSERT INTO deb_uploads (release_id, source, version, changes_name, architectures) VALUES (?, ?, ?, ?, ?) RETURNING id`),
        insertUploadFile: db.prepare("INSERT OR IGNORE INTO deb_upload_files (upload_id, file_id) VALUES (?, ?)"),

        releaseArchitectures: db.prepare(
            "SELECT DISTINCT architecture FROM index_files WHERE release_id = ? AND architecture != '' ORDER BY architecture"),
        releaseComponents: db.prepare("SELECT DISTINCT component FROM index_files WHERE release_id = ? AND component != '' ORDER BY component"),
        releaseExtraKinds: db.prepare(
            "SELECT DISTINCT component, kind FROM index_files WHERE release_id = ? AND kind IN ('debug', 'installer') ORDER BY component, kind"),
        allIndexFiles: db.prepare("SELECT id, stored_path FROM index_files WHERE release_id = ? AND architecture = 'all'"),
        supersedeFile: db.prepare("INSERT OR REPLACE INTO superseded_files (path, superseded_at) VALUES (?, ?)"),
        deleteIndexFile: db.prepare("DELETE FROM index_files WHERE id = ?"),

        listSources: db.prepare(`
            SELECT source, version FROM deb_sources WHERE release_id = ?1 AND (source, version) > (?2, ?3) ORDER BY source, version LIMIT ?4`),
        listSource: db.prepare(`
            SELECT source, version FROM deb_sources WHERE release_id = ?1 AND source = ?4 AND (source, version) > (?2, ?3)
                ORDER BY source, version LIMIT ?5`),
        listFiles: db.prepare(`
            SELECT path FROM pool_files WHERE path > ?4 AND id IN (
                SELECT sf.file_id FROM deb_sources s JOIN deb_source_files sf ON sf.source_id = s.id
                    WHERE s.release_id = ?1 AND s.source = ?2 AND (?3 IS NULL OR s.version = ?3)
                UNION SELECT file_id FROM deb_binaries WHERE release_id = ?1 AND source = ?2 AND (?3 IS NULL OR source_version = ?3)
                UNION SELECT uf.file_id FROM deb_uploads u JOIN deb_upload_files uf ON uf.upload_id = u.id
                    WHERE u.release_id = ?1 AND u.source = ?2 AND (?3 IS NULL OR u.version = ?3))
                ORDER BY path LIMIT ?5`),
    };
}

/** Each input path once; the same path with two digests is a caller bug */
function distinctFiles(u: DebUploadInput): PoolFile[] {
    const byPath = new Map<string, PoolFile>();
    for (const file of [...u.trackedFiles, ...(u.sourcePackage?.files ?? []), ...u.binaries.map(b => b.file)]) {
        const seen = byPath.get(file.path);
        if (seen === undefined) {
            byPath.set(file.path, file);
        } else if (seen.sha256 !== file.sha256) {
            throw new Error(`${ file.path } is listed twice with different digests`);
        }
    }
    return [...byPath.values()];
}

/**
 * The Debian tables: source packages, binaries, uploads and the pool files they reference, plus the dirty keys that tell
 * the publisher which index files to regenerate. Every write is one transaction.
 */
export class DebCatalog {
    private readonly db: Database;
    private readonly pool: Pool;
    private readonly s: ReturnType<typeof prepareStatements>;

    constructor(db: Database) {
        this.db = db;
        this.pool = new Pool(db, "deb", REFERENCING_TABLES);
        this.s = prepareStatements(db);
    }

    /**
     * Replaces everything of (release, source, version) whose architecture is in the upload's scope, across all
     * components. Files of the replaced rows that nothing references any more get removed_at and are returned.
     */
    applyUpload(u: DebUploadInput, now: number): UploadOutcome {
        try {
            return transaction<UploadOutcome>(this.db, () => ({ ok: true, unreferenced: this.replaceUpload(u, now) }));
        } catch (err) {
            if (err instanceof UploadConflicts) {
                return { ok: false, conflicts: err.paths };
            }
            throw err;
        }
    }

    /**
     * Removes the matching sources, binaries and uploads. `removed` lists every file they referenced; those nothing references
     * any more get removed_at, and with `immediate` are also returned in `deleteNow` for deletion from disk.
     */
    remove(f: { distro?: string; release?: string; source: string; version?: string }, now: number, immediate: boolean):
        { removed: string[]; deleteNow: string[] } {

        return transaction(this.db, () => {
            const fileIds: number[] = [];
            for (const r of this.pool.releaseRows(f.distro, f.release)) {
                fileIds.push(...this.dropRows(r.id, f.source, f.version ?? null, () => true, () => true));
            }
            return this.pool.removeFiles(fileIds, now, immediate);
        });
    }

    /** The release and the grid around a published cell, which stay published with nothing in them */
    ensureCell(c: DebCell, now: number): void {
        transaction(this.db, () => {
            const releaseId = this.pool.ensureRelease(c.distro, c.release);
            if (c.kind === "source") {
                this.pool.ensureIndexFile(releaseId, "sources", c.component, "");
            } else {
                this.ensureBinaryIndexes(releaseId, c.kind, c.component, c.architecture);
            }
            this.completeGrid(releaseId, now);
        });
    }

    listSources(f: { distro?: string; release?: string; source?: string }, page: Page): SourceListing {
        return collectPage(page, 2, from => this.pool.releaseRows(f.distro, f.release, from), (r, after, limit) => {
            const from = [r.id, after?.[0] ?? "", after?.[1] ?? ""];
            const rows = f.source === undefined ? this.s.listSources.all(...from, limit) : this.s.listSource.all(...from, f.source, limit);
            return (rows as { source: string; version: string }[]).map(row => ({ distro: r.distro, release: r.name, source: row.source, version: row.version }));
        }, i => [i.source, i.version]);
    }

    listFiles(f: { distro?: string; release?: string; source: string; version?: string }, page: Page): FileListing {
        return collectPage(page, 1, from => this.pool.releaseRows(f.distro, f.release, from),
            (r, after, limit) => (this.s.listFiles.all(r.id, f.source, f.version ?? null, after?.[0] ?? "", limit) as { path: string }[])
                .map(row => ({ distro: r.distro, release: r.name, path: row.path })),
            i => [i.path]);
    }

    /** Components and architectures with an index file; "all" is reported only when no concrete architecture exists */
    releases(distro?: string, release?: string): DebReleaseView[] {
        return this.pool.releaseRows(distro, release).map(r => {
            const architectures = this.architecturesOf(r.id);
            const concrete = architectures.filter(a => a !== "all");
            const components = this.s.releaseComponents.all(r.id).map(row => row.component as string);
            return { distro: r.distro, release: r.name, components, architectures: concrete.length > 0 ? concrete : architectures };
        });
    }

    private replaceUpload(u: DebUploadInput, now: number): string[] {
        // The new rows' own identities widen an inconsistent scope, so they can never collide with the rows they replace
        const scope = new Set(u.scope);
        if (u.sourcePackage !== undefined) {
            scope.add("source");
        }
        for (const b of u.binaries) {
            scope.add(b.architecture);
        }
        const existing = this.pool.releaseId(u.distro, u.release);
        const replacedFileIds = existing === undefined ? [] : this.dropRows(existing, u.source, u.version,
            b => scope.has(b.architecture),
            up => up.changes_name === u.changesName || up.architectures.split(" ").every(a => a.length === 0 || scope.has(a)),
            scope.has("source"));
        const conflicts = distinctFiles(u).filter(f => {
            const row = this.s.selectPoolFile.get(f.path) as PoolRow | undefined;
            return row !== undefined && row.sha256 !== f.sha256 && this.pool.isReferenced(row.id);
        }).map(f => f.path);
        if (existing !== undefined) {
            // deb_binaries is unique on the binary's own identity, so a namesake of another source cannot coexist
            for (const b of u.binaries) {
                const owner = this.s.selectBinaryOwner.get(existing, b.kind, b.package, b.version, b.architecture) as
                    { source: string; source_version: string } | undefined;
                if (owner !== undefined) {
                    conflicts.push(`${ b.package }_${ b.version }_${ b.architecture } (${ b.kind }) is already provided by source ${
                        owner.source } ${ owner.source_version }`);
                }
            }
        }
        if (conflicts.length > 0) {
            throw new UploadConflicts(conflicts);
        }

        const releaseId = this.pool.ensureRelease(u.distro, u.release);
        // Index files of the upload's concrete architectures first, so its arch all binaries land in them too
        for (const b of u.binaries) {
            if (b.architecture !== "all") {
                this.ensureBinaryIndexes(releaseId, b.kind, u.component, b.architecture);
            }
        }
        if (u.sourcePackage !== undefined) {
            const sortKey = sourceSortKey(u.source, u.version);
            const { id } = this.s.insertSource.get(releaseId, u.component, u.source, u.version, sortKey, u.sourcePackage.stanza) as { id: number };
            for (const file of u.sourcePackage.files) {
                this.s.insertSourceFile.run(id, this.pool.upsertPoolFile(file));
            }
            this.pool.markDirty(releaseId, "sources", u.component, "", [sortKey]);
        }
        for (const b of u.binaries) {
            const sortKey = binarySortKey(u.source, b.package, b.version, b.architecture);
            const { id } = this.s.insertBinary.get(releaseId, u.component, b.kind, b.package, b.version, b.architecture, u.source, u.version,
                b.section, sortKey, this.pool.upsertPoolFile(b.file), b.stanza) as { id: number };
            for (const path of b.paths) {
                this.s.insertBinaryPath.run(releaseId, u.component, path, id);
            }
            this.markBinary(releaseId, u.component, b.kind, b.architecture, sortKey, b.paths);
        }
        const { id: uploadId } = this.s.insertUpload.get(releaseId, u.source, u.version, u.changesName, [...scope].sort().join(" ")) as
            { id: number };
        for (const file of u.trackedFiles) {
            this.s.insertUploadFile.run(uploadId, this.pool.upsertPoolFile(file));
        }
        this.completeGrid(releaseId, now);
        return this.pool.retire(replacedFileIds, now);
    }

    /** Marks the rows of (source, version) dirty and deletes them; returns the ids of the files they referenced */
    private dropRows(releaseId: number, source: string, version: string | null, binaryInScope: (b: BinaryRow) => boolean,
        uploadInScope: (u: UploadRow) => boolean, sourceInScope = true): number[] {

        const fileIds: number[] = [];
        if (sourceInScope) {
            for (const s of this.s.selectSources.all(releaseId, source, version) as SourceRow[]) {
                fileIds.push(...this.s.sourceFileIds.all(s.id).map(row => row.file_id as number));
                this.pool.markDirty(releaseId, "sources", s.component, "", [s.sort_key]);
                this.s.deleteSource.run(s.id);
            }
        }
        for (const b of this.s.selectBinaries.all(releaseId, source, version) as BinaryRow[]) {
            if (binaryInScope(b)) {
                fileIds.push(b.file_id);
                this.markBinary(releaseId, b.component, b.kind, b.architecture, b.sort_key,
                    this.s.binaryPaths.all(b.id).map(row => row.path as string));
                this.s.deleteBinary.run(b.id);
            }
        }
        for (const up of this.s.selectUploads.all(releaseId, source, version) as UploadRow[]) {
            if (uploadInScope(up)) {
                fileIds.push(...this.s.uploadFileIds.all(up.id).map(row => row.file_id as number));
                this.s.deleteUpload.run(up.id);
            }
        }
        return fileIds;
    }

    private architecturesOf(releaseId: number): string[] {
        return this.s.releaseArchitectures.all(releaseId).map(row => row.architecture as string);
    }

    /** An arch all binary belongs to every concrete architecture of the release, or to "all" while there is none */
    private targetArchitectures(releaseId: number, architecture: string): string[] {
        if (architecture !== "all") {
            return [architecture];
        }
        const concrete = this.architecturesOf(releaseId).filter(a => a !== "all");
        return concrete.length > 0 ? concrete : ["all"];
    }

    private ensureBinaryIndexes(releaseId: number, kind: DebBinaryInput["kind"], component: string, architecture: string): void {
        const kinds = INDEX_KINDS[kind];
        this.pool.ensureIndexFile(releaseId, kinds.packages, component, architecture);
        if (kinds.contents !== undefined) {
            this.pool.ensureIndexFile(releaseId, kinds.contents, component, architecture);
        }
    }

    private markBinary(releaseId: number, component: string, kind: DebBinaryInput["kind"], architecture: string, sortKey: string,
        paths: string[]): void {

        const kinds = INDEX_KINDS[kind];
        for (const arch of this.targetArchitectures(releaseId, architecture)) {
            this.pool.markDirty(releaseId, kinds.packages, component, arch, [sortKey]);
            if (kinds.contents !== undefined) {
                this.pool.markDirty(releaseId, kinds.contents, component, arch, paths);
            }
        }
    }

    /**
     * Every component gets a Sources index and the binary indexes of every architecture of the release, as apt expects from
     * Release. The first concrete architecture retires the "all" indexes; a new index starts at generation 0, which means a
     * full build.
     */
    private completeGrid(releaseId: number, now: number): void {
        const architectures = this.architecturesOf(releaseId);
        const concrete = architectures.filter(a => a !== "all");
        if (concrete.length > 0 && concrete.length < architectures.length) {
            for (const row of this.s.allIndexFiles.all(releaseId) as { id: number; stored_path: string | null }[]) {
                if (row.stored_path !== null) {
                    this.s.supersedeFile.run(row.stored_path, now);
                }
                this.s.deleteIndexFile.run(row.id);
            }
        }
        const grid = concrete.length > 0 ? concrete : architectures;
        for (const row of this.s.releaseComponents.all(releaseId)) {
            const component = row.component as string;
            this.pool.ensureIndexFile(releaseId, "sources", component, "");
            for (const arch of grid) {
                this.ensureBinaryIndexes(releaseId, "deb", component, arch);
            }
        }
        for (const row of this.s.releaseExtraKinds.all(releaseId) as { component: string; kind: string }[]) {
            for (const arch of grid) {
                this.ensureBinaryIndexes(releaseId, row.kind === "debug" ? "ddeb" : "udeb", row.component, arch);
            }
        }
    }
}
