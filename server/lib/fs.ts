import osPath from "path";
import fsExtra from "fs-extra";
import { Socket } from "node:net";
import crypto from "crypto";
import logger from "./logger.ts";
import { glob } from "glob";

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
