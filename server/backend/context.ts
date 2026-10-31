import type { Database } from "node:sqlite";
import type * as openpgp from "openpgp";
import { toOsPath } from "../lib/safe-path.ts";

/** What every backend operation works with; now() is unix seconds, injectable for tests */
export type BackendContext = {
    db: Database;
    paths: { incomingDir: string; repoStateDir: string; repoDir: string };
    signingKey: openpgp.PrivateKey | undefined;
    /** What uploads have to be signed with; without any, signed uploads are only warned about */
    uploadKeys?: openpgp.PublicKey[];
    now(): number;
};

/** The file of a path below repoDir */
export function repoFile(ctx: BackendContext, relPath: string): string {
    return toOsPath(ctx.paths.repoDir, relPath);
}
