import type { NextFunction, Request, Response } from "express";
import express from "express";
import post from "./post.ts";
import put from "./put.ts";
import repo from "./repo.ts";
import authMiddleware from "../../lib/auth.ts";
import { enablingMiddleware } from "../../lib/req.ts";
import type { AppConfig } from "../../lib/config.ts";
import { sendErrorResponse } from "../../lib/res.ts";
import logger, { logResponseMiddleware } from "../../lib/logger.ts";
import type { ParamsDictionary } from "express-serve-static-core";

function unknownUploadMiddleware() {
    return function (req: Request<ParamsDictionary & { splat: string[] }>, res: Response) {
        const path = (req.params.splat?.join('/') ?? "") + (req.originalUrl.endsWith('/') ? '/' : '');
        if (req.params.splat?.[0] === 'deb' || req.params.splat?.[0] === 'rpm') {
            if (req.method === "POST" || req.method === "PUT") {
                return sendErrorResponse(res, 404, 'Unknown upload path');
            } else {
                return sendErrorResponse(res, 405, 'Method not allowed', { 'Allow': 'POST, PUT' });
            }
        } else if (req.params.splat?.[0] === 'build-repo') {
            if (path !== "build-repo") {
                return sendErrorResponse(res, 404, 'Unknown upload path');
            } else {
                // Correct path, but still we got here, so it has to be a bad method
                return sendErrorResponse(res, 405, 'Method not allowed', { 'Allow': 'POST' });
            }
        } else {
            return sendErrorResponse(res, 404, `Unknown upload path`);
        }
    }
}

function unexpectedErrorHandler() {
    return function (err: unknown, _req: Request, res: Response, next: NextFunction) {
        if (res.headersSent) {
            next(err);
        }
        logger.error("File upload error:", { err });
        sendErrorResponse(res, 500, 'Upload error, see server logs for details');
    }
}

function statusMiddleware(config: AppConfig) {
    return function (_req: Request, res: Response) {
        res.json({
            message: 'Package Uploader API (TypeScript) is running',
            api: {
                deb: {
                    enabled: config.upload.enabledApi.deb,
                },
                rpm: {
                    enabled: config.upload.enabledApi.rpm,
                },
            }
        });
    };
}

export default function router(config: AppConfig) {
    const router = express.Router({ strict: true });

    router.use(logResponseMiddleware());

    const auth = authMiddleware(config.upload.allowedIps, config.upload.basicAuth);
    if (auth.length > 0) {
        router.use(...auth);
    }

    router.get('/status', statusMiddleware(config));

    router.use(enablingMiddleware(
        config.upload.enabledApi.deb || config.upload.enabledApi.rpm,
        'The upload functionality is disabled'));

    router.use('/deb',
        enablingMiddleware(config.upload.enabledApi.deb,
            "The Debian upload functionality is disabled"),
        post.deb(config.paths, config.upload),
        put.deb(config.paths, config.upload));
    router.use('/rpm',
        enablingMiddleware(config.upload.enabledApi.rpm,
            "The RedHat upload functionality is disabled"),
        post.rpm(config.paths, config.upload),
        put.rpm(config.paths, config.upload));
    router.post('/build-repo', repo.post(config.paths, config.gpg, config.upload));

    router.use('/*splat', unknownUploadMiddleware());
    router.all('/', unknownUploadMiddleware());
    router.use(unexpectedErrorHandler());

    return router;
}
