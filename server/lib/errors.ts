import type { RemovalFile } from "./repo-types.ts";

export class RepoError extends Error {
    public readonly cause?: unknown;
    constructor(message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = new.target.name;
        if (options && "cause" in options) {
            this.cause = options.cause;
        }
    }
}

export class RepoValidationError extends RepoError { }
export class RepoNotFoundError extends RepoError { }
export class RepoServiceUnavailableError extends RepoError {
    public readonly format?: "deb" | "rpm";
    constructor(message: string, options?: { cause?: unknown; format?: "deb" | "rpm" }) {
        super(message, options);
        this.format = options?.format;
    }
}

export class RepoInternalError extends RepoError {
    public readonly files?: RemovalFile[];
    constructor(message: string, options?: { cause?: unknown; files?: RemovalFile[] }) {
        super(message, options);
        this.files = options?.files;
    }
}
