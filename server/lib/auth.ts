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

export type AuthClass = "anonymous" | "authenticated" | "invalid";

export function classifyAuth(req: Request, basicCredentials: string[] | undefined,
    bearerTokens: string[] | undefined): AuthClass {
    const header = req.headers.authorization?.trim() ?? "";
    if (!header) return "anonymous";
    if (matchesBasic(header, basicCredentials ?? [])) return "authenticated";
    if (matchesBearer(header, bearerTokens ?? [])) return "authenticated";
    return "invalid";
}

function rejectAuth(req: Request, res: Response) {
    logger.warn(`User ${ req.ip } authentication failed`);
    res.setHeader("WWW-Authenticate", CHALLENGE);
    res.status(401).send("Authentication required");
}

export type Refusal = "ip" | "credentials";

/** An access check, and how a request failing it is answered */
type Check = {
    refusal: Refusal;
    passes: (req: Request) => boolean;
    reject: (req: Request, res: Response) => void;
};

function credentialsCheck(basicCredentials: string[] | undefined, bearerTokens: string[] | undefined,
    allowAnonymous: boolean): Check {
    return {
        refusal: "credentials",
        passes: (req: Request) => {
            const authClass = classifyAuth(req, basicCredentials, bearerTokens);
            return authClass === "authenticated" || (allowAnonymous && authClass === "anonymous");
        },
        reject: rejectAuth,
    };
}

function allowedIpsCheck(isAllowed: IpCheckFn): Check {
    return {
        refusal: "ip",
        passes: (req: Request) => !!req.ip && isAllowed(req.ip),
        reject: (req: Request, res: Response) => {
            logger.warn(`Client IP ${ req.ip } not allowed.`);
            res.status(403).send("Forbidden");
        },
    };
}

function checkMiddleware(check: Check): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        if (check.passes(req)) return next();
        check.reject(req, res);
    };
}

function hasCredentials(basicAuth: string[] | undefined, bearerAuth: string[] | undefined): boolean {
    return !!basicAuth?.length || !!bearerAuth?.length;
}

function writeChecks(
    allowedIps: IpCheckFn | undefined,
    basicAuth: string[] | undefined,
    bearerAuth: string[] | undefined
): Check[] {
    const checks: Check[] = [];
    if (allowedIps) {
        checks.push(allowedIpsCheck(allowedIps));
    }
    if (hasCredentials(basicAuth, bearerAuth)) {
        checks.push(credentialsCheck(basicAuth, bearerAuth, false));
    }
    return checks;
}

export function writeAuthMiddleware(
    allowedIps: IpCheckFn | undefined,
    basicAuth: string[] | undefined,
    bearerAuth: string[] | undefined
): RequestHandler[] {
    return writeChecks(allowedIps, basicAuth, bearerAuth).map(checkMiddleware);
}

/** The write check that would refuse a request, or undefined when writeAuthMiddleware lets it through */
export function writeGateRefusal(
    allowedIps: IpCheckFn | undefined,
    basicAuth: string[] | undefined,
    bearerAuth: string[] | undefined
): (req: Request) => Refusal | undefined {
    const checks = writeChecks(allowedIps, basicAuth, bearerAuth);
    return (req: Request) => checks.find(check => !check.passes(req))?.refusal;
}

/** Wrong credentials get 401 rather than passing as anonymous */
export function readAuthMiddleware(
    allowedIps: IpCheckFn | undefined,
    basicAuth: string[] | undefined,
    bearerAuth: string[] | undefined,
    publicRead: boolean
): RequestHandler[] {
    if (!publicRead) {
        return writeAuthMiddleware(allowedIps, basicAuth, bearerAuth);
    }
    return hasCredentials(basicAuth, bearerAuth) ? [checkMiddleware(credentialsCheck(basicAuth, bearerAuth, true))] : [];
}
