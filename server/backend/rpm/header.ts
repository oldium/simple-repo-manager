import osPath from "path";
import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import { RepoValidationError } from "../../lib/errors.ts";

export type RpmDep = { name: string; flags: number; version?: string };

export type RpmFile = { path: string; type: "file" | "dir" | "ghost" };

export type RpmChangelog = { author: string; date: number; text: string };

export type RpmHeader = {
    name: string;
    epoch: number;
    version: string;
    release: string;
    arch: string;
    isSource: boolean;
    sourceRpm: string;
    summary: string;
    description: string;
    packager: string;
    url: string;
    buildTime: number;
    buildHost: string;
    license: string;
    vendor: string;
    group: string;
    installedSize: number;
    archiveSize: number;
    headerStart: number;
    headerEnd: number;
    provides: RpmDep[];
    requires: RpmDep[];
    conflicts: RpmDep[];
    obsoletes: RpmDep[];
    recommends: RpmDep[];
    suggests: RpmDep[];
    supplements: RpmDep[];
    enhances: RpmDep[];
    files: RpmFile[];
    changelogs: RpmChangelog[];
};

const LEAD_SIZE = 96;
const LEAD_MAGIC = Buffer.from([0xed, 0xab, 0xee, 0xdb]);
const HEADER_MAGIC = Buffer.from([0x8e, 0xad, 0xe8, 0x01]);
const HEADER_INTRO_SIZE = 16;
const ENTRY_SIZE = 16;
// rpm's own limits for an index count and a data store
const MAX_ENTRIES = 0xffff;
const MAX_DATA = 256 * 1024 * 1024;
// The store alone bounds nothing: entries may overlap, and an empty string takes one byte of it
const MAX_DECODED = 64 * 1024 * 1024;
// Array slot, string header and the object built from the value
const DECODED_OVERHEAD = 32;
// XML escaping grows a string several times, and past V8's limits that aborts the process uncatchably
const MAX_STRING = 1024 * 1024;

// rpmtag.h
const NAME = 1000;
const VERSION = 1001;
const RELEASE = 1002;
const EPOCH = 1003;
const SUMMARY = 1004;
const DESCRIPTION = 1005;
const BUILDTIME = 1006;
const BUILDHOST = 1007;
const SIZE = 1009;
const VENDOR = 1011;
const LICENSE = 1014;
const PACKAGER = 1015;
const GROUP = 1016;
const URL = 1020;
const ARCH = 1022;
const FILEMODES = 1030;
const FILEFLAGS = 1037;
const SOURCERPM = 1044;
const PROVIDENAME = 1047;
const REQUIREFLAGS = 1048;
const REQUIRENAME = 1049;
const REQUIREVERSION = 1050;
const CONFLICTFLAGS = 1053;
const CONFLICTNAME = 1054;
const CONFLICTVERSION = 1055;
const CHANGELOGTIME = 1080;
const CHANGELOGNAME = 1081;
const CHANGELOGTEXT = 1082;
const OBSOLETENAME = 1090;
const SOURCEPACKAGE = 1106;
const PROVIDEFLAGS = 1112;
const PROVIDEVERSION = 1113;
const OBSOLETEFLAGS = 1114;
const OBSOLETEVERSION = 1115;
const DIRINDEXES = 1116;
const BASENAMES = 1117;
const DIRNAMES = 1118;
const OLDSUGGESTSNAME = 1156;
const OLDSUGGESTSVERSION = 1157;
const OLDSUGGESTSFLAGS = 1158;
const OLDENHANCESNAME = 1159;
const OLDENHANCESVERSION = 1160;
const OLDENHANCESFLAGS = 1161;
const LONGSIZE = 5009;
const RECOMMENDNAME = 5046;
const RECOMMENDVERSION = 5047;
const RECOMMENDFLAGS = 5048;
const SUGGESTNAME = 5049;
const SUGGESTVERSION = 5050;
const SUGGESTFLAGS = 5051;
const SUPPLEMENTNAME = 5052;
const SUPPLEMENTVERSION = 5053;
const SUPPLEMENTFLAGS = 5054;
const ENHANCENAME = 5055;
const ENHANCEVERSION = 5056;
const ENHANCEFLAGS = 5057;
const PAYLOADSIZEALT = 5113;
// signature header
const SIG_LONGARCHIVESIZE = 271;
const SIG_PAYLOADSIZE = 1007;

const RPMFILE_GHOST = 1 << 6;
const RPMSENSE_STRONG = 1 << 27;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

// header data types
const TYPE_CHAR = 1;
const TYPE_INT8 = 2;
const TYPE_INT16 = 3;
const TYPE_INT32 = 4;
const TYPE_INT64 = 5;
const TYPE_STRING = 6;
const TYPE_STRING_ARRAY = 8;
const TYPE_I18NSTRING = 9;

const INT_WIDTH: Record<number, number> = { [TYPE_CHAR]: 1, [TYPE_INT8]: 1, [TYPE_INT16]: 2, [TYPE_INT32]: 4, [TYPE_INT64]: 8 };

type Entry = { type: number; offset: number; count: number };

function tooMuchDecoded(file: string): RepoValidationError {
    return new RepoValidationError(`${ file }: header decodes to more than ${ MAX_DECODED } bytes`);
}

class Header {
    private readonly entries: Map<number, Entry>;
    private readonly data: Buffer;
    private readonly file: string;
    private decoded = 0;

    constructor(entries: Map<number, Entry>, data: Buffer, file: string) {
        this.entries = entries;
        this.data = data;
        this.file = file;
    }

    has(tag: number): boolean {
        return this.entries.has(tag);
    }

    /** First string of a STRING, STRING_ARRAY or I18NSTRING tag */
    string(tag: number): string | undefined {
        return this.strings(tag)[0];
    }

    strings(tag: number): string[] {
        const entry = this.entries.get(tag);
        if (entry === undefined) {
            return [];
        }
        if (entry.type !== TYPE_STRING && entry.type !== TYPE_STRING_ARRAY && entry.type !== TYPE_I18NSTRING) {
            throw this.malformed(tag, entry.type);
        }
        const strings: string[] = [];
        let position = entry.offset;
        for (let i = 0; i < entry.count; i++) {
            const end = this.data.indexOf(0, position);
            if (position > this.data.length || end < 0) {
                throw this.malformed(tag, entry.type);
            }
            if (end - position > MAX_STRING) {
                throw new RepoValidationError(`${ this.file }: header tag ${ tag } holds a string of ${ end - position } bytes, over the ${ MAX_STRING } limit`);
            }
            this.charge(end - position + DECODED_OVERHEAD);
            strings.push(this.data.toString("utf8", position, end));
            position = end + 1;
        }
        return strings;
    }

    number(tag: number): number | undefined {
        return this.numbers(tag)[0];
    }

    numbers(tag: number): number[] {
        const entry = this.entries.get(tag);
        if (entry === undefined) {
            return [];
        }
        const width = INT_WIDTH[entry.type];
        if (width === undefined || entry.offset + width * entry.count > this.data.length) {
            throw this.malformed(tag, entry.type);
        }
        this.charge(entry.count * DECODED_OVERHEAD);
        const numbers: number[] = [];
        for (let i = 0; i < entry.count; i++) {
            const at = entry.offset + width * i;
            numbers.push(width === 8 ? Number(this.data.readBigUInt64BE(at)) : this.data.readUIntBE(at, width));
        }
        return numbers;
    }

    private charge(cost: number): void {
        this.decoded += cost;
        if (this.decoded > MAX_DECODED) {
            throw tooMuchDecoded(this.file);
        }
    }

    private malformed(tag: number, type: number): RepoValidationError {
        return new RepoValidationError(`${ this.file }: malformed header tag ${ tag } (type ${ type })`);
    }
}

async function readAt(handle: FileHandle, position: number, length: number, file: string, what: string): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead !== length) {
        throw new RepoValidationError(`${ file }: truncated ${ what }`);
    }
    return buffer;
}

async function readHeader(handle: FileHandle, position: number, fileSize: number, file: string, what: string): Promise<{ header: Header; end: number }> {
    const intro = await readAt(handle, position, HEADER_INTRO_SIZE, file, what);
    if (!intro.subarray(0, HEADER_MAGIC.length).equals(HEADER_MAGIC)) {
        throw new RepoValidationError(`${ file }: bad ${ what } magic`);
    }
    const count = intro.readUInt32BE(8);
    const size = intro.readUInt32BE(12);
    if (count > MAX_ENTRIES || size > MAX_DATA) {
        throw new RepoValidationError(`${ file }: oversized ${ what }`);
    }
    // Checked before the allocation, so a bogus size cannot cost memory
    if (position + HEADER_INTRO_SIZE + count * ENTRY_SIZE + size > fileSize) {
        throw new RepoValidationError(`${ file }: truncated ${ what }`);
    }
    const body = await readAt(handle, position + HEADER_INTRO_SIZE, count * ENTRY_SIZE + size, file, what);
    const entries = new Map<number, Entry>();
    for (let i = 0; i < count; i++) {
        const at = i * ENTRY_SIZE;
        const offset = body.readUInt32BE(at + 8);
        if (offset > size) {
            throw new RepoValidationError(`${ file }: malformed ${ what } index`);
        }
        entries.set(body.readUInt32BE(at), { type: body.readUInt32BE(at + 4), offset, count: body.readUInt32BE(at + 12) });
    }
    return { header: new Header(entries, body.subarray(count * ENTRY_SIZE), file), end: position + HEADER_INTRO_SIZE + body.length };
}

function required(h: Header, tag: number, name: string, file: string): string {
    const value = h.string(tag);
    if (value === undefined || value.length === 0) {
        throw new RepoValidationError(`${ file }: header has no ${ name }`);
    }
    return value;
}

function dependencies(h: Header, nameTag: number, flagsTag: number, versionTag: number, file: string): RpmDep[] {
    const names = h.strings(nameTag);
    const flags = h.numbers(flagsTag);
    const versions = h.strings(versionTag);
    if (names.length > 0 && (flags.length !== names.length || versions.length !== names.length)) {
        throw new RepoValidationError(`${ file }: dependency tags ${ nameTag }, ${ flagsTag } and ${ versionTag } differ in length`);
    }
    return names.map((name, i) => versions[i].length === 0 ? { name, flags: flags[i] } : { name, flags: flags[i], version: versions[i] });
}

function files(h: Header, file: string): RpmFile[] {
    const basenames = h.strings(BASENAMES);
    const dirnames = h.strings(DIRNAMES);
    const dirindexes = h.numbers(DIRINDEXES);
    const modes = h.numbers(FILEMODES);
    const flags = h.numbers(FILEFLAGS);
    if (dirindexes.length !== basenames.length) {
        throw new RepoValidationError(`${ file }: BASENAMES and DIRINDEXES differ in length`);
    }
    let pathsLength = 0;
    return basenames.map((base, i) => {
        const dir = dirnames[dirindexes[i]];
        if (dir === undefined) {
            throw new RepoValidationError(`${ file }: DIRINDEXES entry ${ i } is out of range`);
        }
        // One long directory name would repeat in every path
        pathsLength += dir.length + base.length;
        if (pathsLength > MAX_DECODED) {
            throw tooMuchDecoded(file);
        }
        const type = ((modes[i] ?? 0) & S_IFMT) === S_IFDIR ? "dir" : ((flags[i] ?? 0) & RPMFILE_GHOST) !== 0 ? "ghost" : "file";
        return { path: `${ dir }${ base }`, type };
    });
}

function changelogs(h: Header, file: string): RpmChangelog[] {
    const times = h.numbers(CHANGELOGTIME);
    const names = h.strings(CHANGELOGNAME);
    const texts = h.strings(CHANGELOGTEXT);
    if (names.length !== times.length || texts.length !== times.length) {
        throw new RepoValidationError(`${ file }: CHANGELOG tags differ in length`);
    }
    return times.map((date, i) => ({ author: names[i], date, text: texts[i] }));
}

/** Reads the lead, signature header and main header; the payload is never touched */
export async function readRpmHeader(file: string): Promise<RpmHeader> {
    // Messages reach upload clients, so they name the file without its directory
    const fileName = osPath.basename(file);
    const handle = await fs.open(file, "r");
    try {
        const { size: fileSize } = await handle.stat();
        const lead = await readAt(handle, 0, LEAD_SIZE, fileName, "lead");
        if (!lead.subarray(0, LEAD_MAGIC.length).equals(LEAD_MAGIC)) {
            throw new RepoValidationError(`${ fileName } is not an rpm package`);
        }
        const signature = await readHeader(handle, LEAD_SIZE, fileSize, fileName, "signature header");
        const headerStart = signature.end + (8 - signature.end % 8) % 8;
        const { header: h, end: headerEnd } = await readHeader(handle, headerStart, fileSize, fileName, "header");
        const sourceRpm = h.string(SOURCERPM) ?? "";
        const isSource = h.has(SOURCEPACKAGE) || sourceRpm.length === 0;
        // Legacy weak dependencies: the STRONG flag turns a suggestion into a recommendation, an enhancement into a supplement
        const oldSuggests = dependencies(h, OLDSUGGESTSNAME, OLDSUGGESTSFLAGS, OLDSUGGESTSVERSION, fileName);
        const oldEnhances = dependencies(h, OLDENHANCESNAME, OLDENHANCESFLAGS, OLDENHANCESVERSION, fileName);
        const strong = (d: RpmDep) => (d.flags & RPMSENSE_STRONG) !== 0;
        return {
            name: required(h, NAME, "NAME", fileName),
            epoch: h.number(EPOCH) ?? 0,
            version: required(h, VERSION, "VERSION", fileName),
            release: required(h, RELEASE, "RELEASE", fileName),
            arch: isSource ? "src" : required(h, ARCH, "ARCH", fileName),
            isSource,
            sourceRpm,
            summary: h.string(SUMMARY) ?? "",
            description: h.string(DESCRIPTION) ?? "",
            packager: h.string(PACKAGER) ?? "",
            url: h.string(URL) ?? "",
            buildTime: h.number(BUILDTIME) ?? 0,
            buildHost: h.string(BUILDHOST) ?? "",
            license: h.string(LICENSE) ?? "",
            vendor: h.string(VENDOR) ?? "",
            group: h.string(GROUP) ?? "",
            installedSize: h.number(LONGSIZE) ?? h.number(SIZE) ?? 0,
            archiveSize: signature.header.number(SIG_LONGARCHIVESIZE) ?? signature.header.number(SIG_PAYLOADSIZE) ?? h.number(PAYLOADSIZEALT) ?? 0,
            headerStart,
            headerEnd,
            provides: dependencies(h, PROVIDENAME, PROVIDEFLAGS, PROVIDEVERSION, fileName),
            requires: dependencies(h, REQUIRENAME, REQUIREFLAGS, REQUIREVERSION, fileName),
            conflicts: dependencies(h, CONFLICTNAME, CONFLICTFLAGS, CONFLICTVERSION, fileName),
            obsoletes: dependencies(h, OBSOLETENAME, OBSOLETEFLAGS, OBSOLETEVERSION, fileName),
            recommends: [...dependencies(h, RECOMMENDNAME, RECOMMENDFLAGS, RECOMMENDVERSION, fileName), ...oldSuggests.filter(strong)],
            suggests: [...dependencies(h, SUGGESTNAME, SUGGESTFLAGS, SUGGESTVERSION, fileName), ...oldSuggests.filter(d => !strong(d))],
            supplements: [...dependencies(h, SUPPLEMENTNAME, SUPPLEMENTFLAGS, SUPPLEMENTVERSION, fileName), ...oldEnhances.filter(strong)],
            enhances: [...dependencies(h, ENHANCENAME, ENHANCEFLAGS, ENHANCEVERSION, fileName), ...oldEnhances.filter(d => !strong(d))],
            files: files(h, fileName),
            changelogs: changelogs(h, fileName),
        };
    } finally {
        await handle.close();
    }
}

/** Splits a SOURCERPM value such as clevis-dracut-22-1.fc42.src.rpm at its last two dashes */
export function parseSourceRpmName(s: string): { name: string; version: string; release: string } {
    let nevr = s;
    for (const suffix of [".src.rpm", ".nosrc.rpm"]) {
        if (s.endsWith(suffix)) {
            nevr = s.slice(0, -suffix.length);
        }
    }
    const releaseAt = nevr.lastIndexOf("-");
    const versionAt = nevr.lastIndexOf("-", releaseAt - 1);
    if (releaseAt < 0 || versionAt < 1 || versionAt + 1 === releaseAt || releaseAt + 1 === nevr.length) {
        throw new RepoValidationError(`Malformed source rpm name: ${ s }`);
    }
    return { name: nevr.slice(0, versionAt), version: nevr.slice(versionAt + 1, releaseAt), release: nevr.slice(releaseAt + 1) };
}
