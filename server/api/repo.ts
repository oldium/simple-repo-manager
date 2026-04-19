import type { EnabledApi, Gpg, Paths, UploadOptions } from "../lib/config.ts";
import type { Request, RequestHandler, Response } from "express";
import { default as processIncomingDeb, removePackage as removeDebPackage } from "../lib/deb.ts";
import { default as processIncomingRpm, removePackage as removeRpmPackage } from "../lib/rpm.ts";
import type { ActionResult } from "../lib/exec.ts";
import type { LoggedResponse } from "../lib/logger.ts";
import logger from "../lib/logger.ts";
import { sendErrorResponse, sendRepoResponse, sendUploadResponse } from "../lib/res.ts";
import osPath from "path";
import { moveAll } from "../lib/fs.ts";
import lock from "../lib/lock.ts";
import { validatePackageIdentifier } from "../lib/validations.ts";
import type { ParamsDictionary } from "express-serve-static-core";

type RemoveParams = { format: string; distribution: string; release: string; source: string; version: string };

class RepoHandler {
    private enabledApi: EnabledApi;
    constructor(private paths: Paths, private gpg: Gpg, upload: UploadOptions) {
        this.enabledApi = upload.enabledApi;
    }

    public importMiddleware(): RequestHandler {
        return this.importHandler.bind(this);
    }

    public removeMiddleware(): RequestHandler<ParamsDictionary & RemoveParams> {
        return this.removeHandler.bind(this);
    }

    private async importHandler(_req: Request, res: LoggedResponse): Promise<void> {
        const result: Record<string, ActionResult> = {};

        try {
            await lock.forExecOnce(async () => await moveAll(osPath.join(this.paths.incomingDir, "staging"),
                osPath.join(this.paths.incomingDir, "process")));

            if (!this.enabledApi.deb && !this.enabledApi.rpm) {
                return sendErrorResponse(res, 503, 'No repository tool available', { 'Retry-After': '3600' });
            }

            if (this.enabledApi.deb) {
                Object.assign(result, await processIncomingDeb(this.paths, this.gpg));
            }
            if (this.enabledApi.rpm) {
                Object.assign(result, await processIncomingRpm(this.paths, this.gpg));
            }

            const okKeys: string[] = [];
            const scriptKeys: string[] = [];
            const errorKeys: string[] = [];
            Object.entries(result).forEach(([key, value]) => {
                switch (value.result) {
                    case "success":
                        okKeys.push(key);
                        break;
                    case "error":
                        errorKeys.push(key);
                        break;
                    case "script":
                        scriptKeys.push(key);
                        break;
                }
            });

            if (Object.keys(result).length === 0) {
                sendRepoResponse(res, 200, 'No files to process');
            } else if (scriptKeys.length === 0 && errorKeys.length === 0) {
                sendRepoResponse(res, 200, 'Repository build script executed successfully');
            } else {
                sendRepoResponse(res, 500, 'Repository build script execution failed. See server logs for details');
            }
        } catch (err: unknown) {
            logger.error("Error during repository build:", { err });
            if (!res.headersSent) {
                sendRepoResponse(res, 500, 'An unexpected server error occurred. See server logs for details');
            }
        }
    }

    private async removeHandler(req: Request<ParamsDictionary & RemoveParams>, res: Response): Promise<void> {
        const { format, distribution, release, source, version } = req.params;

        if (format !== "rpm" && format !== "deb") {
            return sendErrorResponse(res, 404, "Unknown repository format");
        }
        if (!validatePackageIdentifier(distribution)
            || !validatePackageIdentifier(release)
            || !validatePackageIdentifier(source)
            || !validatePackageIdentifier(version)) {
            return sendErrorResponse(res, 400, "Invalid characters in path segment");
        }

        if (format === "rpm" && !this.enabledApi.rpm) {
            return sendErrorResponse(res, 503, "RPM repository tool not available", { 'Retry-After': '3600' });
        }
        if (format === "deb" && !this.enabledApi.deb) {
            return sendErrorResponse(res, 503, "Debian repository tool not available", { 'Retry-After': '3600' });
        }

        try {
            await lock.forExecOnce(async () => {
                if (format === "rpm") {
                    const result = await removeRpmPackage(this.paths, distribution, release, source, version);
                    if (result.notFound === true) {
                        return sendErrorResponse(res, 404, `No such repository rpm/${ distribution }/${ release }`);
                    }
                    if (result.action && result.action.result !== "success") {
                        return sendErrorResponse(res, 500,
                            "createrepo failed during removal. See server logs for details");
                    }
                    const msg = result.files.length === 0
                        ? `No packages matched ${ source }-${ version } in rpm/${ distribution }/${ release }`
                        : `Removed ${ result.files.length } file(s) from rpm/${ distribution }/${ release }`;
                    return sendUploadResponse(res, 200, msg, result.files);
                }
                const debResult = await removeDebPackage(this.paths, distribution, release, source, version);
                if (debResult.notFound === true) {
                    return sendErrorResponse(res, 404, `No such repository deb/${ distribution }/${ release }`);
                }
                if (debResult.action && debResult.action.result !== "success") {
                    return sendErrorResponse(res, 500,
                        "reprepro failed during removal. See server logs for details");
                }
                const msg = debResult.files.length === 0
                    ? `No packages matched ${ source }/${ version } in deb/${ distribution }/${ release }`
                    : `Removed ${ debResult.files.length } entr${ debResult.files.length === 1 ? "y" : "ies" } from deb/${ distribution }/${ release }`;
                return sendUploadResponse(res, 200, msg, debResult.files);
            });
        } catch (err) {
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

export default {
    post: importMiddleware,
    remove: removeMiddleware
};
