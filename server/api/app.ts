import type { NextFunction, Request, Response } from "express";
import express from "express";
import type { AppConfig, Environment } from "../lib/config.ts";
import logger, { loggingMiddlewares } from "../lib/logger.ts";
import fsExtra from "fs-extra";
import osPath from "path";
import files from "./files.ts";
import finalhandler from "finalhandler";
import { gpgInit } from "../lib/gpg.ts";
import { openBackend } from "../backend/index.ts";
import { resolveFileNaming } from "../lib/file-naming.ts";
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
    for (const format of ["deb", "rpm"]) {
        await fsExtra.ensureDir(osPath.join(config.paths.incomingDir, 'staging', format));
        await fsExtra.ensureDir(osPath.join(config.paths.incomingDir, 'process', format));
    }

    // A directory that does not exist yet could only answer with the Windows default
    await fsExtra.ensureDir(config.paths.repoDir);
    await resolveFileNaming(config.fileNaming, [config.paths.repoDir, config.paths.incomingDir]);

    await openBackend(config.paths, config.gpg.gpgRepoPrivateKeyFile, { rebuild: process.argv.includes("--rebuild") });
    if (config.gpg.gpgRepoPrivateKeyFile) {
        // The keyring lives in the format dirs, which a fresh install lacks; made after openBackend so they never pass for a published tree
        for (const format of ["deb", "rpm"]) {
            await fsExtra.ensureDir(osPath.join(config.paths.repoDir, format));
        }
    }
    await gpgInit(config);

    const app = express();
    app.enable("strict routing");
    app.disable('x-powered-by');
    if (config.security.trustProxy) {
        app.set("trust proxy", config.security.trustProxy);
    }
    if (config.publicUrl) {
        app.set("public url", config.publicUrl);
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
