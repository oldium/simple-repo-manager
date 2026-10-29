import osPath from "path";
import fs from "fs/promises";
import { MAX_CONTROL_SIZE } from "../archive.ts";
import type { Stanza } from "../control.ts";
import type { Digests, HashName } from "../hash.ts";
import { checkPathSegment, checkSafeName } from "../staging.ts";
import type { DebBinaryInput, PoolFile } from "./catalog.ts";
import { inspectDeb, parseDsc } from "./inspect.ts";
import type { DscFile } from "./inspect.ts";
import { binarySource, renderPackagesStanza, renderSourcesStanza, requiredField } from "./stanzas.ts";
import type { SectionPriority } from "./stanzas.ts";
import { RepoValidationError } from "../../lib/errors.ts";

export const BINARY_KINDS: Record<string, DebBinaryInput["kind"] | undefined> = { ".deb": "deb", ".ddeb": "ddeb", ".udeb": "udeb" };

const HASHES: HashName[] = ["md5", "sha1", "sha256", "sha512"];

/** Size and digests a .changes or .dsc lists for a file */
export type Listed = { size: number } & Partial<Record<HashName, string>>;

/** A package file on disk with its verified digests and the Section/Priority it is indexed under */
export type LocatedFile = { name: string; location: string; file: PoolFile } & SectionPriority;

export type SourceVersion = { source: string; version: string };

export function verify(name: string, d: Digests, listed: Listed, context: string): void {
    if (listed.size !== d.size) {
        throw new RepoValidationError(`${ name }: size ${ context }`);
    }
    for (const hash of HASHES) {
        const expected = listed[hash];
        if (expected !== undefined && expected !== d[hash]) {
            throw new RepoValidationError(`${ name }: ${ hash } ${ context }`);
        }
    }
}

/** A .changes or .dsc as text; the size comes first, as all of it goes to memory */
export async function readControlFile(file: string): Promise<string> {
    const { size } = await fs.stat(file);
    if (size > MAX_CONTROL_SIZE) {
        throw new RepoValidationError(`${ osPath.basename(file) } holds ${ size } bytes, over the ${ MAX_CONTROL_SIZE } limit`);
    }
    return fs.readFile(file, "utf8");
}

export function checkSourceVersion(sv: SourceVersion, file: string): void {
    checkSafeName("debName", sv.source, `Source of ${ file }`);
    checkPathSegment(sv.version, `Version of ${ file }`);
}

/** The Architecture list of a .changes, where "source" and "all" sit next to the binary architectures */
export function changesArchitectures(stanza: Stanza, file: string): string[] {
    const architectures = requiredField(stanza, "Architecture").split(" ").filter(a => a.length > 0);
    for (const architecture of architectures) {
        checkSafeName("debArchitecture", architecture, `Architecture of ${ file }`);
    }
    return architectures;
}

/** The catalog input for a .deb, .ddeb or .udeb that must be built from the expected source version */
export async function readBinary(located: LocatedFile, kind: DebBinaryInput["kind"], expected: SourceVersion, poolDir: string): Promise<DebBinaryInput> {
    // ddebs are never listed in Contents, so their data member stays unread
    const { control, paths } = await inspectDeb(located.location, kind !== "ddeb");
    const built = binarySource(control);
    // The mismatch message prints both sides as they are
    checkSourceVersion(built, located.name);
    checkSourceVersion(expected, located.name);
    if (built.source !== expected.source || built.version !== expected.version) {
        throw new RepoValidationError(`${ located.name } is built from ${ built.source } ${ built.version }, not ${ expected.source } ${ expected.version }`);
    }
    const packageName = requiredField(control, "Package");
    const version = requiredField(control, "Version");
    const architecture = requiredField(control, "Architecture");
    checkSafeName("debName", packageName, `Package of ${ located.name }`);
    checkPathSegment(version, `Version of ${ located.name }`);
    checkSafeName("debBinaryArchitecture", architecture, `Architecture of ${ located.name }`);
    const { file } = located;
    const stanza = renderPackagesStanza(control, { filename: `${ poolDir }/${ located.name }`, size: file.size, md5: file.md5, sha256: file.sha256 }, located);
    return { kind, package: packageName, version, architecture, section: located.section, stanza, file, paths };
}

/** The .dsc of the expected source version and the files it lists, each obtained through fileOf and verified against it */
export async function readSource(dsc: LocatedFile, expected: SourceVersion, poolDir: string, fileOf: (name: string, listed: DscFile) => Promise<PoolFile>):
    Promise<{ sourcePackage: { stanza: string; files: PoolFile[] }; referenced: Set<string> }> {

    const parsed = parseDsc(await readControlFile(dsc.location));
    // The Sources index must carry a sha256 for each file
    for (const [name, listed] of parsed.files) {
        if (listed.sha256 === undefined) {
            throw new RepoValidationError(`${ name } is not listed in Checksums-Sha256 of ${ dsc.name }`);
        }
    }
    const source = requiredField(parsed.stanza, "Source");
    const version = requiredField(parsed.stanza, "Version");
    // The mismatch message prints both sides as they are
    checkSourceVersion({ source, version }, dsc.name);
    checkSourceVersion(expected, dsc.name);
    if (source !== expected.source || version !== expected.version) {
        throw new RepoValidationError(`${ dsc.name } is ${ source } ${ version }, not ${ expected.source } ${ expected.version }`);
    }
    const files: PoolFile[] = [dsc.file];
    for (const [name, listed] of parsed.files) {
        checkPathSegment(name, `file name in ${ dsc.name }`);
        const file = await fileOf(name, listed);
        verify(name, file, listed, "does not match the .dsc");
        files.push(file);
    }
    const stanza = renderSourcesStanza(parsed.stanza, { name: dsc.name, ...dsc.file }, poolDir, dsc);
    return { sourcePackage: { stanza, files }, referenced: new Set(parsed.files.keys()) };
}
