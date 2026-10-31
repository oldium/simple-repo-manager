import osPath from "path";
import { renameOverOpenFile } from "./win-rename.ts";
import fs from "fs/promises";
import type { Dirent, Stats } from "fs";
import logger from "../lib/logger.ts";
import { segmentProblem, toPosixPath } from "../lib/safe-path.ts";

function tempName(file: string): string {
    return `${ file }.tmp-${ process.pid }`;
}

/** Whether the file is named as tempName names one: ".tmp-" and the pid's digits end its basename */
export function isTempName(file: string): boolean {
    const name = osPath.basename(file);
    const at = name.lastIndexOf(".tmp-");
    if (at < 0 || at + 5 === name.length) {
        return false;
    }
    for (let i = at + 5; i < name.length; i++) {
        if (name[i] < "0" || name[i] > "9") {
            return false;
        }
    }
    return true;
}

/** The name the temp file stands for; what the limit on names keeps room for does not count */
export function withoutTempSuffix(name: string): string {
    return name.slice(0, name.lastIndexOf(".tmp-"));
}

export function errorCode(err: unknown): string | undefined {
    return (err as NodeJS.ErrnoException).code;
}

export function byName(a: { name: string }, b: { name: string }): number {
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Writes through a temp file in the same directory, so readers see either the old or the complete new content */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
    const tempFile = tempName(file);
    try {
        const handle = await fs.open(tempFile, "w");
        try {
            await handle.writeFile(data);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await replaceFile(tempFile, file);
    } catch (err) {
        await removeQuietly(tempFile);
        throw err;
    }
    await syncDirectory(osPath.dirname(file));
}

/** Parent directories are created; passing storedPath as tempFile only links the canonical paths */
export async function placeFile(tempFile: string, storedPath: string, canonicalPaths: string[]): Promise<void> {
    if (osPath.resolve(tempFile) !== osPath.resolve(storedPath)) {
        await fs.mkdir(osPath.dirname(storedPath), { recursive: true });
        const stored = await statQuietly(storedPath);
        if (stored && stored.size === (await fs.stat(tempFile)).size) {
            await fs.unlink(tempFile);
        } else {
            // The temp file may live on another volume than the repository
            await moveFile(tempFile, storedPath);
        }
    }
    for (const canonicalPath of canonicalPaths) {
        await fs.mkdir(osPath.dirname(canonicalPath), { recursive: true });
        const linkTemp = tempName(canonicalPath);
        // A leftover of a crashed run makes link fail with EEXIST
        await removeQuietly(linkTemp);
        try {
            await linkOrCopy(storedPath, linkTemp);
            await replaceFile(linkTemp, canonicalPath);
            // A POSIX rename over a link to the same file is a no-op that keeps the temp name
            await removeQuietly(linkTemp);
        } catch (err) {
            await removeQuietly(linkTemp);
            throw err;
        }
    }
}

async function linkOrCopy(source: string, target: string): Promise<void> {
    try {
        await fs.link(source, target);
    } catch (err) {
        const code = errorCode(err);
        if (code !== "EPERM" && code !== "EXDEV" && code !== "ENOTSUP") {
            throw err;
        }
        await fs.copyFile(source, target);
    }
}

/** Windows refuses a rename over an open file; deleting it instead frees the name, but leaves it missing until the rename */
async function replaceFile(from: string, to: string): Promise<void> {
    try {
        await fs.rename(from, to);
    } catch (err) {
        if (errorCode(err) !== "EPERM") {
            throw err;
        }
        if (process.platform === "win32" && await renameOverOpenFile(from, to)) {
            return;
        }
        await removeQuietly(to);
        await fs.rename(from, to);
    }
}

export async function removeQuietly(file: string): Promise<void> {
    try {
        await fs.unlink(file);
    } catch (err) {
        if (errorCode(err) !== "ENOENT") {
            throw err;
        }
    }
}

/** Removes the file's parent directories while they are empty, below stopDir and never stopDir itself */
export async function removeEmptyParents(file: string, stopDir: string): Promise<void> {
    const stop = osPath.resolve(stopDir);
    for (let dir = osPath.dirname(osPath.resolve(file)); dir.startsWith(stop + osPath.sep); dir = osPath.dirname(dir)) {
        try {
            await fs.rmdir(dir);
        } catch (err) {
            const code = errorCode(err);
            // A directory still holding entries ends the walk; one already gone does not
            if (code === "ENOTEMPTY" || code === "EEXIST") {
                return;
            }
            if (code !== "ENOENT") {
                throw err;
            }
        }
    }
}

export async function statQuietly(file: string): Promise<Stats | undefined> {
    try {
        return await fs.stat(file);
    } catch (err) {
        if (errorCode(err) !== "ENOENT") {
            throw err;
        }
        return undefined;
    }
}

/** Whether a directory entry can be part of the repository; no URL or repo-relative path could reach any other */
export function isUsableEntry(dir: string, name: string): boolean {
    const problem = segmentProblem(name);
    if (problem !== undefined) {
        logger.warn(`Ignoring an entry of ${ dir }: ${ problem }`);
    }
    return problem === undefined;
}

/** Every file below root as a relative posix path, in name order; directories for which skip(relative path) holds are not entered; none when root is missing */
export async function listFiles(root: string, skip: (rel: string) => boolean = () => false): Promise<string[]> {
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
        let entries: Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (err) {
            if (errorCode(err) !== "ENOENT") {
                throw err;
            }
            return;
        }
        for (const entry of entries.sort(byName).filter(e => isUsableEntry(dir, e.name))) {
            const file = osPath.join(dir, entry.name);
            const rel = toPosixPath(root, file);
            if (entry.isDirectory()) {
                if (!skip(rel)) {
                    await walk(file);
                }
            } else if (entry.isFile() || entry.isSymbolicLink()) {
                files.push(rel);
            }
        }
    };
    await walk(root);
    return files;
}

// NTFS refuses fsync on a directory handle
export async function syncDirectory(dir: string): Promise<void> {
    if (process.platform === "win32") {
        return;
    }
    const handle = await fs.open(dir, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/**
 * rename, or on another device a copy placed next to the target so the pool never shows a partial file; the copy keeps
 * the source's mtime, as a rename would
 */
export async function moveFile(from: string, to: string): Promise<void> {
    await fs.mkdir(osPath.dirname(to), { recursive: true });
    try {
        await replaceFile(from, to);
    } catch (err) {
        if (errorCode(err) !== "EXDEV") {
            throw err;
        }
        // Not by process: a crash leaves the source, so the import at the next start finds this file again and replaces it
        const temp = `${ to }.tmp-0`;
        try {
            await removeQuietly(temp);
            await fs.copyFile(from, temp);
            const { atime, mtime } = await fs.stat(from);
            await fs.utimes(temp, atime, mtime);
            await replaceFile(temp, to);
        } catch (copyErr) {
            await removeQuietly(temp);
            throw copyErr;
        }
        await fs.unlink(from);
    }
}

/** The file's text, undefined when it is missing */
export async function readQuietly(file: string): Promise<string | undefined> {
    try {
        return await fs.readFile(file, "utf8");
    } catch (err) {
        if (errorCode(err) !== "ENOENT") {
            throw err;
        }
        return undefined;
    }
}
