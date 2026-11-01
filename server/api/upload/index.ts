import type { Request, Response } from "express";
import express from "express";
import post from "./post.ts";
import put from "./put.ts";
import { writeAuthMiddleware } from "../../lib/auth.ts";
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

    const auth = writeAuthMiddleware(config.upload.allowedIps, config.upload.basicAuth, config.upload.bearerAuth);
    if (auth.length > 0) {
        router.use(...auth);
    }

    router.use('/deb',
        post.deb(config.paths, config.upload),
        put.deb(config.paths, config.upload));
    router.use('/rpm',
        post.rpm(config.paths, config.upload),
        put.rpm(config.paths, config.upload));

    router.use('/*splat', unknownUploadMiddleware());
    router.all('/', unknownUploadMiddleware());

    return router;
}
