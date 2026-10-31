import fs from "node:fs/promises";
import { caseChecker } from "../../backend/case-conflict.ts";
import type { Digests } from "../../backend/hash.ts";
import { getBackend } from "../../backend/index.ts";
import { move } from "../../lib/fs.ts";
import lock from "../../lib/lock.ts";
import logger from "../../lib/logger.ts";

export type StagedUpload = {
    tempPath: string;
    stagingDir: string;
    targetDir: string;
    targetPath: string;
    /** The row key: the staged path relative to the staging root, posix */
    relPath: string;
    /** The same as the client spelled it, for a refusal */
    sentPath: string;
    repoStateDir: string;
    digests: Digests;
};

/** The last run per key, settled; the next run of that key starts after it */
const inFlight = new Map<string, Promise<void>>();

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const result = (inFlight.get(key) ?? Promise.resolve()).then(fn);
    const settled = result.then(() => undefined, () => undefined);
    inFlight.set(key, settled);
    void settled.then(() => {
        if (inFlight.get(key) === settled) {
            inFlight.delete(key);
        }
    });
    return result;
}

/**
 * Moves the finished upload to its staged path and records its digests for the importer. Uploads of one name, in any
 * case, run one after another: fsExtra.move(overwrite) is remove+rename, so a concurrent one could be statted in place of
 * this one, and on Windows another case would replace the staged file unnoticed.
 * The row is best-effort, the import hashes a file without one.
 */
export function stageUpload(u: StagedUpload): Promise<void> {
    return lock.forMove(() => serialized(u.targetPath.toLowerCase(), async () => {
        await caseChecker(u.stagingDir)([u.relPath], () => u.sentPath);
        await move(u.tempPath, u.targetDir, u.targetPath);
        try {
            // The importer trusts the row while size and mtime of the staged file match, so stat it after the move
            getBackend(u.repoStateDir).recordStagedDigest(u.relPath, await fs.stat(u.targetPath), u.digests);
        } catch (err: unknown) {
            logger.warn(`Failed to record checksums of ${ u.targetPath }, the import will hash it`, { err });
        }
    }));
}
