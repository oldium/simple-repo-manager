import osPath from "path";
import path from "path/posix";
import fs from "fs/promises";
import type { Stats } from "fs";
import type { Database } from "node:sqlite";
import { hashFile } from "./hash.ts";
import type { Digests } from "./hash.ts";
import type { Format } from "./pool.ts";
import { byName, statQuietly } from "./publish-fs.ts";
import { RepoValidationError } from "../lib/errors.ts";
import logger, { getCorrelationId } from "../lib/logger.ts";

/** A directory below process/<format> with files; rel is the import-style path, target what the format reads off the segments */
export type StagingDir<T> = { rel: string; dir: string; files: string[]; target?: T };

type StagedRow = Digests & { mtime_ms: number };

// Package metadata decides pool and index paths and shows up on the browse pages
const SAFE_NAMES = {
    debName: /^[a-z0-9][a-z0-9+.-]+$/,
    debArchitecture: /^[a-z0-9][a-z0-9-]*$/,
    // In a .changes, "source" stands for the source package
    debBinaryArchitecture: /^(?!source$)[a-z0-9][a-z0-9-]*$/,
    rpmName: /^[A-Za-z0-9][A-Za-z0-9._+-]*$/,
};

const UNSAFE_IN_SEGMENT = /[\s\p{Cc}/\\]/u;

function prepareStatements(db: Database) {
    return {
        selectStaged: db.prepare("SELECT size, mtime_ms, md5, sha1, sha256, sha512 FROM staged_digests WHERE rel_path = ?"),
        deleteStaged: db.prepare("DELETE FROM staged_digests WHERE rel_path = ?"),
    };
}

/** Every directory with files below incomingDir/process/<format>, parents first, entries sorted by name */
export async function stagingDirs<T>(incomingDir: string, format: Format, target: (segments: string[]) => T | undefined):
    Promise<StagingDir<T>[]> {

    const root = osPath.join(incomingDir, "process", format);
    const dirs: StagingDir<T>[] = [];
    const walk = async (segments: string[]): Promise<void> => {
        const dir = osPath.join(root, ...segments);
        const entries = (await fs.readdir(dir, { withFileTypes: true })).sort(byName);
        const files = entries.filter(e => e.isFile()).map(e => e.name);
        if (files.length > 0) {
            dirs.push({ rel: path.join(format, ...segments), dir, files, target: target(segments) });
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                await walk([...segments, entry.name]);
            }
        }
    };
    if (await statQuietly(root) === undefined) {
        return [];
    }
    await walk([]);
    return dirs;
}

// JSON keeps a hostile value's control characters out of the log
function malformed(what: string, value: string): RepoValidationError {
    return new RepoValidationError(`Malformed ${ what }: ${ JSON.stringify(value) }`);
}

// Names become pool path segments, so a separator or ".." must never get through
export function checkPathSegment(value: string, what: string): void {
    if (value.length === 0 || value === "." || value === ".." || UNSAFE_IN_SEGMENT.test(value)) {
        throw malformed(what, value);
    }
}

export function checkSafeName(kind: keyof typeof SAFE_NAMES, value: string, what: string): void {
    if (!SAFE_NAMES[kind].test(value)) {
        throw malformed(what, value);
    }
}

/** The digests the upload handler recorded for staged files, keyed by the path relative to process/ */
export class StagedDigests {
    private readonly s: ReturnType<typeof prepareStatements>;

    constructor(db: Database) {
        this.s = prepareStatements(db);
    }

    /** The recorded digests, or the file is hashed when the row is missing or stale */
    async digests(relPath: string, file: string, stat: Stats): Promise<Digests> {
        if (!stat.isFile()) {
            throw new RepoValidationError(`${ osPath.basename(file) } is not a file`);
        }
        const row = this.s.selectStaged.get(relPath) as StagedRow | undefined;
        if (row !== undefined && row.size === stat.size && Math.trunc(row.mtime_ms) === Math.trunc(stat.mtimeMs)) {
            return { size: row.size, md5: row.md5, sha1: row.sha1, sha256: row.sha256, sha512: row.sha512 };
        }
        return hashFile(file);
    }

    delete(relPath: string): void {
        this.s.deleteStaged.run(relPath);
    }
}

/** Logs the failure under the correlation id and returns the reason reported for the file */
export function importFailure(relPath: string, err: unknown): string {
    const cid = getCorrelationId();
    const failed = cid === undefined ? "import failed" : `import failed, correlation id=${ cid }`;
    if (err instanceof RepoValidationError) {
        logger.warn(`Import of ${ relPath } failed: ${ err.message }`);
        return `${ failed }: ${ err.message }`;
    }
    // fs and other unexpected errors can name server paths, so only the log gets their cause
    logger.error(`Import of ${ relPath } failed`, { err });
    return failed;
}
