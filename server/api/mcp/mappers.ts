import { getCorrelationId } from "../../lib/logger.ts";
import {
    RepoNotFoundError,
    RepoServiceUnavailableError,
    RepoValidationError,
} from "../../lib/errors.ts";

export type ToolTextContent = { type: "text"; text: string };
export type ToolResourceLinkContent = {
    type: "resource_link";
    uri: string;
    name: string;
    mimeType?: string;
    description?: string;
    size?: number;
};
export type ToolContent = ToolTextContent | ToolResourceLinkContent;
export type ToolResult<T extends object | undefined = undefined> = {
    isError?: boolean;
    content: ToolContent[];
    structuredContent?: T;
};

export function successResult<T extends object>(text: string, structured?: T): ToolResult<T> {
    return {
        isError: false,
        content: [{ type: "text", text }],
        structuredContent: structured,
    };
}

type ErrorStructured =
    | { correlation?: { id: string }; ok?: false }
    | { code: "backend_unavailable"; format?: "deb" | "rpm" };

export function errorResult(err: unknown): ToolResult<ErrorStructured> {
    if (err instanceof RepoValidationError) {
        return {
            isError: true,
            content: [{ type: "text", text: `Invalid argument: ${ err.message }` }],
        };
    }
    if (err instanceof RepoNotFoundError) {
        return {
            isError: true,
            content: [{ type: "text", text: `Not found: ${ err.message }` }],
        };
    }
    if (err instanceof RepoServiceUnavailableError) {
        const structured: { code: "backend_unavailable"; format?: "deb" | "rpm" } = {
            code: "backend_unavailable",
        };
        if (err.format !== undefined) structured.format = err.format;
        return {
            isError: true,
            content: [{ type: "text", text: `Unavailable: ${ err.message }` }],
            structuredContent: structured,
        };
    }
    const correlationId = getCorrelationId();
    return {
        isError: true,
        content: [{
            type: "text",
            text: correlationId
                ? `Internal error; check server logs (correlation=${ correlationId }).`
                : "Internal error; check server logs.",
        }],
        structuredContent: correlationId ? { correlation: { id: correlationId } } : undefined,
    };
}
