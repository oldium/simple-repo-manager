import type { Gpg, Paths, UploadOptions } from "../lib/config.ts";
import type { Request, RequestHandler, Response } from "express";
import type { LoggedResponse } from "../lib/logger.ts";
import logger from "../lib/logger.ts";
import { sendErrorResponse, sendListResponse, sendRepoResponse, sendUploadResponse } from "../lib/res.ts";
import { getUriNoQuery } from "../lib/req.ts";
import {
    isAnyWildcard,
    validatePackageIdentifier,
    validateWildcardOrIdentifier
} from "../lib/validations.ts";
import type { ParamsDictionary } from "express-serve-static-core";
import { RepoService } from "../lib/repo-service.ts";
import {
    RepoError,
    RepoInternalError,
    RepoNotFoundError,
    RepoServiceUnavailableError,
    RepoValidationError,
} from "../lib/errors.ts";

type PackagePathParams = {
    format: string;
    distribution: string;
    release: string;
    source: string;
    version?: string;
};

class RepoHandler {
    private readonly service: RepoService;

    constructor(paths: Paths, gpg: Gpg, upload: UploadOptions) {
        this.service = new RepoService(paths, gpg, upload);
    }

    public importMiddleware(): RequestHandler {
        return this.importHandler.bind(this);
    }

    public removeMiddleware(): RequestHandler<ParamsDictionary & PackagePathParams> {
        return this.removeHandler.bind(this);
    }

    public listMiddleware(): RequestHandler<ParamsDictionary & PackagePathParams> {
        return this.listHandler.bind(this);
    }

    private async listHandler(req: Request<ParamsDictionary & PackagePathParams>, res: Response): Promise<void> {
        const { format, distribution, release, source, version } = req.params;

        if (!validateWildcardOrIdentifier(format) || (format !== "-" && format !== "deb" && format !== "rpm")) {
            return sendErrorResponse(res, 404, "Unknown repository format");
        }
        if (!validateWildcardOrIdentifier(distribution)
            || !validateWildcardOrIdentifier(release)
            || !validatePackageIdentifier(source)
            || (version !== undefined && !validateWildcardOrIdentifier(version))) {
            return sendErrorResponse(res, 400, "Invalid characters in path segment");
        }

        const formatArg = isAnyWildcard(format) ? undefined : (format as "deb" | "rpm");
        const distroArg = isAnyWildcard(distribution) ? undefined : distribution;
        const releaseArg = isAnyWildcard(release) ? undefined : release;
        const versionArg = version === undefined || isAnyWildcard(version) ? undefined : version;

        try {
            const result = await this.service.listPackageFiles({
                format: formatArg,
                distribution: distroArg,
                release: releaseArg,
                source,
                version: versionArg,
            });
            const versionLabel = version ?? "-";
            const msg = result.files.length === 0
                ? `No packages matched ${ source }/${ versionLabel } in ${ format }/${ distribution }/${ release }`
                : `Found ${ result.files.length } file(s) across ${ result.touchedTargets } release(s)`;
            const files = result.files.map(f => ({
                filename: f.filename,
                path: f.path,
                downloadUrl: getUriNoQuery(req, "/" + f.path),
            }));
            return sendListResponse(res, 200, msg, files, result.touchedTargets);
        } catch (err) {
            if (err instanceof RepoValidationError) {
                return sendErrorResponse(res, 400, err.message);
            }
            if (err instanceof RepoNotFoundError) {
                return sendErrorResponse(res, 404, err.message);
            }
            if (err instanceof RepoServiceUnavailableError) {
                return sendErrorResponse(res, 503, err.message);
            }
            if (err instanceof RepoInternalError) {
                logger.error("Listing target failed:", { err });
                return sendErrorResponse(res, 500, `${ err.message }. See server logs for details`);
            }
            logger.error("Error during package listing:", { err });
            if (!res.headersSent) {
                sendErrorResponse(res, 500, "Package listing failed. See server logs for details");
            }
        }
    }

    private async importHandler(_req: Request, res: LoggedResponse): Promise<void> {
        try {
            const result = await this.service.importRepository();
            if (result.ok) {
                sendRepoResponse(res, 200, "Repository build script executed successfully");
            } else {
                sendRepoResponse(res, 500, "Repository build script execution failed. See server logs for details");
            }
        } catch (err) {
            if (err instanceof RepoServiceUnavailableError) {
                return sendErrorResponse(res, 503, err.message);
            }
            logger.error("Error during repository build:", { err });
            if (!res.headersSent) {
                sendRepoResponse(res, 500, "An unexpected server error occurred. See server logs for details");
            }
        }
    }

    private async removeHandler(req: Request<ParamsDictionary & PackagePathParams>, res: Response): Promise<void> {
        const { format, distribution, release, source, version } = req.params;

        if (!validateWildcardOrIdentifier(format) || (format !== "-" && format !== "deb" && format !== "rpm")) {
            return sendErrorResponse(res, 404, "Unknown repository format");
        }
        if (!validateWildcardOrIdentifier(distribution)
            || !validateWildcardOrIdentifier(release)
            || !validatePackageIdentifier(source)
            || (version !== undefined && !validateWildcardOrIdentifier(version))) {
            return sendErrorResponse(res, 400, "Invalid characters in path segment");
        }

        const formatArg = isAnyWildcard(format) ? undefined : (format as "deb" | "rpm");
        const distroArg = isAnyWildcard(distribution) ? undefined : distribution;
        const releaseArg = isAnyWildcard(release) ? undefined : release;
        const versionArg = version === undefined || isAnyWildcard(version) ? undefined : version;

        try {
            const result = await this.service.removePackage({
                format: formatArg,
                distribution: distroArg,
                release: releaseArg,
                source,
                version: versionArg,
            });
            const versionLabel = version ?? "-";
            const msg = result.files.length === 0
                ? `No packages matched ${ source }/${ versionLabel } in ${ format }/${ distribution }/${ release }`
                : `Removed ${ result.files.length } file(s) across ${ result.touchedTargets } release(s)`;
            return sendUploadResponse(res, 200, msg, result.files);
        } catch (err) {
            if (err instanceof RepoValidationError) {
                return sendErrorResponse(res, 400, err.message);
            }
            if (err instanceof RepoNotFoundError) {
                return sendErrorResponse(res, 404, err.message);
            }
            if (err instanceof RepoServiceUnavailableError) {
                return sendErrorResponse(res, 503, err.message);
            }
            if (err instanceof RepoInternalError) {
                logger.error("Partial removal failure:", { err });
                return sendUploadResponse(res, 500, `${ err.message }. See server logs for details`, err.files ?? []);
            }
            if (err instanceof RepoError) {
                logger.error("Repo error:", { err });
                return sendErrorResponse(res, 500, "Package removal failed. See server logs for details");
            }
            logger.error("Error during package removal:", { err });
            if (!res.headersSent) {
                sendErrorResponse(res, 500, "Package removal failed. See server logs for details");
            }
        }
    }
}

function importMiddleware(paths: Paths, gpg: Gpg, upload: UploadOptions) {
    return new RepoHandler(paths, gpg, upload).importMiddleware();
}

function removeMiddleware(paths: Paths, gpg: Gpg, upload: UploadOptions) {
    return new RepoHandler(paths, gpg, upload).removeMiddleware();
}

function listMiddleware(paths: Paths, gpg: Gpg, upload: UploadOptions) {
    return new RepoHandler(paths, gpg, upload).listMiddleware();
}

export default {
    post: importMiddleware,
    remove: removeMiddleware,
    list: listMiddleware,
};
