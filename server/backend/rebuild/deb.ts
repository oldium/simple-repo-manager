import osPath from "path";
import path from "path/posix";
import fs from "fs/promises";
import { promisify } from "util";
import zlib from "zlib";
import type { Database } from "node:sqlite";
import { field, parseControl, parseFileList, stripClearsign } from "../control.ts";
import type { ListedFile, Stanza } from "../control.ts";
import { DebCatalog } from "../deb/catalog.ts";
import type { DebBinaryInput, DebUploadInput, PoolFile } from "../deb/catalog.ts";
import { changesArchitectures, readBinary, readControlFile, readSource } from "../deb/inputs.ts";
import { binarySource, requiredField } from "../deb/stanzas.ts";
import type { SectionPriority } from "../deb/stanzas.ts";
import { hashFile } from "../hash.ts";
import type { Digests } from "../hash.ts";
import { errorCode, listFiles, statQuietly } from "../publish-fs.ts";
import { checkPathSegment } from "../staging.ts";
import { RepoValidationError } from "../../lib/errors.ts";
import logger from "../../lib/logger.ts";

const gunzip = promisify(zlib.gunzip);

const INDEX_BASES = ["Packages", "Sources"] as const;

type IndexKind = DebBinaryInput["kind"] | "source";

/** An index file below dists/<release>, with the cell it belongs to */
type IndexFile = { rel: string; distro: string; release: string; component: string; architecture: string; kind: IndexKind };

type BinaryEntry = { indexPath: string; kind: DebBinaryInput["kind"]; architecture: string; stanza: Stanza; filename: string; poolPath: string; size: number; sha256: string };

type SourceEntry = { indexPath: string; stanza: Stanza; directory: string; dscName: string; files: ListedFile[] };

/** Everything the indexes of one release list for a source version in a component; binaries keyed by pool path */
type Group = { distro: string; release: string; component: string; source: string; version: string; binaries: Map<string, BinaryEntry>; sourcePackage?: SourceEntry };

type Changes = { name: string; file: PoolFile; source: string; version: string; architectures: string[]; files: Map<string, SectionPriority> };

type SourcePackage = { stanza: string; files: PoolFile[] };

function compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

export function problemText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function versionWithoutEpoch(version: string): string {
    return version.slice(version.indexOf(":") + 1);
}

function versionKey(g: Group): string {
    return [g.distro, g.release, g.source, g.version].join("\0");
}

/** The cell of an index directory below dists/<release>: <component>[/debug|/debian-installer]/binary-<arch> or <component>/source */
function cellOf(segments: string[]): { component: string; architecture: string; kind: IndexKind } | undefined {
    const last = segments[segments.length - 1];
    const rest = segments.slice(0, -1);
    if (last === "source") {
        return rest.length > 0 ? { component: rest.join("/"), architecture: "", kind: "source" } : undefined;
    }
    if (last === undefined || !last.startsWith("binary-")) {
        return undefined;
    }
    const architecture = last.slice("binary-".length);
    const parent = rest[rest.length - 1];
    const kind = parent === "debug" ? "ddeb" : parent === "debian-installer" ? "udeb" : "deb";
    const component = (kind === "deb" ? rest : rest.slice(0, -1)).join("/");
    return component.length > 0 && architecture.length > 0 ? { component, architecture, kind } : undefined;
}

function checkRelativePath(value: string, what: string): void {
    for (const segment of value.split("/")) {
        checkPathSegment(segment, what);
    }
}

class DebRebuild {
    private readonly repoDir: string;
    private readonly now: number;
    private readonly problems: string[];
    private readonly catalog: DebCatalog;
    private readonly groups = new Map<string, Group>();
    private readonly digests = new Map<string, Promise<Digests | string>>();
    private readonly binaries = new Map<string, Promise<DebBinaryInput>>();
    private readonly listings = new Map<string, Promise<string[]>>();
    private readonly changes = new Map<string, Promise<Changes | undefined>>();
    private readonly referenced = new Set<string>();

    constructor(db: Database, repoDir: string, now: number, problems: string[]) {
        this.repoDir = repoDir;
        this.now = now;
        this.problems = problems;
        this.catalog = new DebCatalog(db);
    }

    async run(): Promise<void> {
        const indexes = await this.indexFiles();
        for (const index of indexes) {
            this.catalog.ensureCell(index, this.now);
        }
        for (const index of indexes) {
            try {
                await this.readIndex(index);
            } catch (err) {
                this.problem(index.rel, err);
            }
        }
        const shared = this.sharedVersions();
        for (const key of [...this.groups.keys()].sort(compare)) {
            const group = this.groups.get(key) as Group;
            await this.applyGroup(group, shared.has(versionKey(group)));
        }
        if (this.problems.length === 0) {
            await this.warnUnreferenced();
        }
    }

    /** Versions in more than one component of a release: the catalog keys a version by release alone, so one would silently replace the other */
    private sharedVersions(): Set<string> {
        const components = new Map<string, Set<string>>();
        for (const group of this.groups.values()) {
            const key = versionKey(group);
            components.set(key, new Set([...components.get(key) ?? [], group.component]));
        }
        const shared = new Set<string>();
        for (const key of [...components.keys()].sort(compare)) {
            const names = components.get(key) as Set<string>;
            if (names.size > 1) {
                const [distro, release, source, version] = key.split("\0");
                this.problems.push(`deb/${ distro }/dists/${ release }: ${ source } ${ version } is in components ${ [...names].sort(compare).join(", ") }`);
                shared.add(key);
            }
        }
        return shared;
    }

    private location(rel: string): string {
        return osPath.join(this.repoDir, ...rel.split("/"));
    }

    private problem(rel: string, err: unknown): void {
        this.problems.push(`${ rel }: ${ problemText(err) }`);
    }

    /** Packages and Sources of every dists/<release>: the .gz Release lists and apt fetches when present, else the uncompressed file */
    private async indexFiles(): Promise<IndexFile[]> {
        const candidates = new Map<string, string[]>();
        for (const rel of await listFiles(osPath.join(this.repoDir, "deb"), dir => dir.split("/")[1] === "pool" || dir.endsWith("/by-hash"))) {
            const segments = rel.split("/");
            if (segments.length > 4 && segments[1] === "dists" && INDEX_BASES.some(base => segments[segments.length - 1].startsWith(base))) {
                const dir = segments.slice(0, -1).join("/");
                candidates.set(dir, [...candidates.get(dir) ?? [], segments[segments.length - 1]]);
            }
        }
        const indexes: IndexFile[] = [];
        for (const [dir, names] of candidates) {
            const [distro, , release, ...cellSegments] = dir.split("/");
            for (const base of INDEX_BASES) {
                const variants = names.filter(name => name === base || name.startsWith(`${ base }.`));
                if (variants.length === 0) {
                    continue;
                }
                const name = variants.includes(`${ base }.gz`) ? `${ base }.gz` : variants.includes(base) ? base : undefined;
                const cell = cellOf(cellSegments);
                if (name === undefined) {
                    this.problems.push(`deb/${ dir }/${ variants[0] }: neither ${ base } nor ${ base }.gz is there to read`);
                } else if (cell === undefined || (cell.kind === "source") !== (base === "Sources")) {
                    this.problems.push(`deb/${ dir }/${ name }: not in a <component>/binary-<arch> or <component>/source directory`);
                } else {
                    indexes.push({ rel: `deb/${ dir }/${ name }`, distro, release, ...cell });
                }
            }
        }
        return indexes;
    }

    private async readIndex(index: IndexFile): Promise<void> {
        const data = await fs.readFile(this.location(index.rel));
        const text = (index.rel.endsWith(".gz") ? await gunzip(data) : data).toString("utf8");
        for (const stanza of parseControl(text)) {
            try {
                if (index.kind === "source") {
                    this.addSource(index, stanza);
                } else {
                    this.addBinary(index, index.kind, stanza);
                }
            } catch (err) {
                const label = [field(stanza, "Package"), field(stanza, "Version")].filter(v => v !== undefined).join(" ");
                this.problem(index.rel, label.length > 0 ? `${ label }: ${ problemText(err) }` : err);
            }
        }
    }

    private group(index: IndexFile, source: string, version: string): Group {
        const key = [index.distro, index.release, index.component, source, version].join("\0");
        let group = this.groups.get(key);
        if (group === undefined) {
            group = { distro: index.distro, release: index.release, component: index.component, source, version, binaries: new Map() };
            this.groups.set(key, group);
        }
        return group;
    }

    private addBinary(index: IndexFile, kind: DebBinaryInput["kind"], stanza: Stanza): void {
        const architecture = requiredField(stanza, "Architecture");
        const filename = requiredField(stanza, "Filename");
        checkRelativePath(filename, "Filename segment");
        const size = Number(requiredField(stanza, "Size"));
        if (!Number.isInteger(size) || size < 0) {
            throw new RepoValidationError(`Malformed Size: ${ field(stanza, "Size") as string }`);
        }
        const sha256 = requiredField(stanza, "SHA256");
        const built = binarySource(stanza);
        const group = this.group(index, built.source, built.version);
        const poolPath = path.join("deb", index.distro, filename);
        const first = group.binaries.get(poolPath);
        if (first === undefined) {
            group.binaries.set(poolPath, { indexPath: index.rel, kind, architecture, stanza, filename, poolPath, size, sha256 });
        } else if (first.size !== size || first.sha256 !== sha256 || first.kind !== kind || first.architecture !== architecture) {
            throw new RepoValidationError(`${ filename } is listed differently in ${ first.indexPath }`);
        }
    }

    private addSource(index: IndexFile, stanza: Stanza): void {
        const source = requiredField(stanza, "Package");
        const version = requiredField(stanza, "Version");
        const directory = requiredField(stanza, "Directory");
        checkRelativePath(directory, "Directory segment");
        const files = parseFileList(requiredField(stanza, "Checksums-Sha256"), false);
        for (const listed of files) {
            checkPathSegment(listed.name, "file name in Checksums-Sha256");
        }
        const dscs = files.filter(listed => listed.name.endsWith(".dsc"));
        if (dscs.length !== 1) {
            throw new RepoValidationError(`Checksums-Sha256 lists ${ dscs.length } .dsc files`);
        }
        const group = this.group(index, source, version);
        if (group.sourcePackage !== undefined) {
            throw new RepoValidationError(`already listed in ${ group.sourcePackage.indexPath }`);
        }
        group.sourcePackage = { indexPath: index.rel, stanza, directory, dscName: dscs[0].name, files };
    }

    /** The file's digests, hashed once, or why there are none: "missing" or the error */
    private digestsOf(poolPath: string): Promise<Digests | string> {
        let digests = this.digests.get(poolPath);
        if (digests === undefined) {
            digests = this.hash(this.location(poolPath));
            this.digests.set(poolPath, digests);
        }
        return digests;
    }

    private async hash(file: string): Promise<Digests | string> {
        try {
            const stat = await statQuietly(file);
            return stat === undefined ? "missing" : stat.isFile() ? await hashFile(file) : "not a regular file";
        } catch (err) {
            return errorCode(err) ?? problemText(err);
        }
    }

    /** The file's digests when it is there with the size and SHA256 the index names; otherwise a problem */
    private async verified(poolPath: string, size: number, sha256: string, indexPath: string): Promise<Digests | undefined> {
        const digests = await this.digestsOf(poolPath);
        if (typeof digests === "string") {
            this.problems.push(`${ poolPath }: ${ digests }, listed in ${ indexPath }`);
        } else if (digests.size !== size) {
            this.problems.push(`${ poolPath }: size ${ digests.size } on disk, ${ size } in ${ indexPath }`);
        } else if (digests.sha256 !== sha256) {
            this.problems.push(`${ poolPath }: SHA256 does not match ${ indexPath }`);
        } else {
            return digests;
        }
        return undefined;
    }

    private listing(dir: string): Promise<string[]> {
        let names = this.listings.get(dir);
        if (names === undefined) {
            names = listFiles(this.location(dir), () => true);
            this.listings.set(dir, names);
        }
        return names;
    }

    private changesOf(poolPath: string): Promise<Changes | undefined> {
        let changes = this.changes.get(poolPath);
        if (changes === undefined) {
            changes = this.readChanges(poolPath);
            this.changes.set(poolPath, changes);
        }
        return changes;
    }

    /** A .changes that cannot be read belongs to no group: it may concern a version the indexes no longer list */
    private async readChanges(poolPath: string): Promise<Changes | undefined> {
        try {
            const stanzas = parseControl(stripClearsign(await readControlFile(this.location(poolPath))));
            if (stanzas.length !== 1) {
                throw new RepoValidationError(`A .changes must hold one stanza, found ${ stanzas.length }`);
            }
            const stanza = stanzas[0];
            requiredField(stanza, "Source");
            const files = new Map<string, SectionPriority>();
            for (const listed of parseFileList(requiredField(stanza, "Files"), true)) {
                checkPathSegment(listed.name, "file name in Files");
                files.set(listed.name, { section: listed.section ?? "", priority: listed.priority ?? "" });
            }
            const digests = await this.digestsOf(poolPath);
            if (typeof digests === "string") {
                throw new RepoValidationError(digests);
            }
            return {
                name: path.basename(poolPath), file: { path: poolPath, ...digests }, ...binarySource(stanza),
                architectures: changesArchitectures(stanza, path.basename(poolPath)), files,
            };
        } catch (err) {
            logger.warn(`${ poolPath }: ${ problemText(err) }; treated as a file no upload references`);
            return undefined;
        }
    }

    /** The .changes of the source version in the pool directories its files sit in */
    private async groupChanges(g: Group): Promise<Changes[]> {
        const dirs = new Set([...g.binaries.keys()].map(poolPath => path.dirname(poolPath)));
        if (g.sourcePackage !== undefined) {
            dirs.add(path.join("deb", g.distro, g.sourcePackage.directory));
        }
        const changes: Changes[] = [];
        for (const dir of [...dirs].sort(compare)) {
            for (const name of (await this.listing(dir)).filter(n => n.endsWith(".changes"))) {
                const c = await this.changesOf(`${ dir }/${ name }`);
                if (c !== undefined && c.source === g.source && c.version === g.version) {
                    changes.push(c);
                }
            }
        }
        return changes;
    }

    private binaryInput(entry: BinaryEntry, digests: Digests, sp: SectionPriority): Promise<DebBinaryInput> {
        const expected = binarySource(entry.stanza);
        const key = [entry.poolPath, entry.kind, sp.section, sp.priority, expected.source, expected.version].join("\0");
        let input = this.binaries.get(key);
        if (input === undefined) {
            const name = path.basename(entry.filename);
            input = readBinary({ name, location: this.location(entry.poolPath), file: { path: entry.poolPath, ...digests }, ...sp }, entry.kind, expected,
                path.dirname(entry.filename));
            this.binaries.set(key, input);
        }
        return input;
    }

    /** The source package when every file the index lists is there and the .dsc agrees; problems otherwise */
    private async sourceInput(g: Group, entry: SourceEntry, sp: (name: string, stanza: Stanza) => SectionPriority): Promise<SourcePackage | undefined> {
        const poolDir = path.join("deb", g.distro, entry.directory);
        let complete = true;
        for (const listed of entry.files) {
            if (await this.verified(`${ poolDir }/${ listed.name }`, listed.size, listed.hash, entry.indexPath) === undefined) {
                complete = false;
            }
        }
        if (!complete) {
            return undefined;
        }
        const dscPath = `${ poolDir }/${ entry.dscName }`;
        const fileOf = async (name: string): Promise<PoolFile> => {
            const digests = await this.digestsOf(`${ poolDir }/${ name }`);
            if (typeof digests === "string") {
                throw new RepoValidationError(`${ poolDir }/${ name }: ${ digests }`);
            }
            return { path: `${ poolDir }/${ name }`, ...digests };
        };
        try {
            const dsc = { name: entry.dscName, location: this.location(dscPath), file: await fileOf(entry.dscName), ...sp(entry.dscName, entry.stanza) };
            return (await readSource(dsc, { source: g.source, version: g.version }, entry.directory, fileOf)).sourcePackage;
        } catch (err) {
            this.problem(dscPath, err);
            return undefined;
        }
    }

    /** The .buildinfo files the .changes lists, when they are in its pool directory */
    private async buildinfos(c: Changes): Promise<PoolFile[]> {
        const files: PoolFile[] = [];
        for (const name of [...c.files.keys()].filter(n => n.endsWith(".buildinfo")).sort(compare)) {
            const poolPath = `${ path.dirname(c.file.path) }/${ name }`;
            const digests = await this.digestsOf(poolPath);
            if (typeof digests !== "string") {
                files.push({ path: poolPath, ...digests });
            }
        }
        return files;
    }

    /**
     * One upload per .changes, each carrying the binaries of the architectures in its scope and the source when it lists
     * "source". Wider scopes go first, so a later narrower one re-inserts what it replaces instead of dropping an upload
     * whose scope covers it. Whatever no .changes covers becomes an upload without one.
     */
    private async uploads(g: Group, changes: Changes[], binaries: DebBinaryInput[], sourcePackage: SourcePackage | undefined): Promise<DebUploadInput[]> {
        const base = { distro: g.distro, release: g.release, component: g.component, source: g.source, version: g.version };
        const uploads: DebUploadInput[] = [];
        const covered = new Set<string>();
        for (const c of [...changes].sort((a, b) => b.architectures.length - a.architectures.length || compare(a.name, b.name))) {
            uploads.push({
                ...base, scope: c.architectures, changesName: c.name, trackedFiles: [c.file, ...await this.buildinfos(c)],
                sourcePackage: c.architectures.includes("source") ? sourcePackage : undefined,
                binaries: binaries.filter(b => c.architectures.includes(b.architecture)),
            });
            for (const architecture of c.architectures) {
                covered.add(architecture);
            }
        }
        const rest = binaries.filter(b => !covered.has(b.architecture));
        const restSource = covered.has("source") ? undefined : sourcePackage;
        if (rest.length > 0 || restSource !== undefined) {
            const scope = [...new Set(rest.map(b => b.architecture))];
            if (restSource !== undefined) {
                scope.push("source");
            }
            // Without the .changes suffix the name can never be a real upload's, so only a covering scope replaces this row
            uploads.push({ ...base, scope, changesName: `${ g.source }_${ versionWithoutEpoch(g.version) }`, trackedFiles: [], sourcePackage: restSource, binaries: rest });
        }
        return uploads;
    }

    /** Verifies the group's files and, unless its version is shared between components, catalogs its uploads */
    private async applyGroup(g: Group, shared: boolean): Promise<void> {
        const changes = await this.groupChanges(g);
        const sp = (name: string, stanza: Stanza): SectionPriority =>
            changes.find(c => c.files.has(name))?.files.get(name) ?? { section: field(stanza, "Section") ?? "", priority: field(stanza, "Priority") ?? "" };
        let complete = true;
        const binaries: DebBinaryInput[] = [];
        for (const entry of [...g.binaries.values()].sort((a, b) => compare(a.poolPath, b.poolPath))) {
            const digests = await this.verified(entry.poolPath, entry.size, entry.sha256, entry.indexPath);
            if (digests === undefined) {
                complete = false;
                continue;
            }
            try {
                binaries.push(await this.binaryInput(entry, digests, sp(path.basename(entry.filename), entry.stanza)));
            } catch (err) {
                this.problem(entry.poolPath, err);
                complete = false;
            }
        }
        let sourcePackage: SourcePackage | undefined;
        if (g.sourcePackage !== undefined) {
            sourcePackage = await this.sourceInput(g, g.sourcePackage, sp);
            complete &&= sourcePackage !== undefined;
        }
        if (!complete || shared) {
            return;
        }
        const label = `deb/${ g.distro }/dists/${ g.release }/${ g.component }: ${ g.source } ${ g.version }`;
        for (const upload of await this.uploads(g, changes, binaries, sourcePackage)) {
            const outcome = this.catalog.applyUpload(upload, this.now);
            if (!outcome.ok) {
                this.problems.push(`${ label }: ${ outcome.conflicts.join("; ") }`);
                return;
            }
            // A file left unreferenced has removed_at set, and GC would delete it after the grace: the version is in another
            // component of the release, or two .changes share a scope
            if (outcome.unreferenced.length > 0) {
                this.problems.push(`${ label }: ${ upload.changesName } would unreference ${ outcome.unreferenced.join(", ") }`);
                return;
            }
            for (const file of [...upload.trackedFiles, ...upload.sourcePackage?.files ?? [], ...upload.binaries.map(b => b.file)]) {
                this.referenced.add(file.path);
            }
        }
    }

    private async warnUnreferenced(): Promise<void> {
        for (const rel of await listFiles(osPath.join(this.repoDir, "deb"), dir => dir.split("/")[1] === "dists")) {
            const poolPath = `deb/${ rel }`;
            if (rel.split("/")[1] === "pool" && !this.referenced.has(poolPath)) {
                logger.warn(`${ poolPath }: referenced by no index or upload, left in place`);
            }
        }
    }
}

/**
 * Catalogs every source, binary and upload that the published Debian indexes below repoDir list: membership and the
 * Section/Priority fallback come from the index stanzas, metadata from the pool files themselves, uploads from the .changes
 * in the pool. Every index file keeps its release and cell, with no stanza too. Problems are collected, never thrown; the
 * catalog is left incomplete when there are any.
 */
export async function rebuildDebian(db: Database, repoDir: string, now: number, problems: string[]): Promise<void> {
    await new DebRebuild(db, repoDir, now, problems).run();
}
