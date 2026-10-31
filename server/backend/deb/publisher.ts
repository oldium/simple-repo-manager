import osPath from "path";
import path from "path/posix";
import fs from "fs/promises";
import type { Database, Statement } from "node:sqlite";
import { repoFile } from "../context.ts";
import type { BackendContext } from "../context.ts";
import { KEYS_END_SQL } from "../chunked.ts";
import type { IndexSource } from "../chunked.ts";
import { hashFile } from "../hash.ts";
import { IndexPublisher, releaseCells } from "../index-publish.ts";
import type { IndexRow, PublishedRow } from "../index-publish.ts";
import { clearsign, detachedSignature, verifyClearsigned, verifyDetached } from "../pgp.ts";
import { errorCode, readQuietly, removeQuietly, writeFileAtomic } from "../publish-fs.ts";
import { contentsRecords } from "./contents.ts";
import { getEnv } from "../../lib/env.ts";
import logger from "../../lib/logger.ts";
import { RELEASE_FILES } from "../../lib/validations.ts";

export type ReleaseInfo = {
    distro: string; release: string; origin?: string; description?: string; date: Date; architectures: string[]; components: string[];
};

export type ReleaseFile = { name: string; size: number; md5: string; sha256: string };

type IndexKind = "packages" | "debug" | "installer" | "sources" | "contents" | "contents-udeb";

/** The order in which Release lists the indexes of a component */
const KIND_ORDER: IndexKind[] = ["packages", "debug", "installer", "sources", "contents", "contents-udeb"];

const BINARY_KINDS: Partial<Record<IndexKind, string>> = { packages: "deb", debug: "ddeb", installer: "udeb" };

type ReleaseRow = { id: number; distro: string; name: string; published_date: number | null; origin: string | null; description: string | null };

type ReleaseName = Pick<ReleaseRow, "distro" | "name">;

function prepareStatements(db: Database) {
    return {
        listReleases: db.prepare("SELECT id, distro, name, published_date, origin, description FROM releases WHERE format = 'deb' ORDER BY distro, name"),
        binaryRecords: db.prepare(`
            SELECT sort_key, stanza FROM deb_binaries WHERE release_id = ?1 AND component = ?2 AND kind = ?3 AND architecture IN (?4, 'all')
                AND sort_key >= ?5 AND sort_key < coalesce(?6, ${ KEYS_END_SQL }) ORDER BY sort_key`),
        sourceRecords: db.prepare(`
            SELECT sort_key, stanza FROM deb_sources WHERE release_id = ?1 AND component = ?2 AND sort_key >= ?3
                AND sort_key < coalesce(?4, ${ KEYS_END_SQL }) ORDER BY sort_key`),
        updateRelease: db.prepare("UPDATE releases SET published_date = ?, origin = ?, description = ? WHERE id = ?"),
    };
}

/** Directory of an index below dists/<release> and its name without the compression suffix */
function indexLocation(kind: IndexKind, component: string, architecture: string): { dir: string; name: string } {
    switch (kind) {
        case "packages":
            return { dir: `${ component }/binary-${ architecture }`, name: "Packages" };
        case "debug":
            return { dir: `${ component }/debug/binary-${ architecture }`, name: "Packages" };
        case "installer":
            return { dir: `${ component }/debian-installer/binary-${ architecture }`, name: "Packages" };
        case "sources":
            return { dir: `${ component }/source`, name: "Sources" };
        case "contents":
            return { dir: component, name: `Contents-${ architecture }` };
        case "contents-udeb":
            return { dir: component, name: `Contents-udeb-${ architecture }` };
        default:
            throw new Error(`Unknown index kind ${ kind as string }`);
    }
}

/** The MD5Sum by-hash twin of a stored SHA256 by-hash file */
export function md5LinkPath(storedPath: string, md5: string): string {
    return `${ path.dirname(path.dirname(storedPath)) }/MD5Sum/${ md5 }`;
}

function distsPath(r: ReleaseName): string {
    return `deb/${ r.distro }/dists/${ r.name }`;
}

function releaseFilePaths(r: ReleaseName): string[] {
    return RELEASE_FILES.map(name => `${ distsPath(r) }/${ name }`);
}

/** The canonical name of an index below repoDir */
function canonicalPath(r: ReleaseName, index: Pick<IndexRow<IndexKind>, "kind" | "component" | "architecture">): string {
    const { dir, name } = indexLocation(index.kind, index.component, index.architecture);
    return `${ distsPath(r) }/${ dir }/${ name }.gz`;
}

/** Every name a current release publishes below repoDir: Release and its signatures, the indexes' canonical names, stored files and MD5Sum twins */
export function debPublishedPaths(db: Database, distro: string, name: string): string[] {
    const cells = releaseCells<IndexKind>(db, "deb", distro, name);
    return cells.length === 0 ? [] : [
        ...releaseFilePaths({ distro, name }),
        ...cells.flatMap(cell => [
            canonicalPath({ distro, name }, cell),
            ...cell.stored_path === null ? [] : [cell.stored_path, md5LinkPath(cell.stored_path, cell.md5 as string)],
        ]),
    ];
}

/** The names the publisher writes below dists/<release>: Contents only directly in a component directory */
function ownedIndexName(segments: string[], name: string, components: Set<string>): boolean {
    const parent = segments[segments.length - 1] ?? "";
    return (name === "Packages.gz" && parent.startsWith("binary-")) || (name === "Sources.gz" && parent === "source")
        || (name.startsWith("Contents-") && name.endsWith(".gz") && components.has(segments.join("/")));
}

function formatDate(date: Date): string {
    const utc = date.toUTCString();
    return `${ utc.slice(0, utc.lastIndexOf(" ") + 1) }UTC`;
}

export function renderRelease(r: ReleaseInfo, files: ReleaseFile[]): string {
    const lines: string[] = [];
    if (r.origin !== undefined) {
        lines.push(`Origin: ${ r.origin }`);
    }
    lines.push(`Suite: ${ r.release }`, `Codename: ${ r.release }`, `Date: ${ formatDate(r.date) }`, "Acquire-By-Hash: yes");
    if (r.architectures.length > 0) {
        lines.push(`Architectures: ${ r.architectures.join(" ") }`);
    }
    lines.push(`Components: ${ r.components.join(" ") }`);
    if (r.description !== undefined) {
        lines.push(`Description: ${ r.description }`);
    }
    lines.push("MD5Sum:", ...files.map(f => ` ${ f.md5 } ${ f.size } ${ f.name }`));
    lines.push("SHA256:", ...files.map(f => ` ${ f.sha256 } ${ f.size } ${ f.name }`));
    return `${ lines.join("\n") }\n`;
}

function envValue(prefix: string, distro: string, release: string): string | undefined {
    const value = getEnv(prefix, distro, release)?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
}

function sortedUnique(values: string[]): string[] {
    return [...new Set(values)].sort();
}

/** The concrete architectures, or "all" while a release has nothing else */
function architecturesOf(rows: PublishedRow<IndexKind>[]): string[] {
    const all = sortedUnique(rows.filter(r => r.architecture !== "").map(r => r.architecture));
    const concrete = all.filter(a => a !== "all");
    return concrete.length > 0 ? concrete : all;
}

/** Raw and .gz entry of every index, per component in KIND_ORDER; rows arrive ordered by architecture */
function releaseFiles(rows: PublishedRow<IndexKind>[]): ReleaseFile[] {
    const files: ReleaseFile[] = [];
    for (const component of sortedUnique(rows.map(r => r.component))) {
        for (const kind of KIND_ORDER) {
            for (const row of rows.filter(r => r.component === component && r.kind === kind)) {
                const { dir, name } = indexLocation(row.kind, row.component, row.architecture);
                files.push({ name: `${ dir }/${ name }`, size: row.raw_size, md5: row.raw_md5, sha256: row.raw_sha256 });
                files.push({ name: `${ dir }/${ name }.gz`, size: row.size, md5: row.md5, sha256: row.sha256 });
            }
        }
    }
    return files;
}

function stanzaRecords(select: Statement, params: (string | number)[]): IndexSource {
    return function* (start, end) {
        for (const row of select.iterate(...params, start, end ?? null)) {
            yield { key: row.sort_key as string, text: `${ row.stanza as string }\n` };
        }
    };
}

class DebPublisher {
    private readonly ctx: BackendContext;
    private readonly db: Database;
    private readonly s: ReturnType<typeof prepareStatements>;
    private readonly indexes: IndexPublisher;

    constructor(ctx: BackendContext) {
        this.ctx = ctx;
        this.db = ctx.db;
        this.s = prepareStatements(ctx.db);
        this.indexes = new IndexPublisher(ctx);
    }

    releases(): ReleaseRow[] {
        return this.s.listReleases.all() as ReleaseRow[];
    }

    /** Publishes the pending indexes of the release and, when anything changed, its Release; true when it did */
    async publishRelease(r: ReleaseRow): Promise<boolean> {
        const pending = this.indexes.pendingIndexes<IndexKind>(r.id);
        for (const index of pending) {
            await this.publishIndex(r, index);
        }
        const origin = envValue("DEB_ORIGIN", r.distro, r.name);
        const description = envValue("DEB_DESCRIPTION", r.distro, r.name);
        if (pending.length === 0 && origin === (r.origin ?? undefined) && description === (r.description ?? undefined)) {
            return false;
        }
        const rows = this.indexes.publishedIndexes<IndexKind>(r.id);
        if (rows.length === 0) {
            return false;
        }
        await this.removeOrphans(r, rows);
        await this.writeRelease(r, rows, origin, description);
        logger.info(`Published deb/${ r.distro }/${ r.name }: ${ pending.length } index file(s)`);
        return true;
    }

    /**
     * Repairs canonical names, Release and signatures from the database; true when anything changed. With no key loaded,
     * keyConfigured keeps existing signatures: the key file is configured but missing, not withdrawn.
     */
    async reconcileRelease(r: ReleaseRow, keyConfigured: boolean): Promise<boolean> {
        const rows = this.indexes.publishedIndexes<IndexKind>(r.id);
        if (rows.length === 0) {
            return false;
        }
        const repairs: string[] = [];
        let relinked = 0;
        for (const row of rows) {
            if (await this.indexes.relink(row, [canonicalPath(r, row)])) {
                relinked++;
            }
        }
        if (relinked > 0) {
            repairs.push(`${ relinked } canonical name(s)`);
        }
        const origin = envValue("DEB_ORIGIN", r.distro, r.name);
        const description = envValue("DEB_DESCRIPTION", r.distro, r.name);
        const dir = repoFile(this.ctx, distsPath(r));
        const current = await readQuietly(osPath.join(dir, "Release"));
        const expected = r.published_date === null ? undefined : this.releaseText(r, rows, origin, description, r.published_date);
        if (current === undefined || current !== expected) {
            await this.removeOrphans(r, rows);
            await this.writeRelease(r, rows, origin, description);
            repairs.push("Release");
        } else if (!await this.signaturesConsistent(dir, current, keyConfigured)) {
            await this.writeSignatures(r, current);
            repairs.push(this.ctx.signingKey === undefined ? "removed signatures" : "signatures");
        }
        if (repairs.length > 0) {
            logger.info(`Repaired deb/${ r.distro }/${ r.name }: ${ repairs.join(", ") }`);
        }
        return repairs.length > 0;
    }

    sweepShadows(): Promise<void> {
        return this.indexes.sweepShadows();
    }

    private publishIndex(r: ReleaseRow, index: IndexRow<IndexKind>): Promise<void> {
        const canonical = canonicalPath(r, index);
        const base = path.dirname(canonical);
        return this.indexes.publish(index, {
            codec: "gzip", source: this.source(r.id, index),
            storedPath: ({ sha256 }) => `${ base }/by-hash/SHA256/${ sha256 }`,
            linkedPaths: (storedPath, md5) => [md5LinkPath(storedPath, md5)],
            canonicalPaths: [canonical],
        });
    }

    private source(releaseId: number, index: IndexRow<IndexKind>): IndexSource {
        const binaryKind = BINARY_KINDS[index.kind];
        if (binaryKind !== undefined) {
            return stanzaRecords(this.s.binaryRecords, [releaseId, index.component, binaryKind, index.architecture]);
        }
        if (index.kind === "sources") {
            return stanzaRecords(this.s.sourceRecords, [releaseId, index.component]);
        }
        return contentsRecords(this.db, index.id);
    }

    private releaseText(r: ReleaseRow, rows: PublishedRow<IndexKind>[], origin: string | undefined, description: string | undefined, date: number): string {
        return renderRelease({
            distro: r.distro, release: r.name, origin, description, date: new Date(date * 1000),
            architectures: architecturesOf(rows), components: sortedUnique(rows.map(row => row.component)),
        }, releaseFiles(rows));
    }

    private async writeRelease(r: ReleaseRow, rows: PublishedRow<IndexKind>[], origin: string | undefined, description: string | undefined): Promise<void> {
        const date = Math.max(this.ctx.now(), (r.published_date ?? 0) + 1);
        const text = this.releaseText(r, rows, origin, description, date);
        const dir = repoFile(this.ctx, distsPath(r));
        await fs.mkdir(dir, { recursive: true });
        await writeFileAtomic(osPath.join(dir, "Release"), text);
        await this.writeSignatures(r, text);
        // Origin/Description count as published only once on disk, so a failed write is retried by the next publish
        this.s.updateRelease.run(date, origin ?? null, description ?? null, r.id);
    }

    private async writeSignatures(r: ReleaseRow, text: string): Promise<void> {
        const dir = repoFile(this.ctx, distsPath(r));
        const key = this.ctx.signingKey;
        if (key === undefined) {
            // Signatures of an earlier key would no longer match
            await removeQuietly(osPath.join(dir, "Release.gpg"));
            await removeQuietly(osPath.join(dir, "InRelease"));
        } else {
            await writeFileAtomic(osPath.join(dir, "Release.gpg"), await detachedSignature(text, key));
            await writeFileAtomic(osPath.join(dir, "InRelease"), await clearsign(text, key));
        }
        this.indexes.unsupersede(releaseFilePaths(r));
    }

    /** With a key, InRelease and Release.gpg both verify the text with it; without one, neither exists */
    private async signaturesConsistent(dir: string, text: string, keyConfigured: boolean): Promise<boolean> {
        const key = this.ctx.signingKey;
        if (key === undefined && keyConfigured) {
            // The key file is missing: what an earlier run signed stays as it is
            return true;
        }
        const inRelease = await readQuietly(osPath.join(dir, "InRelease"));
        const releaseGpg = await readQuietly(osPath.join(dir, "Release.gpg"));
        if (key === undefined) {
            return inRelease === undefined && releaseGpg === undefined;
        }
        return inRelease !== undefined && releaseGpg !== undefined
            && await verifyClearsigned(inRelease, text, key) && await verifyDetached(text, releaseGpg, key);
    }

    /** Canonical names and MD5Sum links of cells the catalog dropped; their stored files are superseded and left to GC */
    private async removeOrphans(r: ReleaseRow, rows: PublishedRow<IndexKind>[]): Promise<void> {
        const expected = new Set(rows.map(row => {
            const { dir, name } = indexLocation(row.kind, row.component, row.architecture);
            return `${ dir }/${ name }.gz`;
        }));
        const components = new Set(rows.map(row => row.component));
        const liveMd5Links = new Set(rows.map(row => md5LinkPath(row.stored_path, row.md5)));
        const base = distsPath(r);
        const root = repoFile(this.ctx, base);
        const walk = async (dir: string, segments: string[]): Promise<void> => {
            for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    if (entry.name !== "by-hash") {
                        await walk(osPath.join(dir, entry.name), [...segments, entry.name]);
                    }
                } else if (entry.isFile() && ownedIndexName(segments, entry.name, components) && !expected.has(path.join(...segments, entry.name))) {
                    const file = osPath.join(dir, entry.name);
                    const { md5 } = await hashFile(file);
                    // An identical live index of another architecture shares the link
                    if (!liveMd5Links.has(path.join(base, ...segments, "by-hash", "MD5Sum", md5))) {
                        await removeQuietly(osPath.join(dir, "by-hash", "MD5Sum", md5));
                    }
                    await removeQuietly(file);
                }
            }
        };
        try {
            await walk(root, []);
        } catch (err) {
            if (errorCode(err) !== "ENOENT") {
                throw err;
            }
        }
    }
}

/**
 * Publishes every index file with dirty keys or at generation 0, then the Release of every release that changed, including
 * one whose Origin/Description env changed. Returns the touched releases as distro/release.
 */
export async function publishDebian(ctx: BackendContext): Promise<string[]> {
    const publisher = new DebPublisher(ctx);
    const touched: string[] = [];
    for (const release of publisher.releases()) {
        if (await publisher.publishRelease(release)) {
            touched.push(`${ release.distro }/${ release.name }`);
        }
    }
    if (touched.length > 0) {
        await publisher.sweepShadows();
    }
    return touched;
}

/**
 * Repairs what a crash or failed write after a commit left, without bumping what is correct: canonical names are
 * linked again to their stored file, a Release that differs from the one the database describes (also through a changed
 * Origin/Description env) is written and signed anew, and signatures are re-signed or removed to match the key. With no
 * key loaded, keyConfigured keeps existing signatures: the key file is configured but missing, not withdrawn. Returns
 * the repaired releases as distro/release.
 */
export async function reconcileDebian(ctx: BackendContext, o: { keyConfigured?: boolean } = {}): Promise<string[]> {
    const publisher = new DebPublisher(ctx);
    const repaired: string[] = [];
    for (const release of publisher.releases()) {
        if (await publisher.reconcileRelease(release, o.keyConfigured ?? false)) {
            repaired.push(`${ release.distro }/${ release.name }`);
        }
    }
    return repaired;
}
