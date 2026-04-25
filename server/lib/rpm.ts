import { glob } from "glob";
import type { Gpg, Paths } from "./config.ts";
import { type ActionResult, exec } from "./exec.ts";
import path from "node:path/posix";
import fsExtra from "fs-extra";
import fs from "node:fs/promises";
import assert from "node:assert";
import { gpgInitRpm } from "./gpg.ts";
import fg from "fast-glob";
import type { Repository } from "./repo.ts";
import logger, { getCorrelationId } from "./logger.ts";
import { matchesSourceIdentity, sourceIdentityOf, streamPackages } from "./rpm-metadata.ts";
import type { PackageInfo } from "./rpm-metadata.ts";
import type { RemovalFile, RepoFile } from "./repo-types.ts";
import type { ImportFile, ImportFileStatus } from "./repo-service.ts";

export type RpmVersionFilter = string | { any: true };

// Canonical RPM package layout: Packages/<first-character-of-filename>/<filename>.
// Used for both import-time placement and listing/removal path resolution so
// there's one source of truth for the layout.
function packageRelPath(filename: string): string {
    return path.join("Packages", filename[0], filename);
}

function isAnyVersion(v: RpmVersionFilter): v is { any: true } {
    return typeof v !== "string";
}

async function isDirNonempty(path: string): Promise<boolean> {
    try {
        const dir = await fs.opendir(path);
        const entry = await dir.read();
        await dir.close();
        return entry !== null;
    } catch {
        return false;
    }
}

async function hasFile(path: string, mask: string): Promise<boolean> {
    // noinspection LoopStatementThatDoesntLoopJS
    for await (const _ of fg.globStream(mask, { cwd: path, onlyFiles: true })) {
        return true;
    }
    return false;
}

export async function getRepository(repoDir: string): Promise<Repository>;
export async function getRepository(repoDir: string, distro: string): Promise<Repository>;
export async function getRepository(repoDir: string, distro: string, release: string): Promise<Repository>;
export async function getRepository(repoDir: string, distro?: string, release?: string): Promise<Repository> {
    const repoObj: Repository = {
        type: "rpm",
        path: "/rpm",
        distributions: {}
    }
    const rpmRoot = path.join(repoDir, "rpm");
    const rpmDirs = await glob(`${ distro ? distro : "*" }/${ release ? release : "*" }/`, { cwd: rpmRoot, posix: true });
    for (const directory of rpmDirs) {
        const directoryComponents = directory.split(path.sep);
        const [distro, release] = directoryComponents;
        if (await hasFile(path.join(rpmRoot, directory), "*/*/*.rpm")) {
            const distroObj = repoObj.distributions[distro] ?? (repoObj.distributions[distro] = {
                path: path.join(repoObj.path, distro),
                releases: {},
            });
            distroObj.releases[release] = {
                path: path.join(distroObj.path, release),
            };
        }
    }
    return repoObj;
}

export interface StagingRpmDirSnapshot {
    /** directory path relative to `process/rpm/`, forward slashes, "<distro>/<release>" */
    dirRel: string;
    /** basenames of *.rpm files present in this directory */
    files: string[];
}

/**
 * Scan the given rpm staging root and return one entry per `<distro>/<release>`
 * directory that contains `*.rpm` files.
 *
 * Returns `[]` if the root does not exist. Path separators in the returned
 * `dirRel` are forward slashes, matching the project's URL-shape convention.
 */
export async function scanProcessRpmTree(
    incomingRpmRoot: string,
): Promise<StagingRpmDirSnapshot[]> {
    let rpmFiles: string[];
    try {
        rpmFiles = await glob("*/*/*.rpm", { cwd: incomingRpmRoot, posix: true, nodir: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
    }

    const byDir = new Map<string, string[]>();
    for (const rel of rpmFiles) {
        const dirRel = path.dirname(rel);
        const basename = path.basename(rel);
        const list = byDir.get(dirRel) ?? [];
        list.push(basename);
        byDir.set(dirRel, list);
    }

    const snapshots: StagingRpmDirSnapshot[] = [];
    for (const [dirRel, files] of byDir) {
        snapshots.push({ dirRel, files });
    }
    return snapshots;
}

export default async function processIncoming(paths: Paths, gpg: Gpg): Promise<ImportFile[]> {
    assert(paths.createrepoScript, "createrepoScript is not available");

    const incomingRpmRoot = path.join(paths.incomingDir, "process", "rpm");

    // Pre-scan: remember which rpm files are staged under which dir so we can
    // classify each one against the per-dir createrepo outcome.
    const preSnaps = await scanProcessRpmTree(incomingRpmRoot);

    const result: Record<string, ActionResult> = {};
    const rpmRepoDir = path.join(paths.repoDir, "rpm");

    // Process new RPMs first
    if (preSnaps.length !== 0) {
        if (!await fsExtra.pathExists(rpmRepoDir)) {
            await fsExtra.ensureDir(rpmRepoDir);
            await gpgInitRpm(paths, gpg);
        }
        for (const snap of preSnaps) {
            const targetBaseDir = path.join(rpmRepoDir, snap.dirRel);
            for (const filename of snap.files) {
                const targetPath = path.join(targetBaseDir, packageRelPath(filename));
                await fsExtra.ensureDir(path.dirname(targetPath));
                await fsExtra.move(
                    path.join(incomingRpmRoot, snap.dirRel, filename),
                    targetPath,
                    { overwrite: true });
            }
            result[`rpm/${ snap.dirRel }`] = await exec(paths.createrepoScript, targetBaseDir, paths.signScript ?? "");
        }
    }

    // Rescan also the rest of the RPM repositories to possibly re-try indexing.
    // These don't map back to any pre-scan entry, so they never contribute
    // ImportFile rows — they just run for their side-effect on metadata.
    const rpmDirs = await glob("*/*/", { cwd: rpmRepoDir, posix: true });
    for (const directory of rpmDirs) {
        const resultDir = `rpm/${ directory }`;
        const targetBaseDir = path.join(rpmRepoDir, directory);
        if (result[resultDir] === undefined && await isDirNonempty(targetBaseDir)) {
            result[resultDir] = await exec(paths.createrepoScript, targetBaseDir, paths.signScript ?? "");
        }
    }

    // Classify each pre-scan file against its dir's createrepo outcome. The
    // move always happens before createrepo, so the only failure mode per
    // file is "moved to pool but metadata build failed for that dir".
    const sharedCid = getCorrelationId();
    const files: ImportFile[] = [];
    for (const snap of preSnaps) {
        const dirResult = result[`rpm/${ snap.dirRel }`];
        const dirFailed = dirResult !== undefined
            && (dirResult.result === "error" || dirResult.result === "script");

        for (const name of snap.files) {
            const logicalPath = path.join("rpm", snap.dirRel, name);
            let status: ImportFileStatus;
            let reason: string | undefined;
            if (!dirFailed) {
                status = "ok";
            } else {
                status = "failed";
                reason = sharedCid
                    ? `files moved to pool but repository metadata build failed, correlation id=${ sharedCid }`
                    : "files moved to pool but repository metadata build failed";
            }
            files.push({
                filename: name,
                path: logicalPath,
                status,
                ...(reason ? { reason } : {}),
            });
        }
    }

    return files;
}

export type RpmRemovalResult =
    | { notFound: true }
    | { notFound: false; files: RemovalFile[]; action?: ActionResult };

export type RpmListResult =
    | { notFound: true }
    | { notFound: false; files: RepoFile[] };

export async function listPackageFiles(
    paths: Paths,
    distro: string,
    release: string,
    source: string,
    version: RpmVersionFilter
): Promise<RpmListResult> {
    const releaseDir = path.join(paths.repoDir, "rpm", distro, release);
    if (!await fsExtra.pathExists(releaseDir)) {
        return { notFound: true };
    }

    const literalInput = isAnyVersion(version) ? null : `${ source }-${ version }`;

    const actualSources: PackageInfo[] = [];
    const candidatesBySourcerpm = new Map<string, PackageInfo[]>();

    for await (const pkg of streamPackages(releaseDir)) {
        if (pkg.arch === "src") {
            if (pkg.name !== source) continue;
            if (literalInput !== null) {
                const identity = sourceIdentityOf(pkg);
                if (!identity || !matchesSourceIdentity(literalInput, identity)) continue;
            }
            actualSources.push(pkg);
        } else {
            if (!pkg.sourcerpm.startsWith(`${ source }-`)) continue;
            if (!pkg.sourcerpm.endsWith(".src.rpm")) continue;
            const list = candidatesBySourcerpm.get(pkg.sourcerpm) ?? [];
            list.push(pkg);
            candidatesBySourcerpm.set(pkg.sourcerpm, list);
        }
    }

    const actualSourcerpms = new Set<string>();
    for (const src of actualSources) {
        const identity = sourceIdentityOf(src);
        if (identity) actualSourcerpms.add(identity);
    }

    const files: RepoFile[] = [];
    const collect = (pkg: PackageInfo) => {
        const filename = path.basename(pkg.href);
        files.push({
            filename,
            path: path.join("rpm", distro, release, packageRelPath(filename)),
        });
    };

    for (const src of actualSources) collect(src);
    for (const [sourcerpm, bins] of candidatesBySourcerpm) {
        if (!actualSourcerpms.has(sourcerpm)) continue;
        for (const bin of bins) collect(bin);
    }

    return { notFound: false, files };
}

export async function removePackage(
    paths: Paths,
    distro: string,
    release: string,
    source: string,
    version: RpmVersionFilter
): Promise<RpmRemovalResult> {
    assert(paths.createrepoScript, "createrepoScript is not available");

    const list = await listPackageFiles(paths, distro, release, source, version);
    if (list.notFound) return { notFound: true };
    const matched = list.files;

    if (matched.length === 0) {
        return { notFound: false, files: [] };
    }

    const releaseDir = path.join(paths.repoDir, "rpm", distro, release);
    const files: RemovalFile[] = [];
    const seenLetterDirs = new Set<string>();

    for (const hit of matched) {
        const relPath = packageRelPath(hit.filename);
        const absPath = path.join(releaseDir, relPath);
        seenLetterDirs.add(path.dirname(relPath));
        try {
            await fs.unlink(absPath);
            files.push({ filename: hit.filename, status: "ok", path: hit.path });
        } catch (err) {
            logger.warn(`Failed to remove ${ absPath }`, { err });
            files.push({ filename: hit.filename, status: "failed", path: hit.path });
        }
    }

    for (const letterDir of seenLetterDirs) {
        const abs = path.join(releaseDir, letterDir);
        try {
            const entries = await fs.readdir(abs);
            if (entries.length === 0) {
                await fs.rmdir(abs);
            }
        } catch (err) {
            logger.warn(`Failed to clean up ${ abs }`, { err });
        }
    }

    const action = await exec(paths.createrepoScript, releaseDir, paths.signScript ?? "");
    return { notFound: false, files, action };
}

export type RpmTarget = { distribution: string; release: string };

export async function enumerateTargets(
    paths: Paths,
    distro: string | undefined,
    release: string | undefined
): Promise<RpmTarget[]> {
    const rpmRoot = path.join(paths.repoDir, "rpm");
    const distroPat = distro ?? "*";
    const releasePat = release ?? "*";
    const dirs = await glob(`${ distroPat }/${ releasePat }/`, { cwd: rpmRoot, posix: true });

    const targets: RpmTarget[] = [];
    for (const dir of dirs) {
        const [distName, relName] = dir.split(path.sep);
        if (!distName || !relName) continue;
        // Only consider releases that have been indexed at least once.
        if (!await fsExtra.pathExists(path.join(rpmRoot, dir, "repodata", "repomd.xml"))) continue;
        targets.push({ distribution: distName, release: relName });
    }
    return targets;
}

export type RpmSourcePackage = { source: string; version: string };

export async function listSourcePackages(
    paths: Paths,
    distro: string,
    release: string,
    source: string | undefined
): Promise<RpmSourcePackage[]> {
    const releaseDir = path.join(paths.repoDir, "rpm", distro, release);
    if (!await fsExtra.pathExists(releaseDir)) return [];

    const seen = new Map<string, RpmSourcePackage>();
    for await (const pkg of streamPackages(releaseDir)) {
        if (pkg.arch !== "src") continue;
        if (source !== undefined && pkg.name !== source) continue;
        const version = `${ pkg.ver }-${ pkg.rel }`;
        const key = `${ pkg.name }|${ version }`;
        if (!seen.has(key)) {
            seen.set(key, { source: pkg.name, version });
        }
    }
    return Array.from(seen.values());
}
