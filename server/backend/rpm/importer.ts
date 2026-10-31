import fs from "fs/promises";
import { caseChecker } from "../case-conflict.ts";
import type { CaseChecker } from "../case-conflict.ts";
import { repoFile } from "../context.ts";
import type { BackendContext } from "../context.ts";
import { moveFile } from "../publish-fs.ts";
import { StagedDigests, checkStagedDirectories, importFailure, stagingDirs } from "../staging.ts";
import { checkRpmSignature } from "../upload-signature.ts";
import type { StagingDir } from "../staging.ts";
import { RpmCatalog } from "./catalog.ts";
import { readRpm } from "./inputs.ts";
import { repoDirectoryName } from "../../lib/file-naming.ts";
import logger from "../../lib/logger.ts";
import type { ImportFile } from "../../lib/repo-service.ts";
import { toOsPath } from "../../lib/safe-path.ts";

const NOT_RPM_REASON = "not an .rpm file";

const WRONG_DEPTH_REASON = "not in a <distro>/<release> directory";

type Target = { distro: string; release: string };

/** Only <distro>/<release> itself */
function targetOf(segments: string[]): Target | undefined {
    return segments.length === 2 ? { distro: repoDirectoryName(segments[0]), release: repoDirectoryName(segments[1]) } : undefined;
}

class RpmImporter {
    private readonly ctx: BackendContext;
    private readonly catalog: RpmCatalog;
    private readonly staged: StagedDigests;
    private readonly checkCase: CaseChecker;

    constructor(ctx: BackendContext) {
        this.ctx = ctx;
        this.catalog = new RpmCatalog(ctx.db);
        this.staged = new StagedDigests(ctx.db);
        this.checkCase = caseChecker(ctx.paths.repoDir);
    }

    /** Catalogs the package and moves it to the pool; returns the failure reason, or undefined when the file is in */
    async importPackage(dir: StagingDir<Target>, target: Target, name: string): Promise<string | undefined> {
        const relPath = `${ dir.rel }/${ name }`;
        try {
            checkStagedDirectories(dir.rel);
            const location = toOsPath(dir.dir, name);
            const stat = await fs.stat(location);
            await checkRpmSignature(location, name, this.ctx.uploadKeys);
            const input = await readRpm(location, name, target, await this.staged.digests(relPath, location, stat), stat);
            await this.checkCase([input.file.path]);
            const outcome = this.catalog.applyPackage(input, this.ctx.now());
            if (outcome.replacedPath !== undefined && outcome.replacedPath !== input.file.path) {
                logger.info(`${ relPath } replaced ${ outcome.replacedPath }`);
            }
            await moveFile(location, repoFile(this.ctx, input.file.path));
            this.staged.delete(relPath);
            return undefined;
        } catch (err) {
            return importFailure(relPath, err);
        }
    }
}

/**
 * Imports every .rpm below incomingDir/process/rpm/<distro>/<release>/ and reports each staged file as ok, skipped or
 * failed. Failed and skipped files stay where they are.
 */
export async function importRpm(ctx: BackendContext): Promise<ImportFile[]> {
    const importer = new RpmImporter(ctx);
    const result: ImportFile[] = [];
    for (const dir of await stagingDirs(ctx.paths.incomingDir, "rpm", targetOf)) {
        for (const name of dir.files) {
            const relPath = `${ dir.rel }/${ name }`;
            if (dir.target === undefined) {
                result.push({ filename: name, path: relPath, status: "skipped", reason: WRONG_DEPTH_REASON });
            } else if (!name.endsWith(".rpm")) {
                result.push({ filename: name, path: relPath, status: "skipped", reason: NOT_RPM_REASON });
            } else {
                const reason = await importer.importPackage(dir, dir.target, name);
                result.push(reason === undefined ? { filename: name, path: relPath, status: "ok" } : { filename: name, path: relPath, status: "failed", reason });
            }
        }
    }
    return result;
}
