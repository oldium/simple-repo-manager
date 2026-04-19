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
import logger from "./logger.ts";
import { matchesSourceIdentity, sourceIdentityOf, streamPackages } from "./rpm-metadata.ts";

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

export default async function processIncoming(paths: Paths, gpg: Gpg): Promise<Record<string, ActionResult>> {
    assert(paths.createrepoScript, "createrepoScript is not available");

    const incomingRpmRoot = path.join(paths.incomingDir, "process", "rpm");

    const result: Record<string, ActionResult> = {};

    // noinspection SpellCheckingInspection
    const rpmFiles = await glob("*/*/*.rpm", { cwd: incomingRpmRoot, posix: true, nodir: true });
    const rpmMap: Record<string, string[]> = {};

    for (const rpmFile of rpmFiles) {
        const directory = path.dirname(rpmFile);
        (rpmMap[directory] ?? (rpmMap[directory] = [])).push(rpmFile);
    }

    const rpmRepoDir = path.join(paths.repoDir, "rpm");

    // Process new RPMs first
    if (Object.keys(rpmMap).length !== 0) {
        if (!await fsExtra.pathExists(rpmRepoDir)) {
            await fsExtra.ensureDir(rpmRepoDir);
            await gpgInitRpm(paths, gpg);
        }
        for (const [directory, rpmFiles] of Object.entries(rpmMap)) {
            const targetBaseDir = path.join(rpmRepoDir, directory);
            const targetPackageRootDir = path.join(targetBaseDir, "Packages");
            for (const rpmFile of rpmFiles) {
                const targetPackageDir = path.join(targetPackageRootDir, path.basename(rpmFile)[0]);
                await fsExtra.ensureDir(targetPackageDir);
                await fsExtra.move(
                    path.join(incomingRpmRoot, rpmFile),
                    path.join(targetPackageDir, path.basename(rpmFile)),
                    { overwrite: true });
            }
            result[`rpm/${ directory }`] = await exec(paths.createrepoScript, targetBaseDir, paths.signScript ?? "");
        }
    }

    // Rescan also the rest of the RPM repositories to possibly re-try indexing
    const rpmDirs = await glob("*/*/", { cwd: rpmRepoDir, posix: true });
    for (const directory of rpmDirs) {
        const resultDir = `rpm/${ directory }`;
        const targetBaseDir = path.join(rpmRepoDir, directory);
        if (result[resultDir] === undefined && await isDirNonempty(targetBaseDir)) {
            result[resultDir] = await exec(paths.createrepoScript, targetBaseDir, paths.signScript ?? "");
        }
    }

    return result;
}

export type RpmRemovalFile = {
    filename: string;
    status: "ok" | "failed";
    path: string;
};

export type RpmRemovalResult =
    | { notFound: true }
    | { notFound: false; files: RpmRemovalFile[]; action?: ActionResult };

export async function removePackage(
    paths: Paths,
    distro: string,
    release: string,
    source: string,
    version: string
): Promise<RpmRemovalResult> {
    assert(paths.createrepoScript, "createrepoScript is not available");

    const releaseDir = path.join(paths.repoDir, "rpm", distro, release);
    if (!await fsExtra.pathExists(releaseDir)) {
        return { notFound: true };
    }

    const input = `${ source }-${ version }`;
    const matched: { href: string; filename: string }[] = [];
    const seenLetterDirs = new Set<string>();

    for await (const pkg of streamPackages(releaseDir)) {
        const identity = sourceIdentityOf(pkg);
        if (identity && matchesSourceIdentity(input, identity)) {
            matched.push({ href: pkg.href, filename: path.basename(pkg.href) });
            seenLetterDirs.add(path.dirname(pkg.href));
        }
    }

    if (matched.length === 0) {
        return { notFound: false, files: [] };
    }

    const files: RpmRemovalFile[] = [];
    for (const hit of matched) {
        const absPath = path.join(releaseDir, hit.href);
        try {
            await fs.unlink(absPath);
            files.push({
                filename: hit.filename,
                status: "ok",
                path: path.posix.join("rpm", distro, release, hit.href)
            });
        } catch (err) {
            logger.warn(`Failed to remove ${ absPath }`, { err });
            files.push({
                filename: hit.filename,
                status: "failed",
                path: path.posix.join("rpm", distro, release, hit.href)
            });
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
