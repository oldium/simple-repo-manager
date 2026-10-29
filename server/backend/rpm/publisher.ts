import osPath from "path";
import fs from "fs/promises";
import type { Database, Statement } from "node:sqlite";
import { repoFile } from "../context.ts";
import type { BackendContext } from "../context.ts";
import { KEYS_END_SQL } from "../chunked.ts";
import type { IndexSource } from "../chunked.ts";
import { IndexPublisher, releaseCells } from "../index-publish.ts";
import type { IndexRow, PublishedRow } from "../index-publish.ts";
import { detachedSignature, verifyDetached } from "../pgp.ts";
import { readQuietly, removeQuietly, writeFileAtomic } from "../publish-fs.ts";
import { renderRepomd, xmlFooter, xmlHeader } from "./xml.ts";
import type { MetadataKind, RepomdEntry } from "./xml.ts";
import logger from "../../lib/logger.ts";

/** The order in which repomd.xml lists the metadata */
const KIND_ORDER: MetadataKind[] = ["primary", "filelists", "other"];

const REPOMD_FILES = ["repomd.xml", "repomd.xml.asc"];

type ReleaseRow = { id: number; distro: string; name: string; published_date: number | null };

type ReleaseName = Pick<ReleaseRow, "distro" | "name">;

function prepareStatements(db: Database) {
    const records = (kind: MetadataKind): Statement => db.prepare(`
        SELECT sort_key, ${ kind }_xml AS xml FROM rpm_packages WHERE release_id = ?1 AND sort_key >= ?2
            AND sort_key < coalesce(?3, ${ KEYS_END_SQL }) ORDER BY sort_key`);
    return {
        listReleases: db.prepare("SELECT id, distro, name, published_date FROM releases WHERE format = 'rpm' ORDER BY distro, name"),
        countPackages: db.prepare("SELECT count(*) AS n FROM rpm_packages WHERE release_id = ?"),
        records: { primary: records("primary"), filelists: records("filelists"), other: records("other") },
        updateRelease: db.prepare("UPDATE releases SET published_date = ? WHERE id = ?"),
    };
}

/** Name of a metadata file below repodata, as createrepo_c names it */
function metadataName(sha256: string, kind: MetadataKind): string {
    return `${ sha256 }-${ kind }.xml.zst`;
}

function repodataPath(r: ReleaseName): string {
    return `rpm/${ r.distro }/${ r.name }/repodata`;
}

function repomdPaths(r: ReleaseName): string[] {
    return REPOMD_FILES.map(name => `${ repodataPath(r) }/${ name }`);
}

/** Every name a current release publishes below repoDir: repomd.xml, its signature and the metadata files */
export function rpmPublishedPaths(db: Database, distro: string, name: string): string[] {
    const cells = releaseCells<MetadataKind>(db, "rpm", distro, name);
    return cells.length === 0 ? [] : [...repomdPaths({ distro, name }), ...cells.flatMap(cell => cell.stored_path ?? [])];
}

class RpmPublisher {
    private readonly ctx: BackendContext;
    private readonly s: ReturnType<typeof prepareStatements>;
    private readonly indexes: IndexPublisher;

    constructor(ctx: BackendContext) {
        this.ctx = ctx;
        this.s = prepareStatements(ctx.db);
        this.indexes = new IndexPublisher(ctx);
    }

    releases(): ReleaseRow[] {
        return this.s.listReleases.all() as ReleaseRow[];
    }

    /** Publishes the pending metadata of the release and then its repomd.xml; true when there was any */
    async publishRelease(r: ReleaseRow): Promise<boolean> {
        const pending = this.indexes.pendingIndexes<MetadataKind>(r.id);
        if (pending.length === 0) {
            return false;
        }
        const count = (this.s.countPackages.get(r.id) as { n: number }).n;
        for (const index of pending) {
            await this.publishIndex(r, index, count);
        }
        await this.writeRepomd(r, this.indexes.publishedIndexes<MetadataKind>(r.id));
        logger.info(`Published rpm/${ r.distro }/${ r.name }: ${ pending.length } metadata file(s)`);
        return true;
    }

    /**
     * Repairs repomd.xml and its signature from the database; true when anything changed. With no key loaded,
     * keyConfigured keeps an existing signature: the key file is configured but missing, not withdrawn.
     */
    async reconcileRelease(r: ReleaseRow, keyConfigured: boolean): Promise<boolean> {
        const rows = this.indexes.publishedIndexes<MetadataKind>(r.id);
        if (rows.length === 0) {
            return false;
        }
        const dir = repoFile(this.ctx, repodataPath(r));
        const current = await readQuietly(osPath.join(dir, "repomd.xml"));
        const expected = r.published_date === null ? undefined : await this.repomdText(rows, r.published_date);
        let repaired: string;
        if (current === undefined || current !== expected) {
            await this.writeRepomd(r, rows);
            repaired = "repomd.xml";
        } else if (!await this.signatureConsistent(dir, current, keyConfigured)) {
            await this.writeSignature(r, current);
            repaired = this.ctx.signingKey === undefined ? "removed signature" : "signature";
        } else {
            return false;
        }
        logger.info(`Repaired rpm/${ r.distro }/${ r.name }: ${ repaired }`);
        return true;
    }

    sweepShadows(): Promise<void> {
        return this.indexes.sweepShadows();
    }

    private publishIndex(r: ReleaseRow, index: IndexRow<MetadataKind>, count: number): Promise<void> {
        const kind = index.kind;
        return this.indexes.publish(index, {
            codec: "zstd", source: this.source(r.id, kind), header: xmlHeader(kind, count), footer: xmlFooter(kind),
            storedPath: ({ sha256 }) => `${ repodataPath(r) }/${ metadataName(sha256, kind) }`,
        });
    }

    private source(releaseId: number, kind: MetadataKind): IndexSource {
        const select = this.s.records[kind];
        return function* (start, end) {
            for (const row of select.iterate(releaseId, start, end ?? null)) {
                yield { key: row.sort_key as string, text: row.xml as string };
            }
        };
    }

    private async repomdText(rows: PublishedRow<MetadataKind>[], revision: number): Promise<string> {
        const entries: RepomdEntry[] = [];
        for (const kind of KIND_ORDER) {
            for (const row of rows.filter(row => row.kind === kind)) {
                // createrepo_c stamps every entry with its file's mtime
                const { mtimeMs } = await fs.stat(repoFile(this.ctx, row.stored_path));
                entries.push({
                    type: kind, href: `repodata/${ metadataName(row.sha256, kind) }`, sha256: row.sha256, openSha256: row.raw_sha256,
                    size: row.size, openSize: row.raw_size, timestamp: Math.floor(mtimeMs / 1000),
                });
            }
        }
        return renderRepomd(revision, entries);
    }

    private async writeRepomd(r: ReleaseRow, rows: PublishedRow<MetadataKind>[]): Promise<void> {
        const revision = Math.max(this.ctx.now(), (r.published_date ?? 0) + 1);
        const text = await this.repomdText(rows, revision);
        const dir = repoFile(this.ctx, repodataPath(r));
        await fs.mkdir(dir, { recursive: true });
        await writeFileAtomic(osPath.join(dir, "repomd.xml"), text);
        await this.writeSignature(r, text);
        this.s.updateRelease.run(revision, r.id);
    }

    private async writeSignature(r: ReleaseRow, text: string): Promise<void> {
        const dir = repoFile(this.ctx, repodataPath(r));
        const key = this.ctx.signingKey;
        if (key === undefined) {
            // A signature of an earlier key would no longer match
            await removeQuietly(osPath.join(dir, "repomd.xml.asc"));
        } else {
            await writeFileAtomic(osPath.join(dir, "repomd.xml.asc"), await detachedSignature(text, key));
        }
        this.indexes.unsupersede(repomdPaths(r));
    }

    /** With a key, repomd.xml.asc verifies the text with it; without one, it does not exist */
    private async signatureConsistent(dir: string, text: string, keyConfigured: boolean): Promise<boolean> {
        const key = this.ctx.signingKey;
        if (key === undefined && keyConfigured) {
            // The key file is missing: what an earlier run signed stays as it is
            return true;
        }
        const signature = await readQuietly(osPath.join(dir, "repomd.xml.asc"));
        if (key === undefined) {
            return signature === undefined;
        }
        return signature !== undefined && await verifyDetached(text, signature, key);
    }
}

/**
 * Publishes the primary, filelists and other metadata of every release with pending changes, then its repomd.xml.
 * Returns the touched releases as distro/release.
 */
export async function publishRpm(ctx: BackendContext): Promise<string[]> {
    const publisher = new RpmPublisher(ctx);
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
 * Repairs what a crash or failed write after a commit left, without bumping what is correct: a repomd.xml that differs
 * from the one the database describes is written and signed anew, and its signature is re-signed or removed to match the
 * key. With no key loaded, keyConfigured keeps an existing signature: the key file is configured but missing, not
 * withdrawn. Returns the repaired releases as distro/release.
 */
export async function reconcileRpm(ctx: BackendContext, o: { keyConfigured?: boolean } = {}): Promise<string[]> {
    const publisher = new RpmPublisher(ctx);
    const repaired: string[] = [];
    for (const release of publisher.releases()) {
        if (await publisher.reconcileRelease(release, o.keyConfigured ?? false)) {
            repaired.push(`${ release.distro }/${ release.name }`);
        }
    }
    return repaired;
}
