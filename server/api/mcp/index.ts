import express from "express";
import type { Request, Response } from "express";
import type { Eta } from "eta";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRequire } from "node:module";
import type { AppConfig } from "../../lib/config.ts";
import { RepoService } from "../../lib/repo-service.ts";
import { registerTools } from "./tools.ts";
import logger from "../../lib/logger.ts";
import { writeGateRefusal } from "../../lib/auth.ts";
import { renderSetupInstructions } from "../../lib/render.ts";

const pkg = createRequire(import.meta.url)("../../../package.json") as { version: string };

export default function mcpRouter(config: AppConfig, eta: Eta) {
    const router = express.Router({ strict: true });
    const service = new RepoService(config.paths, config.gpg, config.upload);
    const { allowedIps, basicAuth, bearerAuth } = config.upload;
    const writeRefusal = writeGateRefusal(allowedIps, basicAuth, bearerAuth);

    router.get("/", (_req, res) => {
        res.setHeader("Allow", "POST");
        res.status(405).json({ error: "Method Not Allowed" });
    });

    router.post("/", express.json(), async (req: Request, res: Response) => {
        const refusal = writeRefusal(req);
        const writeAllowed = refusal === undefined;
        // Presented credentials are valid here (invalid ones got 401), so only the allowlist downgrades them
        if (refusal === "ip") {
            logger.info(`Client ${ req.ip } gets only the MCP read tools: IP not in the allowlist`);
        }
        const actions = writeAllowed ? "list, search, upload, import, and remove" : "list and search";
        const baseInstructions = `Use these tools to ${ actions } deb and rpm packages from the configured repositories.`;

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
            description: "Repository manager. Enabled backends: deb, rpm.",
        };
        if (instanceLabel) serverInfo.title = instanceLabel;

        const server = new McpServer(serverInfo, {
            capabilities: { tools: {} },
            instructions,
        });

        registerTools(server, service, req, writeAllowed, target => renderSetupInstructions(req, config.paths, config.gpg, eta, target));

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
