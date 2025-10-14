import type { NextFunction, Request, RequestHandler, Response } from "express";
import { sendErrorResponse } from "./res.ts";
import { AsyncResource } from "node:async_hooks";

export function enablingMiddleware(enabled: boolean, disabledMessage: string): RequestHandler {
    return function (_req: Request, res: Response, next: NextFunction) {
        if (enabled) {
            next();
        } else {
            sendErrorResponse(res, 503, disabledMessage, { 'Retry-After': '3600' });
        }
    }
}

export function ensureAsyncContext(middleware: RequestHandler): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        return middleware(req, res, AsyncResource.bind(next));
    }
}

export function joinPath(base: string, path?: string) {
    if (!path) {
        return base;
    } else {
        if (base.endsWith("/")) {
            if (path.startsWith("/")) {
                return base + path.slice(1);
            } else {
                return base + path;
            }
        } else {
            if (!path.startsWith("/")) {
                return base + "/" + path;
            } else {
                return base + path;
            }
        }
    }
}

function hasPort(host: string) {
    const index = host[0] === '[' ? host.indexOf(']') + 1 : 0;
    return host.indexOf(':', index) !== -1;
}

export function getUriNoQuery(req: Request, path?: string): string {
    let proto: string;
    let hostPort: string;
    let baseUrl: string;

    const resolvePath = path ?? req.originalUrl;

    const trustFn = req.app.get('trust proxy fn');
    if (!trustFn(req.socket.remoteAddress, 0)) {
        proto = req.protocol;
        if (!hasPort(req.host)
            && ((proto === "http" && req.socket.localPort !== 80)
                || (proto === "https" && req.socket.localPort !== 443))) {
            hostPort = `${ req.host }:${ req.socket.localPort }`;
        } else {
            hostPort = req.host;
        }
        baseUrl = "";
    } else {
        proto = req.protocol;
        const host = req.host;
        let port = req.headers["x-forwarded-port"];
        if (port && port.indexOf(',') !== -1) {
            port = port.substring(0, port.indexOf(',')).trimEnd();
        }
        if (!hasPort(host) && port !== undefined && ((proto === "http" && port !== "80") || (proto === "https" && port !== "443"))) {
            hostPort = `${ host }:${ port }`;
        } else {
            hostPort = host
        }
        baseUrl = req.headers["x-forwarded-path"] ?? "";
    }
    const fullPath = joinPath(baseUrl, resolvePath);
    const url = new URL(`${ proto }://${ hostPort }${ fullPath }`);
    return `${ url.origin }${ url.pathname }`;
}
