import { z } from "zod";
import { READ_TOOLS } from "./tools.ts";

export const WEBMCP_SCRIPT_URL = "/webmcp.js";

/** The read tools for an agent in the browser: their definitions come along, so it never has to ask for them */
export function webMcpScript(): string {
    const tools = Object.entries(READ_TOOLS).map(([name, { title, description, inputSchema, annotations }]) => ({
        name,
        title,
        description,
        inputSchema: z.toJSONSchema(z.object(inputSchema), { target: "draft-7", io: "input" }),
        annotations,
    }));

    return `(async () => {
    // navigator is where Chromium first had it, the specification moved it to document
    const modelContext = document.modelContext ?? navigator.modelContext;
    if (!modelContext) {
        return;
    }

    const call = async (name, args, signal) => {
        const response = await fetch("/api/v1/mcp", {
            method: "POST",
            // Credentials of this origin could only turn a read into a 401
            credentials: "omit",
            signal,
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args ?? {} } }),
        });
        const { result, error } = await response.json();
        if (error) {
            throw new Error(error.message);
        }
        return result.isError ? result : result.structuredContent ?? result;
    };

    for (const tool of ${ JSON.stringify(tools) }) {
        await modelContext.registerTool({ ...tool, execute: (args, options) => call(tool.name, args, options?.signal) });
    }
})().catch(err => console.warn("Registering the WebMCP tools failed:", err));
`;
}
