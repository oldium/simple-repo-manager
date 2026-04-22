import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Request } from "express";
import { RepoService } from "../../lib/repo-service.ts";
import { errorResult, successResult, type ToolResult } from "./mappers.ts";
import { getUriNoQuery } from "../../lib/req.ts";
import logger from "../../lib/logger.ts";
import { mimeTypeFor } from "../../lib/mime.ts";

export interface EnabledBackends {
    deb: boolean;
    rpm: boolean;
}

function withLogging<Args extends unknown[], R extends ToolResult<object | undefined>>(
    name: string,
    cb: (...args: Args) => Promise<R> | R,
): (...args: Args) => Promise<R> {
    return async (...args: Args) => {
        const input = args[0] ?? {};
        logger.info(`MCP tool ${ name } input=${ JSON.stringify(input) }`);
        const result = await Promise.resolve(cb(...args));
        if (result.isError) {
            const text = result.content.find(c => c.type === "text")?.text ?? "unknown";
            logger.info(`MCP tool ${ name } - error: ${ text }`);
        } else {
            logger.info(`MCP tool ${ name } - ok`);
        }
        return result;
    };
}

export function registerTools(
    server: McpServer,
    service: RepoService,
    req: Request,
    enabled: EnabledBackends
) {
    // Always-available status probe.
    server.registerTool("server_status", {
        title: "Server status",
        description: "Report server health and which repository backends (deb, rpm) are currently enabled. Always callable regardless of configuration. Call this first to discover capability before invoking other tools.",
        inputSchema: {},
    }, withLogging("server_status", async () => {
        const status = service.getStatus();
        const parts: string[] = [];
        if (status.api.deb.enabled) parts.push("deb");
        if (status.api.rpm.enabled) parts.push("rpm");
        const label = parts.length === 0 ? "none" : parts.join(", ");
        return successResult(
            `Repository manager is running. Enabled backends: ${ label }.`,
            {
                message: status.message,
                api: {
                    deb: { enabled: status.api.deb.enabled },
                    rpm: { enabled: status.api.rpm.enabled },
                },
            }
        );
    }));

    // No repo tools when nothing is reachable — tools/list is an honest inventory.
    if (!enabled.deb && !enabled.rpm) return;

    // Narrowed format enum: list only enabled values. At this point we know at
    // least one is enabled (the early return above guarantees it).
    const formatEnum = enabled.deb && enabled.rpm
        ? z.enum(["deb", "rpm"])
        : enabled.deb
            ? z.enum(["deb"])
            : z.enum(["rpm"]);

    server.registerTool("list_repositories", {
        title: "List repositories",
        description: "List configured (format, distribution, release) triples, optionally filtered.",
        inputSchema: {
            format: formatEnum.describe("Repository format filter. Omit to include all enabled backends.").optional(),
            distribution: z.string().min(1).describe("Distribution name filter (e.g. 'debian', 'fedora'). Omit to match any.").optional(),
            release: z.string().min(1).describe("Release name filter (e.g. 'bookworm', '40'). Omit to match any.").optional(),
        },
    }, withLogging("list_repositories", async (input) => {
        try {
            const repos = await service.listRepositories(input);
            return successResult(
                `Found ${ repos.length } repositor${ repos.length === 1 ? "y" : "ies" }.`,
                { repositories: repos }
            );
        } catch (err) {
            return errorResult(err);
        }
    }));

    server.registerTool("list_source_packages", {
        title: "List source packages",
        description: "List source packages across matching repositories.",
        inputSchema: {
            format: formatEnum.describe("Repository format filter. Omit to include all enabled backends.").optional(),
            distribution: z.string().min(1).describe("Distribution name filter. Omit to match any.").optional(),
            release: z.string().min(1).describe("Release name filter. Omit to match any.").optional(),
            source: z.string().min(1).describe("Source package name filter. Omit to return every source.").optional(),
        },
    }, withLogging("list_source_packages", async (input) => {
        try {
            const packages = await service.listSourcePackages(input);
            return successResult(
                `Found ${ packages.length } source package${ packages.length === 1 ? "" : "s" }.`,
                { packages }
            );
        } catch (err) {
            return errorResult(err);
        }
    }));

    server.registerTool("prepare_upload", {
        title: "Prepare upload",
        description: "Return one PUT URL per filename. Agents upload each file then call import_repository.",
        inputSchema: {
            format: formatEnum.describe("Repository format the uploaded files target."),
            distribution: z.string().min(1).describe("Distribution name (e.g. 'debian', 'fedora')."),
            release: z.string().min(1).describe("Release name (e.g. 'bookworm', '40')."),
            component: z.string().min(1).describe("Debian component (e.g. 'main'). Required for deb, must be omitted for rpm.").optional(),
            subcomponent: z.string().min(1).describe("Optional Debian subcomponent. Only valid when format=deb.").optional(),
            filenames: z.union([
                z.string().min(1),
                z.array(z.string().min(1)).min(1),
            ]).describe("One filename or an array of filenames to upload. Each gets its own PUT URL."),
        },
    }, withLogging("prepare_upload", async (input) => {
        try {
            const filenames = Array.isArray(input.filenames) ? input.filenames : [input.filenames];
            const slots = service.prepareUpload({
                format: input.format,
                distribution: input.distribution,
                release: input.release,
                component: input.component,
                subcomponent: input.subcomponent,
            }, filenames);

            const callerAuth = req.headers.authorization;
            const headers = callerAuth ? { Authorization: callerAuth } : undefined;

            const resolved = slots.map((slot) => {
                const entry: {
                    filename: string;
                    uploadUrl: string;
                    method: "PUT";
                    headers?: { Authorization: string };
                    maxBytes?: number;
                } = {
                    filename: slot.filename,
                    uploadUrl: getUriNoQuery(req, slot.relativePath),
                    method: "PUT",
                };
                if (headers) entry.headers = headers;
                if (slot.maxBytes !== undefined) entry.maxBytes = slot.maxBytes;
                return entry;
            });

            return successResult(
                `Prepared ${ resolved.length } upload slot${ resolved.length === 1 ? "" : "s" }. PUT each file to its uploadUrl, then call import_repository.`,
                { slots: resolved }
            );
        } catch (err) {
            return errorResult(err);
        }
    }));

    server.registerTool("import_repository", {
        title: "Import staged uploads",
        description: "Run the repository rebuild for all staged files.",
        inputSchema: {},
    }, withLogging("import_repository", async () => {
        try {
            const result = await service.importRepository();
            if (result.ok) {
                return successResult("Import completed successfully.", { ok: true as const });
            }
            const correlationId = result.correlationId;
            return {
                isError: true,
                content: [{
                    type: "text",
                    text: correlationId
                        ? `Import failed. Check server logs with correlation id=${ correlationId }.`
                        : "Import failed. Check server logs.",
                }],
                structuredContent: correlationId
                    ? { ok: false as const, correlation: { id: correlationId } }
                    : { ok: false as const },
            };
        } catch (err) {
            return errorResult(err);
        }
    }));

    server.registerTool("remove_package", {
        title: "Remove package",
        description: "Remove a package across one or many (format, distribution, release) triples.",
        inputSchema: {
            format: formatEnum.describe("Repository format filter. Omit to remove from every enabled backend.").optional(),
            distribution: z.string().min(1).describe("Distribution name filter. Omit to match any.").optional(),
            release: z.string().min(1).describe("Release name filter. Omit to match any.").optional(),
            source: z.string().min(1).describe("Source package name to remove."),
            version: z.string().min(1).describe("Specific version to remove. Omit to remove every version.").optional(),
        },
    }, withLogging("remove_package", async (input) => {
        try {
            const result = await service.removePackage(input);
            const msg = result.files.length === 0
                ? `No packages matched ${ input.source }.`
                : `Removed ${ result.files.length } file(s) across ${ result.touchedTargets } release(s).`;
            return successResult(msg, { files: result.files, touchedTargets: result.touchedTargets });
        } catch (err) {
            return errorResult(err);
        }
    }));

    server.registerTool("list_package_files", {
        title: "List package files",
        description: "List files belonging to a source package across one or many "
            + "(format, distribution, release) triples. Each result includes a "
            + "direct HTTPS download URL; fetch each downloadUrl with the same "
            + "Authorization header the caller used. Use remove_package to delete instead.",
        inputSchema: {
            format: formatEnum.describe("Repository format filter. Omit to include all enabled backends.").optional(),
            distribution: z.string().min(1).describe("Distribution name filter. Omit to match any.").optional(),
            release: z.string().min(1).describe("Release name filter. Omit to match any.").optional(),
            source: z.string().min(1).describe("Source package name."),
            version: z.string().min(1).describe("Specific version to list. Omit to list every version.").optional(),
        },
    }, withLogging("list_package_files", async (input) => {
        try {
            const { files, touchedTargets } = await service.listPackageFiles(input);

            const callerAuth = req.headers.authorization;
            const fileEntries = files.map((f) => {
                const downloadUrl = getUriNoQuery(req, "/" + f.path);
                const entry: {
                    filename: string;
                    path: string;
                    downloadUrl: string;
                    method: "GET";
                    headers?: { Authorization: string };
                } = {
                    filename: f.filename,
                    path: f.path,
                    downloadUrl,
                    method: "GET",
                };
                if (callerAuth) entry.headers = { Authorization: callerAuth };
                return entry;
            });

            const resourceLinks = files.map((f) => ({
                type: "resource_link" as const,
                uri: getUriNoQuery(req, "/" + f.path),
                name: f.filename,
                mimeType: mimeTypeFor(f.filename),
            }));

            const text = files.length === 0
                ? `No packages matched ${ input.source }.`
                : `Found ${ files.length } file(s) across ${ touchedTargets } release(s). `
                + `GET each downloadUrl (same auth as this request) to fetch.`;

            return {
                isError: false,
                content: [{ type: "text" as const, text }, ...resourceLinks],
                structuredContent: { files: fileEntries, touchedTargets },
            };
        } catch (err) {
            return errorResult(err);
        }
    }));
}
