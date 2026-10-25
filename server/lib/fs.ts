import osPath from "path";
import fsExtra from "fs-extra";
import { constants, type Stats } from "fs";
import fs from "fs/promises";
import { Socket } from "node:net";
import crypto from "crypto";
import logger from "./logger.ts";
import { glob } from "glob";

export const Access = {
    ReadOnly: 0,
    Writable: 1,
    // Missing when only a parent like data/ is mounted, then the nearest existing parent must be writable
    Creatable: 2,
} as const;
export type Access = typeof Access[keyof typeof Access];

/** Returns why the process cannot access the path, undefined when it can */
export async function checkAccess(name: string, path: string, access: Access): Promise<string | undefined> {
    const absolutePath = osPath.resolve(path);
    if (access === Access.Creatable) {
        let existing = absolutePath;
        while (!await fsExtra.pathExists(existing) && osPath.dirname(existing) !== existing) {
            existing = osPath.dirname(existing);
        }
        return existing === absolutePath
            ? checkAccess(name, absolutePath, Access.Writable)
            : checkAccess(`${ name } ${ absolutePath } cannot be created, directory`, existing, Access.Writable);
    }
    const writable = access === Access.Writable;
    let stats: Stats | undefined;
    try {
        stats = await fs.stat(absolutePath);
        await fs.access(absolutePath,
            constants.R_OK | (writable ? constants.W_OK : 0) | (stats.isDirectory() ? constants.X_OK : 0));
        return undefined;
    } catch (err) {
        const identity = process.getuid && process.getgid
            ? `UID ${ process.getuid() }, GID ${ process.getgid() }`
            : "the current user";
        const owner = stats
            ? ` (owner ${ stats.uid }:${ stats.gid }, mode ${ (stats.mode & 0o7777).toString(8).padStart(4, "0") })`
            : "";
        const reason = (err as NodeJS.ErrnoException).code ?? String(err);
        return `${ name } ${ absolutePath } is not ${ writable ? "writable" : "readable" } for ${ identity }${ owner }: ${
            reason }`;
    }
}

// Ownership mismatches of mounted volumes are the usual start-up failure, so report owner and mode
export async function requireAccess(name: string, path: string, access: Access): Promise<void> {
    const error = await checkAccess(name, path, access);
    if (error) {
        logger.error(error);
        process.exit(1);
    }
}

/**
 * Moves a temporary file to its final incoming directory.
 * Creates the target directory if it doesn't exist.
 * Throws an error if finalization is in progress or if move fails.
 */
export async function move(tempPath: string, targetDir: string, targetPath: string): Promise<void> {
    try {
        await fsExtra.ensureDir(targetDir);
        await fsExtra.move(tempPath, targetPath, { overwrite: true });
        logger.debug(`Successfully moved ${ osPath.basename(tempPath) } to ${ targetPath }`);
    } catch (err: unknown) {
        throw new Error(`Error moving file ${ tempPath } to ${ targetPath }`, { cause: err });
    }
}

export async function moveAll(src: string, dest: string): Promise<void> {
    let ensuredDir: string | undefined = undefined;
    for (const file of await glob("**/*", { cwd: src, nodir: true })) {
        const srcPath = osPath.join(src, file);
        const destPath = osPath.join(dest, file);
        const destDir = osPath.dirname(destPath);
        if (destDir !== ensuredDir) {
            await fsExtra.ensureDir(destDir);
            ensuredDir = destDir;
        }
        await fsExtra.move(srcPath, destPath, { overwrite: true });
    }
}

export function tempName(socket: Socket, filename: string): string {
    const remoteAddress = socket.remoteAddress;
    const remotePort = socket.remotePort;
    let identifierHash: string;

    if (!remoteAddress || !remotePort) {
        logger.warn('Could not get remote address or port.');
        identifierHash = crypto.randomBytes(16).toString('hex');
    } else {
        const clientIdentifier = `${ remoteAddress }:${ remotePort }`;
        const hash = crypto.createHash('sha1');
        hash.update(clientIdentifier);
        identifierHash = hash.digest('hex');
    }

    // Use the filename from the URL parameter for PUT requests
    const generatedTempFilename = `${ Date.now() }-${ identifierHash }-${ filename }`;
    return generatedTempFilename;
}
