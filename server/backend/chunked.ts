import osPath from "path";
import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import zlib from "zlib";
import { MultiHash } from "./hash.ts";
import { removeQuietly } from "./publish-fs.ts";

/** Uncompressed bytes per chunk, cut at record boundaries */
export const CHUNK_TARGET = 1048576;

export type IndexCodec = "gzip" | "zstd";

export type IndexRecord = { key: string; text: string };

/** Chunk i covers the keys from startKey up to the next chunk's startKey; the first startKey is "" */
export type ChunkInfo = { startKey: string; offset: number; length: number; rawOffset: number; rawLength: number };

/** Yields the records of [startKey, endKey) in compareKeys order; endKey undefined means to the end */
export type IndexSource = (startKey: string, endKey: string | undefined) => Iterable<IndexRecord>;

/** SQL above every key, for the end of an open range: the byte 0xFF occurs in no UTF-8 text */
export const KEYS_END_SQL = "CAST(x'FF' AS TEXT)";

export type PreviousIndex = { file: string; shadow: string; chunks: ChunkInfo[] };

export type ChunkedIndexOptions = {
    codec: IndexCodec;
    source: IndexSource;
    previous?: PreviousIndex;
    dirtyKeys?: Iterable<string>;
    header?: string;
    footer?: string;
    targetChunkSize?: number;
    outFile: string;
    outShadow: string;
};

export type ChunkedIndexResult = {
    chunks: ChunkInfo[];
    size: number;
    rawSize: number;
    md5: string;
    sha256: string;
    rawMd5: string;
    rawSha256: string;
};

type RawChunk = { startKey: string; text: string };
type PendingRecord = { key: string; text: string; size: number };
type FileDigests = { size: number; md5: string; sha256: string };

const COPY_BUFFER_SIZE = 65536;

/** Orders keys like SQLite BINARY, by UTF-8 bytes */
export function compareKeys(a: string, b: string): number {
    return a === b ? 0 : Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function compress(codec: IndexCodec, data: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const callback = (err: Error | null, out: Buffer) => err ? reject(err) : resolve(out);
        if (codec === "gzip") {
            zlib.gzip(data, { level: 6 }, callback);
        } else {
            zlib.zstdCompress(data, callback);
        }
    });
}

/** Index of the chunk whose key range contains the key */
function chunkIndexFor(chunks: ChunkInfo[], key: string): number {
    let low = 0;
    let high = chunks.length - 1;
    let found = 0;
    while (low <= high) {
        const mid = (low + high) >>> 1;
        if (compareKeys(chunks[mid].startKey, key) <= 0) {
            found = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return found;
}

class HashedFile {
    readonly hash = new MultiHash(["md5", "sha256"]);
    position = 0;
    private readonly file: string;
    private handle: FileHandle | undefined;

    private constructor(file: string, handle: FileHandle) {
        this.file = file;
        this.handle = handle;
    }

    static async create(file: string): Promise<HashedFile> {
        return new HashedFile(file, await fs.open(file, "w"));
    }

    async write(data: Uint8Array): Promise<void> {
        this.hash.update(data);
        let written = 0;
        while (written < data.byteLength) {
            const { bytesWritten } = await this.handle!.write(data, written, data.byteLength - written);
            written += bytesWritten;
        }
        this.position += data.byteLength;
    }

    async close(): Promise<FileDigests> {
        const handle = this.handle!;
        this.handle = undefined;
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
        return this.hash.digest() as FileDigests;
    }

    async discard(): Promise<void> {
        const handle = this.handle;
        this.handle = undefined;
        await handle?.close().catch(() => undefined);
        await removeQuietly(this.file);
    }
}

class RangeReader {
    private readonly file: string;
    private handle: FileHandle | undefined;
    private readonly buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);

    constructor(file: string) {
        this.file = file;
    }

    async copyTo(out: HashedFile, position: number, length: number): Promise<void> {
        this.handle ??= await fs.open(this.file, "r");
        let remaining = length;
        while (remaining > 0) {
            const { bytesRead } = await this.handle.read(this.buffer, 0, Math.min(this.buffer.length, remaining), position);
            if (bytesRead === 0) {
                throw new Error(`${ this.file } is shorter than its chunk table`);
            }
            await out.write(this.buffer.subarray(0, bytesRead));
            position += bytesRead;
            remaining -= bytesRead;
        }
    }

    async close(): Promise<void> {
        const handle = this.handle;
        this.handle = undefined;
        await handle?.close();
    }
}

/**
 * Groups records into chunks. In cutting mode a chunk ends at the first record boundary at or past the target;
 * otherwise records are buffered until they exceed twice the target, so a rebuilt chunk that grew a little keeps
 * its single member.
 */
class ChunkCutter {
    private readonly target: number;
    private startKey: string | undefined;
    private cutting: boolean;
    private pending: PendingRecord[] = [];
    private pendingSize = 0;
    private lastKey: string | undefined;

    constructor(target: number, startKey: string, cutting: boolean) {
        this.target = target;
        this.startKey = startKey;
        this.cutting = cutting;
    }

    /** Bytes buffered since the last cut */
    get buffered(): number {
        return this.pendingSize;
    }

    add(record: IndexRecord): RawChunk[] {
        if (this.lastKey !== undefined && compareKeys(this.lastKey, record.key) > 0) {
            throw new Error(`Index records out of order: "${ record.key }" after "${ this.lastKey }"`);
        }
        const out: RawChunk[] = [];
        // Equal keys never straddle a cut, as the key range of a chunk could not name the boundary
        if (this.cutting && this.pendingSize >= this.target && record.key !== this.lastKey) {
            out.push(this.take(this.pending.length));
        }
        const size = Buffer.byteLength(record.text);
        this.startKey ??= record.key;
        this.pending.push({ key: record.key, text: record.text, size });
        this.pendingSize += size;
        this.lastKey = record.key;
        if (!this.cutting && this.pendingSize > 2 * this.target) {
            this.cutting = true;
            this.cutBuffered(out);
        }
        return out;
    }

    finish(): RawChunk | undefined {
        return this.pendingSize > 0 ? this.take(this.pending.length) : undefined;
    }

    private cutBuffered(out: RawChunk[]): void {
        let size = 0;
        let i = 0;
        while (i < this.pending.length) {
            size += this.pending[i].size;
            i++;
            if (size >= this.target && i < this.pending.length && this.pending[i].key !== this.pending[i - 1].key) {
                out.push(this.take(i));
                size = 0;
                i = 0;
            }
        }
    }

    private take(count: number): RawChunk {
        const taken = this.pending.splice(0, count);
        const chunk = { startKey: this.startKey!, text: taken.map(r => r.text).join("") };
        this.pendingSize -= taken.reduce((sum, r) => sum + r.size, 0);
        this.startKey = this.pending[0]?.key;
        return chunk;
    }
}

class IndexWriter {
    readonly chunks: ChunkInfo[] = [];
    private readonly codec: IndexCodec;
    private readonly target: number;
    private readonly file: HashedFile;
    private readonly shadow: HashedFile;
    private readonly previousFile: RangeReader | undefined;
    private readonly previousShadow: RangeReader | undefined;

    private constructor(codec: IndexCodec, target: number, file: HashedFile, shadow: HashedFile,
        previous: PreviousIndex | undefined) {
        this.codec = codec;
        this.target = target;
        this.file = file;
        this.shadow = shadow;
        this.previousFile = previous && new RangeReader(previous.file);
        this.previousShadow = previous && new RangeReader(previous.shadow);
    }

    static async create(o: ChunkedIndexOptions, target: number): Promise<IndexWriter> {
        const file = await HashedFile.create(o.outFile);
        try {
            return new IndexWriter(o.codec, target, file, await HashedFile.create(o.outShadow), o.previous);
        } catch (err) {
            await file.discard();
            throw err;
        }
    }

    get empty(): boolean {
        return this.file.position === 0;
    }

    async writeMember(text: string): Promise<void> {
        const raw = Buffer.from(text, "utf8");
        const compressed = await compress(this.codec, raw);
        await this.file.write(compressed);
        await this.shadow.write(raw);
    }

    async build(source: IndexSource): Promise<void> {
        const cutter = new ChunkCutter(this.target, "", true);
        await this.consume(cutter, source, "", undefined);
        await this.flush(cutter);
    }

    async rebuild(previous: PreviousIndex, dirty: Set<number>, source: IndexSource): Promise<void> {
        const chunks = previous.chunks;
        let i = 0;
        while (i < chunks.length) {
            if (!dirty.has(i)) {
                await this.copyChunk(chunks[i]);
                i++;
                continue;
            }
            const cutter = new ChunkCutter(this.target, chunks[i].startKey, false);
            let last = i;
            for (;;) {
                await this.consume(cutter, source, chunks[last].startKey, chunks[last + 1]?.startKey);
                const undersized = cutter.buffered > 0 && cutter.buffered < this.target / 4;
                if (!undersized || last + 1 >= chunks.length) {
                    break;
                }
                last++;
            }
            await this.flush(cutter);
            i = last + 1;
        }
        // A dropped first chunk leaves its range to the next one
        if (this.chunks.length > 0) {
            this.chunks[0].startKey = "";
        }
    }

    async close(): Promise<ChunkedIndexResult> {
        await this.previousFile?.close();
        await this.previousShadow?.close();
        const file = await this.file.close();
        const shadow = await this.shadow.close();
        return {
            chunks: this.chunks, size: file.size, rawSize: shadow.size, md5: file.md5, sha256: file.sha256,
            rawMd5: shadow.md5, rawSha256: shadow.sha256,
        };
    }

    async discard(): Promise<void> {
        await this.previousFile?.close().catch(() => undefined);
        await this.previousShadow?.close().catch(() => undefined);
        await this.file.discard();
        await this.shadow.discard();
    }

    private async consume(cutter: ChunkCutter, source: IndexSource, start: string, end: string | undefined): Promise<void> {
        const range = end === undefined ? `from "${ start }"` : `["${ start }", "${ end }")`;
        let first = true;
        for (const record of source(start, end)) {
            if ((first && compareKeys(record.key, start) < 0) || (end !== undefined && compareKeys(record.key, end) >= 0)) {
                throw new Error(`Index record "${ record.key }" is outside the chunk range ${ range }`);
            }
            first = false;
            for (const chunk of cutter.add(record)) {
                await this.writeChunk(chunk);
            }
        }
    }

    private async flush(cutter: ChunkCutter): Promise<void> {
        const chunk = cutter.finish();
        if (chunk) {
            await this.writeChunk(chunk);
        }
    }

    private async writeChunk(chunk: RawChunk): Promise<void> {
        const raw = Buffer.from(chunk.text, "utf8");
        const compressed = await compress(this.codec, raw);
        this.chunks.push({
            startKey: chunk.startKey, offset: this.file.position, length: compressed.length,
            rawOffset: this.shadow.position, rawLength: raw.length,
        });
        await this.file.write(compressed);
        await this.shadow.write(raw);
    }

    private async copyChunk(chunk: ChunkInfo): Promise<void> {
        this.chunks.push({
            startKey: chunk.startKey, offset: this.file.position, length: chunk.length,
            rawOffset: this.shadow.position, rawLength: chunk.rawLength,
        });
        await this.previousFile!.copyTo(this.file, chunk.offset, chunk.length);
        await this.previousShadow!.copyTo(this.shadow, chunk.rawOffset, chunk.rawLength);
    }
}

/**
 * Writes an index as concatenated gzip members or zstd frames, one per chunk, plus the uncompressed shadow.
 * With `previous`, only the chunks covering a dirty key are rebuilt from `source`; the others are copied by
 * offset. Both outputs are created or truncated and removed again on failure.
 */
export async function writeChunkedIndex(o: ChunkedIndexOptions): Promise<ChunkedIndexResult> {
    const target = o.targetChunkSize ?? CHUNK_TARGET;
    if (!(target > 0)) {
        throw new Error(`Invalid chunk size ${ target }`);
    }
    if (o.previous) {
        const kept = [o.previous.file, o.previous.shadow].map(file => osPath.resolve(file));
        for (const out of [o.outFile, o.outShadow]) {
            if (kept.includes(osPath.resolve(out))) {
                throw new Error(`Output ${ out } would overwrite the previous index`);
            }
        }
    }
    const writer = await IndexWriter.create(o, target);
    let done = false;
    try {
        if (o.header) {
            await writer.writeMember(o.header);
        }
        if (o.previous && o.previous.chunks.length > 0) {
            const dirty = new Set<number>();
            for (const key of o.dirtyKeys ?? []) {
                dirty.add(chunkIndexFor(o.previous.chunks, key));
            }
            await writer.rebuild(o.previous, dirty, o.source);
        } else {
            await writer.build(o.source);
        }
        if (o.footer) {
            await writer.writeMember(o.footer);
        }
        if (writer.empty) {
            await writer.writeMember("");
        }
        const result = await writer.close();
        done = true;
        return result;
    } finally {
        if (!done) {
            await writer.discard();
        }
    }
}
