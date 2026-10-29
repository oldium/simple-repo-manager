import { withLocalTmpDir } from "../utils.ts";
import osPath from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { createReadStream } from "fs";
import { pipeline, Readable } from "stream";
import { pipeline as pipelineAsync } from "stream/promises";
import zlib from "zlib";
import { compressionOf, decompressor, readArMembers, readTar } from "../../server/backend/archive.ts";
import type { ArMember, Compression, TarEntry } from "../../server/backend/archive.ts";
import { field, formatStanza, parseControl, parseFileList, stripClearsign } from "../../server/backend/control.ts";
import { RepoValidationError } from "../../server/lib/errors.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/packages/deb/", import.meta.url));
const XZ_DEB = osPath.join(FIXTURES, "debian", "trixie", "main", "srm-hello_1.0-1_amd64.deb");
const ZST_DEB = osPath.join(FIXTURES, "ubuntu", "noble", "universe", "srm-zst_3.0-1_amd64.deb");
const GZ_DEB = osPath.join(FIXTURES, "debian", "bookworm", "main", "srm-gz_0.1-1_amd64.deb");
const DSC = osPath.join(FIXTURES, "debian", "trixie", "main", "srm-hello_1.0-1.dsc");

// `printf 'hi\n' | xz --check=sha256` and `--check=crc64`
const XZ_SHA256 = "/Td6WFoAAArh+wyhBMAHAyEBFgAAAAAAAAAAAOLzWwwBAAJoaQoAAJjqbk8hby+0tp//mzpEhCw4aGymhfP1XcSMXT+xEHvkAAE7A6kLPYUYm0uaAQAAAAAKWVo=";
const XZ_CRC64 = "/Td6WFoAAATm1rRGBMAHAyEBFgAAAAAAAAAAAOLzWwwBAAJoaQoAAPt76OgqWENPAAEjA/CTJgcftvN9AQAAAAAEWVo=";

const TEXT = Buffer.from("hello world\n".repeat(50));
const GZIP = zlib.gzipSync(TEXT);
// dpkg writes checksummed frames too; without the checksum a flipped byte decodes silently
const ZSTD = zlib.zstdCompressSync(TEXT, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });

const MIB = 1024 * 1024;

const USTAR_MAGIC = "ustar\x0000";
const GNU_MAGIC = "ustar  \x00";

type HeaderFields = { linkname?: string; magic?: string; prefix?: string };

function tarHeader(name: string, size: number, type: string, fields: HeaderFields = {}): Buffer {
    const block = Buffer.alloc(512);
    block.write(name, 0, 100, "latin1");
    block.write("0000644\x00", 100, "latin1");
    block.write("0000000\x00", 108, "latin1");
    block.write("0000000\x00", 116, "latin1");
    block.write(`${ size.toString(8).padStart(11, "0") }\x00`, 124, "latin1");
    block.write("00000000000\x00", 136, "latin1");
    block.write("        ", 148, "latin1");
    block.write(type, 156, "latin1");
    if (fields.linkname) {
        block.write(fields.linkname, 157, 100, "latin1");
    }
    block.write(fields.magic ?? USTAR_MAGIC, 257, "latin1");
    if (fields.prefix) {
        block.write(fields.prefix, 345, 155, "latin1");
    }
    let sum = 0;
    for (const byte of block) {
        sum += byte;
    }
    block.write(`${ sum.toString(8).padStart(6, "0") }\x00 `, 148, "latin1");
    return block;
}

function tarEntry(name: string, body: Buffer | string, type = "0", fields: HeaderFields = {}): Buffer {
    const content = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    const padding = (512 - content.length % 512) % 512;
    return Buffer.concat([tarHeader(name, content.length, type, fields), content, Buffer.alloc(padding)]);
}

function paxRecord(key: string, value: string): string {
    const rest = ` ${ key }=${ value }\n`;
    let total = rest.length + 1;
    while (String(total).length + rest.length > total) {
        total++;
    }
    return `${ total }${ rest }`;
}

function tarBytes(...entries: Buffer[]): Buffer {
    return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

function tar(...entries: Buffer[]): Readable {
    return Readable.from([tarBytes(...entries)]);
}

function chunked(bytes: Buffer, chunkSize: number): Readable {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        chunks.push(bytes.subarray(offset, offset + chunkSize));
    }
    return Readable.from(chunks);
}

/** The header and a long run of zeros, noting how much of them was pulled */
function pulling(header: Buffer, pulled: { bytes: number }): Readable {
    return Readable.from((function* () {
        yield header;
        while (pulled.bytes < 32 * MIB) {
            pulled.bytes += 16384;
            yield Buffer.alloc(16384);
        }
    })());
}

async function collect(input: Readable, wantBody?: (e: TarEntry) => boolean): Promise<(TarEntry & { body?: Buffer })[]> {
    const entries: (TarEntry & { body?: Buffer })[] = [];
    for await (const entry of readTar(input, wantBody)) {
        entries.push(entry);
    }
    return entries;
}

function memberStream(file: string, member: ArMember): Readable {
    const decoded = decompressor(compressionOf(member.name));
    pipeline(createReadStream(file, { start: member.offset, end: member.offset + member.size - 1 }), decoded, () => { });
    return decoded;
}

function corrupted(bytes: Buffer): Buffer {
    const copy = Buffer.from(bytes);
    copy[Math.floor(copy.length / 2)] ^= 0xff;
    return copy;
}

async function decode(compression: Compression, input: Buffer[]): Promise<Buffer> {
    const chunks: Buffer[] = [];
    await pipelineAsync(Readable.from(input), decompressor(compression), async function (source) {
        for await (const chunk of source) {
            chunks.push(chunk as Buffer);
        }
    });
    return Buffer.concat(chunks);
}

describe("Tests for readArMembers", () => {
    test("Lists deb members in order", async () => {
        const members = await readArMembers(XZ_DEB);
        expect(members.map(m => m.name)).toEqual(["debian-binary", "control.tar.xz", "data.tar.xz"]);
        expect(members[0]).toEqual({ name: "debian-binary", offset: 68, size: 4 });
        expect(members[1].offset).toBe(132);
        expect(members[2].offset).toBe(members[1].offset + members[1].size + members[1].size % 2 + 60);
    });

    test("Rejects a non-ar file", async () => {
        await expect(readArMembers(DSC)).rejects.toStrictEqual(new RepoValidationError("srm-hello_1.0-1.dsc is not an ar archive"));
    });

    test("Rejects a truncated archive", withLocalTmpDir(async () => {
        await fs.mkdir("staged");
        await fs.writeFile(osPath.join("staged", "cut.deb"), (await fs.readFile(XZ_DEB)).subarray(0, 200));
        await expect(readArMembers(osPath.join("staged", "cut.deb"))).rejects.toStrictEqual(new RepoValidationError("cut.deb: truncated ar member control.tar.xz"));
    }));
});

describe("Tests for readTar", () => {
    test("Reads GNU long names", async () => {
        const longName = `usr/share/${ "x".repeat(120) }`;
        const entries = await collect(tar(
            tarEntry("././@LongLink", `${ longName }\x00`, "L", { magic: GNU_MAGIC }),
            tarEntry(longName.slice(0, 100), "payload", "0", { magic: GNU_MAGIC }),
        ), () => true);
        expect(entries).toEqual([{ path: longName, type: "file", size: 7, body: Buffer.from("payload") }]);
    });

    test("Reads pax paths and link targets", async () => {
        const longName = `opt/${ "y".repeat(150) }`;
        const target = `../${ "z".repeat(110) }`;
        const entries = await collect(tar(
            tarEntry("PaxHeaders/link", paxRecord("path", longName) + paxRecord("linkpath", target), "x"),
            tarEntry("link", "", "2", { linkname: "short" }),
        ));
        expect(entries).toEqual([{ path: longName, type: "symlink", size: 0, linkTarget: target }]);
    });

    test("Joins the ustar prefix and strips the leading ./", async () => {
        const entries = await collect(tar(
            tarEntry("./", "", "5"),
            tarEntry("pkg/README", "doc", "0", { prefix: "./usr/share/doc" }),
            tarEntry("./usr/bin/tool", "", "1", { linkname: "./usr/bin/other" }),
            tarEntry("./dev/null", "", "3"),
        ));
        expect(entries).toEqual([
            { path: "", type: "directory", size: 0 },
            { path: "usr/share/doc/pkg/README", type: "file", size: 3 },
            { path: "usr/bin/tool", type: "hardlink", size: 0, linkTarget: "./usr/bin/other" },
            { path: "dev/null", type: "other", size: 0 },
        ]);
    });

    test("Reads bodies only when asked", async () => {
        const big = Buffer.alloc(1500, 7);
        const entries = await collect(tar(
            tarEntry("./first", big),
            tarEntry("./control", "Package: a\n"),
            tarEntry("./last", "tail"),
        ), e => e.path === "control");
        expect(entries.map(e => [e.path, e.size, e.body?.toString()])).toEqual([
            ["first", 1500, undefined],
            ["control", 11, "Package: a\n"],
            ["last", 4, undefined],
        ]);
    });

    test("Reads the same entries from any chunking", async () => {
        const bytes = tarBytes(
            tarEntry("./usr/", "", "5"),
            tarEntry("./usr/bin/tool", Buffer.alloc(1300, 1)),
            tarEntry("././@LongLink", `./${ "n".repeat(150) }\x00`, "L", { magic: GNU_MAGIC }),
            tarEntry("n".repeat(100), "long-named body", "0", { magic: GNU_MAGIC }),
            tarEntry("./etc/skipped", Buffer.alloc(700, 2)),
            tarEntry("./etc/wanted", "wanted body"),
        );
        const wantBody = (e: TarEntry) => e.path !== "etc/skipped";
        const whole = await collect(Readable.from([bytes]), wantBody);
        expect(whole.map(e => [e.path, e.size, e.body?.length])).toEqual([
            ["usr/", 0, 0],
            ["usr/bin/tool", 1300, 1300],
            ["n".repeat(150), 15, 15],
            ["etc/skipped", 700, undefined],
            ["etc/wanted", 11, 11],
        ]);
        expect(await collect(chunked(bytes, 7), wantBody)).toEqual(whole);
        expect(await collect(chunked(bytes, 513), wantBody)).toEqual(whole);
    });

    test.each([
        ["L", GNU_MAGIC], ["K", GNU_MAGIC], ["x", USTAR_MAGIC], ["g", USTAR_MAGIC],
    ])("Refuses a %s body over 1 MiB without reading it", async (type, magic) => {
        const pulled = { bytes: 0 };

        await expect(collect(pulling(tarHeader("./meta", MIB + 1, type, { magic }), pulled)))
            .rejects.toStrictEqual(new RepoValidationError(`tar entry "./meta" holds ${ MIB + 1 } bytes, over the ${ MIB } limit`));

        expect(pulled.bytes).toBeLessThan(MIB);
    });

    test("Reads a long name of exactly 1 MiB", async () => {
        const entries = await collect(tar(tarEntry("././@LongLink", "n".repeat(MIB), "L", { magic: GNU_MAGIC }), tarEntry("short", "", "0", { magic: GNU_MAGIC })));
        expect(entries).toEqual([{ path: "n".repeat(MIB), type: "file", size: 0 }]);
    });

    test("Refuses a wanted body over 16 MiB without reading it", async () => {
        const pulled = { bytes: 0 };

        await expect(collect(pulling(tarHeader("./control", 16 * MIB + 1, "0"), pulled), () => true))
            .rejects.toStrictEqual(new RepoValidationError(`tar entry "control" holds ${ 16 * MIB + 1 } bytes, over the ${ 16 * MIB } limit`));

        expect(pulled.bytes).toBeLessThan(MIB);
    });

    test("Refuses a wanted body that a pax header declares over 16 MiB", async () => {
        const size = 16 * MIB + 1;
        await expect(collect(tar(tarEntry("PaxHeaders/control", paxRecord("size", String(size)), "x"), tarEntry("./control", "short")), () => true))
            .rejects.toStrictEqual(new RepoValidationError(`tar entry "control" holds ${ size } bytes, over the ${ 16 * MIB } limit`));
    });

    test("Reads a wanted body of exactly 16 MiB and skips a larger unwanted one", async () => {
        const entries = await collect(tar(tarEntry("./control", Buffer.alloc(16 * MIB)), tarEntry("./large", Buffer.alloc(16 * MIB + 1))), e => e.path === "control");
        expect(entries.map(e => [e.path, e.size, e.body?.length])).toEqual([["control", 16 * MIB, 16 * MIB], ["large", 16 * MIB + 1, undefined]]);
    });

    test("Rejects a bad header checksum", async () => {
        const corrupt = tarEntry("./file", "data");
        corrupt[0] ^= 0xff;
        await expect(collect(tar(corrupt))).rejects.toThrow(/checksum/);
    });

    test("Rejects a truncated body", async () => {
        const cut = tarEntry("./file", "data").subarray(0, 514);
        await expect(collect(Readable.from([cut]), () => true)).rejects.toThrow(/truncated/);
    });
});

describe("Tests for compressionOf and decompressor", () => {
    test.each([
        ["control.tar.xz", "xz"],
        ["control.tar.zst", "zstd"],
        ["control.tar.gz", "gzip"],
        ["control.tar", "none"],
    ])("Detects %s", (name, compression) => {
        expect(compressionOf(name)).toBe(compression);
    });

    test.each(["data.tar.bz2", "data.tar.lzma", "debian-binary"])("Rejects %s", (name) => {
        expect(() => compressionOf(name)).toThrow(/unsupported/i);
        expect(() => compressionOf(name)).toThrow(RepoValidationError);
    });

    test.each([
        ["xz", XZ_DEB, "srm-hello"],
        ["zstd", ZST_DEB, "srm-zst"],
        ["gzip", GZ_DEB, "srm-gz"],
    ])("Decodes the %s control.tar", async (_, deb, packageName) => {
        const members = await readArMembers(deb);
        const control = members.find(m => m.name.startsWith("control.tar"))!;
        const entries = await collect(memberStream(deb, control), e => e.path === "control");
        expect(entries.map(e => e.path)).toContain("control");
        const stanza = parseControl(entries.find(e => e.path === "control")!.body!.toString("utf8"))[0];
        expect(field(stanza, "package")).toBe(packageName);
    });

    test("Decodes a CRC64 xz stream", async () => {
        expect((await decode("xz", [Buffer.from(XZ_CRC64, "base64")])).toString()).toBe("hi\n");
    });

    test("Reports an unsupported xz integrity check instead of hanging", async () => {
        await expect(decode("xz", [Buffer.from(XZ_SHA256, "base64")])).rejects.toThrow(/integrity check/);
    });

    test("Reports non-xz input", async () => {
        await expect(decode("xz", [Buffer.from("plain text, not xz")])).rejects.toThrow(/not an xz stream/);
    });

    test("Reports empty xz input as a validation error", async () => {
        await expect(decode("xz", [])).rejects.toThrow(RepoValidationError);
        await expect(decode("xz", [])).rejects.toThrow(/^xz: /);
    });

    test("Reports a truncated xz stream", async () => {
        const cut = Buffer.from(XZ_CRC64, "base64").subarray(0, 40);
        await expect(decode("xz", [cut])).rejects.toThrow(RepoValidationError);
        await expect(decode("xz", [cut])).rejects.toThrow("xz: truncated stream");
    });

    test("Reports a corrupt gzip stream as a validation error", async () => {
        expect((await decode("gzip", [GZIP])).equals(TEXT)).toBe(true);
        await expect(decode("gzip", [corrupted(GZIP)])).rejects.toThrow(RepoValidationError);
        await expect(decode("gzip", [corrupted(GZIP)])).rejects.toThrow(/^gzip: /);
        await expect(decode("gzip", [Buffer.from("plain text, not gzip")])).rejects.toThrow("gzip: incorrect header check");
        await expect(decode("gzip", [GZIP.subarray(0, 20)])).rejects.toThrow(RepoValidationError);
        await expect(decode("gzip", [GZIP.subarray(0, 20)])).rejects.toThrow("gzip: unexpected end of file");
    });

    test("Reports a corrupt zstd stream as a validation error", async () => {
        expect((await decode("zstd", [ZSTD])).equals(TEXT)).toBe(true);
        await expect(decode("zstd", [corrupted(ZSTD)])).rejects.toThrow(RepoValidationError);
        await expect(decode("zstd", [corrupted(ZSTD)])).rejects.toThrow(/^zstd: /);
        await expect(decode("zstd", [Buffer.from("plain text, not zstd")])).rejects.toThrow("zstd: Unknown frame descriptor");
        await expect(decode("zstd", [ZSTD.subarray(0, 20)])).rejects.toThrow(RepoValidationError);
        await expect(decode("zstd", [ZSTD.subarray(0, 20)])).rejects.toThrow("zstd: unexpected end of file");
    });

    test.each(["gzip", "zstd"] as const)("Keeps an error injected into the %s decoder as it is", async (compression) => {
        const decoded = decompressor(compression);
        const injected = Object.assign(new Error("no such file"), { code: "ENOENT" });
        const failed = new Promise<unknown>(resolve => decoded.on("error", resolve));
        decoded.destroy(injected);
        expect(await failed).toBe(injected);
    });
});

describe("Tests for parseControl and formatStanza", () => {
    test("Round-trips a stanza with continuation lines", () => {
        const text = "Package: a\nDescription: short\n long line\n .\n more\n";
        expect(formatStanza(parseControl(text)[0])).toBe(text);
    });

    test("Keeps an empty first line of a multi-line value", () => {
        const text = "Files:\n 0123 10 a_1.deb\nSource: a\n";
        const stanza = parseControl(text)[0];
        expect(stanza).toEqual([["Files", "\n 0123 10 a_1.deb"], ["Source", "a"]]);
        expect(formatStanza(stanza)).toBe(text);
    });

    test("Splits stanzas at blank lines and normalizes CRLF", () => {
        const stanzas = parseControl("Package: a\r\nVersion: 1\r\n\r\n\r\nPackage: b\r\n");
        expect(stanzas).toEqual([[["Package", "a"], ["Version", "1"]], [["Package", "b"]]]);
        expect(parseControl("")).toEqual([]);
    });

    test("field is case-insensitive", () => {
        const stanza = parseControl("Package: a\nMulti-Arch: same\n")[0];
        expect(field(stanza, "multi-arch")).toBe("same");
        expect(field(stanza, "PACKAGE")).toBe("a");
        expect(field(stanza, "Version")).toBeUndefined();
    });

    test("Rejects a line without a field name", () => {
        expect(() => parseControl("Package: a\ngarbage\n")).toThrow(RepoValidationError);
        expect(() => parseControl(" continuation first\n")).toThrow(RepoValidationError);
    });
});

describe("Tests for stripClearsign", () => {
    test("Strips clearsign armor, CRLF and dash escapes", () => {
        const signed = "-----BEGIN PGP SIGNED MESSAGE-----\r\nHash: SHA512\r\n\r\nSource: a\r\n- -dash\r\n-----BEGIN PGP SIGNATURE-----\r\nx\r\n-----END PGP SIGNATURE-----\r\n";
        expect(stripClearsign(signed)).toBe("Source: a\n-dash\n");
    });

    test("Leaves an unsigned file alone apart from CRLF", () => {
        expect(stripClearsign("Source: a\r\nVersion: 1\r\n")).toBe("Source: a\nVersion: 1\n");
    });

    test("Rejects armor without a signature block", () => {
        expect(() => stripClearsign("-----BEGIN PGP SIGNED MESSAGE-----\n\nSource: a\n")).toThrow(RepoValidationError);
    });
});

describe("Tests for parseFileList", () => {
    test("Parses .changes Files with section and priority", () => {
        expect(parseFileList("\n 0123 10 utils optional a_1.deb", true))
            .toEqual([{ hash: "0123", size: 10, section: "utils", priority: "optional", name: "a_1.deb" }]);
    });

    test("Parses checksum lists without section and priority", () => {
        expect(parseFileList("\n 0123 10 a_1.deb\n 4567 20 a_1.dsc\n", false))
            .toEqual([{ hash: "0123", size: 10, name: "a_1.deb" }, { hash: "4567", size: 20, name: "a_1.dsc" }]);
        expect(parseFileList("", false)).toEqual([]);
    });

    test("Rejects malformed lines", () => {
        expect(() => parseFileList("\n 0123 ten a_1.deb", false)).toThrow(RepoValidationError);
        expect(() => parseFileList("\n 0123 10 a_1.deb", true)).toThrow(RepoValidationError);
    });
});
