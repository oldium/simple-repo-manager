import type { Request, Response } from "express";
import express from "express";
import post from "./post.ts";
import put from "./put.ts";
import authMiddleware from "../../lib/auth.ts";
import { enablingMiddleware } from "../../lib/req.ts";
import type { AppConfig } from "../../lib/config.ts";
import { sendErrorResponse } from "../../lib/res.ts";
import { logResponseMiddleware } from "../../lib/logger.ts";
import type { ParamsDictionary } from "express-serve-static-core";

function unknownUploadMiddleware() {
    return function (req: Request<ParamsDictionary & { splat: string[] }>, res: Response) {
        if (req.params.splat?.[0] === 'deb' || req.params.splat?.[0] === 'rpm') {
            if (req.method === "POST" || req.method === "PUT") {
                return sendErrorResponse(res, 404, 'Unknown upload path');
            } else {
                return sendErrorResponse(res, 405, 'Method not allowed', { 'Allow': 'POST, PUT' });
            }
        } else {
            return sendErrorResponse(res, 404, `Unknown upload path`);
        }
    }
}

export default function router(config: AppConfig) {
    const router = express.Router({ strict: true });

    router.use(logResponseMiddleware());

    const auth = authMiddleware(config.upload.allowedIps, config.upload.basicAuth);
    if (auth.length > 0) {
        router.use(...auth);
    }

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

    router.use('/*splat', unknownUploadMiddleware());
    router.all('/', unknownUploadMiddleware());

    return router;
}
