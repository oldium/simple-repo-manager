import { withLocalTmpDir } from "../utils.ts";
import crypto from "crypto";
import fs from "fs/promises";
import zlib from "zlib";
import { openDatabase } from "../../server/backend/db.ts";
import { CHUNK_TARGET, compareKeys, KEYS_END_SQL, writeChunkedIndex } from "../../server/backend/chunked.ts";
import type { ChunkedIndexOptions, ChunkInfo, IndexCodec, IndexRecord } from "../../server/backend/chunked.ts";

const TARGET = 100;
const MD5_EMPTY = "d41d8cd98f00b204e9800998ecf8427e";
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

type Call = [string, string | undefined];

function key(i: number): string {
    return `k${ i.toString().padStart(3, "0") }`;
}

/** 49 bytes with the default filler, so three records pass the 100 byte target */
function record(k: string, filler = "x".repeat(20)): IndexRecord {
    return { key: k, text: `Package: ${ k }\nDescription: ${ filler }\n\n` };
}

function records(count: number): IndexRecord[] {
    return Array.from({ length: count }, (_, i) => record(key(i)));
}

function sorted(list: IndexRecord[]): IndexRecord[] {
    return [...list].sort((a, b) => compareKeys(a.key, b.key));
}

function concat(list: IndexRecord[]): string {
    return sorted(list).map(r => r.text).join("");
}

function replace(list: IndexRecord[], ...changed: IndexRecord[]): IndexRecord[] {
    const keys = new Set(changed.map(r => r.key));
    return [...list.filter(r => !keys.has(r.key)), ...changed];
}

function without(list: IndexRecord[], ...keys: string[]): IndexRecord[] {
    return list.filter(r => !keys.includes(r.key));
}

function sourceOf(list: IndexRecord[]) {
    const calls: Call[] = [];
    const source = (start: string, end: string | undefined) => {
        calls.push([start, end]);
        return sorted(list).filter(r => compareKeys(r.key, start) >= 0 && (end === undefined || compareKeys(r.key, end) < 0));
    };
    return { source, calls };
}

function digest(name: string, data: Buffer): string {
    return crypto.createHash(name).update(data).digest("hex");
}

/** An empty slice holds no member at all, which decodes to nothing */
function decode(codec: IndexCodec, data: Buffer): string {
    if (data.length === 0) {
        return "";
    }
    return (codec === "gzip" ? zlib.gunzipSync(data) : zlib.zstdDecompressSync(data)).toString();
}

async function write(list: IndexRecord[], name: string, extra: Partial<ChunkedIndexOptions> = {}) {
    const { source, calls } = sourceOf(list);
    const codec = extra.codec ?? "gzip";
    const outFile = `${ name }.${ codec }`;
    const outShadow = `${ name }.raw`;
    const result = await writeChunkedIndex({ codec, source, targetChunkSize: TARGET, outFile, outShadow, ...extra });
    const file = await fs.readFile(outFile);
    const shadow = await fs.readFile(outShadow);
    return { result, calls, file, shadow, previous: { file: outFile, shadow: outShadow, chunks: result.chunks } };
}

type Built = Awaited<ReturnType<typeof write>>;

function compressedSlices(built: Built): Buffer[] {
    return built.result.chunks.map(c => built.file.subarray(c.offset, c.offset + c.length));
}

function rawSlices(built: Built): string[] {
    return built.result.chunks.map(c => built.shadow.subarray(c.rawOffset, c.rawOffset + c.rawLength).toString());
}

/** Chunks tile both files between the header and the footer, every chunk is its own member and decodes to its raw slice */
function expectWellFormed(built: Built, codec: IndexCodec, header = "", footer = "") {
    const { result, file, shadow } = built;
    expect(result).toMatchObject({
        size: file.length, rawSize: shadow.length, md5: digest("md5", file), sha256: digest("sha256", file),
        rawMd5: digest("md5", shadow), rawSha256: digest("sha256", shadow),
    });
    const chunks = result.chunks;
    if (chunks.length > 0) {
        expect(chunks[0].startKey).toBe("");
        expect(decode(codec, file.subarray(0, chunks[0].offset))).toBe(header);
        expect(shadow.subarray(0, chunks[0].rawOffset).toString()).toBe(header);
        const last = chunks[chunks.length - 1];
        expect(decode(codec, file.subarray(last.offset + last.length))).toBe(footer);
        expect(shadow.subarray(last.rawOffset + last.rawLength).toString()).toBe(footer);
    }
    for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].offset).toBe(chunks[i - 1].offset + chunks[i - 1].length);
        expect(chunks[i].rawOffset).toBe(chunks[i - 1].rawOffset + chunks[i - 1].rawLength);
        expect(compareKeys(chunks[i - 1].startKey, chunks[i].startKey)).toBeLessThan(0);
    }
    expect(compressedSlices(built).map(slice => decode(codec, slice))).toEqual(rawSlices(built));
}

function startKeys(chunks: ChunkInfo[]): string[] {
    return chunks.map(c => c.startKey);
}

describe("Tests for writeChunkedIndex", () => {
    test("Full build decodes to the concatenated records and reports digests", withLocalTmpDir(async () => {
        const list = records(10);
        const built = await write(list, "full");
        expect(built.calls).toEqual([["", undefined]]);
        expect(zlib.gunzipSync(built.file).toString()).toBe(concat(list));
        expect(built.shadow.toString()).toBe(concat(list));
        expectWellFormed(built, "gzip");
        expect(startKeys(built.result.chunks)).toEqual(["", "k003", "k006", "k009"]);
        expect(built.result.chunks.map(c => c.rawLength)).toEqual([147, 147, 147, 49]);
        expect(rawSlices(built)).toEqual([
            concat(list.slice(0, 3)), concat(list.slice(3, 6)), concat(list.slice(6, 9)), concat(list.slice(9)),
        ]);
        expect(CHUNK_TARGET).toBe(1048576);
    }));

    test("Incremental build rewrites only the dirty chunk", withLocalTmpDir(async () => {
        const list = records(10);
        const first = await write(list, "first");
        const changed = replace(list, record("k004", "y".repeat(40)));
        const second = await write(changed, "second", { previous: first.previous, dirtyKeys: ["k004"] });
        expect(second.calls).toEqual([["k003", "k006"]]);
        expect(zlib.gunzipSync(second.file).toString()).toBe(concat(changed));
        expectWellFormed(second, "gzip");
        expect(startKeys(second.result.chunks)).toEqual(["", "k003", "k006", "k009"]);
        const before = compressedSlices(first);
        const after = compressedSlices(second);
        expect(after[0].equals(before[0])).toBe(true);
        expect(after[1].equals(before[1])).toBe(false);
        expect(after[2].equals(before[2])).toBe(true);
        expect(after[3].equals(before[3])).toBe(true);
        expect(second.result.chunks[1].rawLength).toBe(147 + 20);
        expect(second.result.chunks[2].offset).toBe(second.result.chunks[1].offset + second.result.chunks[1].length);
        expect(second.result.chunks[2].offset).not.toBe(first.result.chunks[2].offset);
    }));

    test("Dirty keys map to the chunk whose range contains them", withLocalTmpDir(async () => {
        const list = records(10);
        const first = await write(list, "first");
        const changed = [...list, record("k0035"), record("zzz")];
        const second = await write(changed, "second", { previous: first.previous, dirtyKeys: ["zzz", "k0035"] });
        expect(second.calls).toEqual([["k003", "k006"], ["k009", undefined]]);
        expect(zlib.gunzipSync(second.file).toString()).toBe(concat(changed));
        expectWellFormed(second, "gzip");
        expect(startKeys(second.result.chunks)).toEqual(["", "k003", "k006", "k009"]);
        expect(rawSlices(second)[3]).toBe(concat([record("k009"), record("zzz")]));
        const unchanged = await write(changed, "third", { previous: second.previous, dirtyKeys: [] });
        expect(unchanged.calls).toEqual([]);
        expect(unchanged.file.equals(second.file)).toBe(true);
        expect(unchanged.result).toEqual(second.result);
    }));

    test("Removing every record of a chunk drops it", withLocalTmpDir(async () => {
        const list = records(10);
        const first = await write(list, "first");
        const middleGone = without(list, "k003", "k004", "k005");
        const middle = await write(middleGone, "middle", { previous: first.previous, dirtyKeys: ["k003", "k004", "k005"] });
        expect(middle.calls).toEqual([["k003", "k006"]]);
        expect(zlib.gunzipSync(middle.file).toString()).toBe(concat(middleGone));
        expectWellFormed(middle, "gzip");
        expect(startKeys(middle.result.chunks)).toEqual(["", "k006", "k009"]);
        expect(compressedSlices(middle)[1].equals(compressedSlices(first)[2])).toBe(true);

        const headGone = without(list, "k000", "k001", "k002");
        const head = await write(headGone, "head", { previous: first.previous, dirtyKeys: ["k001"] });
        expect(head.calls).toEqual([["", "k003"]]);
        expect(zlib.gunzipSync(head.file).toString()).toBe(concat(headGone));
        expectWellFormed(head, "gzip");
        expect(startKeys(head.result.chunks)).toEqual(["", "k006", "k009"]);
        expect(compressedSlices(head)[0].equals(compressedSlices(first)[1])).toBe(true);

        const allGone = await write([], "none", { previous: first.previous, dirtyKeys: list.map(r => r.key) });
        expect(allGone.result.chunks).toEqual([]);
        expect(zlib.gunzipSync(allGone.file).length).toBe(0);
        expect(allGone.shadow.length).toBe(0);
        expectWellFormed(allGone, "gzip");

        const back = await write(list.slice(0, 2), "back", { previous: allGone.previous, dirtyKeys: ["k000", "k001"] });
        expect(back.calls).toEqual([["", undefined]]);
        expect(zlib.gunzipSync(back.file).toString()).toBe(concat(list.slice(0, 2)));
        expectWellFormed(back, "gzip");
        expect(startKeys(back.result.chunks)).toEqual([""]);
    }));

    test("Oversized chunk splits, undersized merges", withLocalTmpDir(async () => {
        const list = records(10);
        const first = await write(list, "first");

        // One filler byte less keeps the five-character keys at 49 bytes per record
        const grown = [...list, ...[0, 1, 2, 3, 4, 5].map(i => record(`k003${ i }`, "x".repeat(19)))];
        const split = await write(grown, "split", { previous: first.previous, dirtyKeys: ["k0030"] });
        expect(split.calls).toEqual([["k003", "k006"]]);
        expect(zlib.gunzipSync(split.file).toString()).toBe(concat(grown));
        expectWellFormed(split, "gzip");
        expect(startKeys(split.result.chunks)).toEqual(["", "k003", "k0032", "k0035", "k006", "k009"]);
        expect(split.result.chunks.map(c => c.rawLength)).toEqual([147, 147, 147, 147, 147, 49]);
        expect(compressedSlices(split)[4].equals(compressedSlices(first)[2])).toBe(true);

        const bigger = replace(list, record("k004", "y".repeat(60)));
        const kept = await write(bigger, "kept", { previous: first.previous, dirtyKeys: ["k004"] });
        expect(zlib.gunzipSync(kept.file).toString()).toBe(concat(bigger));
        expectWellFormed(kept, "gzip");
        expect(startKeys(kept.result.chunks)).toEqual(["", "k003", "k006", "k009"]);
        expect(kept.result.chunks[1].rawLength).toBe(187);

        const tiny = { key: "k003", text: "P: k003\n\n" };
        const shrunk = replace(without(list, "k004", "k005"), tiny);
        const merged = await write(shrunk, "merged", { previous: first.previous, dirtyKeys: ["k004"] });
        expect(merged.calls).toEqual([["k003", "k006"], ["k006", "k009"]]);
        expect(zlib.gunzipSync(merged.file).toString()).toBe(concat(shrunk));
        expectWellFormed(merged, "gzip");
        expect(startKeys(merged.result.chunks)).toEqual(["", "k003", "k009"]);
        expect(rawSlices(merged)[1]).toBe(tiny.text + concat(list.slice(6, 9)));
        expect(compressedSlices(merged)[2].equals(compressedSlices(first)[3])).toBe(true);

        const tail = { key: "k009", text: "P: k009\n\n" };
        const lastSmall = await write(replace(list, tail), "tail", { previous: first.previous, dirtyKeys: ["k009"] });
        expect(lastSmall.calls).toEqual([["k009", undefined]]);
        expectWellFormed(lastSmall, "gzip");
        expect(startKeys(lastSmall.result.chunks)).toEqual(["", "k003", "k006", "k009"]);
        expect(rawSlices(lastSmall)[3]).toBe(tail.text);
    }));

    test("A split's undersized tail merges with the next chunk", withLocalTmpDir(async () => {
        const list = records(10);
        const first = await write(list, "first");
        const tiny = { key: "k005", text: "P: k005\n\n" };
        const grown = replace([...without(list, "k004"), ...[0, 1, 2, 3, 4].map(i => record(`k003${ i }`, "x".repeat(19)))], tiny);
        const built = await write(grown, "tail", { previous: first.previous, dirtyKeys: ["k0030"] });
        expect(built.calls).toEqual([["k003", "k006"], ["k006", "k009"]]);
        expect(zlib.gunzipSync(built.file).toString()).toBe(concat(grown));
        expectWellFormed(built, "gzip");
        expect(startKeys(built.result.chunks)).toEqual(["", "k003", "k0032", "k005", "k008", "k009"]);
        expect(built.result.chunks.map(c => c.rawLength)).toEqual([147, 147, 147, 107, 49, 49]);
        expect(rawSlices(built)[3]).toBe(tiny.text + concat(list.slice(6, 8)));
        expect(compressedSlices(built)[5].equals(compressedSlices(first)[3])).toBe(true);
    }));

    test("An undersized chunk merges past an emptied neighbour", withLocalTmpDir(async () => {
        const list = records(10);
        const first = await write(list, "first");
        const tiny = { key: "k003", text: "P: k003\n\n" };
        const shrunk = replace(without(list, "k004", "k005", "k006", "k007", "k008"), tiny);
        const built = await write(shrunk, "cascade", { previous: first.previous, dirtyKeys: ["k004", "k006"] });
        expect(built.calls).toEqual([["k003", "k006"], ["k006", "k009"], ["k009", undefined]]);
        expect(zlib.gunzipSync(built.file).toString()).toBe(concat(shrunk));
        expectWellFormed(built, "gzip");
        expect(startKeys(built.result.chunks)).toEqual(["", "k003"]);
        expect(rawSlices(built)[1]).toBe(tiny.text + record("k009").text);
        expect(compressedSlices(built)[0].equals(compressedSlices(first)[0])).toBe(true);
    }));

    test("An undersized first chunk merges with the second and keeps the empty start key", withLocalTmpDir(async () => {
        const list = records(10);
        const first = await write(list, "first");
        const tiny = { key: "k000", text: "P: k000\n\n" };
        const shrunk = replace(without(list, "k001", "k002"), tiny);
        const built = await write(shrunk, "head", { previous: first.previous, dirtyKeys: ["k001"] });
        expect(built.calls).toEqual([["", "k003"], ["k003", "k006"]]);
        expect(zlib.gunzipSync(built.file).toString()).toBe(concat(shrunk));
        expectWellFormed(built, "gzip");
        expect(startKeys(built.result.chunks)).toEqual(["", "k006", "k009"]);
        expect(rawSlices(built)[0]).toBe(tiny.text + concat(list.slice(3, 6)));
        expect(compressedSlices(built).slice(1).map(s => s.toString("hex")))
            .toEqual(compressedSlices(first).slice(2).map(s => s.toString("hex")));
    }));

    test("Refuses outputs that would overwrite the previous index", withLocalTmpDir(async () => {
        const first = await write(records(10), "first");
        const options = { codec: "gzip" as const, source: () => [], previous: first.previous };
        await expect(writeChunkedIndex({ ...options, outFile: "first.gzip", outShadow: "other.raw" }))
            .rejects.toThrow(/overwrite the previous index/);
        await expect(writeChunkedIndex({ ...options, outFile: "other.gz", outShadow: "./first.raw" }))
            .rejects.toThrow(/overwrite the previous index/);
        await expect(writeChunkedIndex({ ...options, outFile: "first.raw", outShadow: "other.raw" }))
            .rejects.toThrow(/overwrite the previous index/);
        expect((await fs.readFile("first.gzip")).equals(first.file)).toBe(true);
        expect((await fs.readFile("first.raw")).equals(first.shadow)).toBe(true);
        await expect(fs.stat("other.raw")).rejects.toThrow(/ENOENT/);
        await expect(fs.stat("other.gz")).rejects.toThrow(/ENOENT/);
    }));

    test("Header and footer are separate frames and zstd output decodes", withLocalTmpDir(async () => {
        const list = records(10);
        const header = "<?xml version=\"1.0\"?>\n<metadata packages=\"10\">\n";
        const footer = "</metadata>\n";
        const first = await write(list, "first", { codec: "zstd", header, footer });
        expect(zlib.zstdDecompressSync(first.file).toString()).toBe(header + concat(list) + footer);
        expect(first.shadow.toString()).toBe(header + concat(list) + footer);
        expectWellFormed(first, "zstd", header, footer);
        expect(startKeys(first.result.chunks)).toEqual(["", "k003", "k006", "k009"]);
        expect(first.result.chunks[0].rawOffset).toBe(Buffer.byteLength(header));
        expect(first.result.chunks[0].offset).toBe(zlib.zstdCompressSync(header).length);

        const changed = [...list, record("k010")];
        const newHeader = header.replace("10", "11");
        const second = await write(changed, "second", {
            codec: "zstd", header: newHeader, footer, previous: first.previous, dirtyKeys: ["k010"],
        });
        expect(second.calls).toEqual([["k009", undefined]]);
        expect(zlib.zstdDecompressSync(second.file).toString()).toBe(newHeader + concat(changed) + footer);
        expectWellFormed(second, "zstd", newHeader, footer);
        const before = compressedSlices(first);
        const after = compressedSlices(second);
        expect(after.slice(0, 3).map(s => s.toString("hex"))).toEqual(before.slice(0, 3).map(s => s.toString("hex")));
        expect(after[3].equals(before[3])).toBe(false);

        const empty = await write([], "empty", { codec: "zstd", header, footer });
        expect(empty.result.chunks).toEqual([]);
        expect(zlib.zstdDecompressSync(empty.file).toString()).toBe(header + footer);
    }));

    test("compareKeys orders UTF-8 bytes like SQLite", () => {
        const db = openDatabase(":memory:");
        try {
            const keys = ["b", "a b", "naïve", "a", "ä", "z", "\u{1F600}"];
            const sqlOrder = db.prepare("SELECT value AS k FROM json_each(?) ORDER BY k").all(JSON.stringify(keys)).map(r => r.k);
            expect([...keys].sort(compareKeys)).toEqual(sqlOrder);

            // U+FF5E sorts after U+1F600 by UTF-16 code units but before it by UTF-8 bytes
            const tricky = ["～", "\u{1F600}", "", "a"];
            const trickyOrder = db.prepare("SELECT value AS k FROM json_each(?) ORDER BY k").all(JSON.stringify(tricky)).map(r => r.k);
            expect([...tricky].sort()).not.toEqual(trickyOrder);
            expect([...tricky].sort(compareKeys)).toEqual(trickyOrder);
        } finally {
            db.close();
        }
    });

    test("KEYS_END_SQL is above every key, also one that starts with the last code point", () => {
        const db = openDatabase(":memory:");
        try {
            const below = db.prepare(`SELECT ? < ${ KEYS_END_SQL } AS below`);
            for (const k of ["", "a", "\u{FFFF}", "\u{10FFFF}", "\u{10FFFF}\u{10FFFF}"]) {
                expect(below.get(k)).toEqual({ below: 1 });
            }
        } finally {
            db.close();
        }
    });

    test("Empty index is a valid gzip of empty content", withLocalTmpDir(async () => {
        const empty = await write([], "empty");
        expect(empty.calls).toEqual([["", undefined]]);
        expect(empty.result).toEqual({
            chunks: [], size: empty.file.length, rawSize: 0, md5: digest("md5", empty.file), sha256: digest("sha256", empty.file),
            rawMd5: MD5_EMPTY, rawSha256: SHA256_EMPTY,
        });
        expect(empty.file.length).toBeGreaterThan(0);
        expect(zlib.gunzipSync(empty.file).length).toBe(0);
        expect(empty.shadow.length).toBe(0);

        const zstd = await write([], "empty", { codec: "zstd" });
        expect(zstd.file.length).toBeGreaterThan(0);
        expect(zlib.zstdDecompressSync(zstd.file).length).toBe(0);
    }));

    test("Rejects records out of key order and leaves no output behind", withLocalTmpDir(async () => {
        const unordered = () => [record("k001"), record("k000")];
        await expect(writeChunkedIndex({ codec: "gzip", source: unordered, outFile: "bad.gz", outShadow: "bad.raw" }))
            .rejects.toThrow(/out of order/);
        await expect(fs.stat("bad.gz")).rejects.toThrow(/ENOENT/);
        await expect(fs.stat("bad.raw")).rejects.toThrow(/ENOENT/);

        const first = await write(records(10), "first");
        const leaking = () => [record("k003"), record("k006")];
        await expect(writeChunkedIndex({
            codec: "gzip", source: leaking, previous: first.previous, dirtyKeys: ["k003"], targetChunkSize: TARGET,
            outFile: "leak.gz", outShadow: "leak.raw",
        })).rejects.toThrow(/k006/);
        await expect(fs.stat("leak.gz")).rejects.toThrow(/ENOENT/);
    }));
});
