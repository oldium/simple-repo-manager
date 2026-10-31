import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import express from "express";
import fs from "node:fs";
import fsExtra from "fs-extra";
import { pipeline } from "node:stream";
import { tempName } from "../../lib/fs.ts";
import type { ErrorCode, Multer, StorageEngine } from "multer";
import multer from "multer";
import type { Paths, UploadOptions } from "../../lib/config.ts";
import osPath from "node:path";
import path from "node:path/posix";
import { validateDistro, validateFilename } from "../../lib/validations.ts";
import logger from "../../lib/logger.ts";
import type { FileResponse } from "../../lib/res.ts";
import { sendErrorResponse, sendUploadResponse } from "../../lib/res.ts";
import { ensureAsyncContext } from "../../lib/req.ts";
import type { Digests } from "../../backend/hash.ts";
import { hashingTransform } from "../../backend/hash.ts";
import { stageUpload } from "./stage.ts";

interface PostRequestParams {
    distro: string;
    release: string;
    component?: string;
    subcomponent?: string;
}

type UploadedFile = Express.Multer.File & { digests: Digests };

/** Writes each file to the temp directory, hashing it on the way; sets path, size and digests on the file */
class HashingDiskStorage implements StorageEngine {
    private readonly tmpDir: string;
    /** Write streams still open: _removeFile waits for the descriptor, Windows refuses to unlink an open file */
    private readonly openStreams = new WeakMap<Express.Multer.File, fs.WriteStream>();

    constructor(tmpDir: string) {
        this.tmpDir = tmpDir;
    }

    _handleFile(req: Request, file: Express.Multer.File, cb: (error?: unknown, info?: Partial<UploadedFile>) => void): void {
        const tempPath = osPath.join(this.tmpDir, tempName(req.socket));
        if (file.stream.destroyed) {
            // A multer 2.5 code, not yet in @types/multer 2.3
            cb(new multer.MulterError("STREAM_DESTROYED" as ErrorCode));
            return;
        }
        const outStream = fs.createWriteStream(tempPath);
        // multer removes an aborted upload only when the file already has its path
        file.path = tempPath;
        this.openStreams.set(file, outStream);
        outStream.once('close', () => this.openStreams.delete(file));

        let digests: Digests | undefined = undefined;
        pipeline(file.stream, hashingTransform(d => { digests = d; }), outStream, err => {
            if (err) {
                fs.rm(tempPath, { force: true }, rmErr => {
                    if (rmErr) {
                        logger.warn(`Failed to remove temporary file ${ tempPath }:`, { err: rmErr });
                    }
                    cb(err);
                });
            } else {
                cb(null, { path: tempPath, size: outStream.bytesWritten, digests });
            }
        });
    }

    _removeFile(_req: Request, file: Express.Multer.File, cb: (error: Error | null) => void): void {
        const unlink = () => fs.rm(file.path, { force: true }, cb);
        const outStream = this.openStreams.get(file);
        if (outStream === undefined || outStream.closed) {
            unlink();
            return;
        }
        const onReleased = () => {
            outStream.off('close', onReleased);
            outStream.off('error', onReleased);
            unlink();
        };
        outStream.once('close', onReleased);
        outStream.once('error', onReleased);
        outStream.destroy();
    }
}

class PostHandler {
    private readonly paths: Paths;
    private readonly storage: StorageEngine;
    private readonly upload: Multer;
    private readonly postField: string;

    constructor(paths: Paths, upload: UploadOptions) {
        this.paths = paths;
        this.storage = new HashingDiskStorage(osPath.join(paths.incomingDir, 'tmp'));

        this.postField = upload.postField;

        const limits = (upload.sizeLimit && upload.sizeLimit > 0) ? { limits: { fileSize: upload.sizeLimit } } : {};
        this.upload = multer({
            storage: this.storage,
            ...limits
        });
    };

    public middlewares(
        type: string
    ): (RequestHandler<PostRequestParams> | ErrorRequestHandler<PostRequestParams>)[] {
        return [
            ensureAsyncContext(this.upload.array(this.postField)) as unknown as RequestHandler<PostRequestParams>,
            this.postHandler.bind(this, type),
            this.errorHandler.bind(this)
        ];
    }

    private async deleteFiles(files: Express.Multer.File[] | undefined) {
        for (const file of (files || [])) {
            await fsExtra.remove(file.path).catch(cleanupErr => {
                logger.error(`Error cleaning up failed temporary file ${ file.path }:`, { err: cleanupErr });
            });
        }
    }

    private async errorHandler(err: Error, _req: Request<PostRequestParams>, res: Response, next: NextFunction) {
        if (res.headersSent) {
            return next(err);
        }

        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                logger.warn(`File size limit exceeded`);
                return sendErrorResponse(res, 413, 'File too large');
            } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
                logger.warn(`Wrong field used to upload file`);
                return sendErrorResponse(res, 400,
                    'Wrong field used to upload file, expected field name "' + this.postField + '"');
            } else {
                logger.error("Multer Error:", { err });
                return sendErrorResponse(res, 500, 'Upload error, see server logs for details');
            }
        }

        next(err);
    }

    private async postHandler(
        type: string,
        req: Request<PostRequestParams>,
        res: Response
    ): Promise<void> {
        const { distro, release, component, subcomponent } = req.params;
        const files = req.files as UploadedFile[] | undefined;

        if (!files || files.length === 0) {
            sendErrorResponse(res, 400, `No files uploaded, expected field name "${ this.postField }"`);
            return;
        }

        logger.debug(`Processing ${ files.length } files`);

        const distroComponents = [distro, release].concat(
            component ? [component].concat(subcomponent ? [subcomponent] : []) : []);
        if (!validateDistro(type, distroComponents)) {
            logger.warn(`Invalid distro: ${ distroComponents.join('/') }`);
            await this.deleteFiles(files);
            sendErrorResponse(res, 400, `Unknown or invalid distro: ${ type }/${ distroComponents.join('/') }`);
            return;
        }

        logger.info(`Received ${ files.length } file${ files.length > 1 ? "s" : "" } via POST for ` +
            `${ type }/${ distroComponents.join('/') }: ` +
            files.map(f => f.originalname).join(', '));

        // Store results for each file processed in the batch
        const fileResponses: FileResponse[] = [];

        let clientError = false;
        let serverError = false;

        // Process each uploaded file sequentially (using for...of loop with await)
        for (const file of files) {
            const originalFilename = file.originalname;

            const tempPath = file.path;
            const targetDir = osPath.join(this.paths.incomingDir, 'staging', type, ...distroComponents);
            const targetPath = osPath.join(targetDir, originalFilename);

            const relPath = path.join(type, ...distroComponents, originalFilename);
            const filePath: Omit<FileResponse, "status"> = {
                filename: originalFilename,
                path: relPath
            };

            try {
                let status: FileResponse["status"];
                if (!validateFilename(type, originalFilename)) {
                    clientError = true;
                    logger.warn(`Invalid filename: ${ originalFilename }`);
                    status = 'failed';
                    await fsExtra.remove(tempPath);
                } else {
                    await stageUpload({ tempPath, targetDir, targetPath, relPath, repoStateDir: this.paths.repoStateDir, digests: file.digests });
                    status = 'ok';
                }
                fileResponses.push({ ...filePath, status });
            } catch (err: unknown) {
                serverError = true;
                logger.error(`Failed to process ${ originalFilename }:`, { err });
                fileResponses.push({ ...filePath, status: 'failed' });

                // Attempt to clean up the temporary file for this specific failure
                await fsExtra.remove(tempPath).catch(cleanupErr => {
                    logger.error(`Error cleaning up failed temporary file ${ tempPath }:`, { err: cleanupErr });
                });
            }
        }

        // Send final response based on overall success
        if (clientError) {
            sendUploadResponse(res, 400, 'One or more files failed to upload', fileResponses);
        } else if (serverError) {
            sendUploadResponse(res, 500, 'One or more files failed to upload', fileResponses);
        } else {
            sendUploadResponse(res, 201, 'All files uploaded successfully', fileResponses);
        }
    }
}

function debRouter(paths: Paths, upload: UploadOptions) {
    const router = express.Router({ strict: true });
    const handler = new PostHandler(paths, upload);
    router.post('/:distro/:release/:component', handler.middlewares("deb"));
    router.post('/:distro/:release/:component/:subcomponent', handler.middlewares("deb"));
    return router;
}

function rpmRouter(paths: Paths, upload: UploadOptions) {
    const router = express.Router({ strict: true });
    const handler = new PostHandler(paths, upload);
    router.post<string, PostRequestParams>('/:distro/:release', handler.middlewares("rpm"));
    return router;
}

export default {
    deb: debRouter,
    rpm: rpmRouter
}
