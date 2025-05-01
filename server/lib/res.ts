import type { Response } from "express";
import { getCorrelationId } from "./logger.ts";

export type FileResponse = {
    filename: string;
    status: "ok" | "failed";
    path?: string;
}

function getResponseCorrelationId(status: number) {
    let correlationId: string | undefined;
    if (status >= 400) {
        correlationId = getCorrelationId();
    }
    return correlationId ? { correlation: { id: correlationId } } : undefined;
}

export function sendUploadResponse(res: Response, status: number, message: string, files: FileResponse[]) {
    res.status(status).json({ ...getResponseCorrelationId(status), message, files });
}

export function sendRepoResponse(res: Response, status: number, message: string) {
    res.status(status).json({ ...getResponseCorrelationId(status), message });
}

export function sendErrorResponse(res: Response, status: number, message: string | undefined,
    headers?: Record<string, string>) {
    res.status(status);
    if (headers) {
        Object.entries(headers).forEach(([key, value]) => {
            res.set(key, value);
        });
    }
    if (message !== undefined) {
        res.json({ ...getResponseCorrelationId(status), message });
    } else {
        res.end();
    }
}
