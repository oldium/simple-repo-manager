import express from "express";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRequire } from "node:module";
import type { AppConfig } from "../../lib/config.ts";
import { RepoService } from "../../lib/repo-service.ts";
import { registerTools } from "./tools.ts";
import logger from "../../lib/logger.ts";

const pkg = createRequire(import.meta.url)("../../../package.json") as { version: string };

export default function mcpRouter(config: AppConfig) {
    const router = express.Router({ strict: true });
    const service = new RepoService(config.paths, config.gpg, config.upload);

    router.get("/", (_req, res) => {
        res.setHeader("Allow", "POST");
        res.status(405).json({ error: "Method Not Allowed" });
    });

    router.post("/", express.json(), async (req: Request, res: Response) => {
        const enabled = {
            deb: config.upload.enabledApi.deb,
            rpm: config.upload.enabledApi.rpm,
        };
        const parts: string[] = [];
        if (enabled.deb) parts.push("deb");
        if (enabled.rpm) parts.push("rpm");
        const enabledLabel = parts.length === 0 ? "none" : parts.join(", ");

        const baseInstructions =
            parts.length === 2
                ? "Use these tools to list, upload, import, and remove deb and rpm packages from the configured repositories."
                : parts.length === 1
                    ? `Use these tools to list, upload, import, and remove ${ parts[0] } packages. The ${ parts[0] === "deb" ? "rpm" : "deb" } backend is disabled in the current server configuration.`
                    : "No repository backends are enabled on this server. Both deb and rpm are disabled in the current configuration. Call server_status to confirm, then ask an administrator to enable at least one backend and restart the server.";

        const { instanceLabel } = config;
        const instructions = instanceLabel
            ? `This MCP server manages the "${ instanceLabel }" repository. ${ baseInstructions }`
            : baseInstructions;

        const serverInfo: {
            name: string;
            version: string;
            description: string;
            title?: string;
        } = {
            name: "simple-repo-manager",
            version: pkg.version,
            description: `Repository manager. Enabled backends: ${ enabledLabel }.`,
        };
        if (instanceLabel) serverInfo.title = instanceLabel;

        const server = new McpServer(serverInfo, {
            capabilities: { tools: {} },
            instructions,
        });

        registerTools(server, service, req, enabled);

        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });

        res.on("close", () => {
            transport.close().catch((err) => logger.debug("MCP transport close failed", { err }));
            server.close().catch((err) => logger.debug("MCP server close failed", { err }));
        });

        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (err) {
            logger.error("MCP request failed", { err });
            if (!res.headersSent) {
                res.status(500).json({ error: "Internal MCP error" });
            }
        }
    });

    return router;
}
