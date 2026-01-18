import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import express from "express";
import fsExtra from "fs-extra";
import { move, tempName } from "../../lib/fs.ts";
import type { Multer, StorageEngine } from "multer";
import multer from "multer";
import type { Paths, UploadOptions } from "../../lib/config.ts";
import osPath from "node:path";
import path from "node:path/posix";
import { validateDistro, validateFilename } from "../../lib/validations.ts";
import logger from "../../lib/logger.ts";
import lock from "../../lib/lock.ts";
import type { FileResponse } from "../../lib/res.ts";
import { sendErrorResponse, sendUploadResponse } from "../../lib/res.ts";
import { ensureAsyncContext } from "../../lib/req.ts";

interface PostRequestParams {
    distro: string;
    release: string;
    component?: string;
    subcomponent?: string;
}

class PostHandler {
    private readonly storage: StorageEngine;
    private readonly upload: Multer;
    private readonly postField: string;

    constructor(private paths: Paths, upload: UploadOptions) {
        this.storage = multer.diskStorage({
            destination: (_req, _file, cb) => {
                // Always save to the central temp directory first
                cb(null, osPath.join(paths.incomingDir, 'tmp'));
            },
            filename: (req, file, cb) => {
                try {
                    // Sanitize original filename
                    const safeOriginalName = osPath.basename(file.originalname).replace(/[^a-zA-Z0-9_.-]/g, '');
                    const tempFilename = tempName(req.socket, safeOriginalName);
                    cb(null, tempFilename);
                } catch (err: unknown) {
                    logger.error("Error during temporary filename generation:", { err });
                    cb(err instanceof Error ? err : new Error(String(err)), ''); // Pass error to multer
                }
            }
        });

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
        const files = req.files as Express.Multer.File[] | undefined;

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

            const filePath: Omit<FileResponse, "status"> = {
                filename: originalFilename,
                path: path.join(type, ...distroComponents, originalFilename)
            };

            try {
                let status: FileResponse["status"];
                if (!validateFilename(type, originalFilename)) {
                    clientError = true;
                    logger.warn(`Invalid filename: ${ originalFilename }`);
                    status = 'failed';
                    await fsExtra.remove(tempPath);
                } else {
                    await lock.forMove(async () => await move(tempPath, targetDir, targetPath));
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
