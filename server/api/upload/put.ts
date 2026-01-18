import type { Paths, UploadOptions } from "../../lib/config.ts";
import type { Request, RequestHandler, Response } from "express";
import express from "express";
import fs from "fs";
import fsExtra from "fs-extra";
import { move, tempName } from "../../lib/fs.ts";
import { validateDistro, validateFilename } from "../../lib/validations.ts";
import osPath from "path";
import path from "node:path/posix";
import logger from "../../lib/logger.ts";
import { SizeLimitStream } from "../../lib/streams.ts";
import lock from "../../lib/lock/naive.ts";
import { type FileResponse, sendErrorResponse, sendUploadResponse } from "../../lib/res.ts";

interface PutRequestParams {
    distro: string;
    release: string;
    component?: string;
    subcomponent?: string;
    filename: string;
}

class PutHandler {
    private readonly sizeLimit;

    constructor(private paths: Paths, upload: UploadOptions) {
        this.sizeLimit = upload.sizeLimit;
    }

    public middleware(type: string): RequestHandler<PutRequestParams> {
        return this.putHandler.bind(this, type);
    }

    private putHandler(
        type: string,
        req: Request<PutRequestParams>,
        res: Response
    ): void {
        const { distro, release, component, subcomponent, filename } = req.params;

        const distroComponents = [distro, release].concat(
            component ? [component].concat(subcomponent ? [subcomponent] : []) : []);
        if (!validateDistro(type, distroComponents)) {
            logger.warn(`Invalid distro: ${ distroComponents.join('/') }`);
            sendErrorResponse(res, 400, `Unknown or invalid distro: ${ type }/${ distroComponents.join('/') }`);
            return;
        }

        const filePath: Omit<FileResponse, "status"> = {
            filename,
            path: path.join(type, ...distroComponents, filename)
        };

        logger.info(`Received PUT upload request for ${ type }/${ distroComponents.join('/') }: ${ filename }`);

        if (!validateFilename(type, filename)) {
            logger.warn(`Invalid filename: ${ filename }`);
            sendUploadResponse(res, 400, `Invalid filename: ${ filename }`, [{ ...filePath, status: 'failed' }]);
            return;
        }

        // Generate temporary filename using IP:Port (same logic as storage engine)
        const tempPath: string = osPath.join(this.paths.incomingDir, 'tmp', tempName(req.socket, filename));

        const writeStream = fs.createWriteStream(tempPath, {
            flags: 'w',
            encoding: 'binary'
        });

        let sizeLimitStream: SizeLimitStream | undefined = undefined;
        if (this.sizeLimit && this.sizeLimit > 0) {
            sizeLimitStream = new SizeLimitStream(this.sizeLimit);
        }

        // Helper function to clean up the temp file for this PUT request
        const cleanupTempFile = async () => {
            logger.info(`Cleaning up temporary file: ${ tempPath }`);
            await fsExtra.remove(tempPath).catch(cleanupErr => {
                logger.error(`Error cleaning up temporary file ${ tempPath }:`, { err: cleanupErr });
            });
        }

        let response: { status: number, message: string, files: FileResponse[] } | undefined = undefined;

        const maySetResponse = (status: number, message: string, uploadStatus: FileResponse["status"]) => {
            if (!response) {
                response = { status, message, files: [{ ...filePath, status: uploadStatus }] };
            }
        }

        const sendResponse = () => {
            if (!res.headersSent && res.writable) {
                const { status, ...json } = response || { status: 500, message: "Unknown error" };
                res.status(status).json(json);
            }
        }

        const endWritable = () => {
            if (sizeLimitStream) {
                if (!sizeLimitStream.writableEnded) {
                    req.unpipe(sizeLimitStream);
                    sizeLimitStream.end();
                }
            } else {
                if (!writeStream.writableEnded) {
                    req.unpipe(writeStream);
                    writeStream.end();
                }
            }
        }

        const reqFailed = () => {
            req.off('error', onReqError);
            sizeLimitStream?.off('exceeded', onSizeExceeded);
            writeStream.off('error', onWriteError);
            writeStream.off('close', onWriteCloseWithSuccess);

            // Allow more than one run of reqFailed
            writeStream.off('close', onWriteCloseSendResponse);
            writeStream.once('close', onWriteCloseSendResponse);
        }

        const onWriteCloseWithSuccess = async () => {
            logger.debug(`Temp file written: ${ tempPath }`);

            writeStream.off('error', onWriteError);

            const targetDir = osPath.join(this.paths.incomingDir, 'staging', type, ...distroComponents);
            const targetPath = osPath.join(targetDir, filename);

            try {
                // Attempt to move the completed temporary file
                // targetPaths were already validated earlier
                await lock.forMove(async () => await move(tempPath, targetDir, targetPath));

                // Send success response ONLY AFTER successful move
                maySetResponse(201, 'File uploaded successfully', 'ok');
            } catch (err: unknown) {
                logger.error(`Error finalizing PUT upload for ${ tempPath }:`, { err });
                await cleanupTempFile(); // Clean up temp file on move failure
                maySetResponse(500, 'Failed to finalize upload', 'failed');
            }

            sendResponse();
        }

        const onWriteCloseSendResponse = async () => {
            writeStream.off('error', onWriteError);

            await cleanupTempFile();

            maySetResponse(500, 'Unknown error', 'failed');
            sendResponse();
        }

        const onSizeExceeded = async () => {
            logger.warn(`PUT upload size limit exceeded`);
            reqFailed();
            maySetResponse(413, 'File size exceeded', 'failed');
        }

        const onWriteError = async (err: Error) => {
            logger.error('Write stream error during PUT:', { err });
            reqFailed();
            maySetResponse(500, 'Error writing file during upload', 'failed');
        }

        const onEventNoop = () => {};
        const onWriteErrorNoop = onEventNoop;

        const onReqError = async (err: Error) => {
            logger.error('Request stream error during PUT:', { err });

            req.off('end', onReqEnd);

            reqFailed();
            maySetResponse(500, 'Error receiving file data during upload', 'failed');
        };

        const onReqErrorNoop = onEventNoop;

        const onReqClose = async () => {
            req.off('error', onReqError);
            req.off('end', onReqEnd);
            endWritable();
        }

        const onReqEnd = async () => {
            req.off('error', onReqError);
            req.off('close', onReqClose);
            endWritable();
        }

        req.once('destroyed', onReqClose);
        req.once('end', onReqEnd);
        req.once('error', onReqError);
        req.on('error', onReqErrorNoop);    // Prevent any unhandled errors
        req.once('close', onReqClose);
        writeStream.once('error', onWriteError);
        writeStream.on('error', onWriteErrorNoop);  // Prevent any unhandled errors
        writeStream.once('close', onWriteCloseWithSuccess);

        if (sizeLimitStream) {
            sizeLimitStream.once('exceeded', onSizeExceeded);
            req.pipe(sizeLimitStream, { end: false });
            sizeLimitStream.pipe(writeStream);
        } else {
            req.pipe(writeStream, { end: false });
        }
    }
}

function debRouter(paths: Paths, upload: UploadOptions) {
    const router = express.Router({ strict: true });
    const handler = new PutHandler(paths, upload);
    router.put('/:distro/:release/:component/:filename', handler.middleware("deb"));
    router.put('/:distro/:release/:component/:subcomponent/:filename', handler.middleware("deb"));
    return router;
}

function rpmRouter(paths: Paths, upload: UploadOptions) {
    const router = express.Router({ strict: true });
    const handler = new PutHandler(paths, upload);
    router.put('/:distro/:release/:filename', handler.middleware("rpm"));
    return router;
}

export default {
    deb: debRouter,
    rpm: rpmRouter
}
