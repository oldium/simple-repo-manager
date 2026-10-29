import { field, formatStanza, parseFileList } from "../control.ts";
import type { ListedFile, Stanza } from "../control.ts";
import { RepoValidationError } from "../../lib/errors.ts";

export const KEY_SEP = "\u0001";

export type SectionPriority = { section: string; priority: string };

export type PackageFile = { filename: string; size: number; md5: string; sha256: string };

export type DscDigests = { name: string; size: number; md5: string; sha1: string; sha256: string; sha512: string };

// Fields reprepro replaces in a Packages stanza; stale copies in the input are dropped
const PACKAGES_REPLACED = new Set(["priority", "section", "filename", "size", "md5sum", "sha1", "sha256", "sha512"]);

const SOURCES_REPLACED = new Set(["source", "package", "priority", "section", "directory", "files"]);

const SOURCES_LISTS: [field: string, hash: "md5" | "sha1" | "sha256"][] = [
    ["Files", "md5"],
    ["Checksums-Sha1", "sha1"],
    ["Checksums-Sha256", "sha256"],
];

export function requiredField(stanza: Stanza, name: string): string {
    const value = field(stanza, name);
    if (value === undefined || value.length === 0) {
        throw new RepoValidationError(`Missing ${ name } field`);
    }
    return value;
}

export function poolDirectory(component: string, source: string): string {
    if (source.length === 0) {
        throw new RepoValidationError("Empty source package name");
    }
    const prefix = source.startsWith("lib") && source.length > 3 ? source.slice(0, 4) : source[0];
    return `pool/${ component }/${ prefix }/${ source }`;
}

/** Source of a binary control; "name (version)" carries the source version; absent or empty → Package/Version */
export function binarySource(control: Stanza): { source: string; version: string } {
    const source = field(control, "Source") ?? "";
    const open = source.indexOf("(");
    if (open < 0) {
        return { source: source.length === 0 ? requiredField(control, "Package") : source, version: requiredField(control, "Version") };
    }
    const name = source.slice(0, open).trim();
    const version = source.slice(open + 1, -1).trim();
    if (!source.endsWith(")") || name.length === 0 || version.length === 0) {
        throw new RepoValidationError(`Malformed Source field: ${ source }`);
    }
    return { source: name, version };
}

export function binarySortKey(source: string, pkg: string, version: string, arch: string): string {
    return [source, pkg, version, arch].join(KEY_SEP);
}

export function sourceSortKey(source: string, version: string): string {
    return [source, version].join(KEY_SEP);
}

export function renderPackagesStanza(control: Stanza, file: PackageFile, sp: SectionPriority): string {
    const kept = control.filter(([name]) => !PACKAGES_REPLACED.has(name.toLowerCase()));
    const inserted: Stanza = [
        ["Priority", sp.priority],
        ["Section", sp.section],
        ["Filename", file.filename],
        ["Size", String(file.size)],
        ["SHA256", file.sha256],
        ["MD5sum", file.md5],
    ];
    const description = kept.findIndex(([name]) => name.toLowerCase() === "description");
    const at = description < 0 ? kept.length : description;
    return formatStanza([...kept.slice(0, at), ...inserted, ...kept.slice(at)]);
}

// Trailing space after the colon, as reprepro writes these lists
function renderFileList(name: string, entries: ListedFile[]): string {
    return `${ name }: \n${ entries.map(e => ` ${ e.hash } ${ e.size } ${ e.name }\n`).join("") }`;
}

function replacedInSources(name: string): boolean {
    const lower = name.toLowerCase();
    return SOURCES_REPLACED.has(lower) || lower.startsWith("checksums-");
}

export function renderSourcesStanza(dsc: Stanza, dscFile: DscDigests, directory: string, sp: SectionPriority): string {
    const source = requiredField(dsc, "Source");
    const kept = dsc.filter(([name]) => !replacedInSources(name));
    let text = formatStanza([["Package", source], ...kept, ["Priority", sp.priority], ["Section", sp.section], ["Directory", directory]]);
    for (const [name, hash] of SOURCES_LISTS) {
        const value = field(dsc, name);
        if (value !== undefined) {
            const own = { name: dscFile.name, size: dscFile.size, hash: dscFile[hash] };
            text += renderFileList(name, [own, ...parseFileList(value, false)]);
        }
    }
    return text;
}

export function renderContentsLine(path: string, qualified: string[]): string {
    return `${ path }\t    ${ qualified.join(",") }\n`;
}
