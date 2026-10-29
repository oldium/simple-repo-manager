import osPath from "path";
import path from "path/posix";
import fs from "fs/promises";
import type { Database } from "node:sqlite";
import { repoFile } from "../context.ts";
import type { BackendContext } from "../context.ts";
import { field, parseControl, parseFileList, stripClearsign } from "../control.ts";
import type { Stanza } from "../control.ts";
import type { Digests } from "../hash.ts";
import { moveFile, statQuietly } from "../publish-fs.ts";
import { StagedDigests, checkPathSegment, importFailure, stagingDirs } from "../staging.ts";
import type { StagingDir } from "../staging.ts";
import { DebCatalog } from "./catalog.ts";
import type { DebBinaryInput, DebUploadInput, PoolFile } from "./catalog.ts";
import type { DscFile } from "./inspect.ts";
import { BINARY_KINDS, changesArchitectures, checkSourceVersion, readBinary, readControlFile, readSource, verify } from "./inputs.ts";
import type { Listed } from "./inputs.ts";
import { binarySource, poolDirectory, requiredField } from "./stanzas.ts";
import { RepoValidationError } from "../../lib/errors.ts";
import logger from "../../lib/logger.ts";
import type { ImportFile } from "../../lib/repo-service.ts";

const SKIPPED_REASON = "no .changes file references it";

const CHANGES_CHECKSUMS: [field: string, hash: "sha1" | "sha256"][] = [["Checksums-Sha1", "sha1"], ["Checksums-Sha256", "sha256"]];

type ChangesFile = Listed & { name: string; section: string; priority: string };

/** A listed file with verified digests, found in the staging directory or already in the pool */
type Uploaded = ChangesFile & { file: PoolFile; location: string; staged: boolean };

type Target = { distro: string; release: string; component: string };

type Move = { name: string; poolPath: string };

type Upload = { input: DebUploadInput; moves: Move[] };

type Outcome = { parsed: boolean; moved: string[]; failed: string[]; reason?: string };

function prepareStatements(db: Database) {
    return {
        selectPool: db.prepare("SELECT size, md5, sha1, sha256, sha512 FROM pool_files WHERE path = ?"),
    };
}

function parseChanges(text: string): { stanza: Stanza; files: ChangesFile[] } {
    const stanzas = parseControl(stripClearsign(text));
    if (stanzas.length !== 1) {
        throw new RepoValidationError(`A .changes must hold one stanza, found ${ stanzas.length }`);
    }
    const stanza = stanzas[0];
    const files = new Map<string, ChangesFile>();
    for (const listed of parseFileList(requiredField(stanza, "Files"), true)) {
        checkPathSegment(listed.name, "file name in Files");
        if (files.has(listed.name)) {
            throw new RepoValidationError(`${ listed.name } is listed twice in Files`);
        }
        files.set(listed.name, { name: listed.name, size: listed.size, md5: listed.hash, section: listed.section ?? "", priority: listed.priority ?? "" });
    }
    for (const [fieldName, hash] of CHANGES_CHECKSUMS) {
        const value = field(stanza, fieldName);
        if (value === undefined) {
            continue;
        }
        for (const listed of parseFileList(value, false)) {
            const entry = files.get(listed.name);
            if (entry === undefined || entry.size !== listed.size) {
                throw new RepoValidationError(`${ fieldName } of the .changes does not match Files for ${ listed.name }`);
            }
            entry[hash] = listed.hash;
        }
    }
    return { stanza, files: [...files.values()] };
}

/** The catalog reports a conflict as a bare pool path or as a sentence */
function conflictText(conflict: string): string {
    return conflict.includes(" ") ? conflict : `${ conflict } is in the pool with other content that is still referenced`;
}

/** The component level and below: <distro>/<release>/<component>[/<sub>] */
function targetOf(segments: string[]): Target | undefined {
    const [distro, release, ...component] = segments;
    return component.length > 0 ? { distro, release, component: component.join("/") } : undefined;
}

class DebImporter {
    private readonly ctx: BackendContext;
    private readonly catalog: DebCatalog;
    private readonly staged: StagedDigests;
    private readonly s: ReturnType<typeof prepareStatements>;

    constructor(ctx: BackendContext) {
        this.ctx = ctx;
        this.catalog = new DebCatalog(ctx.db);
        this.staged = new StagedDigests(ctx.db);
        this.s = prepareStatements(ctx.db);
    }

    async importChanges(dir: StagingDir<Target>, target: Target, changesName: string): Promise<Outcome> {
        const moved: string[] = [];
        let claimed = [changesName];
        let parsed = false;
        try {
            const changes = parseChanges(await readControlFile(osPath.join(dir.dir, changesName)));
            parsed = true;
            claimed = [changesName, ...changes.files.map(f => f.name)];
            const upload = await this.readUpload(dir, target, changesName, changes);
            const outcome = this.catalog.applyUpload(upload.input, this.ctx.now());
            if (!outcome.ok) {
                throw new RepoValidationError(outcome.conflicts.map(conflictText).join("; "));
            }
            if (outcome.unreferenced.length > 0) {
                logger.info(`${ dir.rel }/${ changesName } left unreferenced: ${ outcome.unreferenced.join(", ") }`);
            }
            for (const move of upload.moves) {
                await moveFile(osPath.join(dir.dir, move.name), repoFile(this.ctx, move.poolPath));
                this.staged.delete(`${ dir.rel }/${ move.name }`);
                moved.push(move.name);
            }
            return { parsed, moved, failed: [] };
        } catch (err) {
            return { parsed, moved, failed: claimed.filter(name => !moved.includes(name)), reason: importFailure(`${ dir.rel }/${ changesName }`, err) };
        }
    }

    private async readUpload(dir: StagingDir<Target>, target: Target, changesName: string, changes: ReturnType<typeof parseChanges>): Promise<Upload> {
        // Pool acceptance must never rest on md5 and size alone
        for (const listed of changes.files) {
            if (listed.sha256 === undefined) {
                throw new RepoValidationError(`${ listed.name } is not listed in Checksums-Sha256 of the .changes`);
            }
        }
        // binarySource would fall back to Package, which a .changes does not have
        requiredField(changes.stanza, "Source");
        const expected = binarySource(changes.stanza);
        checkSourceVersion(expected, changesName);
        const distributions = requiredField(changes.stanza, "Distribution").split(" ");
        if (!distributions.includes(target.release)) {
            throw new RepoValidationError(`Distribution "${ distributions.join(" ") }" does not contain ${ target.release }`);
        }
        const scope = changesArchitectures(changes.stanza, changesName);
        const poolDir = poolDirectory(target.component, expected.source);
        const poolPathOf = (name: string): string => path.join("deb", target.distro, poolDir, name);

        const uploaded = new Map<string, Uploaded>();
        for (const listed of changes.files) {
            uploaded.set(listed.name, await this.locate(dir, listed, poolPathOf(listed.name)));
        }

        const changesFile = osPath.join(dir.dir, changesName);
        const trackedFiles: PoolFile[] = [{
            path: poolPathOf(changesName), ...await this.staged.digests(`${ dir.rel }/${ changesName }`, changesFile, await fs.stat(changesFile)),
        }];
        const binaries: DebBinaryInput[] = [];
        let dsc: Uploaded | undefined;
        const others: Uploaded[] = [];
        for (const listed of uploaded.values()) {
            const extension = osPath.extname(listed.name);
            const kind = BINARY_KINDS[extension];
            if (kind !== undefined) {
                binaries.push(await readBinary(listed, kind, expected, poolDir));
            } else if (extension === ".dsc") {
                if (dsc !== undefined) {
                    throw new RepoValidationError("The .changes lists more than one .dsc");
                }
                dsc = listed;
            } else if (extension === ".buildinfo") {
                trackedFiles.push(listed.file);
            } else {
                others.push(listed);
            }
        }
        // The catalog would drop the source package of this version with nothing to replace it
        if (dsc === undefined && scope.includes("source")) {
            throw new RepoValidationError("Architecture lists source but no .dsc is listed");
        }
        const fileOf = async (name: string, listed: DscFile): Promise<PoolFile> =>
            uploaded.get(name)?.file ?? await this.fromPool(poolPathOf(name), name, listed, "in the pool does not match the .dsc");
        const source = dsc === undefined ? undefined : await readSource(dsc, expected, poolDir, fileOf);
        for (const listed of others) {
            if (source === undefined || !source.referenced.has(listed.name)) {
                throw new RepoValidationError(`${ listed.name } is neither a package nor referenced by the .dsc`);
            }
        }
        // The .changes goes last: while it is staged, a re-run after an interrupted move completes the bundle
        const moves = [...uploaded.values()].filter(u => u.staged).map(u => u.name);
        moves.push(changesName);
        return {
            input: { ...target, ...expected, scope, changesName, trackedFiles, sourcePackage: source?.sourcePackage, binaries },
            moves: moves.map(name => ({ name, poolPath: poolPathOf(name) })),
        };
    }

    /** A listed file from the staging directory, or from the pool when it is not there (an interrupted earlier move) */
    private async locate(dir: StagingDir<Target>, listed: ChangesFile, poolPath: string): Promise<Uploaded> {
        const location = osPath.join(dir.dir, listed.name);
        const stat = await statQuietly(location);
        if (stat === undefined) {
            const file = await this.fromPool(poolPath, listed.name, listed, "in the pool does not match the .changes");
            // A row left by a crash between the move and its deletion
            this.staged.delete(`${ dir.rel }/${ listed.name }`);
            return { ...listed, file, location: repoFile(this.ctx, poolPath), staged: false };
        }
        const digests = await this.staged.digests(`${ dir.rel }/${ listed.name }`, location, stat);
        verify(listed.name, digests, listed, "does not match the .changes");
        return { ...listed, file: { path: poolPath, ...digests }, location, staged: true };
    }

    private async fromPool(poolPath: string, name: string, listed: Listed, context: string): Promise<PoolFile> {
        const row = this.s.selectPool.get(poolPath) as Digests | undefined;
        if (row === undefined) {
            throw new RepoValidationError(`${ name } is neither uploaded nor in the pool`);
        }
        verify(name, row, listed, context);
        const stat = await statQuietly(repoFile(this.ctx, poolPath));
        if (stat === undefined || !stat.isFile() || stat.size !== row.size) {
            throw new RepoValidationError(`${ name } is missing or damaged in the pool`);
        }
        return { path: poolPath, ...row };
    }
}

/**
 * Imports every .changes below incomingDir/process/deb/<distro>/<release>/<component>[/<sub>]/ and reports each staged file
 * as ok, skipped or failed. Failed and skipped files stay where they are.
 */
export async function importDebian(ctx: BackendContext): Promise<ImportFile[]> {
    const importer = new DebImporter(ctx);
    const result: ImportFile[] = [];
    for (const dir of await stagingDirs(ctx.paths.incomingDir, "deb", targetOf)) {
        const files = new Map<string, ImportFile>(dir.files.map(name =>
            [name, { filename: name, path: `${ dir.rel }/${ name }`, status: "skipped", reason: SKIPPED_REASON }]));
        const report = (names: string[], status: ImportFile["status"], reason?: string): void => {
            for (const name of names) {
                const file = files.get(name);
                if (file !== undefined && file.status !== "ok") {
                    files.set(name, { filename: name, path: file.path, status, ...(reason === undefined ? {} : { reason }) });
                }
            }
        };
        const unparsed: string[] = [];
        if (dir.target !== undefined) {
            for (const name of dir.files.filter(n => n.endsWith(".changes"))) {
                const outcome = await importer.importChanges(dir, dir.target, name);
                report(outcome.moved, "ok");
                report(outcome.failed, "failed", outcome.reason);
                if (!outcome.parsed) {
                    unparsed.push(name);
                }
            }
        }
        // An unparseable .changes may well be the one that references the files left over
        for (const [name, file] of files) {
            if (file.status === "skipped" && unparsed.length > 0) {
                files.set(name, { ...file, reason: `${ SKIPPED_REASON }; ${ unparsed.join(", ") } could not be parsed` });
            }
        }
        result.push(...files.values());
    }
    return result;
}
