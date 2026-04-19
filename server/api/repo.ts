import type { EnabledApi, Gpg, Paths, UploadOptions } from "../lib/config.ts";
import type { Request, RequestHandler, Response } from "express";
import {
    default as processIncomingDeb,
    enumerateRemovalTargets as enumerateDebTargets,
    removePackage as removeDebPackage
} from "../lib/deb.ts";
import type { DebVersionFilter } from "../lib/deb.ts";
import {
    default as processIncomingRpm,
    enumerateRemovalTargets as enumerateRpmTargets,
    removePackage as removeRpmPackage
} from "../lib/rpm.ts";
import type { RpmVersionFilter } from "../lib/rpm.ts";
import type { ActionResult } from "../lib/exec.ts";
import type { LoggedResponse } from "../lib/logger.ts";
import logger from "../lib/logger.ts";
import { sendErrorResponse, sendRepoResponse, sendUploadResponse } from "../lib/res.ts";
import osPath from "path";
import { moveAll } from "../lib/fs.ts";
import lock from "../lib/lock.ts";
import {
    isAnyWildcard,
    validatePackageIdentifier,
    validateWildcardOrIdentifier
} from "../lib/validations.ts";
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
        if (!validateWildcardOrIdentifier(distribution)
            || !validateWildcardOrIdentifier(release)
            || !validatePackageIdentifier(source)
            || !validateWildcardOrIdentifier(version)) {
            return sendErrorResponse(res, 400, "Invalid characters in path segment");
        }

        if (format === "rpm" && !this.enabledApi.rpm) {
            return sendErrorResponse(res, 503, "RPM repository tool not available", { 'Retry-After': '3600' });
        }
        if (format === "deb" && !this.enabledApi.deb) {
            return sendErrorResponse(res, 503, "Debian repository tool not available", { 'Retry-After': '3600' });
        }

        const distroArg = isAnyWildcard(distribution) ? undefined : distribution;
        const releaseArg = isAnyWildcard(release) ? undefined : release;
        const versionFilter: DebVersionFilter | RpmVersionFilter =
            isAnyWildcard(version) ? { any: true } as const : version;

        try {
            await lock.forExecOnce(async () => {
                const targets = format === "rpm"
                    ? await enumerateRpmTargets(this.paths, distroArg, releaseArg)
                    : await enumerateDebTargets(this.paths, distroArg, releaseArg);

                // 404 only when a literal distro or release resolved to
                // zero configured repositories. Wildcard → 200 empty.
                if (targets.length === 0 && (distroArg !== undefined || releaseArg !== undefined)) {
                    return sendErrorResponse(res, 404,
                        `No such repository ${ format }/${ distribution }/${ release }`);
                }

                type FileEntry = { filename: string; status: "ok" | "failed"; path: string };
                const files: FileEntry[] = [];
                const failedTargets: { distribution: string; release: string }[] = [];
                let touchedTargets = 0;

                for (const target of targets) {
                    const result = format === "rpm"
                        ? await removeRpmPackage(this.paths, target.distribution, target.release, source, versionFilter)
                        : await removeDebPackage(this.paths, target.distribution, target.release, source, versionFilter);

                    if (result.notFound === true) continue;   // enumerated, so should not happen
                    if (result.files.length > 0) touchedTargets++;
                    files.push(...result.files);
                    if (result.action && result.action.result !== "success") {
                        failedTargets.push(target);
                    }
                }

                if (failedTargets.length > 0) {
                    return sendUploadResponse(res, 500,
                        `Removed ${ files.length } entr${ files.length === 1 ? "y" : "ies" }; one or more targets failed. See server logs for details`,
                        files);
                }

                const msg = files.length === 0
                    ? `No packages matched ${ source }/${ version } in ${ format }/${ distribution }/${ release }`
                    : format === "deb"
                        ? `Removed ${ files.length } package reference(s) across ${ touchedTargets } release(s); shared pool files are retained while referenced elsewhere`
                        : `Removed ${ files.length } file(s) across ${ touchedTargets } release(s)`;

                return sendUploadResponse(res, 200, msg, files);
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
