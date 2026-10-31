import fs from "fs/promises";
import { errorCode } from "./publish-fs.ts";
import { RepoValidationError } from "../lib/errors.ts";
import { fileNaming } from "../lib/file-naming.ts";
import { checkPosixPath, toOsPath } from "../lib/safe-path.ts";

type ReadDir = (dir: string) => Promise<string[]>;

type Spellings = { exact: Set<string>; folded: Map<string, string> };

/** sentAs: how the client spelled a path, for the refusal */
export type CaseChecker = (relPaths: string[], sentAs?: (relPath: string) => string) => Promise<void>;

function conflictText(relPath: string, other: string): string {
    return `${ relPath } differs only in case from ${ other }, which this file system cannot keep apart`;
}

/** Where case does not count, why these paths, or directories on their way, would reach each other under another case; undefined when none would */
export function caseTwinProblem(relPaths: string[]): string | undefined {
    if (fileNaming().caseSensitive) {
        return undefined;
    }
    const spellings = new Map<string, string>();
    for (const relPath of relPaths) {
        const segments = relPath.split("/");
        for (let depth = 1; depth <= segments.length; depth++) {
            const prefix = segments.slice(0, depth).join("/");
            const other = spellings.get(prefix.toLowerCase());
            if (other !== undefined && other !== prefix) {
                return conflictText(prefix, other);
            }
            spellings.set(prefix.toLowerCase(), prefix);
        }
    }
    return undefined;
}

/** What the directory lists, nothing when there is no such directory */
export async function entryNames(dir: string, readdir: ReadDir = fs.readdir): Promise<string[]> {
    try {
        return await readdir(dir);
    } catch (err) {
        const code = errorCode(err);
        if (code !== "ENOENT" && code !== "ENOTDIR") {
            throw err;
        }
        return [];
    }
}

function toSpellings(names: string[]): Spellings {
    return { exact: new Set(names), folded: new Map(names.map(name => [name.toLowerCase(), name])) };
}

function splitPath(relPath: string): { dir: string; name: string } {
    const at = relPath.lastIndexOf("/");
    return { dir: relPath.slice(0, Math.max(at, 0)), name: relPath.slice(at + 1) };
}

/**
 * Where case does not count, refuses repo-relative paths whose file name would reach an entry of its directory under
 * another case. One listing of that directory answers, so the directories on the way never count, a junction among them
 * neither. One checker reads a directory once, for one run under the writer mutex: what passes counts as there, as the run
 * is about to place it.
 */
export function caseChecker(root: string, readdir: ReadDir = fs.readdir): CaseChecker {
    if (fileNaming().caseSensitive) {
        return async () => undefined;
    }
    const listings = new Map<string, Spellings>();
    const listing = async (dir: string): Promise<Spellings> => {
        let spellings = listings.get(dir);
        if (spellings === undefined) {
            spellings = toSpellings(await entryNames(dir === "" ? root : toOsPath(root, dir), readdir));
            listings.set(dir, spellings);
        }
        return spellings;
    };
    return async (relPaths, sentAs = relPath => relPath) => {
        for (const relPath of relPaths) {
            checkPosixPath(relPath);
        }
        const twin = caseTwinProblem(relPaths);
        if (twin !== undefined) {
            throw new RepoValidationError(twin);
        }
        for (const relPath of relPaths) {
            const { dir, name } = splitPath(relPath);
            const spellings = await listing(dir);
            const found = spellings.folded.get(name.toLowerCase());
            if (found !== undefined && !spellings.exact.has(name)) {
                throw new RepoValidationError(conflictText(sentAs(relPath), dir === "" ? found : `${ dir }/${ found }`));
            }
        }
        for (const relPath of relPaths) {
            const { dir, name } = splitPath(relPath);
            const spellings = await listing(dir);
            spellings.exact.add(name);
            if (!spellings.folded.has(name.toLowerCase())) {
                spellings.folded.set(name.toLowerCase(), name);
            }
        }
    };
}
