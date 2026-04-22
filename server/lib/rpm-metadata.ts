import fs from "node:fs/promises";
import fs_ from "node:fs";
import path from "node:path/posix";
import osPath from "path";
import { decodeXML } from "entities";
import zlib from "node:zlib";
import readline from "node:readline";

export type Compression = "gz" | "zst";

export type PrimaryLocation = {
    path: string;
    compression: Compression;
};

function detectCompression(href: string): Compression {
    if (href.endsWith(".zst")) return "zst";
    if (href.endsWith(".gz")) return "gz";
    throw new Error(`Unsupported primary.xml compression for ${ href }`);
}

export async function resolvePrimaryLocation(releaseDir: string): Promise<PrimaryLocation | null> {
    const repomdPath = osPath.join(releaseDir, "repodata", "repomd.xml");
    let content: string;
    try {
        content = await fs.readFile(repomdPath, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }
        throw err;
    }

    // repomd.xml is tiny (a few KB, buffered in full). Scope the scan to the
    // <data type="primary">…</data> block so a <location> from a sibling
    // <data> entry (e.g. "other", "filelists") cannot be picked up by mistake.
    const block = /<data\s[^>]*\btype="primary"[^>]*>([\s\S]*?)<\/data>/.exec(content);
    if (!block) {
        throw new Error(`No <data type="primary"> entry in ${ repomdPath }`);
    }
    const loc = /<location\s[^>]*\bhref="([^"]*)"/.exec(block[1]);
    if (!loc) {
        throw new Error(`No <location href="..."> under <data type="primary"> in ${ repomdPath }`);
    }
    const href = decodeXML(loc[1]);
    return {
        path: osPath.join(releaseDir, href),
        compression: detectCompression(href)
    };
}

export type PackageInfo = {
    name: string;
    arch: string;
    ver: string;
    rel: string;
    href: string;
    sourcerpm: string;
};

function createDecompressor(compression: Compression): NodeJS.ReadWriteStream {
    switch (compression) {
        case "zst":
            return zlib.createZstdDecompress();
        case "gz":
            return zlib.createGunzip();
    }
}

// Single-alternation regex over each line of primary.xml. Each named group
// identifies which tag fired; marker groups (pkgOpen, pkgClose, metaEnd)
// capture an empty string so their presence in m.groups distinguishes the
// branch. The /g flag lets us iterate multiple matches per line — real
// createrepo_c output has at most one tag per line (so the second exec()
// returns null immediately), but test fixtures and hand-written XML often
// pack <format><rpm:sourcerpm>...</rpm:sourcerpm></format> onto one line.
//
// sourcerpm only matches non-empty content — src packages emit
// <rpm:sourcerpm></rpm:sourcerpm>, and since we init sourcerpm to "" at each
// <package>, the empty form needs no extraction.
//
// No <description> handling is needed: createrepo_c XML-escapes every '<'
// inside description content, so the only raw '<' between <description> and
// </description> is the closing tag itself — which sits at the end of the
// last content line and is skipped by the first-char bail. On the rare line
// where </description> stands alone, none of the alternatives match and we
// skip via exec() === null.
const PRIMARY_LINE_RE = new RegExp("(?:" + [
    "<package\\b(?<pkgOpen>)",
    "<\\/package>(?<pkgClose>)",
    "<name>(?<name>[^<]*)<\\/name>",
    "<arch>(?<arch>[^<]*)<\\/arch>",
    '<version\\s[^>]*\\bver="(?<ver>[^"]*)"\\s+rel="(?<rel>[^"]*)"',
    '<location\\s[^>]*\\bhref="(?<href>[^"]*)"',
    "<rpm:sourcerpm>(?<sourcerpm>[^<]+)<\\/rpm:sourcerpm>",
    "<\\/metadata>(?<metaEnd>)",
].join("|") + ")", "g");

export async function* streamPackages(releaseDir: string): AsyncGenerator<PackageInfo> {
    const primary = await resolvePrimaryLocation(releaseDir);
    if (!primary) {
        return;
    }

    const fileStream = fs_.createReadStream(primary.path);
    const decompressor = createDecompressor(primary.compression);

    // readline's async iterator does not forward upstream errors — if the
    // decompressor rejects a truncated/corrupt stream, readline silently
    // closes. Capture the error via event listeners and rethrow once the
    // iteration completes so callers still see the failure.
    let streamError: Error | null = null;
    const onError = (err: Error) => { if (streamError === null) streamError = err; };
    fileStream.on("error", onError);
    (decompressor as unknown as NodeJS.EventEmitter).on("error", onError);

    fileStream.pipe(decompressor as unknown as NodeJS.WritableStream);

    const rl = readline.createInterface({
        input: decompressor as unknown as NodeJS.ReadableStream,
        crlfDelay: Infinity,
    });

    let current: Partial<PackageInfo> | null = null;
    let sawMetaEnd = false;

    try {
        for await (const rawLine of rl) {
            // Trim leading indentation — createrepo_c indents nested tags,
            // but the tag name always begins at the start of the trimmed line.
            const line = rawLine.charCodeAt(0) === 0x20 ? rawLine.trimStart() : rawLine;
            if (line.length === 0) continue;

            if (line.charCodeAt(0) !== 0x3C) continue;   // not '<'

            // Fast-bail for the bulk of the file: <rpm:entry>, <rpm:provides>,
            // <rpm:license>, etc. never contribute to PackageInfo. Only
            // <rpm:sourcerpm> needs to fall through to the main regex.
            if (line.charCodeAt(1) === 0x72 /* 'r' */ && !line.startsWith("<rpm:sourcerpm")) {
                continue;
            }

            // /g flag: iterate all matches on the line. Real createrepo_c
            // output has at most one tag per line — the second exec() returns
            // null immediately — but hand-written fixtures may pack several.
            // exec() resets lastIndex to 0 on null, so no per-line bookkeeping.
            let m: RegExpExecArray | null;
            while ((m = PRIMARY_LINE_RE.exec(line)) !== null) {
                const g = m.groups!;

                // Handle package-boundary / file-boundary markers first: they
                // can fire regardless of whether we are inside a package.
                if (g.pkgOpen !== undefined) {
                    current = { sourcerpm: "" };
                } else if (g.metaEnd !== undefined) {
                    sawMetaEnd = true;
                } else if (current === null) {
                    // Other tags outside a package block are noise — ignore.
                } else if (g.name !== undefined) {
                    current.name = decodeXML(g.name);
                } else if (g.arch !== undefined) {
                    current.arch = decodeXML(g.arch);
                } else if (g.ver !== undefined) {
                    current.ver = decodeXML(g.ver);
                    current.rel = decodeXML(g.rel!);
                } else if (g.href !== undefined) {
                    current.href = decodeXML(g.href);
                } else if (g.sourcerpm !== undefined) {
                    current.sourcerpm = decodeXML(g.sourcerpm);
                } else if (g.pkgClose !== undefined) {
                    const pkg = current as PackageInfo;
                    if (pkg.name && pkg.arch && pkg.href && pkg.ver !== undefined && pkg.rel !== undefined) {
                        yield pkg;
                    }
                    current = null;
                }
            }
        }
    } finally {
        rl.close();
    }

    if (streamError !== null) throw streamError;
    // Truncation / malformed-input guard: createrepo_c always closes with
    // </metadata>. Absence means the stream was cut off or the file is not
    // a primary.xml at all — surface it rather than silently returning a
    // partial package list.
    if (!sawMetaEnd) {
        throw new Error(`Unexpected end of ${ primary.path }: </metadata> not found`);
    }
}

export function sourceIdentityOf(pkg: PackageInfo): string | null {
    if (pkg.arch === "src") {
        return path.basename(pkg.href);
    }
    return pkg.sourcerpm !== "" ? pkg.sourcerpm : null;
}

export function matchesSourceIdentity(input: string, identity: string): boolean {
    if (input.length === 0) return false;
    const re = new RegExp(`^${ RegExp.escape(input) }(\\.[^.\\s]+)?\\.src\\.rpm$`);
    return re.test(identity);
}
