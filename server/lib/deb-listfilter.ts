// server/lib/deb-listfilter.ts
import { posix } from "node:path";

/**
 * reprepro `--list-format` string used by `listPackageFiles`.
 *
 * Four fields per record, TAB-separated, NUL-terminated:
 *   1. ${$type}       — one of "deb" / "ddeb" / "udeb" / "dsc"
 *   2. ${Filename}    — pool-relative path for binaries; empty for source
 *   3. ${Directory}   — pool directory for source; empty for binaries
 *   4. ${Files}       — raw `Files:` control-field body for source;
 *                       empty for binaries
 *
 * TAB is safe as a field separator because no chunk field stored by
 * reprepro contains tabs. NUL is safe as a record separator because
 * Debian control files are text (RFC 822) and cannot contain NUL.
 */
export const LISTFILTER_FORMAT =
    "${$type}\\t${Filename}\\t${Directory}\\t${Files}\\0";

export type ListFilterType = "deb" | "ddeb" | "udeb" | "dsc";

export interface ListFilterEntry {
    type: ListFilterType;
    path: string; // pool-relative, e.g. "pool/main/c/clevis/clevis_22…dsc"
}

export function parseListFilterOutput(stdout: string): ListFilterEntry[] {
    const results: ListFilterEntry[] = [];
    for (const record of stdout.split("\0")) {
        if (record.length === 0) continue;
        const parts = record.split("\t");
        if (parts.length !== 4) {
            throw new Error(
                `malformed listfilter record (expected 4 fields, got ${ parts.length })`,
            );
        }
        const [type, filename, directory, files] = parts;
        if (type === "dsc") {
            for (const line of files.split("\n")) {
                // shape: "[leading-space]<md5> <size> <filename>"
                let start = 0;
                while (start < line.length && line.charCodeAt(start) === 0x20) start++;
                if (start === line.length) continue;                // blank line
                const lastSpace = line.lastIndexOf(" ");
                if (lastSpace < start) continue;                    // malformed — skip
                results.push({
                    type: "dsc",
                    path: posix.join(directory, line.slice(lastSpace + 1)),
                });
            }
        } else if (type === "deb" || type === "ddeb" || type === "udeb") {
            results.push({ type, path: filename });
        }
        // unknown types silently ignored (forward-compat)
    }
    return results;
}

/**
 * reprepro `--list-format` string used by `listSourcePackages`.
 *
 * Two fields per record, TAB-separated, NUL-terminated:
 *   1. ${$source}         — source package name
 *   2. ${$sourceversion}  — source version
 *
 * Same TAB/NUL safety argument as LISTFILTER_FORMAT: Debian source
 * names and versions cannot contain TAB or NUL.
 */
export const SOURCEPKG_LISTFILTER_FORMAT =
    "${$source}\\t${$sourceversion}\\0";

export interface SourcePackageEntry {
    source: string;
    version: string;
}

export function parseSourcePackageListFilterOutput(stdout: string): SourcePackageEntry[] {
    const seen = new Map<string, SourcePackageEntry>();
    for (const record of stdout.split("\0")) {
        if (record.length === 0) continue;
        const parts = record.split("\t");
        if (parts.length !== 2) {
            throw new Error(
                `malformed source-listfilter record (expected 2 fields, got ${ parts.length })`,
            );
        }
        const [source, version] = parts;
        if (source.length === 0 || version.length === 0) {
            throw new Error("malformed source-listfilter record: empty field");
        }
        const key = `${ source }\0${ version }`;
        if (!seen.has(key)) seen.set(key, { source, version });
    }
    return Array.from(seen.values());
}
