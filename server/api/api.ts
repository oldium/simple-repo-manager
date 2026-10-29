import type { NextFunction, Request, RequestHandler, Response } from "express";
import express from "express";
import type { AppConfig } from "../lib/config.ts";
import logger, { logResponseMiddleware } from "../lib/logger.ts";
import { readAuthMiddleware, writeAuthMiddleware } from "../lib/auth.ts";
import upload from "./upload/index.ts";
import { sendErrorResponse } from "../lib/res.ts";
import type { ParamsDictionary } from "express-serve-static-core";
import repo from "./repo.ts";
import mcpRouter from "./mcp/index.ts";
import { RepoService } from "../lib/repo-service.ts";

/** How Express's router marks a route param it cannot percent-decode */
function isParamDecodeError(err: unknown): err is URIError {
    return err instanceof URIError && (err as { status?: unknown }).status === 400;
}

/** How http-errors, e.g. from body-parser, marks a client error whose message the client may see */
function isClientError(err: unknown): err is Error & { status: number } {
    if (!(err instanceof Error)) return false;
    const { expose, status } = err as { expose?: unknown; status?: unknown };
    return expose === true && typeof status === "number" && status >= 400 && status < 500;
}

function unexpectedErrorHandler() {
    return function (err: unknown, req: Request, res: Response, next: NextFunction) {
        if (res.headersSent) {
            return next(err);
        }
        if (isParamDecodeError(err)) {
            logger.warn(`Client ${ req.ip } sent a malformed URL: ${ err.message }`);
            return sendErrorResponse(res, 400, "Invalid percent-encoding in path segment");
        }
        if (isClientError(err)) {
            logger.warn(`Client ${ req.ip } sent an invalid request: ${ err.message }`);
            return sendErrorResponse(res, err.status, err.message);
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

function statusMiddleware(service: RepoService): RequestHandler {
    return function (_req: Request, res: Response) {
        res.json(service.getStatus());
    };
}

/** Must agree with the routes below, which match case-insensitively */
function isReadRequest(req: Request): boolean {
    const [root, version, resource, ...params] = req.path.toLowerCase().split("/");
    if (root !== "" || version !== "v1") return false;
    // MCP offers its write tools only to requests that pass the write gate
    if (resource === "mcp") return params.length === 0;
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    if (resource === "status") return params.length === 0;
    return resource === "repo" && (params.length === 4 || params.length === 5) && params.every(Boolean);
}

/** Decides by method and path alone, so a route param that fails to decode cannot skip it */
function accessGate(readAuth: RequestHandler[], writeAuth: RequestHandler[]): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        const chain = isReadRequest(req) ? readAuth : writeAuth;
        let index = 0;
        const step = (err?: unknown) => {
            if (err || index === chain.length) return next(err);
            chain[index++](req, res, step);
        };
        step();
    };
}

export default function router(config: AppConfig) {
    const router = express.Router({ strict: true });

    router.use(logResponseMiddleware());

    const { allowedIps, basicAuth, bearerAuth, publicRead } = config.upload;
    const writeAuth = writeAuthMiddleware(allowedIps, basicAuth, bearerAuth);
    if (writeAuth.length > 0) {
        router.use(accessGate(readAuthMiddleware(allowedIps, basicAuth, bearerAuth, publicRead), writeAuth));
    }

    const v1 = express.Router({ strict: true });
    router.use('/v1', v1);

    const service = new RepoService(config.paths, config.gpg, config.upload);
    v1.get('/status', statusMiddleware(service));
    v1.use('/upload', upload(config));
    v1.post('/repo/import', repo.post(config.paths, config.gpg, config.upload));
    v1.delete('/repo/:format/:distribution/:release/:source/:version',
        repo.remove(config.paths, config.gpg, config.upload));
    v1.delete('/repo/:format/:distribution/:release/:source',
        repo.remove(config.paths, config.gpg, config.upload));
    v1.get('/repo/:format/:distribution/:release/:source/:version',
        repo.list(config.paths, config.gpg, config.upload));
    v1.get('/repo/:format/:distribution/:release/:source',
        repo.list(config.paths, config.gpg, config.upload));
    v1.use('/mcp', mcpRouter(config));

    router.all('/', unknownApiMiddleware());
    router.use(unexpectedErrorHandler());

    return router;
}
