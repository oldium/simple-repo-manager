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
