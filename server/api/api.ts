import type { NextFunction, Request, Response } from "express";
import express from "express";
import type { AppConfig } from "../lib/config.ts";
import logger, { logResponseMiddleware } from "../lib/logger.ts";
import authMiddleware from "../lib/auth.ts";
import upload from "./upload/index.ts";
import { sendErrorResponse } from "../lib/res.ts";
import type { ParamsDictionary } from "express-serve-static-core";
import repo from "./repo.ts";

function unexpectedErrorHandler() {
    return function (err: unknown, _req: Request, res: Response, next: NextFunction) {
        if (res.headersSent) {
            next(err);
        }
        logger.error("API error:", { err });
        sendErrorResponse(res, 500, 'API error, see server logs for details');
    }
}

function unknownApiMiddleware() {
    return function (req: Request<ParamsDictionary & { splat: string[] }>, res: Response) {
        return sendErrorResponse(res, 404, `Unknown API`);
    }
}

function statusMiddleware(config: AppConfig) {
    return function (_req: Request, res: Response) {
        res.json({
            message: 'Package repository API is running',
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

    const v1 = express.Router({ strict: true });
    router.use('/v1', v1);

    v1.get('/status', statusMiddleware(config));
    v1.use('/upload', upload(config));
    v1.post('/repo/import', repo.post(config.paths, config.gpg, config.upload));

    router.all('/', unknownApiMiddleware());
    router.use(unexpectedErrorHandler());

    return router;
}
