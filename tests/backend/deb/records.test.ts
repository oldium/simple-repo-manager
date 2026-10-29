import { debWithControlTar, tarBytes, tarEntry, withLocalTmpDir } from "../../utils.ts";
import osPath from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import zlib from "zlib";
import { readArMembers } from "../../../server/backend/archive.ts";
import { compareKeys } from "../../../server/backend/chunked.ts";
import { field, parseControl, parseFileList, stripClearsign } from "../../../server/backend/control.ts";
import { hashFile } from "../../../server/backend/hash.ts";
import { inspectDeb, parseDsc } from "../../../server/backend/deb/inspect.ts";
import {
    binarySortKey, binarySource, KEY_SEP, poolDirectory, renderContentsLine, renderPackagesStanza, renderSourcesStanza, sourceSortKey,
} from "../../../server/backend/deb/stanzas.ts";
import { RepoValidationError } from "../../../server/lib/errors.ts";

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));

type Bundle = { dir: string; changes: string; component: string; golden: string };

const TRIXIE: Bundle = {
    dir: osPath.join(FIXTURES, "packages", "deb", "debian", "trixie", "main"),
    changes: "srm-hello_1.0-1_amd64.changes",
    component: "main",
    golden: osPath.join(FIXTURES, "golden", "deb", "debian", "dists", "trixie", "main"),
};
const NOBLE: Bundle = {
    dir: osPath.join(FIXTURES, "packages", "deb", "ubuntu", "noble", "universe"),
    changes: "srm-zst_3.0-1_amd64.changes",
    component: "universe",
    golden: osPath.join(FIXTURES, "golden", "deb", "ubuntu", "dists", "noble", "universe"),
};
const BOOKWORM: Bundle = {
    dir: osPath.join(FIXTURES, "packages", "deb", "debian", "bookworm", "main"),
    changes: "srm-gz_0.1-1_amd64.changes",
    component: "main",
    golden: osPath.join(FIXTURES, "golden", "deb", "debian", "dists", "bookworm", "main"),
};
const UDEB: Bundle = {
    dir: osPath.join(FIXTURES, "packages-udeb", "deb", "debian", "trixie", "main"),
    changes: "srm-hello-udeb_1.0-1_amd64.changes",
    component: "main",
    golden: osPath.join(FIXTURES, "golden", "udeb", "deb", "debian", "dists", "trixie", "main"),
};

const XZ_DEB = osPath.join(TRIXIE.dir, "srm-hello_1.0-1_amd64.deb");
const ZST_DEB = osPath.join(NOBLE.dir, "srm-zst_3.0-1_amd64.deb");
const DDEB = osPath.join(NOBLE.dir, "srm-zst-dbgsym_3.0-1_amd64.ddeb");
const GZ_DEB = osPath.join(BOOKWORM.dir, "srm-gz_0.1-1_amd64.deb");
const UDEB_FILE = osPath.join(UDEB.dir, "srm-hello-udeb_1.0-1_amd64.udeb");
const DSC = osPath.join(TRIXIE.dir, "srm-hello_1.0-1.dsc");

const MIB = 1024 * 1024;

const SHA256_A = "a".repeat(64);
const MD5_B = "b".repeat(32);

async function changesEntry(bundle: Bundle, name: string): Promise<{ source: string; section: string; priority: string }> {
    const changes = parseControl(stripClearsign(await fs.readFile(osPath.join(bundle.dir, bundle.changes), "utf8")))[0];
    const listed = parseFileList(field(changes, "Files")!, true).find(f => f.name === name)!;
    return { source: field(changes, "Source")!, section: listed.section!, priority: listed.priority! };
}

async function goldenStanza(file: string, pkg: string): Promise<string> {
    const found = (await fs.readFile(file, "utf8")).split("\n\n").find(s => s.startsWith(`Package: ${ pkg }\n`));
    if (found === undefined) {
        throw new Error(`${ pkg } is not in ${ file }`);
    }
    return `${ found }\n`;
}

function withoutWeakHashes(stanza: string): string {
    return stanza.split("\n").filter(line => !line.startsWith("SHA1: ") && !line.startsWith("SHA512: ")).join("\n");
}

function arArchive(members: [name: string, body: string | Buffer][]): Buffer {
    const parts = [Buffer.from("!<arch>\n")];
    for (const [name, body] of members) {
        const header = Buffer.alloc(60, " ");
        header.write(name, 0, "latin1");
        header.write(String(body.length), 48, "latin1");
        header.write("`\n", 58, "latin1");
        parts.push(header, typeof body === "string" ? Buffer.from(body) : body, Buffer.alloc(body.length % 2));
    }
    return Buffer.concat(parts);
}

describe("Tests for inspectDeb", () => {
    test("Reads control and paths of an xz deb", async () => {
        const i = await inspectDeb(XZ_DEB, true);
        expect(field(i.control, "Package")).toBe("srm-hello");
        expect(field(i.control, "Description")).toBe("Hello script");
        expect(i.paths).toContain("usr/bin/srm-hello");
        expect(i.paths.some(p => p.endsWith("/"))).toBe(false);
        expect(i.paths).toEqual(["usr/bin/srm-hello"]);
    });

    test("Reads a zstd ddeb and a gzip deb with a non-ASCII path", async () => {
        const ddeb = await inspectDeb(DDEB, true);
        expect(field(ddeb.control, "Package")).toBe("srm-zst-dbgsym");
        expect(field(ddeb.control, "Auto-Built-Package")).toBe("debug-symbols");
        expect(ddeb.paths).toEqual(["usr/lib/debug/.build-id/4a/1b2c3d.debug"]);
        const gz = await inspectDeb(GZ_DEB, true);
        expect(field(gz.control, "Package")).toBe("srm-gz");
        expect(gz.paths).toEqual(["usr/bin/srm-gz", "usr/share/srm-gz/naïve file"]);
    });

    test("Reads a udeb", async () => {
        const udeb = await inspectDeb(UDEB_FILE, true);
        expect(field(udeb.control, "Package")).toBe("srm-hello-udeb");
        expect(field(udeb.control, "Section")).toBe("debian-installer");
        expect(udeb.paths).toEqual(["usr/bin/srm-hello"]);
    });

    test("Leaves the data member unread when paths are not wanted", async () => {
        const i = await inspectDeb(ZST_DEB, false);
        expect(field(i.control, "Version")).toBe("2:3.0-1");
        expect(i.paths).toEqual([]);
    });

    test("Rejects a file that is not a deb", async () => {
        await expect(inspectDeb(DSC, true)).rejects.toStrictEqual(new RepoValidationError("srm-hello_1.0-1.dsc is not an ar archive"));
    });

    test("Rejects a deb without a control member", withLocalTmpDir(async () => {
        await fs.mkdir("staged");
        await fs.writeFile(osPath.join("staged", "bare.deb"), arArchive([["debian-binary", "2.0\n"]]));
        await expect(inspectDeb(osPath.join("staged", "bare.deb"), false)).rejects.toStrictEqual(new RepoValidationError("bare.deb: no control.tar member"));
    }));

    test("Rejects a deb with an empty control member", withLocalTmpDir(async () => {
        await fs.mkdir("staged");
        await fs.writeFile(osPath.join("staged", "empty.deb"), arArchive([["debian-binary", "2.0\n"], ["control.tar.xz", ""]]));
        await expect(inspectDeb(osPath.join("staged", "empty.deb"), false)).rejects.toStrictEqual(new RepoValidationError("empty.deb: control.tar.xz is empty"));
    }));

    test("Rejects a deb whose control member has no control file", withLocalTmpDir(async () => {
        await fs.mkdir("staged");
        await fs.writeFile(osPath.join("staged", "nocontrol.deb"), arArchive([["debian-binary", "2.0\n"], ["control.tar", "\0".repeat(1024)]]));
        await expect(inspectDeb(osPath.join("staged", "nocontrol.deb"), false))
            .rejects.toStrictEqual(new RepoValidationError("nocontrol.deb: control.tar has no control file"));
    }));

    test.each([
        ["xz", XZ_DEB, "srm-hello"],
        ["gzip", GZ_DEB, "srm-gz"],
        ["zstd", ZST_DEB, "srm-zst"],
    ])("Reports a corrupt %s data member and still reads the control", (_, deb, pkg) => withLocalTmpDir(async () => {
        const bytes = await fs.readFile(deb);
        const data = (await readArMembers(deb)).find(m => m.name.startsWith("data.tar"))!;
        bytes[data.offset + Math.floor(data.size / 2)] ^= 0xff;
        await fs.writeFile("corrupt.deb", bytes);
        await expect(inspectDeb("corrupt.deb", true)).rejects.toThrow(RepoValidationError);
        await expect(inspectDeb("corrupt.deb", true)).rejects.toThrow(new RegExp(`^corrupt\\.deb: ${ data.name }: `));
        expect(field((await inspectDeb("corrupt.deb", false)).control, "Package")).toBe(pkg);
    })());

    test.each([
        ["xz", XZ_DEB],
        ["gzip", GZ_DEB],
        ["zstd", ZST_DEB],
    ])("Names the file for a corrupt %s control member", (_, deb) => withLocalTmpDir(async () => {
        const bytes = await fs.readFile(deb);
        const control = (await readArMembers(deb)).find(m => m.name.startsWith("control.tar"))!;
        bytes[control.offset + Math.floor(control.size / 2)] ^= 0xff;
        await fs.writeFile("corrupt.deb", bytes);
        await expect(inspectDeb("corrupt.deb", false)).rejects.toThrow(new RegExp(`^corrupt\\.deb: ${ control.name }: `));
    })());

    test("Names the file for a control file that does not parse", withLocalTmpDir(async () => {
        await fs.writeFile("bad.deb", debWithControlTar(tarBytes(tarEntry("./control", "garbage without a colon\n"))));
        await expect(inspectDeb("bad.deb", false)).rejects.toStrictEqual(new RepoValidationError("bad.deb: control.tar: Malformed control line: garbage without a colon"));
    }));

    test("Refuses a control member with a pax header over 1 MiB", withLocalTmpDir(async () => {
        await fs.writeFile("bomb.deb", debWithControlTar(tarBytes(tarEntry("./PaxHeaders/x", "1".repeat(MIB + 1), "x"), tarEntry("./control", "Package: a\n"))));
        await expect(inspectDeb("bomb.deb", false)).rejects
            .toStrictEqual(new RepoValidationError(`bomb.deb: control.tar: tar entry "./PaxHeaders/x" holds ${ MIB + 1 } bytes, over the ${ MIB } limit`));
    }));

    test("Refuses a control file over 16 MiB", withLocalTmpDir(async () => {
        await fs.writeFile("bomb.deb", debWithControlTar(tarBytes(tarEntry("./control", "a".repeat(16 * MIB + 1)))));
        await expect(inspectDeb("bomb.deb", false)).rejects
            .toStrictEqual(new RepoValidationError(`bomb.deb: control.tar: tar entry "control" holds ${ 16 * MIB + 1 } bytes, over the ${ 16 * MIB } limit`));
    }));

    // Reaching the limit takes 256 MiB of strings: 0.8 s alone, up to 12 s in a busy worker
    test("Refuses a data member whose paths would take too much memory", withLocalTmpDir(async () => {
        // Concatenated gzip members: 260 entries with a 1 MiB name each, in a file of a few hundred KiB
        const entry = zlib.gzipSync(Buffer.concat([tarEntry("././@LongLink", "n".repeat(MIB), "L"), tarEntry("short", "")]));
        await fs.writeFile("bomb.deb", arArchive([
            ["debian-binary", "2.0\n"],
            ["control.tar", tarBytes(tarEntry("./control", "Package: a\n"))],
            ["data.tar.gz", Buffer.concat(Array<Buffer>(260).fill(entry))],
        ]));
        await expect(inspectDeb("bomb.deb", true)).rejects
            .toStrictEqual(new RepoValidationError(`bomb.deb: data.tar.gz: paths take more than ${ 256 * MIB } bytes`));
    }), 60000);
});

describe("Tests for parseDsc", () => {
    test("parseDsc merges checksum lists", async () => {
        const { stanza, files } = parseDsc(await fs.readFile(DSC, "utf8"));
        expect(field(stanza, "Source")).toBe("srm-hello");
        expect(field(stanza, "Version")).toBe("1.0-1");
        expect([...files.keys()]).toEqual(["srm-hello_1.0.orig.tar.gz", "srm-hello_1.0-1.debian.tar.xz"]);
        expect(files.get("srm-hello_1.0.orig.tar.gz")).toEqual({
            size: 207,
            md5: "e089e9fcd5c1d0c4cc34ae95017c1944",
            sha1: "86d7855c7654130232bafa58a1145511660f5666",
            sha256: "100eef9101cda6638eab211e57c90f95b3ebbef9442dee06d762537059c6f88c",
        });
        expect(files.get("srm-hello_1.0-1.debian.tar.xz")?.size).toBe(1016);
    });

    test("Strips the clearsign armor", async () => {
        const text = await fs.readFile(DSC, "utf8");
        const signed = `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\n${ text }-----BEGIN PGP SIGNATURE-----\n\nabc\n-----END PGP SIGNATURE-----\n`;
        expect(parseDsc(signed)).toEqual(parseDsc(text));
    });

    test("Rejects a size that differs between lists", () => {
        const text = `Source: a\nVersion: 1\nChecksums-Sha256:\n ${ SHA256_A } 11 a_1.tar.gz\nFiles:\n ${ MD5_B } 10 a_1.tar.gz\n`;
        expect(() => parseDsc(text)).toThrow(RepoValidationError);
        expect(() => parseDsc(text)).toThrow(/a_1\.tar\.gz/);
    });

    test("Rejects a checksum for a file that Files does not list", () => {
        const text = `Source: a\nVersion: 1\nChecksums-Sha256:\n ${ SHA256_A } 10 b_1.tar.gz\nFiles:\n ${ MD5_B } 10 a_1.tar.gz\n`;
        expect(() => parseDsc(text)).toThrow(RepoValidationError);
    });

    test("Rejects a dsc without Files or with several stanzas", () => {
        expect(() => parseDsc("Source: a\nVersion: 1\n")).toThrow(RepoValidationError);
        expect(() => parseDsc(`Source: a\nFiles:\n ${ MD5_B } 10 a_1.tar.gz\n\nSource: b\n`)).toThrow(RepoValidationError);
        expect(() => parseDsc("")).toThrow(RepoValidationError);
    });
});

describe("Tests for the stanza renderers", () => {
    test.each([
        ["srm-hello_1.0-1_amd64.deb", TRIXIE, "binary-amd64"],
        ["srm-hello-doc_1.0-1_all.deb", TRIXIE, "binary-amd64"],
        ["srm-zst_3.0-1_amd64.deb", NOBLE, "binary-amd64"],
        ["srm-zst-dbgsym_3.0-1_amd64.ddeb", NOBLE, "debug/binary-amd64"],
        ["srm-gz_0.1-1_amd64.deb", BOOKWORM, "binary-amd64"],
        ["srm-hello-udeb_1.0-1_amd64.udeb", UDEB, "debian-installer/binary-amd64"],
    ])("Packages stanza of %s equals reprepro output without SHA1/SHA512", async (name, bundle, index) => {
        const file = osPath.join(bundle.dir, name);
        const { control } = await inspectDeb(file, false);
        const digests = await hashFile(file);
        const entry = await changesEntry(bundle, name);
        const filename = `${ poolDirectory(bundle.component, entry.source) }/${ name }`;
        const stanza = renderPackagesStanza(control, { filename, size: digests.size, md5: digests.md5, sha256: digests.sha256 }, entry);
        const golden = await goldenStanza(osPath.join(bundle.golden, ...index.split("/"), "Packages"), field(control, "Package")!);
        expect(stanza).toBe(withoutWeakHashes(golden));
    });

    test("Packages stanza replaces stale index fields and keeps fields after Description", () => {
        const control = parseControl("Package: a\nSection: old\nVersion: 1\nFilename: stale\nPriority: old\nDescription: d\n x\nBuild-Ids: 1\n")[0];
        const file = { filename: "pool/main/a/a/a_1_amd64.deb", size: 10, md5: MD5_B, sha256: SHA256_A };
        expect(renderPackagesStanza(control, file, { section: "utils", priority: "optional" })).toBe(
            `Package: a\nVersion: 1\nPriority: optional\nSection: utils\nFilename: ${ file.filename }\nSize: 10\nSHA256: ${ SHA256_A }\nMD5sum: ${ MD5_B }\nDescription: d\n x\nBuild-Ids: 1\n`);
        const noDescription = parseControl("Package: a\nVersion: 1\n")[0];
        expect(renderPackagesStanza(noDescription, file, { section: "utils", priority: "optional" }))
            .toBe(`Package: a\nVersion: 1\nPriority: optional\nSection: utils\nFilename: ${ file.filename }\nSize: 10\nSHA256: ${ SHA256_A }\nMD5sum: ${ MD5_B }\n`);
    });

    test.each([
        ["srm-hello_1.0-1.dsc", TRIXIE],
        ["srm-zst_3.0-1.dsc", NOBLE],
        ["srm-gz_0.1-1.dsc", BOOKWORM],
    ])("Sources stanza of %s equals reprepro output", async (name, bundle) => {
        const file = osPath.join(bundle.dir, name);
        const { stanza } = parseDsc(await fs.readFile(file, "utf8"));
        const entry = await changesEntry(bundle, name);
        const rendered = renderSourcesStanza(stanza, { name, ...await hashFile(file) }, poolDirectory(bundle.component, entry.source), entry);
        expect(rendered).toBe(await goldenStanza(osPath.join(bundle.golden, "source", "Sources"), entry.source));
    });

    test("Sources stanza rejects a dsc without Source or with an empty one", async () => {
        const digests = { name: "a_1.dsc", ...await hashFile(DSC) };
        const sp = { section: "misc", priority: "optional" };
        const missing = parseControl("Format: 3.0 (quilt)\nVersion: 1\nFiles:\n a 1 a_1.tar.gz\n")[0];
        expect(() => renderSourcesStanza(missing, digests, "pool/main/a/a", sp)).toThrow(RepoValidationError);
        const empty = parseControl("Source:\nFormat: 3.0 (quilt)\nVersion: 1\nFiles:\n a 1 a_1.tar.gz\n")[0];
        expect(() => renderSourcesStanza(empty, digests, "pool/main/a/a", sp)).toThrow(RepoValidationError);
    });

    test("Pool directory uses the lib prefix", () => {
        expect(poolDirectory("main", "libfoo")).toBe("pool/main/libf/libfoo");
        expect(poolDirectory("main", "lib")).toBe("pool/main/l/lib");
        expect(poolDirectory("main/sub", "srm-hello")).toBe("pool/main/sub/s/srm-hello");
        expect(() => poolDirectory("main", "")).toThrow(RepoValidationError);
    });

    test("binarySource strips the version suffix and falls back to Package and Version", async () => {
        expect(binarySource(parseControl("Package: a\nSource: src\nVersion: 1.0-1\n")[0])).toEqual({ source: "src", version: "1.0-1" });
        expect(binarySource(parseControl("Package: a\nSource: src (1.2-1)\nVersion: 1.2-1+b1\n")[0])).toEqual({ source: "src", version: "1.2-1" });
        expect(binarySource(parseControl("Package: a\nVersion: 2\n")[0])).toEqual({ source: "a", version: "2" });
        expect(binarySource(parseControl("Package: a\nSource:\nVersion: 2\n")[0])).toEqual({ source: "a", version: "2" });
        expect(binarySource((await inspectDeb(DDEB, false)).control)).toEqual({ source: "srm-zst", version: "2:3.0-1" });
        expect(() => binarySource(parseControl("Package: a\nSource: src (1.2\nVersion: 2\n")[0])).toThrow(RepoValidationError);
        expect(() => binarySource(parseControl("Package: a\nSource: (1.2)\nVersion: 2\n")[0])).toThrow(RepoValidationError);
        expect(() => binarySource(parseControl("Source:\nVersion: 2\n")[0])).toThrow(RepoValidationError);
        expect(() => binarySource(parseControl("Package: a\nSource: src\n")[0])).toThrow(RepoValidationError);
    });

    test("Epoch stays in Version but not in Filename", async () => {
        const name = osPath.basename(ZST_DEB);
        const { control } = await inspectDeb(ZST_DEB, false);
        const filename = `${ poolDirectory("universe", "srm-zst") }/${ name }`;
        const stanza = renderPackagesStanza(control, { filename, size: 598, md5: MD5_B, sha256: SHA256_A }, { section: "utils", priority: "standard" });
        expect(stanza).toContain("\nVersion: 2:3.0-1\n");
        expect(stanza).toContain("\nFilename: pool/universe/s/srm-zst/srm-zst_3.0-1_amd64.deb\n");
        expect(binarySortKey("srm-zst", "srm-zst", field(control, "Version")!, "amd64")).toBe(`srm-zst${ KEY_SEP }srm-zst${ KEY_SEP }2:3.0-1${ KEY_SEP }amd64`);
    });

    test("Sort keys group by source and join with KEY_SEP", () => {
        expect(KEY_SEP).toBe("\u0001");
        expect(binarySortKey("srm-hello", "srm-hello-doc", "1.0-1", "all")).toBe("srm-hello\u0001srm-hello-doc\u00011.0-1\u0001all");
        expect(sourceSortKey("srm-hello", "1.0-1")).toBe("srm-hello\u00011.0-1");
        const keys = [
            binarySortKey("zlib", "zlib1g", "1", "amd64"),
            binarySortKey("srm-hello", "srm-hello-doc", "1.0-1", "all"),
            binarySortKey("srm-hello", "srm-hello", "1.0-1", "amd64"),
            binarySortKey("srm-hello-doc", "srm-hello-doc", "0.9", "all"),
        ];
        expect([...keys].sort(compareKeys)).toEqual([keys[2], keys[1], keys[3], keys[0]]);
    });

    test("Contents line matches the golden format", async () => {
        expect(renderContentsLine("usr/bin/x", ["a/x", "b/y"])).toBe("usr/bin/x\t    a/x,b/y\n");
        const { control, paths } = await inspectDeb(GZ_DEB, true);
        const qualified = [`${ field(control, "Section") }/${ field(control, "Package") }`];
        const contents = [...paths].sort(compareKeys).map(p => renderContentsLine(p, qualified)).join("");
        expect(contents).toBe(await fs.readFile(osPath.join(BOOKWORM.golden, "Contents-amd64"), "utf8"));
    });
});
