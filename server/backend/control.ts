import { RepoValidationError } from "../lib/errors.ts";

/** A multi-line value keeps its continuation lines joined with "\n", each with its leading space */
export type Stanza = [name: string, value: string][];

export type ListedFile = { name: string; size: number; hash: string; section?: string; priority?: string };

const BEGIN_SIGNED = "-----BEGIN PGP SIGNED MESSAGE-----\n";
const BEGIN_SIGNATURE = "\n-----BEGIN PGP SIGNATURE-----";
const END_SIGNATURE = "-----END PGP SIGNATURE-----";

function normalize(text: string): string {
    return text.replaceAll("\r\n", "\n");
}

export function parseControl(text: string): Stanza[] {
    const stanzas: Stanza[] = [];
    let current: Stanza = [];
    for (const line of normalize(text).split("\n")) {
        if (line.trim().length === 0) {
            if (current.length > 0) {
                stanzas.push(current);
                current = [];
            }
        } else if (line[0] === " " || line[0] === "\t") {
            const last = current[current.length - 1];
            if (last === undefined) {
                throw new RepoValidationError(`Continuation line without a field: ${ line }`);
            }
            last[1] += `\n${ line }`;
        } else {
            const colon = line.indexOf(":");
            if (colon <= 0) {
                throw new RepoValidationError(`Malformed control line: ${ line }`);
            }
            current.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
        }
    }
    if (current.length > 0) {
        stanzas.push(current);
    }
    return stanzas;
}

export function field(stanza: Stanza, name: string): string | undefined {
    const wanted = name.toLowerCase();
    return stanza.find(([key]) => key.toLowerCase() === wanted)?.[1];
}

export function formatStanza(stanza: Stanza): string {
    let text = "";
    for (const [name, value] of stanza) {
        text += value.length === 0 || value[0] === "\n" ? `${ name }:${ value }\n` : `${ name }: ${ value }\n`;
    }
    return text;
}

/** Anything but white space after the signature block; such bytes would be stored with the file */
export function hasTextAfterSignature(text: string): boolean {
    const normalized = normalize(text);
    const end = normalized.indexOf(END_SIGNATURE);
    return end >= 0 && normalized.slice(end + END_SIGNATURE.length).trim().length > 0;
}

export function isClearsigned(text: string): boolean {
    return normalize(text).startsWith(BEGIN_SIGNED);
}

export function stripClearsign(text: string): string {
    const normalized = normalize(text);
    if (!normalized.startsWith(BEGIN_SIGNED)) {
        return normalized;
    }
    const headersEnd = normalized.indexOf("\n\n", BEGIN_SIGNED.length - 1);
    const signature = headersEnd < 0 ? -1 : normalized.indexOf(BEGIN_SIGNATURE, headersEnd + 1);
    if (signature < 0) {
        throw new RepoValidationError("Clearsigned text without a signature block");
    }
    return normalized.slice(headersEnd + 2, signature + 1).split("\n")
        .map(line => line.startsWith("- ") ? line.slice(2) : line)
        .join("\n");
}

export function parseFileList(value: string, withSectionPriority: boolean): ListedFile[] {
    const files: ListedFile[] = [];
    const columns = withSectionPriority ? 5 : 3;
    for (const line of value.split("\n")) {
        const parts = line.trim().split(" ").filter(part => part.length > 0);
        if (parts.length === 0) {
            continue;
        }
        const size = parts.length === columns ? Number(parts[1]) : NaN;
        if (!Number.isInteger(size) || size < 0) {
            throw new RepoValidationError(`Malformed file list line: ${ line.trim() }`);
        }
        files.push(withSectionPriority
            ? { name: parts[4], size, hash: parts[0], section: parts[2], priority: parts[3] }
            : { name: parts[2], size, hash: parts[0] });
    }
    return files;
}
