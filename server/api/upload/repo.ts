import type { EnabledApi, Gpg, Paths, UploadOptions } from "../../lib/config.ts";
import type { Request, RequestHandler } from "express";
import { default as processIncomingDeb } from "../../lib/deb.ts";
import { default as processIncomingRpm } from "../../lib/rpm.ts";
import type { ActionResult } from "../../lib/exec.ts";
import type { LoggedResponse } from "../../lib/logger.ts";
import logger from "../../lib/logger.ts";
import { sendErrorResponse, sendRepoResponse } from "../../lib/res.ts";
import osPath from "path";
import { moveAll } from "../../lib/fs.ts";
import lock from "../../lib/lock.ts";

class RepoHandler {
    private enabledApi: EnabledApi;
    constructor(private paths: Paths, private gpg: Gpg, upload: UploadOptions) {
        this.enabledApi = upload.enabledApi;
    }

    public middleware(): RequestHandler {
        return this.repoHandler.bind(this);
    }

    private async repoHandler(_req: Request, res: LoggedResponse): Promise<void> {
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
}

function middleware(paths: Paths, gpg: Gpg, upload: UploadOptions) {
    const handler = new RepoHandler(paths, gpg, upload);
    return handler.middleware();
}

export default {
    post: middleware
}
