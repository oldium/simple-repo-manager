import osPath from "path";
import fs from "fs/promises";
import type { BigIntStats } from "fs";
import type { Database } from "node:sqlite";
import { repoFile } from "./context.ts";
import type { BackendContext } from "./context.ts";
import { writeChunkedIndex } from "./chunked.ts";
import type { ChunkedIndexOptions, ChunkedIndexResult, PreviousIndex } from "./chunked.ts";
import { transaction } from "./db.ts";
import { hashFile } from "./hash.ts";
import { errorCode, placeFile, removeQuietly, statQuietly } from "./publish-fs.ts";

/** An index_files row; a format narrows kind to its own names */
export type IndexRow<K extends string = string> = {
    id: number; kind: K; component: string; architecture: string; generation: number; stored_path: string | null;
    size: number | null; raw_size: number | null;
};

/** An index_files row with a stored file */
export type PublishedRow<K extends string = string> = {
    id: number; kind: K; component: string; architecture: string; stored_path: string; size: number; md5: string; sha256: string;
    raw_size: number; raw_md5: string; raw_sha256: string;
};

/** What names the files of an index; one not yet published has only its cell */
export type IndexCell<K extends string = string> = Pick<IndexRow<K>, "kind" | "component" | "architecture" | "stored_path"> & { md5: string | null };

/** What a format decides per index: how it is written, where its file goes and which other names belong to it */
export type IndexSpec = Pick<ChunkedIndexOptions, "codec" | "source" | "header" | "footer"> & {
    /** Path below repoDir of the written file, content-addressed */
    storedPath(digests: Pick<ChunkedIndexResult, "md5" | "sha256">): string;
    /** Links of a stored file, placed, superseded and unsuperseded with it */
    linkedPaths?(storedPath: string, md5: string): string[];
    /** Links to the stored file placed after the commit */
    canonicalPaths?: string[];
};

type ChunkRow = { start_key: string; offset: number; length: number; raw_offset: number; raw_length: number };

const TEMP_SUFFIX: Record<ChunkedIndexOptions["codec"], string> = { gzip: "gz", zstd: "zst" };

function prepareStatements(db: Database) {
    return {
        pendingIndexes: db.prepare(`
            SELECT id, kind, component, architecture, generation, stored_path, size, raw_size FROM index_files i WHERE release_id = ?
                AND (generation = 0 OR EXISTS (SELECT 1 FROM dirty_keys d WHERE d.index_file_id = i.id)) ORDER BY component, kind, architecture`),
        publishedIndexes: db.prepare(`
            SELECT id, kind, component, architecture, stored_path, size, md5, sha256, raw_size, raw_md5, raw_sha256 FROM index_files
                WHERE release_id = ? AND stored_path IS NOT NULL ORDER BY component, kind, architecture`),
        indexGenerations: db.prepare("SELECT id, generation FROM index_files"),
        otherReference: db.prepare("SELECT 1 FROM index_files WHERE stored_path = ? AND id != ?"),
        chunks: db.prepare("SELECT start_key, offset, length, raw_offset, raw_length FROM index_chunks WHERE index_file_id = ? ORDER BY seq"),
        dirtyKeys: db.prepare("SELECT key FROM dirty_keys WHERE index_file_id = ? ORDER BY key"),

        current: db.prepare("SELECT stored_path, md5 FROM index_files WHERE id = ?"),
        deleteChunks: db.prepare("DELETE FROM index_chunks WHERE index_file_id = ?"),
        insertChunk: db.prepare(`
            INSERT INTO index_chunks (index_file_id, seq, start_key, offset, length, raw_offset, raw_length) VALUES (?, ?, ?, ?, ?, ?, ?)`),
        updateIndex: db.prepare(`
            UPDATE index_files SET generation = generation + 1, stored_path = ?, size = ?, md5 = ?, sha256 = ?, raw_size = ?, raw_md5 = ?, raw_sha256 = ?
                WHERE id = ?`),
        supersede: db.prepare("INSERT OR REPLACE INTO superseded_files (path, superseded_at) VALUES (?, ?)"),
        unsupersede: db.prepare("DELETE FROM superseded_files WHERE path = ?"),
        clearDirty: db.prepare("DELETE FROM dirty_keys WHERE index_file_id = ?"),
    };
}

/** Every index of the release, published or not */
export function releaseCells<K extends string>(db: Database, format: string, distro: string, name: string): IndexCell<K>[] {
    return db.prepare(`
        SELECT i.kind, i.component, i.architecture, i.stored_path, i.md5 FROM index_files i JOIN releases r ON r.id = i.release_id
            WHERE r.format = ? AND r.distro = ? AND r.name = ?`).all(format, distro, name) as IndexCell<K>[];
}

/** Whether the file is the stored one: its link, or (where linking fell back to a copy) a copy of the same size and sha256 */
async function isStoredFile(file: string, stored: BigIntStats, sha256: string): Promise<boolean> {
    let stat: BigIntStats;
    try {
        // Number inodes lose precision on Windows, where a file id is a 64-bit value
        stat = await fs.stat(file, { bigint: true });
    } catch (err) {
        if (errorCode(err) !== "ENOENT") {
            throw err;
        }
        return false;
    }
    if (stat.dev === stored.dev && stat.ino === stored.ino) {
        return true;
    }
    return stat.size === stored.size && (await hashFile(file)).sha256 === sha256;
}

/**
 * Writes index files as chunk sequences and commits them. The new generation's shadow is written before the commit and
 * the previous one removed after it, so the generation the database names always has its shadow.
 */
export class IndexPublisher {
    private readonly ctx: BackendContext;
    private readonly db: Database;
    private readonly s: ReturnType<typeof prepareStatements>;

    constructor(ctx: BackendContext) {
        this.ctx = ctx;
        this.db = ctx.db;
        this.s = prepareStatements(ctx.db);
    }

    /** The indexes of the release at generation 0 or with dirty keys */
    pendingIndexes<K extends string = string>(releaseId: number): IndexRow<K>[] {
        return this.s.pendingIndexes.all(releaseId) as IndexRow<K>[];
    }

    /** The indexes of the release with a stored file */
    publishedIndexes<K extends string = string>(releaseId: number): PublishedRow<K>[] {
        return this.s.publishedIndexes.all(releaseId) as PublishedRow<K>[];
    }

    /** Writes the index, splicing the clean chunks of its previous generation, places its file and commits it */
    async publish(index: IndexRow, spec: IndexSpec): Promise<void> {
        const { storedPath: storedPathOf, linkedPaths, canonicalPaths, ...write } = spec;
        const linked = (storedPath: string, md5: string): string[] => linkedPaths?.(storedPath, md5) ?? [];
        const tmpDir = osPath.join(this.ctx.paths.repoStateDir, "tmp");
        await fs.mkdir(tmpDir, { recursive: true });
        await fs.mkdir(osPath.join(this.ctx.paths.repoStateDir, "shadow"), { recursive: true });
        const outFile = osPath.join(tmpDir, `${ index.id }.${ TEMP_SUFFIX[spec.codec] }`);
        try {
            const previous = await this.previousIndex(index);
            const result = await writeChunkedIndex({
                ...write, previous,
                dirtyKeys: previous && this.s.dirtyKeys.all(index.id).map(row => row.key as string),
                outFile, outShadow: this.shadowFile(index, index.generation + 1),
            });
            const storedPath = storedPathOf(result);
            const links = linked(storedPath, result.md5);
            const stored = repoFile(this.ctx, storedPath);
            await placeFile(outFile, stored, links.map(p => repoFile(this.ctx, p)));
            transaction(this.db, () => {
                const old = this.s.current.get(index.id) as { stored_path: string | null; md5: string };
                this.s.deleteChunks.run(index.id);
                result.chunks.forEach((c, seq) => this.s.insertChunk.run(index.id, seq, c.startKey, c.offset, c.length, c.rawOffset, c.rawLength));
                this.s.updateIndex.run(storedPath, result.size, result.md5, result.sha256, result.rawSize, result.rawMd5, result.rawSha256, index.id);
                // Identical indexes, like the Contents of two architectures, share one stored file
                if (old.stored_path !== null && this.s.otherReference.get(old.stored_path, index.id) === undefined) {
                    const now = this.ctx.now();
                    for (const p of [old.stored_path, ...linked(old.stored_path, old.md5)]) {
                        this.s.supersede.run(p, now);
                    }
                }
                for (const p of [storedPath, ...links, ...canonicalPaths ?? []]) {
                    this.s.unsupersede.run(p);
                }
                this.s.clearDirty.run(index.id);
            });
            await removeQuietly(this.shadowFile(index, index.generation));
            await placeFile(stored, stored, (canonicalPaths ?? []).map(p => repoFile(this.ctx, p)));
        } finally {
            await removeQuietly(outFile);
        }
    }

    /** Places again the canonical paths that are not the stored file, as after the commit; true when any was */
    async relink(row: PublishedRow, canonicalPaths: string[]): Promise<boolean> {
        const stored = repoFile(this.ctx, row.stored_path);
        const storedStat = await fs.stat(stored, { bigint: true });
        const stale: string[] = [];
        for (const canonicalPath of canonicalPaths) {
            if (!await isStoredFile(repoFile(this.ctx, canonicalPath), storedStat, row.sha256)) {
                stale.push(canonicalPath);
            }
        }
        if (stale.length === 0) {
            return false;
        }
        await placeFile(stored, stored, stale.map(p => repoFile(this.ctx, p)));
        this.unsupersede(stale);
        return true;
    }

    /** Names just written are live again; a rebuild may have recorded them while no index named their release */
    unsupersede(paths: string[]): void {
        transaction(this.db, () => {
            for (const p of paths) {
                this.s.unsupersede.run(p);
            }
        });
    }

    /** Shadows of deleted index files and of generations a crash left uncommitted */
    async sweepShadows(): Promise<void> {
        const dir = osPath.join(this.ctx.paths.repoStateDir, "shadow");
        let names: string[];
        try {
            names = await fs.readdir(dir);
        } catch (err) {
            if (errorCode(err) !== "ENOENT") {
                throw err;
            }
            return;
        }
        const current = new Set(this.s.indexGenerations.all().map(row => `${ row.id as number }-${ row.generation as number }`));
        for (const name of names) {
            if (!current.has(name)) {
                await removeQuietly(osPath.join(dir, name));
            }
        }
    }

    private shadowFile(index: IndexRow, generation: number): string {
        return osPath.join(this.ctx.paths.repoStateDir, "shadow", `${ index.id }-${ generation }`);
    }

    /** The published generation to splice from; undefined means a full build, also when its files do not match the chunk table */
    private async previousIndex(index: IndexRow): Promise<PreviousIndex | undefined> {
        if (index.generation === 0 || index.stored_path === null) {
            return undefined;
        }
        const chunks = (this.s.chunks.all(index.id) as ChunkRow[]).map(c =>
            ({ startKey: c.start_key, offset: c.offset, length: c.length, rawOffset: c.raw_offset, rawLength: c.raw_length }));
        if (chunks.length === 0) {
            return undefined;
        }
        const file = repoFile(this.ctx, index.stored_path);
        const shadow = this.shadowFile(index, index.generation);
        if ((await statQuietly(file))?.size !== index.size || (await statQuietly(shadow))?.size !== index.raw_size) {
            return undefined;
        }
        return { file, shadow, chunks };
    }
}
