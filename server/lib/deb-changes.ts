// server/lib/deb-changes.ts
//
// Parser for the subset of Debian `.changes` control-file fields that the
// import pipeline needs. Uses indexOf/slice/split — no regex — to match
// the project parsing convention.

export type ParsedChangesMetadata = {
    distributions: string[];
    source?: string;
    version?: string;
    architectures: Set<string>;
    hasDdeb: boolean;
};

/**
 * Return the trimmed value of a single-line control field, or `undefined`
 * if the field is missing. First occurrence wins.
 */
function readControlField(content: string, name: string): string | undefined {
    const header = `${ name }:`;
    let valueStart: number;
    if (content.startsWith(header)) {
        valueStart = header.length;
    } else {
        const idx = content.indexOf(`\n${ header }`);
        if (idx < 0) return undefined;
        valueStart = idx + 1 + header.length;
    }
    const eol = content.indexOf("\n", valueStart);
    return content.slice(valueStart, eol < 0 ? content.length : eol).trim();
}

/**
 * Return the body of the `Files:` field (continuation lines, joined by `\n`,
 * without leading whitespace stripped) or `undefined` when there is no
 * `Files:` header. The block ends at the first blank or non-indented line.
 */
function readFilesBlock(content: string): string | undefined {
    let headerStart: number;
    if (content.startsWith("Files:")) {
        headerStart = 0;
    } else {
        const idx = content.indexOf("\nFiles:");
        if (idx < 0) return undefined;
        headerStart = idx + 1;
    }
    const headerEnd = content.indexOf("\n", headerStart);
    if (headerEnd < 0) return undefined;
    const lines = content.slice(headerEnd + 1).split("\n");
    const stop = lines.findIndex(l =>
        l.length === 0 || (l[0] !== " " && l[0] !== "\t"));
    return (stop < 0 ? lines : lines.slice(0, stop)).join("\n");
}

/**
 * Parse the in-memory contents of a Debian `.changes` file.
 *
 * Trims a trailing PGP signature block (if any) before parsing so that
 * fields inside the signature armor (e.g. `Version: GnuPG v2`) cannot
 * shadow body fields.
 */
export function parseChangesContent(content: string): ParsedChangesMetadata {
    const sigStart = content.indexOf("\n-----BEGIN PGP SIGNATURE-----");
    const body = sigStart < 0 ? content : content.slice(0, sigStart);

    return {
        distributions: (readControlField(body, "Distribution") || "")
            .split(" ").filter(Boolean),
        source: readControlField(body, "Source") || undefined,
        version: readControlField(body, "Version") || undefined,
        architectures: new Set(
            (readControlField(body, "Architecture") || "")
                .split(" ").filter(Boolean),
        ),
        hasDdeb: (readFilesBlock(body) || "")
            .split("\n").some(l => l.trimEnd().endsWith(".ddeb")),
    };
}
