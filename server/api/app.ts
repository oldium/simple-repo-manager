import type { NextFunction, Request, Response } from "express";
import express from "express";
import type { AppConfig, Environment } from "../lib/config.ts";
import logger, { loggingMiddlewares } from "../lib/logger.ts";
import fsExtra from "fs-extra";
import osPath from "path";
import files from "./files.ts";
import finalhandler from "finalhandler";
import { gpgInit } from "../lib/gpg.ts";
import api from "./api.ts";

function unexpectedErrorHandler() {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return function (err: unknown, req: Request, res: Response, _next: NextFunction) {
        logger.error("Error occurred: ", { err });
        finalhandler(req, res)(err);
    }
}

export default async function createApp(config: AppConfig, environment: Environment) {
    await fsExtra.ensureDir(osPath.join(config.paths.incomingDir, 'tmp'));
    if (config.upload.enabledApi.deb) {
        await fsExtra.ensureDir(osPath.join(config.paths.incomingDir, 'staging', 'deb'));
        await fsExtra.ensureDir(osPath.join(config.paths.incomingDir, 'process', 'deb'));
    }
    if (config.upload.enabledApi.rpm) {
        await fsExtra.ensureDir(osPath.join(config.paths.incomingDir, 'staging', 'rpm'));
        await fsExtra.ensureDir(osPath.join(config.paths.incomingDir, 'process', 'rpm'));
    }

    await gpgInit(config);

    const app = express();
    app.enable("strict routing");
    app.disable('x-powered-by');
    if (config.security.trustProxy) {
        app.set("trust proxy", config.security.trustProxy);
    }

    app.use(loggingMiddlewares());

    app.get('/status', (_req: Request, res: Response) => {
        res.send('Package Uploader API (TypeScript) is running.');
    });

    app.use("/api", api(config));

    app.use(await files(config.paths, config.gpg, environment));
    app.use(unexpectedErrorHandler());

    return app;
}
