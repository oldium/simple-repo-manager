import { withLocalTmpDir } from "../../utils.ts";
import { jest } from "@jest/globals";
import osPath from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { hashFile } from "../../../server/backend/hash.ts";
import { parseSourceRpmName, readRpmHeader } from "../../../server/backend/rpm/header.ts";
import type { RpmDep, RpmHeader } from "../../../server/backend/rpm/header.ts";
import { readRpm } from "../../../server/backend/rpm/inputs.ts";
import type { RpmPackageInput } from "../../../server/backend/rpm/catalog.ts";
import {
    CHANGELOG_LIMIT, compareRpmVersions, renderFilelistsPackage, renderOtherPackage, renderPrimaryPackage, renderRepomd, xmlFooter, xmlHeader,
} from "../../../server/backend/rpm/xml.ts";
import type { RpmMeta } from "../../../server/backend/rpm/xml.ts";
import { RepoValidationError } from "../../../server/lib/errors.ts";

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const RPMS = osPath.join(FIXTURES, "packages", "rpm", "fedora", "42");
const GOLDEN = osPath.join(FIXTURES, "golden", "rpm", "fedora", "42", "repodata");
const SRC_RPM = osPath.join(RPMS, "srm-hello-1.0-1.fc42.src.rpm");
const BIN_RPM = osPath.join(RPMS, "srm-hello-1.0-1.fc42.x86_64.rpm");
const DOC_RPM = osPath.join(RPMS, "srm-hello-doc-1.0-1.fc42.noarch.rpm");

type Kind = "primary" | "filelists" | "other";

// Header data types and a few tags, as rpmtag.h numbers them
const INT16 = 3;
const INT32 = 4;
const INT64 = 5;
const STRING = 6;
const STRING_ARRAY = 8;
const I18NSTRING = 9;

type Entry = [tag: number, type: number, value: number[] | string[]];

const BASE: Entry[] = [
    [1000, STRING, ["a"]], [1001, STRING, ["1"]], [1002, STRING, ["2"]], [1022, STRING, ["x86_64"]], [1044, STRING, ["a-1-2.src.rpm"]],
];

function headerBlob(entries: Entry[]): Buffer {
    const index: Buffer[] = [];
    const data: Buffer[] = [];
    let offset = 0;
    for (const [tag, type, value] of entries) {
        const width = type === INT16 ? 2 : type === INT32 ? 4 : type === INT64 ? 8 : 1;
        const pad = (width - offset % width) % width;
        data.push(Buffer.alloc(pad));
        offset += pad;
        let body: Buffer;
        if (width === 1) {
            body = Buffer.from((value as string[]).map(s => `${ s }\0`).join(""));
        } else {
            body = Buffer.alloc(width * value.length);
            (value as number[]).forEach((n, i) => width === 8 ? body.writeBigUInt64BE(BigInt(n), 8 * i) : body.writeUIntBE(n, width * i, width));
        }
        const entry = Buffer.alloc(16);
        entry.writeUInt32BE(tag, 0);
        entry.writeUInt32BE(type, 4);
        entry.writeUInt32BE(offset, 8);
        entry.writeUInt32BE(value.length, 12);
        index.push(entry);
        data.push(body);
        offset += body.length;
    }
    const intro = Buffer.from([0x8e, 0xad, 0xe8, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    intro.writeUInt32BE(entries.length, 8);
    intro.writeUInt32BE(offset, 12);
    return Buffer.concat([intro, ...index, ...data]);
}

function rpmFile(main: Entry[], sig: Entry[] = [[1007, INT32, [100]]]): Buffer {
    const lead = Buffer.alloc(96);
    lead.set([0xed, 0xab, 0xee, 0xdb, 3, 0]);
    const signature = headerBlob(sig);
    return Buffer.concat([lead, signature, Buffer.alloc((8 - signature.length % 8) % 8), headerBlob(main), Buffer.from("payload")]);
}

async function synthetic(main: Entry[], sig?: Entry[]): Promise<RpmHeader> {
    await fs.writeFile("synthetic.rpm", rpmFile(main, sig));
    return readRpmHeader("synthetic.rpm");
}

async function goldenParts(kind: Kind): Promise<{ header: string; packages: string[]; footer: string }> {
    const text = await fs.readFile(osPath.join(GOLDEN, `${ kind }.xml`), "utf8");
    const start = text.indexOf("<package ");
    const end = text.lastIndexOf("</package>\n") + "</package>\n".length;
    const packages = text.slice(start, end).split("</package>\n").filter(p => p.length > 0).map(p => `${ p }</package>\n`);
    return { header: text.slice(0, start), packages, footer: text.slice(end) };
}

/** Replaces the value between the first marker and the terminator following it */
function replaceValue(text: string, marker: string, terminator: string, value: string): string {
    const at = text.indexOf(marker);
    if (at < 0) {
        throw new Error(`${ marker } not found`);
    }
    const from = at + marker.length;
    return `${ text.slice(0, from) }${ value }${ text.slice(text.indexOf(terminator, from)) }`;
}

async function metaOf(file: string): Promise<RpmMeta> {
    const [header, digests, stat] = await Promise.all([readRpmHeader(file), hashFile(file), fs.stat(file)]);
    return { ...header, pkgid: digests.sha256, size: digests.size, mtime: Math.floor(stat.mtimeMs / 1000), href: `Packages/s/srm-hello/${ osPath.basename(file) }` };
}

function dep(name: string, flags = 0, version?: string): RpmDep {
    return version === undefined ? { name, flags } : { name, flags, version };
}

function file(path: string, type: RpmMeta["files"][number]["type"] = "file"): RpmMeta["files"][number] {
    return { path, type };
}

function meta(o: Partial<RpmMeta> = {}): RpmMeta {
    return {
        name: "a", epoch: 0, version: "1", release: "2", arch: "x86_64", isSource: false, sourceRpm: "a-1-2.src.rpm",
        summary: "s", description: "d", packager: "", url: "", buildTime: 1, buildHost: "h", license: "MIT", vendor: "", group: "g",
        installedSize: 3, archiveSize: 4, headerStart: 5, headerEnd: 6,
        provides: [], requires: [], conflicts: [], obsoletes: [], recommends: [], suggests: [], supplements: [], enhances: [],
        files: [], changelogs: [], pkgid: "0".repeat(64), size: 7, mtime: 8, href: "Packages/a/a/a-1-2.x86_64.rpm", ...o,
    };
}

/** Trimmed lines between <element> and </element>, [] when the element is absent */
function block(xml: string, element: string): string[] {
    const start = xml.indexOf(`<${ element }>`);
    if (start < 0) {
        return [];
    }
    return xml.slice(start, xml.indexOf(`</${ element }>`)).split("\n").slice(1, -1).map(line => line.trim());
}

function changelogs(xml: string): string[] {
    return xml.split("\n").filter(line => line.startsWith("  <changelog ")).map(line => line.trim());
}

describe("Tests for readRpmHeader", () => {
    test("Reads NEVRA, source rpm and header range", async () => {
        const h = await readRpmHeader(BIN_RPM);
        expect([h.name, h.epoch, h.version, h.release, h.arch]).toEqual(["srm-hello", 0, "1.0", "1.fc42", "x86_64"]);
        expect(h.isSource).toBe(false);
        expect(h.sourceRpm).toBe("srm-hello-1.0-1.fc42.src.rpm");
        expect(h.headerStart).toBeGreaterThan(96);
        expect([h.headerStart, h.headerEnd]).toEqual([4504, 7901]);
        expect([h.installedSize, h.archiveSize]).toEqual([40, 432]);
        expect([h.summary, h.description, h.url, h.license, h.group, h.buildHost, h.buildTime])
            .toEqual(["Hello script", "Hello script.", "https://example.com/srm-hello", "MIT", "Unspecified", "srm.example.com", 1793181600]);
        expect([h.packager, h.vendor]).toEqual(["", ""]);
        expect(h.provides.map(d => [d.name, d.flags & 0xf, d.version])).toEqual([
            ["config(srm-hello)", 8, "1.0-1.fc42"], ["srm-greeter", 8, "0.9"], ["srm-hello", 8, "1.0-1.fc42"], ["srm-hello(x86-64)", 8, "1.0-1.fc42"],
        ]);
        expect(h.obsoletes).toEqual([{ name: "srm-greet", flags: 2, version: "0.9" }]);
        expect(h.conflicts).toEqual([]);
        expect(h.changelogs).toHaveLength(12);
        expect(h.changelogs[0]).toEqual({ author: "SRM <srm@example.com> - 1.0-1", date: 1764590400, text: "- Change 12" });
    });

    test("Source rpm reports arch src", async () => {
        const h = await readRpmHeader(SRC_RPM);
        expect([h.name, h.version, h.release, h.arch, h.isSource, h.sourceRpm]).toEqual(["srm-hello", "1.0", "1.fc42", "src", true, ""]);
        expect([h.headerStart, h.headerEnd, h.installedSize, h.archiveSize]).toEqual([4504, 8764, 2003, 2628]);
        expect(h.files).toEqual([
            { path: "README", type: "file" }, { path: "srm-hello", type: "file" }, { path: "srm-hello.conf", type: "file" }, { path: "srm-hello.spec", type: "file" },
        ]);
        expect(h.provides.map(d => d.name)).toEqual(["srm-hello", "srm-hello-doc"]);
        expect(h.requires.every(d => d.name.startsWith("rpmlib("))).toBe(true);
        const doc = await readRpmHeader(DOC_RPM);
        expect([doc.name, doc.arch, doc.isSource, doc.sourceRpm]).toEqual(["srm-hello-doc", "noarch", false, "srm-hello-1.0-1.fc42.src.rpm"]);
        expect([doc.headerEnd, doc.installedSize, doc.archiveSize]).toEqual([7273, 24, 296]);
    });

    test("Files carry dir and ghost types; Requires(pre) and Recommends are read", withLocalTmpDir(async () => {
        const h = await readRpmHeader(BIN_RPM);
        expect(h.files).toEqual([
            { path: "/etc/srm-hello.conf", type: "file" }, { path: "/usr/bin/srm-hello", type: "file" }, { path: "/var/log/srm-hello.log", type: "ghost" },
        ]);
        const named = (name: string) => h.requires.filter(d => d.name === name);
        expect(named("shadow-utils").map(d => d.flags & 0x6e0)).toEqual([0x200, 0x400]);
        expect(named("coreutils").map(d => d.flags & 0x1000)).toEqual([0x1000]);
        expect(named("bash")).toEqual([{ name: "bash", flags: 0 }]);
        expect(h.requires.some(d => d.name.startsWith("rpmlib("))).toBe(true);
        expect(h.recommends.map(d => [d.name, d.flags & 0xf, d.version])).toEqual([["srm-hello-doc", 8, "1.0-1.fc42"]]);
        const s = await synthetic([
            ...BASE, [1003, INT32, [2]], [1118, STRING_ARRAY, ["/etc/", "/usr/"]], [1117, STRING_ARRAY, ["a", "bin"]], [1116, INT32, [0, 1]],
            [1030, INT16, [0o100644, 0o040755]], [1037, INT32, [64, 0]],
        ]);
        expect(s.epoch).toBe(2);
        expect(s.files).toEqual([{ path: "/etc/a", type: "ghost" }, { path: "/usr/bin", type: "dir" }]);
    }));

    test("Reads sizes from the long tags, the signature and the v6 header", withLocalTmpDir(async () => {
        const long = await synthetic([...BASE, [5009, INT64, [5000000000]], [1009, INT32, [1]]], [[271, INT64, [6000000000]], [1007, INT32, [2]]]);
        expect([long.installedSize, long.archiveSize]).toEqual([5000000000, 6000000000]);
        const v6 = await synthetic([...BASE, [1009, INT32, [7]], [5113, INT64, [8]]], []);
        expect([v6.installedSize, v6.archiveSize]).toEqual([7, 8]);
        const none = await synthetic(BASE, []);
        expect([none.installedSize, none.archiveSize, none.epoch, none.buildTime]).toEqual([0, 0, 0, 0]);
        expect([none.summary, none.description, none.packager, none.url, none.license, none.vendor, none.group, none.buildHost])
            .toEqual(["", "", "", "", "", "", "", ""]);
        expect([none.files, none.changelogs, none.provides, none.requires]).toEqual([[], [], [], []]);
    }));

    test("Takes the first string of I18N tags and maps legacy weak dependencies", withLocalTmpDir(async () => {
        const h = await synthetic([
            ...BASE, [1004, I18NSTRING, ["Summary", "Zusammenfassung"]], [1016, I18NSTRING, ["Group"]],
            [1156, STRING_ARRAY, ["weak", "strong"]], [1157, STRING_ARRAY, ["", "1"]], [1158, INT32, [0, 8 | (1 << 27)]],
            [1159, STRING_ARRAY, ["enh", "sup"]], [1160, STRING_ARRAY, ["", ""]], [1161, INT32, [0, 1 << 27]],
            [5046, STRING_ARRAY, ["rec"]], [5047, STRING_ARRAY, ["2"]], [5048, INT32, [12]],
        ]);
        expect([h.summary, h.group]).toEqual(["Summary", "Group"]);
        expect(h.suggests).toEqual([{ name: "weak", flags: 0 }]);
        expect(h.recommends).toEqual([{ name: "rec", flags: 12, version: "2" }, { name: "strong", flags: 8 | (1 << 27), version: "1" }]);
        expect(h.enhances).toEqual([{ name: "enh", flags: 0 }]);
        expect(h.supplements).toEqual([{ name: "sup", flags: 1 << 27 }]);
        const source = await synthetic(BASE.slice(0, 4).concat([[1106, INT32, [1]]]));
        expect([source.isSource, source.arch, source.sourceRpm]).toEqual([true, "src", ""]);
    }));

    test("Rejects files that are not rpm packages or have a damaged header", withLocalTmpDir(async () => {
        await fs.writeFile("tiny.rpm", "short");
        await expect(readRpmHeader("tiny.rpm")).rejects.toThrow(RepoValidationError);
        await fs.mkdir("staged");
        await fs.writeFile(osPath.join("staged", "text.rpm"), "not an rpm package at all, just text that is longer than the lead\n".repeat(3));
        await expect(readRpmHeader(osPath.join("staged", "text.rpm"))).rejects.toStrictEqual(new RepoValidationError("text.rpm is not an rpm package"));
        const whole = rpmFile(BASE);
        await fs.writeFile(osPath.join("staged", "short.rpm"), whole.subarray(0, whole.length - 20));
        await expect(readRpmHeader(osPath.join("staged", "short.rpm"))).rejects.toStrictEqual(new RepoValidationError("short.rpm: truncated header"));
        const magic = rpmFile(BASE);
        magic[96] = 0;
        await fs.writeFile("magic.rpm", magic);
        await expect(readRpmHeader("magic.rpm")).rejects.toThrow(RepoValidationError);
        await fs.writeFile(osPath.join("staged", "noname.rpm"), rpmFile(BASE.slice(1)));
        await expect(readRpmHeader(osPath.join("staged", "noname.rpm"))).rejects.toStrictEqual(new RepoValidationError("noname.rpm: header has no NAME"));
        await fs.writeFile("dirindex.rpm", rpmFile([...BASE, [1118, STRING_ARRAY, ["/"]], [1117, STRING_ARRAY, ["a"]], [1116, INT32, [3]]]));
        await expect(readRpmHeader("dirindex.rpm")).rejects.toThrow(RepoValidationError);
        const huge = rpmFile(BASE, []).subarray(0, 96 + 16);
        huge.writeUInt32BE(200 * 1024 * 1024, 96 + 12);
        await fs.writeFile("huge.rpm", huge);
        const alloc = jest.spyOn(Buffer, "alloc");
        try {
            await expect(readRpmHeader("huge.rpm")).rejects.toThrow(/truncated signature header/);
            expect(alloc.mock.calls.length).toBeGreaterThan(0);
            expect(alloc.mock.calls.filter(([size]) => size >= 200 * 1024 * 1024)).toEqual([]);
        } finally {
            alloc.mockRestore();
        }
    }));

    describe("Headers that decode to far more than they store", () => {
        const MIB = 1024 * 1024;
        const LIMIT = 64 * MIB;
        const INT8 = 2;
        const REFUSED = new RepoValidationError(`synthetic.rpm: header decodes to more than ${ LIMIT } bytes`);
        const EMPTIES = Array<string>(3 * MIB).fill("");

        /** The error reading the rpm ends with; a failing test does not print a huge header */
        function refusal(file: Buffer): Promise<unknown> {
            return fs.writeFile("synthetic.rpm", file).then(() => readRpmHeader("synthetic.rpm")).then(() => undefined, (err: unknown) => err);
        }

        test("Refuses millions of empty strings in one list", withLocalTmpDir(async () => {
            expect(await refusal(rpmFile([...BASE, [1049, STRING_ARRAY, EMPTIES]]))).toStrictEqual(REFUSED);
        }));

        test("Refuses millions of one-byte numbers", withLocalTmpDir(async () => {
            expect(await refusal(rpmFile([...BASE, [1116, INT8, EMPTIES]]))).toStrictEqual(REFUSED);
        }));

        test("Refuses tags that all decode the same store", withLocalTmpDir(async () => {
            const store = MIB / 2;
            const tags = [1004, 1005, 1007, 1011, 1014, 1015, 1016, 1020];
            const main: Entry[] = [...BASE, ...tags.map((tag): Entry => [tag, STRING_ARRAY, [""]]), [1047, STRING_ARRAY, Array<string>(store).fill("")]];
            const bytes = rpmFile(main);
            // Lead, then a signature header of one entry padded to 8 bytes
            const index = 96 + 40 + 16;
            const source = index + 16 * (main.length - 1);
            for (let row = BASE.length; row < main.length - 1; row++) {
                bytes.writeUInt32BE(bytes.readUInt32BE(source + 8), index + 16 * row + 8);
                bytes.writeUInt32BE(store, index + 16 * row + 12);
            }
            expect(await refusal(bytes)).toStrictEqual(REFUSED);
        }));

        test("Refuses a long directory name repeated in every path", withLocalTmpDir(async () => {
            const dir = `/${ "d".repeat(MIB - 2) }/`;
            const count = 65;
            const main: Entry[] = [...BASE, [1118, STRING_ARRAY, [dir]], [1117, STRING_ARRAY, Array<string>(count).fill("f")], [1116, INT32, Array<number>(count).fill(0)]];
            expect(await refusal(rpmFile(main))).toStrictEqual(REFUSED);
        }));

        test("Refuses strings within the limit that together decode too much", withLocalTmpDir(async () => {
            expect(await refusal(rpmFile([...BASE, [1047, STRING_ARRAY, Array<string>(65).fill("x".repeat(MIB))]]))).toStrictEqual(REFUSED);
        }));

        test.each<[string, number, number]>([
            ["Provides name", 1047, STRING_ARRAY], ["file name", 1117, STRING_ARRAY], ["directory name", 1118, STRING_ARRAY],
            ["changelog text", 1082, STRING_ARRAY], ["description", 1005, I18NSTRING], ["vendor", 1011, STRING],
        ])("Refuses a %s over 1 MiB", (_, tag, type) => withLocalTmpDir(async () => {
            expect(await refusal(rpmFile([...BASE, [tag, type, ["&".repeat(MIB + 1)]]])))
                .toStrictEqual(new RepoValidationError(`synthetic.rpm: header tag ${ tag } holds a string of ${ MIB + 1 } bytes, over the ${ MIB } limit`));
        })());

        test("Reads a string of exactly 1 MiB", withLocalTmpDir(async () => {
            const name = "&".repeat(MIB);
            const h = await synthetic([...BASE, [1047, STRING_ARRAY, [name]], [1112, INT32, [0]], [1113, STRING_ARRAY, [""]]]);
            expect(h.provides).toHaveLength(1);
            expect(h.provides[0].name === name).toBe(true);
        }));

        test("Reads a package with 200,000 files", withLocalTmpDir(async () => {
            const count = 200000;
            const h = await synthetic([
                ...BASE, [1118, STRING_ARRAY, ["/usr/share/doc/some-package/html/reference/"]], [1117, STRING_ARRAY, Array.from({ length: count }, (_, i) => `page-${ i }.html`)],
                [1116, INT32, Array<number>(count).fill(0)], [1030, INT16, Array<number>(count).fill(0o100644)], [1037, INT32, Array<number>(count).fill(0)],
            ]);
            expect(h.files).toHaveLength(count);
            expect(h.files[count - 1].path).toBe(`/usr/share/doc/some-package/html/reference/page-${ count - 1 }.html`);
        }));
    });

    test("parseSourceRpmName splits name, version, release", () => {
        expect(parseSourceRpmName("clevis-dracut-22-1.fc42.src.rpm")).toEqual({ name: "clevis-dracut", version: "22", release: "1.fc42" });
        expect(parseSourceRpmName("srm-hello-1.0-1.fc42.src.rpm")).toEqual({ name: "srm-hello", version: "1.0", release: "1.fc42" });
        expect(parseSourceRpmName("a-1-2.nosrc.rpm")).toEqual({ name: "a", version: "1", release: "2" });
        expect(() => parseSourceRpmName("a-1.src.rpm")).toThrow(RepoValidationError);
        expect(() => parseSourceRpmName("-1-2.src.rpm")).toThrow(RepoValidationError);
        expect(() => parseSourceRpmName("")).toThrow(RepoValidationError);
    });
});

describe("Tests for readRpm", () => {
    const NAME = 1000;
    const VERSION = 1001;
    const RELEASE = 1002;
    const ARCH = 1022;
    const SOURCERPM = 1044;
    const SOURCEPACKAGE = 1106;

    function withTag(tag: number, value: string): Entry[] {
        return BASE.map(entry => entry[0] === tag ? [tag, STRING, [value]] : entry);
    }

    async function read(main: Entry[]): Promise<RpmPackageInput> {
        await fs.writeFile("synthetic.rpm", rpmFile(main));
        return readRpm("synthetic.rpm", "synthetic.rpm", { distro: "fedora", release: "42" }, await hashFile("synthetic.rpm"), await fs.stat("synthetic.rpm"));
    }

    test.each<[string, number, string, string]>([
        ["NAME", NAME, "../../../evil", "../../../evil"], ["NAME", NAME, "a/b", "a/b"], ["NAME", NAME, "a\\b", "a\\b"], ["NAME", NAME, "-evil", "-evil"],
        ["NAME", NAME, ".evil", ".evil"], ["NAME", NAME, "ev il", "ev il"], ["NAME", NAME, "ev\til", "ev\til"], ["NAME", NAME, "ev\u0001il", "ev\u0001il"],
        ["NAME", NAME, '"><img>', '"><img>'],
        ["ARCH", ARCH, "../../../evil", "../../../evil"], ["ARCH", ARCH, "-evil", "-evil"], ["ARCH", ARCH, ".evil", ".evil"], ["ARCH", ARCH, "ev il", "ev il"],
        ["source name", SOURCERPM, "../../../evil-1-2.src.rpm", "../../../evil"], ["source name", SOURCERPM, "-evil-1-2.src.rpm", "-evil"],
        ["source name", SOURCERPM, ".evil-1-2.src.rpm", ".evil"], ["source name", SOURCERPM, "ev il-1-2.src.rpm", "ev il"],
        ["source name", SOURCERPM, '"><img>-1-2.src.rpm', '"><img>'],
        ["VERSION", VERSION, "1/0", "1/0"], ["VERSION", VERSION, "1 0", "1 0"], ["RELEASE", RELEASE, "1\\0", "1\\0"], ["RELEASE", RELEASE, "1\n0", "1\n0"],
        ["source version", SOURCERPM, "a-1/0-2.src.rpm", "1/0-2"], ["source version", SOURCERPM, "a-1-2 3.src.rpm", "1-2 3"],
    ])("Rejects %s from tag %i: %j", (what, tag, value, shown) => withLocalTmpDir(async () => {
        await expect(read(withTag(tag, value))).rejects.toStrictEqual(new RepoValidationError(`Malformed ${ what }: ${ JSON.stringify(shown) }`));
    })());

    test("Rejects the NAME of a source package, which is its source name", withLocalTmpDir(async () => {
        await expect(read([...withTag(NAME, "../../../evil"), [SOURCEPACKAGE, INT32, [1]]]))
            .rejects.toStrictEqual(new RepoValidationError('Malformed NAME: "../../../evil"'));
    }));

    test.each<[number, string]>([
        [NAME, "NetworkManager-libnm"], [NAME, "gcc-c++"], [NAME, "python3_foo"], [NAME, "java-1.8.0-openjdk"], [NAME, "a"],
        [ARCH, "x86_64"], [ARCH, "noarch"], [ARCH, "aarch64"], [ARCH, "ppc64le"], [ARCH, "i686"],
        [VERSION, "1.0~rc1"], [VERSION, "1.0^git20261031"], [VERSION, "1_0"], [RELEASE, "0.1~beta.fc42"], [RELEASE, "1.tpm1u0.fc42"],
        [SOURCERPM, "libstdc++_x-1.0~rc1^git-1.fc42.src.rpm"],
    ])("Accepts tag %i with %s", (tag, value) => withLocalTmpDir(async () => {
        await expect(read(withTag(tag, value))).resolves.toMatchObject({ filename: "synthetic.rpm" });
    })());

    test("A source name with _ and + keeps its pool path", withLocalTmpDir(async () => {
        const input = await read(withTag(SOURCERPM, "libstdc++_x-1.0~rc1^git-1.fc42.src.rpm"));
        expect([input.sourceName, input.sourceVersion, input.file.path]).toEqual(["libstdc++_x", "1.0~rc1^git-1.fc42", "rpm/fedora/42/Packages/l/libstdc++_x/synthetic.rpm"]);
    }));
});

describe("Tests for the metadata renderers", () => {
    test("primary, filelists and other packages equal createrepo_c output", async () => {
        const [primary, filelists, other] = await Promise.all([goldenParts("primary"), goldenParts("filelists"), goldenParts("other")]);
        for (const [i, rpm] of [SRC_RPM, BIN_RPM, DOC_RPM].entries()) {
            const m = await metaOf(rpm);
            let golden = replaceValue(primary.packages[i], '<location href="', '"', m.href);
            golden = replaceValue(golden, '<time file="', '"', String(m.mtime));
            golden = replaceValue(golden, 'pkgid="YES">', "<", m.pkgid);
            expect(renderPrimaryPackage(m)).toBe(golden);
            expect(renderFilelistsPackage(m)).toBe(replaceValue(filelists.packages[i], 'pkgid="', '"', m.pkgid));
            expect(renderOtherPackage(m)).toBe(replaceValue(other.packages[i], 'pkgid="', '"', m.pkgid));
        }
    });

    test("Header and footer match the createrepo_c files", async () => {
        for (const kind of ["primary", "filelists", "other"] as const) {
            const parts = await goldenParts(kind);
            expect(xmlHeader(kind, 3)).toBe(parts.header);
            expect(xmlFooter(kind)).toBe(parts.footer);
        }
        expect(xmlHeader("primary", 0)).toContain(' packages="0">\n');
    });

    test("other keeps CHANGELOG_LIMIT entries", async () => {
        expect(CHANGELOG_LIMIT).toBe(10);
        const m = await metaOf(BIN_RPM);
        expect(m.changelogs).toHaveLength(12);
        const lines = changelogs(renderOtherPackage(m));
        expect(lines).toHaveLength(CHANGELOG_LIMIT);
        expect(lines[0]).toBe('<changelog author="SRM &lt;srm@example.com&gt; - 0.3-1" date="1740830400">- Change 3</changelog>');
        expect(lines[9]).toBe('<changelog author="SRM &lt;srm@example.com&gt; - 1.0-1" date="1764590400">- Change 12</changelog>');
    });

    test("Changelogs are written oldest first with trimmed authors and bumped equal times", () => {
        const newestFirst = Array.from({ length: 12 }, (_, i) => ({ author: `A <a@b> - ${ 12 - i }  `, date: 1000 - i, text: `- ${ 12 - i }` }));
        const lines = changelogs(renderOtherPackage(meta({ changelogs: newestFirst })));
        expect(lines).toHaveLength(10);
        expect(lines[0]).toBe('<changelog author="A &lt;a@b&gt; - 3" date="991">- 3</changelog>');
        expect(lines[9]).toBe('<changelog author="A &lt;a@b&gt; - 12" date="1000">- 12</changelog>');
        const same = meta({ changelogs: [{ author: "x", date: 5, text: "c" }, { author: "x", date: 5, text: "b" }, { author: "x", date: 5, text: "a" }, { author: "x", date: 1, text: "z" }] });
        expect(changelogs(renderOtherPackage(same))).toEqual([
            '<changelog author="x" date="1">z</changelog>',
            '<changelog author="x" date="5">a</changelog>',
            '<changelog author="x" date="6">b</changelog>',
            '<changelog author="x" date="7">c</changelog>',
        ]);
        expect(renderOtherPackage(meta())).toBe('<package pkgid="' + "0".repeat(64) + '" name="a" arch="x86_64">\n  <version epoch="0" ver="1" rel="2"/>\n</package>\n');
    });

    test("repomd lists the three types with checksum and open-checksum", async () => {
        const entry = (type: Kind, sha256: string, openSha256: string, size: number, openSize: number) =>
            ({ type, href: `repodata/${ sha256 }-${ type }.xml.zst`, sha256, openSha256, size, openSize, timestamp: 1793227320 });
        const xml = renderRepomd(1793227320, [
            entry("primary", "d0081a5e149173bc9d9c3e866e5f8bd8e6b2f8f4c60c1702467afd697e65a6aa", "fd6179e83e92c51b716077d4d583e68e93d45bb528848eb636972219c3f6e5ed", 952, 3875),
            entry("filelists", "ed841b63eba76e7c07bda54f6d670c216ab4c6692b65cec44adaa908df8e3ab1", "14c0b833f964aa67ef8de00c64af67c1895fe4fd7f5767525847dd02edac80ab", 435, 917),
            entry("other", "828aeb4ac2b0414ede9a3aaf537310b70a74946671f8e741fb696c9f4ba5028a", "2e95762bf4d2ee1957a08c875540a74f3695423f2847452c6a71b351efe703b2", 504, 3620),
        ]);
        expect(xml).toBe(await fs.readFile(osPath.join(GOLDEN, "repomd.xml"), "utf8"));
    });

    // Expectations are createrepo_c 1.2.0 / libxml2 2.9.14 output for these very values
    test("Special characters in summary are escaped", () => {
        const m = meta({
            summary: "sum ž \"dq\" 'sq' <a> & tab\there", description: "line1\r\nline2 ž\tt \"dq\" 'sq'", packager: "Oldřich Jedlička <o@x>",
            href: "Packages/a/a/a&b.rpm", provides: [dep("prov ž \"q\"", 8, "1.ž\"a"), dep("a\nb😀")],
            changelogs: [{ author: "Oldřich Jedlička <o@x> \"q\" 'a' - 1-2", date: 1700000000, text: "text ž \"dq\" 'sq'\r\nnext\tline" }],
        });
        const primary = renderPrimaryPackage(m);
        expect(primary).toContain("  <summary>sum ž \"dq\" 'sq' &lt;a&gt; &amp; tab\there</summary>\n");
        expect(primary).toContain("  <description>line1&#13;\nline2 ž\tt \"dq\" 'sq'</description>\n");
        expect(primary).toContain("  <packager>Oldřich Jedlička &lt;o@x&gt;</packager>\n");
        expect(primary).toContain('  <location href="Packages/a/a/a&amp;b.rpm"/>\n');
        expect(block(primary, "rpm:provides")).toEqual([
            '<rpm:entry name="prov &#x17E; &quot;q&quot;" flags="EQ" epoch="0" ver="1.&#x17E;&quot;a"/>',
            '<rpm:entry name="a&#10;b&#x1F600;"/>',
        ]);
        expect(renderOtherPackage(m)).toContain("  <changelog author=\"Old&#x159;ich Jedli&#x10D;ka &lt;o@x&gt; &quot;q&quot; 'a' - 1-2\" date=\"1700000000\">"
            + "text ž \"dq\" 'sq'&#13;\nnext\tline</changelog>\n");
    });

    test("Characters XML 1.0 lacks are dropped from text and attributes, the rest stays", () => {
        const invalid = "\0\x01\x08\x0B\x0C\x0E\x1F\u{DFFF}\u{D800}\u{FFFE}\u{FFFF}";
        const m = meta({
            summary: `s${ invalid }\t\x7F\x80\x9F\u{D7FF}\u{E000}\u{FFFD}\u{10000}\u{10FFFF}e`, description: `a${ invalid }b`, files: [file(`/usr/bin/a${ invalid }b`)],
            provides: [dep(`p${ invalid }\tq\x7F\u{FFFD}\u{10000}`)], changelogs: [{ author: `me${ invalid }`, date: 1, text: `bad ${ invalid }char` }],
        });
        const primary = renderPrimaryPackage(m);
        const other = renderOtherPackage(m);
        expect(primary).toContain("<summary>s\t\x7F\x80\x9F\u{D7FF}\u{E000}\u{FFFD}\u{10000}\u{10FFFF}e</summary>");
        expect(primary).toContain("<description>ab</description>");
        expect(primary).toContain("<file>/usr/bin/ab</file>");
        expect(block(primary, "rpm:provides")).toEqual(['<rpm:entry name="p&#9;q\x7F&#xFFFD;&#x10000;"/>']);
        expect(other).toContain('<changelog author="me" date="1">bad char</changelog>');
        expect(renderFilelistsPackage(m)).toContain("<file>/usr/bin/ab</file>");
        expect([...`${ primary }${ other }`].filter(c => invalid.includes(c))).toEqual([]);
    });

    test("Requires drop rpmlib, self-provided and shipped primary paths", () => {
        const m = meta({
            provides: [dep("config(a)", 8, "1-2"), dep("a", 8, "1-2")],
            requires: [dep("rpmlib(FileDigests)", 10, "4.6.0-1"), dep("config(a)", 8, "1-2"), dep("/usr/bin/a"), dep("/usr/share/a/data"), dep("/usr/bin/sh"), dep("a", 12, "1")],
            files: [file("/usr/bin/a"), file("/usr/share/a/data")],
        });
        expect(block(renderPrimaryPackage(m), "rpm:requires")).toEqual([
            '<rpm:entry name="/usr/share/a/data"/>', '<rpm:entry name="/usr/bin/sh"/>', '<rpm:entry name="a" flags="GE" epoch="0" ver="1"/>',
        ]);
        expect(renderPrimaryPackage(meta({ requires: [dep("rpmlib(X)", 10, "1")] }))).not.toContain("rpm:requires");
    });

    test("Requires keep the highest libc entry last and drop repeats of the last entry by name", () => {
        const m = meta({
            requires: [
                dep("libc.so.6()(64bit)"), dep("foo"), dep("libc.so.6(GLIBC_2.34)(64bit)"), dep("foo"), dep("libc.so.6(GLIBC_2.4)(64bit)"),
                dep("foo", 12, "1"), dep("foo"), dep("libc.so.6(GLIBC_ABI_DT_RELR)(64bit)"), dep("bar"), dep("libc.so.6(GLIBC_2.3)(64bit)"),
            ],
        });
        expect(block(renderPrimaryPackage(m), "rpm:requires")).toEqual([
            '<rpm:entry name="foo"/>', '<rpm:entry name="foo" flags="GE" epoch="0" ver="1"/>', '<rpm:entry name="foo"/>', '<rpm:entry name="bar"/>',
            '<rpm:entry name="libc.so.6(GLIBC_2.34)(64bit)"/>',
        ]);
        const digitless = meta({ requires: [dep("libc.so.6(GLIBC_ABI_DT_RELR)(64bit)"), dep("libc.so.6(GLIBC_PRIVATE)(64bit)"), dep("libc.so.6()(64bit)")] });
        expect(block(renderPrimaryPackage(digitless), "rpm:requires")).toEqual(['<rpm:entry name="libc.so.6(GLIBC_ABI_DT_RELR)(64bit)"/>']);
        const versioned = meta({ requires: [dep("libc.so.6(GLIBC_PRIVATE)(64bit)"), dep("libc.so.6(GLIBC_2.3)(64bit)"), dep("libc.so.6(GLIBC_2.3)(64bit)")] });
        expect(block(renderPrimaryPackage(versioned), "rpm:requires")).toEqual(['<rpm:entry name="libc.so.6(GLIBC_2.3)(64bit)"/>']);
        const scripted = meta({ requires: [dep("bash"), dep("libc.so.6(GLIBC_2.34)(64bit)", 0x200)] });
        expect(block(renderPrimaryPackage(scripted), "rpm:requires")).toEqual(['<rpm:entry name="bash"/>', '<rpm:entry name="libc.so.6(GLIBC_2.34)(64bit)" pre="1"/>']);
    });

    test("compareRpmVersions orders like rpmvercmp", () => {
        const chains = [
            ["", "1.0~rc1", "1.0", "1.0^post1", "1.0a", "1.0.1", "1.2", "1.10", "2"],
            ["", "GLIBC_ABI_DT_RELR", "GLIBC_PRIVATE", "GLIBC_2.4", "GLIBC_2.34"],
        ];
        for (const ordered of chains) {
            for (let i = 0; i < ordered.length; i++) {
                for (let j = 0; j < ordered.length; j++) {
                    expect([ordered[i], ordered[j], compareRpmVersions(ordered[i], ordered[j])]).toEqual([ordered[i], ordered[j], Math.sign(i - j)]);
                }
            }
        }
        expect(compareRpmVersions("001", "1")).toBe(0);
        expect(compareRpmVersions("1", "a")).toBe(1);
        expect(compareRpmVersions("1.0-1.fc42", "1.0.1.fc42")).toBe(0);
        expect(compareRpmVersions("1a", "1b")).toBe(-1);
    });

    test("Scriptlet requires carry pre and MISSINGOK requires become recommends", () => {
        const m = meta({
            requires: [dep("x", 0x200), dep("x", 0x400), dep("y", 0x1000), dep("z", (1 << 19) | 0x200), dep("v", 0x40 | 0x20 | 0x80), dep("foo", 1 << 19), dep("foo")],
            recommends: [dep("r", 8, "1")],
        });
        const xml = renderPrimaryPackage(m);
        expect(block(xml, "rpm:requires")).toEqual(['<rpm:entry name="x" pre="1"/>', '<rpm:entry name="y"/>', '<rpm:entry name="v" pre="1"/>', '<rpm:entry name="foo"/>']);
        expect(block(xml, "rpm:recommends")).toEqual(['<rpm:entry name="z"/>', '<rpm:entry name="foo"/>', '<rpm:entry name="r" flags="EQ" epoch="0" ver="1"/>']);
    });

    test("Dependency versions split into epoch, ver and rel; a non-numeric epoch skips the entry", () => {
        const m = meta({
            provides: [dep("p", 8, "2:3.0-1"), dep("q", 12, "1.0"), dep("r", 2, "x:1"), dep("s", 8), dep("t", 0, "1.0"), dep("u", 10, "1.0-"), dep("v", 4, ":1-2"), dep("", 8, "1")],
        });
        expect(block(renderPrimaryPackage(m), "rpm:provides")).toEqual([
            '<rpm:entry name="p" flags="EQ" epoch="2" ver="3.0" rel="1"/>',
            '<rpm:entry name="q" flags="GE" epoch="0" ver="1.0"/>',
            '<rpm:entry name="s" flags="EQ"/>',
            '<rpm:entry name="t"/>',
            '<rpm:entry name="u" flags="LE" epoch="0" ver="1.0"/>',
            '<rpm:entry name="v" flags="GT" epoch="0" ver="1" rel="2"/>',
        ]);
    });

    test("Dependency groups render in createrepo_c order and only when present", () => {
        const groups = ["rpm:provides", "rpm:requires", "rpm:conflicts", "rpm:obsoletes", "rpm:suggests", "rpm:enhances", "rpm:recommends", "rpm:supplements"];
        const full = renderPrimaryPackage(meta({
            provides: [dep("p")], requires: [dep("q")], conflicts: [dep("c")], obsoletes: [dep("o")],
            suggests: [dep("s")], enhances: [dep("e")], recommends: [dep("r")], supplements: [dep("u")],
        }));
        const positions = groups.map(g => full.indexOf(`<${ g }>`));
        expect(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]))).toBe(true);
        expect(block(full, "rpm:conflicts")).toEqual(['<rpm:entry name="c"/>']);
        const empty = renderPrimaryPackage(meta());
        expect(groups.some(g => empty.includes(g))).toBe(false);
        expect(empty).toContain('    <rpm:header-range start="5" end="6"/>\n  </format>\n</package>\n');
    });

    test("Primary lists only etc, bin and sendmail paths; filelists lists every path with its type", () => {
        const m = meta({
            files: [
                file("/etc/a.conf"), file("/etc/a", "dir"), file("/usr/lib/sendmail"), file("/usr/sbin/x"), file("/opt/bin/y"),
                file("/usr/share/doc/a", "dir"), file("/var/log/a.log", "ghost"), file("/usr/lib/.build-id/ab"), file("/usr/libexec/binary"),
            ],
        });
        expect(block(renderPrimaryPackage(m), "format").filter(line => line.startsWith("<file"))).toEqual([
            "<file>/etc/a.conf</file>", '<file type="dir">/etc/a</file>', "<file>/usr/lib/sendmail</file>", "<file>/usr/sbin/x</file>", "<file>/opt/bin/y</file>",
        ]);
        expect(renderFilelistsPackage(m)).toBe(
            '<package pkgid="' + "0".repeat(64) + '" name="a" arch="x86_64">\n  <version epoch="0" ver="1" rel="2"/>\n'
            + "  <file>/etc/a.conf</file>\n"
            + '  <file type="dir">/etc/a</file>\n'
            + "  <file>/usr/lib/sendmail</file>\n"
            + "  <file>/usr/sbin/x</file>\n"
            + "  <file>/opt/bin/y</file>\n"
            + '  <file type="dir">/usr/share/doc/a</file>\n'
            + '  <file type="ghost">/var/log/a.log</file>\n'
            + "  <file>/usr/lib/.build-id/ab</file>\n"
            + "  <file>/usr/libexec/binary</file>\n"
            + "</package>\n");
    });
});
