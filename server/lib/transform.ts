import type { NextFunction, Request, RequestHandler, Response } from "express";
import fsExtra from "fs-extra";
import fs from "node:fs/promises";
import etag from "etag";
import fresh from "fresh";
import path from "node:path/posix";
import type { Environment } from "./config.ts";

export type TransformFn = (content: string) => Promise<string> | string;

export function transformMiddleware(file: string, transform: TransformFn, environment: Environment): RequestHandler {
    let cached: { etag: string, lastModified: string, content: string, mtimeMs: number } | false;
    cached = false;
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        if (!await fsExtra.pathExists(file)) {
            next();
        } else {
            const stat = await fs.stat(file);
            const mtimeMs = stat.mtimeMs;
            let content, tag, lastModified;

            // cache miss or file changed?
            if (!cached || cached.mtimeMs !== mtimeMs) {
                const src = await fs.readFile(file, 'utf8');
                content = await transform(src);
                tag = etag(content);
                lastModified = stat.mtime.toUTCString();
                cached = { mtimeMs, lastModified, content, etag: tag };
            } else {
                ({ content, etag: tag, lastModified } = cached);
            }

            // set headers
            res.set({
                'Last-Modified': lastModified,
                'ETag': tag,
                'Cache-Control': (environment !== "production" ? 'no-cache' : 'public, max-age=3600')
            });

            if (fresh(req.headers, { 'etag': tag, 'last-modified': lastModified })) {
                res.status(304).end();
            } else {
                res.type(path.extname(file)).send(content);
            }
        }
    };
}

export function serveMiddleware(file: string, environment: Environment) {
    return transformMiddleware(file, v => v, environment);
}
