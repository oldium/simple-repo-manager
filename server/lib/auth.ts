import type { NextFunction, Request, RequestHandler, Response } from "express";
import logger from "./logger.ts";
import type { IpCheckFn } from "./config.ts";

function auth(credentials: string[]): RequestHandler {
    const expectedAuth = credentials.map(auth => `Basic ${ Buffer.from(auth).toString('base64') }`);
    return (req: Request, res: Response, next: NextFunction) => {
        const authHeader = req.headers.authorization?.trim().split(' ').filter(Boolean).join(' ');
        if (!authHeader || !expectedAuth.includes(authHeader)) {
            logger.warn(`User ${ req.ip } authentication failed`);
            res.setHeader('WWW-Authenticate', 'Basic realm="Upload API"');
            res.status(401).send('Authentication required');
            return;
        }
        next();
    };
}

function allowIps(ipCheck: IpCheckFn | undefined): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        const clientIp = req.ip;
        if (ipCheck && (!clientIp || !ipCheck(clientIp))) {
            logger.warn(`Client IP ${ clientIp } not allowed.`);
            res.status(403).send('Forbidden');
            return;
        } else {
            next();
        }
    }
}

export default function authMiddleware(allowedIps: IpCheckFn | undefined,
    basicAuth: string[] | undefined): RequestHandler[] {
    const handlers = [];
    if (allowedIps) {
        handlers.push(allowIps(allowedIps));
    }
    if (basicAuth) {
        handlers.push(auth(basicAuth));
    }
    return handlers;
}
