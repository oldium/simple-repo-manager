import crypto from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import logger from "./logger.ts";
import type { IpCheckFn } from "./config.ts";

const CHALLENGE = 'Basic realm="API", Bearer realm="API"';

function timingSafeEquals(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) {
        // Still compare against a dummy of equal length to avoid short-circuit timing.
        crypto.timingSafeEqual(ab, Buffer.alloc(ab.length));
        return false;
    }
    return crypto.timingSafeEqual(ab, bb);
}

function matchesBasic(header: string, credentials: string[]): boolean {
    if (!header.toLowerCase().startsWith("basic ")) return false;
    const provided = header.slice(6).trim();
    return credentials.some((expected) => timingSafeEquals(
        provided,
        Buffer.from(expected).toString("base64")
    ));
}

function matchesBearer(header: string, tokens: string[]): boolean {
    if (!header.toLowerCase().startsWith("bearer ")) return false;
    const provided = header.slice(7).trim();
    if (!provided) return false;
    return tokens.some((expected) => timingSafeEquals(provided, expected));
}

function auth(basicCredentials: string[] | undefined,
    bearerTokens: string[] | undefined): RequestHandler {
    const basics = basicCredentials ?? [];
    const bearers = bearerTokens ?? [];
    return (req: Request, res: Response, next: NextFunction) => {
        const header = req.headers.authorization?.trim() ?? "";
        if (header) {
            if (basics.length > 0 && matchesBasic(header, basics)) return next();
            if (bearers.length > 0 && matchesBearer(header, bearers)) return next();
        }
        logger.warn(`User ${ req.ip } authentication failed`);
        res.setHeader("WWW-Authenticate", CHALLENGE);
        res.status(401).send("Authentication required");
    };
}

function allowIps(ipCheck: IpCheckFn | undefined): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        const clientIp = req.ip;
        if (ipCheck && (!clientIp || !ipCheck(clientIp))) {
            logger.warn(`Client IP ${ clientIp } not allowed.`);
            res.status(403).send("Forbidden");
            return;
        }
        next();
    };
}

export default function authMiddleware(
    allowedIps: IpCheckFn | undefined,
    basicAuth: string[] | undefined,
    bearerAuth: string[] | undefined
): RequestHandler[] {
    const handlers: RequestHandler[] = [];
    if (allowedIps) {
        handlers.push(allowIps(allowedIps));
    }
    const hasBasic = !!basicAuth && basicAuth.length > 0;
    const hasBearer = !!bearerAuth && bearerAuth.length > 0;
    if (hasBasic || hasBearer) {
        handlers.push(auth(hasBasic ? basicAuth : undefined, hasBearer ? bearerAuth : undefined));
    }
    return handlers;
}
