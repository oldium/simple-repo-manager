import osPath from "path";
import { createReadStream } from "fs";
import { pipeline } from "stream";
import type { Readable } from "stream";
import { compressionOf, decompressor, readArMembers, readTar } from "../archive.ts";
import type { ArMember } from "../archive.ts";
import { field, parseControl, parseFileList, stripClearsign } from "../control.ts";
import type { Stanza } from "../control.ts";
import { RepoValidationError } from "../../lib/errors.ts";

export type DscFile = { size: number; md5?: string; sha1?: string; sha256?: string; sha512?: string };

const CHECKSUM_FIELDS: [field: string, hash: "sha1" | "sha256" | "sha512"][] = [
    ["Checksums-Sha1", "sha1"],
    ["Checksums-Sha256", "sha256"],
    ["Checksums-Sha512", "sha512"],
];

// Paths stay in memory for the catalog, and a compressed member lists them almost for free
const MAX_PATHS_SIZE = 256 * 1024 * 1024;
// Array slot and string header
const PATH_OVERHEAD = 64;

function findMember(members: ArMember[], base: string, fileName: string): ArMember {
    const member = members.find(m => m.name === base || m.name.startsWith(`${ base }.`));
    if (member === undefined) {
        throw new RepoValidationError(`${ fileName }: no ${ base } member`);
    }
    if (member.size === 0) {
        throw new RepoValidationError(`${ fileName }: ${ member.name } is empty`);
    }
    return member;
}

// Every failure also reaches the consumer through the destroyed decoded stream, so the callback has nothing to add
function memberStream(file: string, member: ArMember): Readable {
    const decoded = decompressor(compressionOf(member.name));
    pipeline(createReadStream(file, { start: member.offset, end: member.offset + member.size - 1 }), decoded, () => { });
    return decoded;
}

/** The streams and parsers below report only what went wrong, not where */
async function inMember<T>(fileName: string, member: ArMember, read: () => Promise<T>): Promise<T> {
    try {
        return await read();
    } catch (err) {
        if (err instanceof RepoValidationError) {
            throw new RepoValidationError(`${ fileName }: ${ member.name }: ${ err.message }`, { cause: err });
        }
        throw err;
    }
}

async function readControl(file: string, fileName: string, member: ArMember): Promise<Stanza> {
    const stanza = await inMember(fileName, member, async () => {
        let control: Buffer | undefined;
        for await (const entry of readTar(memberStream(file, member), e => e.path === "control" && e.type === "file")) {
            control ??= entry.body;
        }
        return control === undefined ? undefined : parseControl(control.toString("utf8"))[0];
    });
    if (stanza === undefined) {
        throw new RepoValidationError(`${ fileName }: ${ member.name } has no control file`);
    }
    return stanza;
}

function readPaths(file: string, fileName: string, member: ArMember): Promise<string[]> {
    return inMember(fileName, member, async () => {
        const paths: string[] = [];
        let held = 0;
        for await (const entry of readTar(memberStream(file, member))) {
            if (entry.type !== "directory") {
                held += entry.path.length + PATH_OVERHEAD;
                if (held > MAX_PATHS_SIZE) {
                    throw new RepoValidationError(`paths take more than ${ MAX_PATHS_SIZE } bytes`);
                }
                paths.push(entry.path);
            }
        }
        return paths;
    });
}

export async function inspectDeb(file: string, listPaths: boolean): Promise<{ control: Stanza; paths: string[] }> {
    // Messages reach upload clients, so they name the file without its directory
    const fileName = osPath.basename(file);
    const members = await readArMembers(file);
    const control = await readControl(file, fileName, findMember(members, "control.tar", fileName));
    const paths = listPaths ? await readPaths(file, fileName, findMember(members, "data.tar", fileName)) : [];
    return { control, paths };
}

export function parseDsc(text: string): { stanza: Stanza; files: Map<string, DscFile> } {
    const stanzas = parseControl(stripClearsign(text));
    if (stanzas.length !== 1) {
        throw new RepoValidationError(`A .dsc must hold one stanza, found ${ stanzas.length }`);
    }
    const stanza = stanzas[0];
    const fileList = field(stanza, "Files");
    if (fileList === undefined) {
        throw new RepoValidationError("The .dsc has no Files field");
    }
    const files = new Map<string, DscFile>();
    for (const listed of parseFileList(fileList, false)) {
        files.set(listed.name, { size: listed.size, md5: listed.hash });
    }
    for (const [fieldName, hash] of CHECKSUM_FIELDS) {
        const value = field(stanza, fieldName);
        if (value === undefined) {
            continue;
        }
        for (const listed of parseFileList(value, false)) {
            const entry = files.get(listed.name);
            if (entry === undefined || entry.size !== listed.size) {
                throw new RepoValidationError(`${ fieldName } of the .dsc does not match Files for ${ listed.name }`);
            }
            entry[hash] = listed.hash;
        }
    }
    return { stanza, files };
}
