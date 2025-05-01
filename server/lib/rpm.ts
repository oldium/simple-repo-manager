import { glob } from "glob";
import type { Gpg, Paths } from "./config.ts";
import { type ActionResult, exec } from "./exec.ts";
import path from "node:path/posix";
import fsExtra from "fs-extra";
import fs from "node:fs/promises";
import assert from "node:assert";
import { gpgInitRpm } from "./gpg.ts";

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

export default async function processIncoming(paths: Paths, gpg: Gpg): Promise<Record<string, ActionResult>> {
    assert(paths.createrepoScript, "createrepoScript is not available");

    const incomingRpmRoot = path.join(paths.incomingDir, "process", "rpm");

    const result: Record<string, ActionResult> = {};

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
