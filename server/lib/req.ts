import type { NextFunction, Request, RequestHandler, Response } from "express";
import { sendErrorResponse } from "./res.ts";
import { AsyncResource } from "node:async_hooks";

export function enablingMiddleware(enabled: boolean, disabledMessage: string): RequestHandler {
    return function (_req: Request, res: Response, next: NextFunction) {
        if (enabled) {
            next();
        } else {
            sendErrorResponse(res, 503, disabledMessage);
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
    const resolvePath = path ?? req.originalUrl;

    const publicUrl: URL | undefined = req.app.get("public url");
    const trusted: boolean = req.app.get('trust proxy fn')(req.socket.remoteAddress, 0);
    // The public URL replaces the untrusted Host, headers of a trusted proxy override it
    const forwarded = (header: string) => trusted && req.headers[header] !== undefined;

    const proto = !publicUrl || forwarded("x-forwarded-proto") ? req.protocol : publicUrl.protocol.slice(0, -1);
    // A Host without a port means the default port, the published port may differ from ours
    let hostPort = !publicUrl || forwarded("x-forwarded-host") ? req.host : publicUrl.host;
    let baseUrl = publicUrl?.pathname ?? "";
    if (trusted) {
        let port = req.headers["x-forwarded-port"];
        if (port && port.indexOf(',') !== -1) {
            port = port.substring(0, port.indexOf(',')).trimEnd();
        }
        if (!hasPort(hostPort) && port !== undefined && ((proto === "http" && port !== "80") || (proto === "https" && port !== "443"))) {
            hostPort = `${ hostPort }:${ port }`;
        }
        baseUrl = req.headers["x-forwarded-path"] ?? baseUrl;
    }
    const fullPath = joinPath(baseUrl, resolvePath);
    const url = new URL(`${ proto }://${ hostPort }${ fullPath }`);
    return `${ url.origin }${ url.pathname }`;
}

export function getHostname(req: Request): string {
    return new URL(getUriNoQuery(req, "/")).hostname;
}
