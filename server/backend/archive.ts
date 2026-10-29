import osPath from "path";
import fs from "fs/promises";
import { Duplex, PassThrough, Readable } from "stream";
import { ReadableStream, TransformStream } from "stream/web";
import zlib from "zlib";
import xz from "xz-decompress";
import { RepoValidationError } from "../lib/errors.ts";

export type ArMember = { name: string; offset: number; size: number };

export type TarEntry = {
    path: string;
    type: "file" | "directory" | "symlink" | "hardlink" | "other";
    size: number;
    linkTarget?: string;
};

export type Compression = "none" | "gzip" | "xz" | "zstd";

const AR_MAGIC = "!<arch>\n";
const AR_HEADER_SIZE = 60;
const TAR_BLOCK_SIZE = 512;
// L, K, x and g bodies go to memory, and real ones are tiny
const MAX_HEADER_BODY = 1024 * 1024;

/** The most a control file may hold, inside a package or on its own */
export const MAX_CONTROL_SIZE = 16 * 1024 * 1024;

export async function readArMembers(file: string): Promise<ArMember[]> {
    // Messages reach upload clients, so they name the file without its directory
    const fileName = osPath.basename(file);
    const handle = await fs.open(file, "r");
    try {
        const { size: fileSize } = await handle.stat();
        const magic = Buffer.alloc(AR_MAGIC.length);
        const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
        if (bytesRead !== magic.length || magic.toString("latin1") !== AR_MAGIC) {
            throw new RepoValidationError(`${ fileName } is not an ar archive`);
        }
        const members: ArMember[] = [];
        const header = Buffer.alloc(AR_HEADER_SIZE);
        let position = AR_MAGIC.length;
        while (position < fileSize) {
            const read = await handle.read(header, 0, AR_HEADER_SIZE, position);
            if (read.bytesRead !== AR_HEADER_SIZE || header.toString("latin1", 58, 60) !== "`\n") {
                throw new RepoValidationError(`${ fileName }: truncated or malformed ar header at ${ position }`);
            }
            const name = header.toString("latin1", 0, 16).trimEnd();
            const size = Number.parseInt(header.toString("latin1", 48, 58).trim(), 10);
            const offset = position + AR_HEADER_SIZE;
            if (!Number.isInteger(size) || size < 0 || offset + size > fileSize) {
                throw new RepoValidationError(`${ fileName }: truncated ar member ${ name }`);
            }
            members.push({ name: name.endsWith("/") ? name.slice(0, -1) : name, offset, size });
            position = offset + size + size % 2;
        }
        return members;
    } finally {
        await handle.close();
    }
}

/** Chunk-list view over a Readable's async iterator so reads and skips of any size never re-concatenate */
class ChunkReader {
    private readonly chunks: AsyncIterator<Buffer>;
    private pending: Buffer[] = [];
    private offset = 0;
    private available = 0;
    private ended = false;

    constructor(input: Readable) {
        this.chunks = input[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    }

    /** Returns fewer than n bytes only at the end of input */
    async read(n: number): Promise<Buffer> {
        const parts: Buffer[] = [];
        let remaining = n;
        while (remaining > 0 && (this.available > 0 || await this.fill())) {
            const head = this.pending[0];
            const piece = head.subarray(this.offset, Math.min(head.length, this.offset + remaining));
            parts.push(piece);
            this.consume(piece.length);
            remaining -= piece.length;
        }
        return parts.length === 1 ? parts[0] : Buffer.concat(parts);
    }

    async skip(n: number): Promise<number> {
        let skipped = 0;
        while (skipped < n && (this.available > 0 || await this.fill())) {
            const step = Math.min(this.pending[0].length - this.offset, n - skipped);
            this.consume(step);
            skipped += step;
        }
        return skipped;
    }

    async drain(): Promise<void> {
        while (!this.ended) {
            this.ended = (await this.chunks.next()).done === true;
        }
    }

    async close(): Promise<void> {
        await this.chunks.return?.();
    }

    private async fill(): Promise<boolean> {
        while (!this.ended) {
            const { value, done } = await this.chunks.next();
            if (done) {
                this.ended = true;
            } else if (value.length > 0) {
                this.pending.push(value);
                this.available += value.length;
                return true;
            }
        }
        return false;
    }

    private consume(count: number): void {
        this.offset += count;
        this.available -= count;
        if (this.offset === this.pending[0].length) {
            this.pending.shift();
            this.offset = 0;
        }
    }
}

type TarHeader = { name: string; size: number; typeflag: string; linkname: string };

function cString(block: Buffer, start: number, length: number): string {
    const end = block.indexOf(0, start);
    return block.toString("utf8", start, end < 0 || end > start + length ? start + length : end);
}

function octal(block: Buffer, start: number, length: number): number {
    return Number.parseInt(block.toString("latin1", start, start + length).replaceAll("\0", " ").trim(), 8);
}

function tarSize(block: Buffer): number {
    // GNU base-256 for sizes beyond 8 GiB
    if (block[124] & 0x80) {
        let size = 0;
        for (let i = 125; i < 136; i++) {
            size = size * 256 + block[i];
        }
        return size;
    }
    return octal(block, 124, 12);
}

function parseTarHeader(block: Buffer): TarHeader {
    let sum = 8 * 0x20;
    for (let i = 0; i < TAR_BLOCK_SIZE; i++) {
        if (i < 148 || i >= 156) {
            sum += block[i];
        }
    }
    if (octal(block, 148, 8) !== sum) {
        throw new RepoValidationError("tar header checksum mismatch");
    }
    const size = tarSize(block);
    if (!Number.isInteger(size) || size < 0) {
        throw new RepoValidationError("malformed tar entry size");
    }
    let name = cString(block, 0, 100);
    // Only POSIX ustar has a prefix field; GNU keeps incremental data there
    if (block.toString("latin1", 257, 263) === "ustar\0") {
        const prefix = cString(block, 345, 155);
        if (prefix.length > 0) {
            name = `${ prefix }/${ name }`;
        }
    }
    return { name, size, typeflag: String.fromCharCode(block[156]), linkname: cString(block, 157, 100) };
}

function parsePax(body: Buffer): Map<string, string> {
    const records = new Map<string, string>();
    let position = 0;
    while (position < body.length) {
        const space = body.indexOf(0x20, position);
        const length = space < 0 ? NaN : Number.parseInt(body.toString("latin1", position, space), 10);
        if (!Number.isInteger(length) || length <= space - position || position + length > body.length) {
            throw new RepoValidationError("malformed pax header");
        }
        const record = body.toString("utf8", space + 1, position + length - 1);
        const equals = record.indexOf("=");
        if (equals < 0) {
            throw new RepoValidationError("malformed pax header");
        }
        records.set(record.slice(0, equals), record.slice(equals + 1));
        position += length;
    }
    return records;
}

function tarType(typeflag: string): TarEntry["type"] {
    switch (typeflag) {
        case "0": case "\0": case "7": return "file";
        case "5": return "directory";
        case "2": return "symlink";
        case "1": return "hardlink";
        default: return "other";
    }
}

function padded(size: number): number {
    return size + (TAR_BLOCK_SIZE - size % TAR_BLOCK_SIZE) % TAR_BLOCK_SIZE;
}

async function readTarBody(reader: ChunkReader, name: string, size: number, limit: number): Promise<Buffer> {
    // Before reading: a small compressed member can expand to any size
    if (size > limit) {
        throw new RepoValidationError(`tar entry ${ JSON.stringify(name) } holds ${ size } bytes, over the ${ limit } limit`);
    }
    const body = await reader.read(size);
    if (body.length < size || await reader.skip(padded(size) - size) < padded(size) - size) {
        throw new RepoValidationError("truncated tar entry");
    }
    return body;
}

export async function* readTar(input: Readable, wantBody?: (e: TarEntry) => boolean): AsyncGenerator<TarEntry & { body?: Buffer }> {
    const reader = new ChunkReader(input);
    try {
        let longName: string | undefined;
        let longLink: string | undefined;
        let pax: Map<string, string> | undefined;
        for (; ;) {
            const block = await reader.read(TAR_BLOCK_SIZE);
            if (block.length === 0 || block.every(byte => byte === 0)) {
                break;
            }
            if (block.length < TAR_BLOCK_SIZE) {
                throw new RepoValidationError("truncated tar header");
            }
            const header = parseTarHeader(block);
            switch (header.typeflag) {
                case "L":
                    longName = cString(await readTarBody(reader, header.name, header.size, MAX_HEADER_BODY), 0, header.size);
                    continue;
                case "K":
                    longLink = cString(await readTarBody(reader, header.name, header.size, MAX_HEADER_BODY), 0, header.size);
                    continue;
                case "x":
                    pax = parsePax(await readTarBody(reader, header.name, header.size, MAX_HEADER_BODY));
                    continue;
                case "g":
                    await readTarBody(reader, header.name, header.size, MAX_HEADER_BODY);
                    continue;
            }
            const paxSize = pax?.get("size");
            const size = paxSize === undefined ? header.size : Number(paxSize);
            if (!Number.isInteger(size) || size < 0) {
                throw new RepoValidationError("malformed pax size");
            }
            const path = pax?.get("path") ?? longName ?? header.name;
            const entry: TarEntry = {
                path: path.startsWith("./") ? path.slice(2) : path,
                type: tarType(header.typeflag),
                size,
            };
            const linkTarget = pax?.get("linkpath") ?? longLink ?? header.linkname;
            if (linkTarget.length > 0) {
                entry.linkTarget = linkTarget;
            }
            longName = longLink = pax = undefined;
            if (wantBody?.(entry)) {
                yield { ...entry, body: await readTarBody(reader, entry.path, entry.size, MAX_CONTROL_SIZE) };
            } else {
                if (await reader.skip(padded(entry.size)) < padded(entry.size)) {
                    throw new RepoValidationError("truncated tar entry");
                }
                yield entry;
            }
        }
        // Consume the trailing padding so an upstream pipeline ends cleanly
        await reader.drain();
    } finally {
        await reader.close();
    }
}

export function compressionOf(memberName: string): Compression {
    switch (memberName.slice(memberName.lastIndexOf(".") + 1)) {
        case "tar": return "none";
        case "gz": return "gzip";
        case "xz": return "xz";
        case "zst": return "zstd";
    }
    throw new RepoValidationError(`Unsupported compression of member ${ memberName }`);
}

export function decompressor(compression: Compression): Duplex {
    switch (compression) {
        case "none": return new PassThrough();
        case "gzip": case "zstd": return zlibDecompressor(compression);
        case "xz": return xzDecompressor();
    }
}

function isZlibError(err: Error | null): err is Error {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code !== undefined && (code.startsWith("Z_") || code.startsWith("ZSTD_error_"));
}

// zlib reports corrupt input by destroying the stream with a Z_*/ZSTD_error_* code; errors the pipeline injects keep their class
function zlibDecompressor(compression: "gzip" | "zstd"): Duplex {
    const stream = compression === "gzip" ? zlib.createGunzip() : zlib.createZstdDecompress();
    const destroy = stream._destroy;
    stream._destroy = (err, callback) => destroy.call(stream,
        isZlibError(err) ? new RepoValidationError(`${ compression }: ${ err.message }`, { cause: err }) : err, callback);
    return stream;
}

// xz-embedded return codes; the decoder reports only the number
const XZ_ERRORS: Record<string, string> = {
    2: "unsupported integrity check",
    3: "out of memory",
    4: "memory limit exceeded",
    5: "not an xz stream",
    6: "unsupported integrity check or filter options (only none, CRC32 and CRC64 checks decode)",
    7: "corrupt data",
    8: "truncated stream",
};

function xzError(err: unknown): RepoValidationError {
    const message = err instanceof Error ? err.message : String(err);
    const reason = XZ_ERRORS[message.slice(message.lastIndexOf(" ") + 1)] ?? message;
    return new RepoValidationError(`xz: ${ reason }`, { cause: err });
}

function xzDecompressor(): Duplex {
    const { readable: compressed, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const reader = new xz.XzReadableStream(compressed).getReader();
    const readable = new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { done, value } = await reader.read().catch(err => { throw xzError(err); });
            if (done) {
                controller.close();
            } else {
                controller.enqueue(value);
            }
        },
        cancel: reason => reader.cancel(reason),
    });
    return Duplex.from({ writable, readable });
}
