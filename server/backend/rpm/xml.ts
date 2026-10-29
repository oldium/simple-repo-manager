import type { RpmChangelog, RpmDep, RpmFile, RpmHeader } from "./header.ts";

export type RpmMeta = RpmHeader & { pkgid: string; size: number; mtime: number; href: string };

export type MetadataKind = "primary" | "filelists" | "other";

export type RepomdEntry = { type: MetadataKind; href: string; sha256: string; openSha256: string; size: number; openSize: number; timestamp: number };

/** createrepo_c's default --changelog-limit */
export const CHANGELOG_LIMIT = 10;

// RPMSENSE_PREREQ | SCRIPT_PRE | POSTTRANS | PRETRANS | SCRIPT_POST: the require is needed before the scriptlets run
const RPMSENSE_PRE = 0x6e0;
const RPMSENSE_MISSINGOK = 1 << 19;

const FLAGS: Record<number, string> = { 2: "LT", 4: "GT", 8: "EQ", 10: "LE", 12: "GE" };

const ROOTS: Record<MetadataKind, { element: string; xmlns: string }> = {
    primary: { element: "metadata", xmlns: 'xmlns="http://linux.duke.edu/metadata/common" xmlns:rpm="http://linux.duke.edu/metadata/rpm"' },
    filelists: { element: "filelists", xmlns: 'xmlns="http://linux.duke.edu/metadata/filelists"' },
    other: { element: "otherdata", xmlns: 'xmlns="http://linux.duke.edu/metadata/other"' },
};

type Entry = RpmDep & { pre?: boolean };

type Evr = { epoch: string; version: string; release: string };

const ATTRIBUTE_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "\n": "&#10;", "\t": "&#9;", "\r": "&#13;" };

// What XML 1.0's Char production leaves out; a single one makes a whole metadata file unreadable, and no reference can stand in
const NOT_XML_CHAR = /[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu;

// libxml2 serialisation: text keeps everything raw but & < > and CR
function text(s: string): string {
    return s.replace(NOT_XML_CHAR, "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\r", "&#13;");
}

// Attribute values also escape " LF TAB and every non-ASCII code point as an uppercase hex reference
function attribute(s: string): string {
    // One pass: appending per character holds a cons string each, gigabytes for a long value
    return s.replace(NOT_XML_CHAR, "").replace(/[&<>"\n\t\r]|\P{ASCII}/gu, c => ATTRIBUTE_ESCAPES[c] ?? `&#x${ (c.codePointAt(0) ?? 0).toString(16).toUpperCase() };`);
}

function isDigit(c: string): boolean {
    return c >= "0" && c <= "9";
}

function isAlpha(c: string): boolean {
    return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

function isDigits(s: string): boolean {
    for (const c of s) {
        if (!isDigit(c)) {
            return false;
        }
    }
    return true;
}

function stripLeadingZeros(s: string): string {
    let start = 0;
    while (start < s.length && s[start] === "0") {
        start++;
    }
    return s.slice(start);
}

function flagString(flags: number): string {
    return FLAGS[flags & 0xf] ?? "";
}

/** createrepo_c's cr_str_to_evr; undefined for an epoch that is not a number, which drops the dependency */
function parseEvr(raw: string): Evr | undefined {
    if (raw.length === 0) {
        return { epoch: "", version: "", release: "" };
    }
    let epoch = "0";
    let rest = raw;
    const colon = raw.indexOf(":");
    if (colon >= 0) {
        const prefix = raw.slice(0, colon);
        if (!isDigits(prefix)) {
            return undefined;
        }
        if (prefix.length > 0) {
            epoch = prefix;
        }
        rest = raw.slice(colon + 1);
    }
    const dash = rest.indexOf("-");
    return dash < 0 ? { epoch, version: rest, release: "" } : { epoch, version: rest.slice(0, dash), release: rest.slice(dash + 1) };
}

/** rpm's rpmvercmp */
export function compareRpmVersions(a: string, b: string): number {
    if (a === b) {
        return 0;
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        while (i < a.length && !isDigit(a[i]) && !isAlpha(a[i]) && a[i] !== "~" && a[i] !== "^") {
            i++;
        }
        while (j < b.length && !isDigit(b[j]) && !isAlpha(b[j]) && b[j] !== "~" && b[j] !== "^") {
            j++;
        }
        // tilde sorts before everything, even the end of the string
        if (a[i] === "~" || b[j] === "~") {
            if (a[i] !== "~") {
                return 1;
            }
            if (b[j] !== "~") {
                return -1;
            }
            i++;
            j++;
            continue;
        }
        // caret sorts before everything except the end of the string
        if (a[i] === "^" || b[j] === "^") {
            if (i >= a.length) {
                return -1;
            }
            if (j >= b.length) {
                return 1;
            }
            if (a[i] !== "^") {
                return 1;
            }
            if (b[j] !== "^") {
                return -1;
            }
            i++;
            j++;
            continue;
        }
        if (i >= a.length || j >= b.length) {
            break;
        }
        const numeric = isDigit(a[i]);
        const same = numeric ? isDigit : isAlpha;
        const startA = i;
        const startB = j;
        while (i < a.length && same(a[i])) {
            i++;
        }
        while (j < b.length && same(b[j])) {
            j++;
        }
        let segmentA = a.slice(startA, i);
        let segmentB = b.slice(startB, j);
        if (segmentB.length === 0) {
            return numeric ? 1 : -1;
        }
        if (numeric) {
            segmentA = stripLeadingZeros(segmentA);
            segmentB = stripLeadingZeros(segmentB);
            if (segmentA.length !== segmentB.length) {
                return segmentA.length > segmentB.length ? 1 : -1;
            }
        }
        if (segmentA !== segmentB) {
            return segmentA < segmentB ? -1 : 1;
        }
    }
    if (i >= a.length && j >= b.length) {
        return 0;
    }
    return i >= a.length ? -1 : 1;
}

/** Version of a libc.so.6(GLIBC_2.34)(64bit) style name: from the first digit inside the parentheses, "" without one */
function libcVersion(name: string): string {
    const open = name.indexOf("(");
    const close = name.indexOf(")", open + 1);
    if (open < 0 || close < 0) {
        return "";
    }
    for (let i = open + 1; i < close; i++) {
        if (isDigit(name[i])) {
            return name.slice(i, close);
        }
    }
    return "";
}

/** createrepo_c's cr_is_primary */
function isPrimaryPath(path: string): boolean {
    return path.startsWith("/etc/") || path === "/usr/lib/sendmail" || path.includes("bin/");
}

function depKey(d: RpmDep): string {
    return `${ d.name }\0${ flagString(d.flags) }\0${ d.version ?? "" }`;
}

/** Requires as createrepo_c files them: filtered, with pre flags, MISSINGOK moved to recommends, the highest libc last */
function primaryRequires(m: RpmMeta): { requires: Entry[]; recommends: Entry[] } {
    const shipped = new Set(m.files.map(f => f.path));
    const provided = new Set(m.provides.map(depKey));
    const last = new Map<string, string>();
    const requires: Entry[] = [];
    const recommends: Entry[] = [];
    let libc: Entry | undefined;
    for (const dep of m.requires) {
        if (dep.name.startsWith("rpmlib(")) {
            continue;
        }
        if (dep.name.startsWith("/") && shipped.has(dep.name) && isPrimaryPath(dep.name)) {
            continue;
        }
        if (provided.has(depKey(dep))) {
            continue;
        }
        const pre = (dep.flags & RPMSENSE_PRE) !== 0;
        const key = `${ flagString(dep.flags) }\0${ dep.version ?? "" }\0${ pre }`;
        if (last.get(dep.name) === key) {
            continue;
        }
        // Only plain requires take part in the dedup; recommends carry no pre
        if (dep.name.startsWith("libc.so.6")) {
            if (libc === undefined || compareRpmVersions(libcVersion(dep.name), libcVersion(libc.name)) > 0) {
                libc = { ...dep, pre };
            }
        } else if ((dep.flags & RPMSENSE_MISSINGOK) !== 0) {
            recommends.push({ ...dep });
        } else {
            last.set(dep.name, key);
            requires.push({ ...dep, pre });
        }
    }
    if (libc !== undefined) {
        requires.push(libc);
    }
    return { requires, recommends: [...recommends, ...m.recommends] };
}

function renderEntry(e: Entry): string | undefined {
    const evr = parseEvr(e.version ?? "");
    if (e.name.length === 0 || evr === undefined) {
        return undefined;
    }
    let attributes = ` name="${ attribute(e.name) }"`;
    const flags = flagString(e.flags);
    if (flags.length > 0) {
        attributes += ` flags="${ flags }"`;
        for (const [name, value] of [["epoch", evr.epoch], ["ver", evr.version], ["rel", evr.release]]) {
            if (value.length > 0) {
                attributes += ` ${ name }="${ attribute(value) }"`;
            }
        }
    }
    return `      <rpm:entry${ attributes }${ e.pre ? ' pre="1"' : "" }/>\n`;
}

function renderGroup(name: string, entries: Entry[]): string {
    const rendered = entries.map(renderEntry).filter(e => e !== undefined);
    return rendered.length === 0 ? "" : `    <rpm:${ name }>\n${ rendered.join("") }    </rpm:${ name }>\n`;
}

function versionElement(m: RpmMeta): string {
    return `<version epoch="${ m.epoch }" ver="${ attribute(m.version) }" rel="${ attribute(m.release) }"/>`;
}

function fileElement(f: RpmFile): string {
    return `<file${ f.type === "file" ? "" : ` type="${ f.type }"` }>${ text(f.path) }</file>`;
}

function packageOpening(m: RpmMeta): string {
    return `<package pkgid="${ m.pkgid }" name="${ attribute(m.name) }" arch="${ attribute(m.arch) }">\n  ${ versionElement(m) }\n`;
}

function trimTrailingSpaces(s: string): string {
    let end = s.length;
    while (end > 0 && s[end - 1] === " ") {
        end--;
    }
    return s.slice(0, end);
}

/** The newest CHANGELOG_LIMIT entries, oldest first; equal consecutive times are made increasing */
function changelogEntries(m: RpmMeta): RpmChangelog[] {
    const entries: RpmChangelog[] = [];
    let last = 0;
    for (const c of m.changelogs.slice(0, CHANGELOG_LIMIT)) {
        entries.unshift({ ...c, author: trimTrailingSpaces(c.author) });
        if (c.date === last) {
            let time = c.date;
            for (let k = 1; k < entries.length && entries[k].date === time; k++) {
                time += 1;
                entries[k].date = time;
            }
        }
        last = c.date;
    }
    return entries;
}

export function renderPrimaryPackage(m: RpmMeta): string {
    const { requires, recommends } = primaryRequires(m);
    const groups = renderGroup("provides", m.provides) + renderGroup("requires", requires) + renderGroup("conflicts", m.conflicts)
        + renderGroup("obsoletes", m.obsoletes) + renderGroup("suggests", m.suggests) + renderGroup("enhances", m.enhances)
        + renderGroup("recommends", recommends) + renderGroup("supplements", m.supplements);
    const files = m.files.filter(f => isPrimaryPath(f.path)).map(f => `    ${ fileElement(f) }\n`).join("");
    return [
        '<package type="rpm">',
        `  <name>${ text(m.name) }</name>`,
        `  <arch>${ text(m.arch) }</arch>`,
        `  ${ versionElement(m) }`,
        `  <checksum type="sha256" pkgid="YES">${ m.pkgid }</checksum>`,
        `  <summary>${ text(m.summary) }</summary>`,
        `  <description>${ text(m.description) }</description>`,
        `  <packager>${ text(m.packager) }</packager>`,
        `  <url>${ text(m.url) }</url>`,
        `  <time file="${ m.mtime }" build="${ m.buildTime }"/>`,
        `  <size package="${ m.size }" installed="${ m.installedSize }" archive="${ m.archiveSize }"/>`,
        `  <location href="${ attribute(m.href) }"/>`,
        "  <format>",
        `    <rpm:license>${ text(m.license) }</rpm:license>`,
        `    <rpm:vendor>${ text(m.vendor) }</rpm:vendor>`,
        `    <rpm:group>${ text(m.group) }</rpm:group>`,
        `    <rpm:buildhost>${ text(m.buildHost) }</rpm:buildhost>`,
        `    <rpm:sourcerpm>${ text(m.sourceRpm) }</rpm:sourcerpm>`,
        `    <rpm:header-range start="${ m.headerStart }" end="${ m.headerEnd }"/>`,
        `${ groups }${ files }  </format>`,
        "</package>\n",
    ].join("\n");
}

export function renderFilelistsPackage(m: RpmMeta): string {
    return `${ packageOpening(m) }${ m.files.map(f => `  ${ fileElement(f) }\n`).join("") }</package>\n`;
}

export function renderOtherPackage(m: RpmMeta): string {
    const entries = changelogEntries(m).map(c => `  <changelog author="${ attribute(c.author) }" date="${ c.date }">${ text(c.text) }</changelog>\n`);
    return `${ packageOpening(m) }${ entries.join("") }</package>\n`;
}

export function xmlHeader(kind: MetadataKind, count: number): string {
    const root = ROOTS[kind];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<${ root.element } ${ root.xmlns } packages="${ count }">\n`;
}

export function xmlFooter(kind: MetadataKind): string {
    return `</${ ROOTS[kind].element }>`;
}

export function renderRepomd(revision: number, entries: RepomdEntry[]): string {
    const data = entries.map(e => [
        `  <data type="${ e.type }">`,
        `    <checksum type="sha256">${ e.sha256 }</checksum>`,
        `    <open-checksum type="sha256">${ e.openSha256 }</open-checksum>`,
        `    <location href="${ attribute(e.href) }"/>`,
        `    <timestamp>${ e.timestamp }</timestamp>`,
        `    <size>${ e.size }</size>`,
        `    <open-size>${ e.openSize }</open-size>`,
        "  </data>\n",
    ].join("\n"));
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<repomd xmlns="http://linux.duke.edu/metadata/repo" xmlns:rpm="http://linux.duke.edu/metadata/rpm">',
        `  <revision>${ revision }</revision>`,
        `${ data.join("") }</repomd>\n`,
    ].join("\n");
}
