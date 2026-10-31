import type { Paths, UploadOptions } from "../../lib/config.ts";
import type { Request, RequestHandler, Response } from "express";
import express from "express";
import fs from "fs";
import assert from "node:assert";
import type { Writable } from "stream";
import { tempName } from "../../lib/fs.ts";
import { invalidDistroMessage, invalidFilenameMessage, validateDistro, validateFilename } from "../../lib/validations.ts";
import { repoDirectoryName } from "../../lib/file-naming.ts";
import { toOsPath } from "../../lib/safe-path.ts";
import { RepoValidationError } from "../../lib/errors.ts";
import osPath from "path";
import path from "node:path/posix";
import logger from "../../lib/logger.ts";
import { SizeLimitStream } from "../../lib/streams.ts";
import { type FileResponse, sendErrorResponse, sendUploadResponse } from "../../lib/res.ts";
import { type Digests, hashingTransform } from "../../backend/hash.ts";
import { stageUpload } from "./stage.ts";

interface PutRequestParams {
    distro: string;
    release: string;
    component?: string;
    subcomponent?: string;
    filename: string;
}

class PutHandler {
    private readonly paths: Paths;
    private readonly sizeLimit;

    constructor(paths: Paths, upload: UploadOptions) {
        this.paths = paths;
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

        const requested = [distro, release].concat(component ? [component].concat(subcomponent ? [subcomponent] : []) : []);
        const distroComponents = requested.map(name => repoDirectoryName(name));
        if (!validateDistro(type, distroComponents)) {
            logger.warn(`Invalid distro: ${ requested.join('/') }`);
            sendErrorResponse(res, 400, invalidDistroMessage(type, requested));
            return;
        }

        const relPath = path.join(type, ...distroComponents, filename);
        const sentPath = [type, ...requested, filename].join('/');

        logger.info(`Received PUT upload request for ${ type }/${ distroComponents.join('/') }: ${ filename }`);

        if (!validateFilename(type, filename)) {
            logger.warn(`Invalid filename: ${ filename }`);
            sendUploadResponse(res, 400, invalidFilenameMessage(filename), [{ filename, path: sentPath, status: 'failed' }]);
            return;
        }

        // Generate temporary filename using IP:Port (same logic as storage engine)
        const tempPath: string = toOsPath(osPath.join(this.paths.incomingDir, 'tmp'), tempName(req.socket));

        const writeStream = fs.createWriteStream(tempPath, {
            flags: 'w',
            encoding: 'binary'
        });

        let digests: Digests | undefined = undefined;
        const hashStream = hashingTransform(d => { digests = d; });

        let sizeLimitStream: SizeLimitStream | undefined = undefined;
        if (this.sizeLimit && this.sizeLimit > 0) {
            sizeLimitStream = new SizeLimitStream(this.sizeLimit);
        }

        // The stage the request feeds; ending it ends the chain through pipe()
        const head: Writable = sizeLimitStream ?? hashStream;

        let response: { status: number, message: string, files: FileResponse[] } | undefined = undefined;

        // Helper function to clean up the temp file for this PUT request.
        //
        // Must complete before the response is sent (the test harness relies
        // on `res.on('close')` + 50 setImmediates to move on to assertions; on
        // slow filesystems — e.g. Docker-Desktop-for-Windows bind mounts — an
        // async `fs.rm` can lose that race). Using the sync variant blocks the
        // event loop atomically for the unlink, which is inexpensive per call
        // and removes the race.
        const cleanupTempFile = () => {
            logger.info(`Cleaning up temporary file: ${ tempPath }`);
            try {
                fs.rmSync(tempPath, { force: true });
            } catch (cleanupErr) {
                logger.error(`Error cleaning up temporary file ${ tempPath }:`, { err: cleanupErr });
            }
        }

        const maySetResponse = (status: number, message: string, uploadStatus: FileResponse["status"]) => {
            if (!response) {
                response = { status, message, files: [{ filename, path: uploadStatus === 'ok' ? relPath : sentPath, status: uploadStatus }] };
            }
        }

        const sendResponse = () => {
            if (!res.headersSent && res.writable) {
                const { status, ...json } = response || { status: 500, message: "Unknown error" };
                res.status(status).json(json);
            }
        }

        const endWritable = () => {
            if (!head.writableEnded) {
                req.unpipe(head);
                head.end();
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

            try {
                const stagingDir = osPath.join(this.paths.incomingDir, 'staging');
                const targetPath = toOsPath(stagingDir, relPath);
                const targetDir = osPath.dirname(targetPath);

                // Attempt to move the completed temporary file
                // targetPaths were already validated earlier; the hash flushed before the write stream could finish
                assert(digests !== undefined);
                await stageUpload({ tempPath, stagingDir, targetDir, targetPath, relPath, sentPath, repoStateDir: this.paths.repoStateDir, digests });

                // Send success response ONLY AFTER successful move
                maySetResponse(201, 'File uploaded successfully', 'ok');
            } catch (err: unknown) {
                cleanupTempFile(); // Clean up temp file on move failure
                if (err instanceof RepoValidationError) {
                    logger.warn(`Refused ${ filename }: ${ err.message }`);
                    maySetResponse(400, err.message, 'failed');
                } else {
                    logger.error(`Error finalizing PUT upload for ${ tempPath }:`, { err });
                    maySetResponse(500, 'Failed to finalize upload', 'failed');
                }
            }

            sendResponse();
        }

        const onWriteCloseSendResponse = () => {
            writeStream.off('error', onWriteError);

            cleanupTempFile();

            maySetResponse(500, 'Unknown error', 'failed');
            sendResponse();
        }

        const onSizeExceeded = () => {
            logger.warn(`PUT upload size limit exceeded`);
            reqFailed();
            maySetResponse(413, 'File size exceeded', 'failed');
        }

        const onWriteError = (err: Error) => {
            logger.error('Write stream error during PUT:', { err });
            reqFailed();
            maySetResponse(500, 'Error writing file during upload', 'failed');
        }

        const onEventNoop = () => {};
        const onWriteErrorNoop = onEventNoop;

        const onReqError = (err: Error) => {
            logger.error('Request stream error during PUT:', { err });

            req.off('end', onReqEnd);

            reqFailed();
            maySetResponse(500, 'Error receiving file data during upload', 'failed');
        };

        const onReqErrorNoop = onEventNoop;

        const onReqClose = () => {
            req.off('error', onReqError);
            req.off('end', onReqEnd);
            endWritable();
        }

        const onReqEnd = () => {
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
            sizeLimitStream.pipe(hashStream);
        }
        hashStream.pipe(writeStream);
        req.pipe(head, { end: false });
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
