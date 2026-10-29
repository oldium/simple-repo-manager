import type { Database } from "node:sqlite";
import type { Digests } from "./hash.ts";

export type Format = "deb" | "rpm";

export function isFormat(value: unknown): value is Format {
    return value === "deb" || value === "rpm";
}

/** A file in the pool; path is relative to repoDir */
export type PoolFile = { path: string } & Digests;

export type ReleaseRow = { id: number; distro: string; name: string };

function prepareStatements(db: Database, referencedBy: string[]) {
    const exists = (table: string) => `EXISTS (SELECT 1 FROM ${ table } WHERE file_id = ?1)`;
    const among = (table: string) => `AND id NOT IN (SELECT file_id FROM ${ table } WHERE file_id IN (SELECT value FROM json_each(?1)))`;
    return {
        selectRelease: db.prepare("SELECT id FROM releases WHERE format = ? AND distro = ? AND name = ?"),
        insertRelease: db.prepare("INSERT OR IGNORE INTO releases (format, distro, name) VALUES (?, ?, ?)"),
        listReleases: db.prepare(`
            SELECT id, distro, name FROM releases WHERE format = ?1 AND (?2 IS NULL OR distro = ?2) AND (?3 IS NULL OR name = ?3)
                AND (distro, name) >= (?4, ?5) ORDER BY distro, name`),

        upsertPoolFile: db.prepare(`
            INSERT INTO pool_files (path, size, md5, sha1, sha256, sha512) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (path) DO UPDATE SET size = excluded.size, md5 = excluded.md5, sha1 = excluded.sha1,
                    sha256 = excluded.sha256, sha512 = excluded.sha512, removed_at = NULL
                RETURNING id`),
        poolPaths: db.prepare("SELECT path FROM pool_files WHERE id IN (SELECT value FROM json_each(?)) ORDER BY path"),
        isReferenced: db.prepare(`SELECT ${ referencedBy.map(exists).join(" OR ") } AS referenced`),
        unreferencedAmong: db.prepare(`
            SELECT id, path FROM pool_files WHERE id IN (SELECT value FROM json_each(?1)) ${ referencedBy.map(among).join(" ") } ORDER BY path`),
        markRemoved: db.prepare("UPDATE pool_files SET removed_at = ? WHERE id = ?"),
        selectRemoved: db.prepare("SELECT id FROM pool_files WHERE path = ? AND removed_at IS NOT NULL"),
        deletePoolFile: db.prepare("DELETE FROM pool_files WHERE id = ?"),

        insertIndexFile: db.prepare("INSERT OR IGNORE INTO index_files (release_id, kind, component, architecture) VALUES (?, ?, ?, ?)"),
        selectIndexFile: db.prepare("SELECT id FROM index_files WHERE release_id = ? AND kind = ? AND component = ? AND architecture = ?"),
        insertDirtyKey: db.prepare("INSERT OR IGNORE INTO dirty_keys (index_file_id, key) VALUES (?, ?)"),
    };
}

/**
 * What both formats share: the releases of one format, pool files with their GC state, index files and their dirty keys.
 * `referencedBy` names the format's tables with a file_id column; a pool file is in use while any of them points at it.
 */
export class Pool {
    private readonly format: Format;
    private readonly s: ReturnType<typeof prepareStatements>;

    constructor(db: Database, format: Format, referencedBy: string[]) {
        this.format = format;
        this.s = prepareStatements(db, referencedBy);
    }

    releaseId(distro: string, release: string): number | undefined {
        return (this.s.selectRelease.get(this.format, distro, release) as { id: number } | undefined)?.id;
    }

    ensureRelease(distro: string, release: string): number {
        this.s.insertRelease.run(this.format, distro, release);
        return this.releaseId(distro, release) as number;
    }

    /** Releases filtered by distro and name, from the (distro, name) in `from` on */
    releaseRows(distro: string | undefined, release: string | undefined, from?: string[]): ReleaseRow[] {
        return this.s.listReleases.all(this.format, distro ?? null, release ?? null, from?.[0] ?? "", from?.[1] ?? "") as ReleaseRow[];
    }

    /** The file's row id; an existing path takes the new digests and is no longer removed */
    upsertPoolFile(file: PoolFile): number {
        return (this.s.upsertPoolFile.get(file.path, file.size, file.md5, file.sha1, file.sha256, file.sha512) as { id: number }).id;
    }

    isReferenced(fileId: number): boolean {
        return (this.s.isReferenced.get(fileId) as { referenced: number }).referenced !== 0;
    }

    poolPaths(fileIds: number[]): string[] {
        return fileIds.length === 0 ? [] : this.s.poolPaths.all(JSON.stringify(fileIds)).map(row => row.path as string);
    }

    /** Of the given files, those nothing references any more: marked removed_at; returns their paths */
    retire(fileIds: number[], now: number): string[] {
        if (fileIds.length === 0) {
            return [];
        }
        const rows = this.s.unreferencedAmong.all(JSON.stringify(fileIds)) as { id: number; path: string }[];
        for (const row of rows) {
            this.s.markRemoved.run(now, row.id);
        }
        return rows.map(row => row.path);
    }

    /**
     * A removal's outcome: every path the dropped rows referenced, and in immediate mode the retired ones to delete once
     * published. They keep removed_at meanwhile, so GC still collects them if publishing fails.
     */
    removeFiles(fileIds: number[], now: number, immediate: boolean): { removed: string[]; deleteNow: string[] } {
        const removed = this.poolPaths(fileIds);
        const retired = this.retire(fileIds, now);
        return { removed, deleteNow: immediate ? retired : [] };
    }

    /** The row id of a file still removed and unreferenced, as GC requires before deleting it */
    removedRow(path: string): number | undefined {
        const row = this.s.selectRemoved.get(path) as { id: number } | undefined;
        return row !== undefined && !this.isReferenced(row.id) ? row.id : undefined;
    }

    /** Drops the row of a file deleted from disk */
    forget(fileId: number): void {
        this.s.deletePoolFile.run(fileId);
    }

    ensureIndexFile(releaseId: number, kind: string, component: string, architecture: string): void {
        this.s.insertIndexFile.run(releaseId, kind, component, architecture);
    }

    markDirty(releaseId: number, kind: string, component: string, architecture: string, keys: string[]): void {
        this.ensureIndexFile(releaseId, kind, component, architecture);
        const { id } = this.s.selectIndexFile.get(releaseId, kind, component, architecture) as { id: number };
        for (const key of keys) {
            this.s.insertDirtyKey.run(id, key);
        }
    }
}
