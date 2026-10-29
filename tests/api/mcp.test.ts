import request from "supertest";
import type { Application } from "express";
import fs from "node:fs/promises";
import osPath from "path";
import { fileURLToPath } from "url";
import { jest } from "@jest/globals";

import createTestApp from "../testapp.ts";
import { poolRemovedAt, servedStatuses, uploadFileByPost, withLocalTmpDir } from "../utils.ts";
import { fixtureNames, importedApp } from "../fixture-upload.ts";
import logger from "../../server/lib/logger.ts";

const RPM_FIXTURES = fileURLToPath(new URL("../fixtures/packages/rpm/fedora/42/", import.meta.url));
const BASIC = ["upload:pw"];
const BEARER = ["token-abc"];
const AUTH = "Bearer token-abc";
const READ_TOOLS = ["list_package_files", "list_repositories", "list_source_packages", "server_status"];
const ALL_TOOLS = [
    "import_repository",
    "list_package_files",
    "list_repositories",
    "list_source_packages",
    "prepare_upload",
    "remove_package",
    "server_status",
];
const INITIALIZE = {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
};

function jsonRpc(method: string, params: Record<string, unknown> = {}, id = 1) {
    return { jsonrpc: "2.0", id, method, params };
}

function mcpPost(app: Application, method: string, params: Record<string, unknown> = {}) {
    return request(app)
        .post("/api/v1/mcp")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .send(jsonRpc(method, params));
}

function toolNames(response: request.Response): string[] {
    expect(response.status).toBe(200);
    return response.body.result.tools.map((t: { name: string }) => t.name).sort();
}

async function callTool(app: Application, name: string, args: Record<string, unknown>) {
    const response = await mcpPost(app, "tools/call", { name, arguments: args });
    expect(response.status).toBe(200);
    return response.body.result;
}

/** Calls a list tool with limit 1 until no nextCursor comes back; returns the structured pages */
async function listByPage(app: Application, name: string, args: Record<string, unknown>, maxPages: number) {
    const pages = [];
    let cursor: string | undefined;
    do {
        const result = await callTool(app, name, { ...args, limit: 1, cursor });
        expect(result.isError).toBeFalsy();
        pages.push(result.structuredContent);
        cursor = result.structuredContent.nextCursor;
    } while (cursor !== undefined && pages.length <= maxPages);
    return pages;
}

async function poolPaths(dir: string, poolDir: string): Promise<string[]> {
    return (await fixtureNames(`packages/${ dir }`)).map(name => `${ poolDir }/${ name }`);
}

/** Uploads the rpm fixture bundle through the REST API and imports it through MCP; returns its file names */
async function importRpmFixtures(app: Application): Promise<string[]> {
    const names = (await fs.readdir(RPM_FIXTURES)).sort();
    const files = await Promise.all(names.map(async name => ({ name, content: await fs.readFile(osPath.join(RPM_FIXTURES, name)) })));
    expect((await uploadFileByPost(app, "/api/v1/upload/rpm/fedora/42", files)).status).toBe(201);
    const response = await request(app)
        .post("/api/v1/mcp")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .send(jsonRpc("tools/call", { name: "import_repository", arguments: {} }));
    expect(response.status).toBe(200);
    const result = response.body.result.structuredContent;
    expect(result.ok).toBe(true);
    expect(result.files.map((f: { path: string; status: string }) => `${ f.path } ${ f.status }`).sort())
        .toEqual(names.map(name => `rpm/fedora/42/${ name } ok`));
    return names;
}

describe("MCP server", () => {
    test("GET returns 405", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const response = await request(app).get("/api/v1/mcp");
        expect(response.status).toBe(405);
        expect(response.headers.allow).toBe("POST");
    }));

    test("Requires credentials when configured", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { bearerAuth: ["token-abc"] } });
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .send(jsonRpc("tools/list"));
        expect(response.status).toBe(401);
    }));

    test("tools/list returns the seven tools when both backends enabled", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/list"));
        expect(response.status).toBe(200);
        const names = response.body.result.tools.map((t: { name: string }) => t.name).sort();
        expect(names).toEqual([
            "import_repository",
            "list_package_files",
            "list_repositories",
            "list_source_packages",
            "prepare_upload",
            "remove_package",
            "server_status",
        ]);
    }));

    test("tools/list returns only server_status when both backends disabled", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { enabledApi: { deb: false, rpm: false } } });
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/list"));
        expect(response.status).toBe(200);
        const names = response.body.result.tools.map((t: { name: string }) => t.name);
        expect(names).toEqual(["server_status"]);
    }));

    test("server_status reports per-backend flags regardless of config", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { enabledApi: { deb: false, rpm: true } } });
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/call", { name: "server_status", arguments: {} }));
        expect(response.status).toBe(200);
        expect(response.body.result.isError).toBeFalsy();
        expect(response.body.result.structuredContent).toEqual({
            message: "Package repository API is running",
            api: {
                deb: { enabled: false },
                rpm: { enabled: true },
            },
        });
    }));

    test("format enum narrows to enabled backends in partial-disable", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { enabledApi: { deb: true, rpm: false } } });
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/list"));
        expect(response.status).toBe(200);
        const prepareUpload = response.body.result.tools.find((t: { name: string }) => t.name === "prepare_upload");
        expect(prepareUpload.inputSchema.properties.format.enum).toEqual(["deb"]);
    }));

    test("prepare_upload with disabled format is rejected at schema layer", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { enabledApi: { deb: true, rpm: false } } });
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/call", {
                name: "prepare_upload",
                arguments: {
                    format: "rpm",
                    distribution: "fedora",
                    release: "40",
                    filenames: ["x.rpm"],
                },
            }));
        expect(response.status).toBe(200);
        // Pin whichever shape the SDK emits — JSON-RPC-level error OR tool-level isError.
        // The load-bearing assertion is that no handler runs successfully.
        const isRpcError = response.body.error !== undefined;
        const isToolError = response.body.result?.isError === true;
        expect(isRpcError || isToolError).toBe(true);
    }));

    test("list_repositories lists the imported rpm repository", withLocalTmpDir(async () => {
        const app = await createTestApp();
        await importRpmFixtures(app);
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/call", { name: "list_repositories", arguments: {} }));
        expect(response.status).toBe(200);
        const result = response.body.result;
        expect(result.structuredContent.repositories).toEqual([
            { format: "rpm", distribution: "fedora", release: "42" },
        ]);
    }));

    test("prepare_upload returns absolute PUT URLs", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .set("Authorization", "Bearer test-token")
            .send(jsonRpc("tools/call", {
                name: "prepare_upload",
                arguments: {
                    format: "rpm",
                    distribution: "fedora",
                    release: "40",
                    filenames: "clevis-21-1.src.rpm",
                },
            }));
        expect(response.status).toBe(200);
        const slots = response.body.result.structuredContent.slots;
        expect(slots).toHaveLength(1);
        expect(slots[0].filename).toBe("clevis-21-1.src.rpm");
        expect(slots[0].uploadUrl).toMatch(/^https?:\/\/.+\/api\/v1\/upload\/rpm\/fedora\/40\/clevis-21-1\.src\.rpm$/);
        expect(slots[0].method).toBe("PUT");
        expect(slots[0].headers.Authorization).toBe("Bearer test-token");
    }));

    test("import_repository with empty incoming reports ok=true", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/call", { name: "import_repository", arguments: {} }));
        expect(response.status).toBe(200);
        expect(response.body.result.isError).toBeFalsy();
        expect(response.body.result.structuredContent).toEqual({ ok: true, files: [] });
    }));

    test("remove_package with unknown literal distro returns not-found isError", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/call", {
                name: "remove_package",
                arguments: { format: "rpm", distribution: "nonexistent", release: "99", source: "nothing" },
            }));
        expect(response.status).toBe(200);
        expect(response.body.result.isError).toBe(true);
        expect(response.body.result.content[0].text).toMatch(/Not found/);
        expect(response.body.result.structuredContent?.code).toBeUndefined();
    }));

    test("Invalid argument surfaces as isError with text", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/call", {
                name: "prepare_upload",
                arguments: {
                    format: "rpm",
                    distribution: "fedora",
                    release: "40",
                    component: "main",
                    filenames: ["x.rpm"],
                },
            }));
        expect(response.status).toBe(200);
        expect(response.body.result.isError).toBe(true);
        expect(response.body.result.content[0].text).toMatch(/Invalid argument.*component\/subcomponent/);
    }));

    test("initialize advertises enabled backends in instructions and description (both on)", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "test", version: "1.0" },
                },
            });
        expect(response.status).toBe(200);
        expect(response.body.result.instructions).toMatch(/deb and rpm/);
        expect(response.body.result.serverInfo.description).toMatch(/deb, rpm/);
    }));

    test("initialize signals zero backends when both disabled", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { enabledApi: { deb: false, rpm: false } } });
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "test", version: "1.0" },
                },
            });
        expect(response.status).toBe(200);
        expect(response.body.result.instructions).toMatch(/No repository backends are enabled/);
        expect(response.body.result.serverInfo.description).toMatch(/Enabled backends: none/);
    }));

    test("logs tool call input and ok result for empty-input tool", withLocalTmpDir(async () => {
        const infoSpy = jest.spyOn(logger, "info");
        const app = await createTestApp();
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/call", { name: "server_status", arguments: {} }));
        expect(response.status).toBe(200);
        const messages = infoSpy.mock.calls.map((c) => String(c[0]));
        expect(messages).toContain("MCP tool server_status input={}");
        expect(messages).toContain("MCP tool server_status - ok");
    }));

    test("logs tool call input as stringified arguments", withLocalTmpDir(async () => {
        const infoSpy = jest.spyOn(logger, "info");
        const app = await createTestApp();
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/call", {
                name: "list_repositories",
                arguments: { format: "deb", distribution: "debian" },
            }));
        expect(response.status).toBe(200);
        const messages = infoSpy.mock.calls.map((c) => String(c[0]));
        expect(messages).toContain(
            'MCP tool list_repositories input={"format":"deb","distribution":"debian"}'
        );
        expect(messages).toContain("MCP tool list_repositories - ok");
    }));

    test("logs tool call error with caller-visible text", withLocalTmpDir(async () => {
        const infoSpy = jest.spyOn(logger, "info");
        const app = await createTestApp();
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/call", {
                name: "prepare_upload",
                arguments: {
                    format: "rpm",
                    distribution: "fedora",
                    release: "40",
                    component: "main",
                    filenames: ["x.rpm"],
                },
            }));
        expect(response.status).toBe(200);
        expect(response.body.result.isError).toBe(true);
        const messages = infoSpy.mock.calls.map((c) => String(c[0]));
        expect(messages).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/^MCP tool prepare_upload input=\{/),
                expect.stringMatching(/^MCP tool prepare_upload - error: Invalid argument/),
            ])
        );
    }));

    test("initialize has no serverInfo.title when instanceLabel is unset", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "test", version: "1.0" },
                },
            });
        expect(response.status).toBe(200);
        expect(response.body.result.serverInfo.title).toBeUndefined();
        expect(response.body.result.instructions).not.toMatch(/^This MCP server manages/);
    }));

    test("initialize exposes instanceLabel as serverInfo.title", withLocalTmpDir(async () => {
        const app = await createTestApp({ instanceLabel: "Home repository" });
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "test", version: "1.0" },
                },
            });
        expect(response.status).toBe(200);
        expect(response.body.result.serverInfo.title).toEqual("Home repository");
    }));

    test("initialize instructions are prefixed with instanceLabel context", withLocalTmpDir(async () => {
        const app = await createTestApp({ instanceLabel: "Home repository" });
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "test", version: "1.0" },
                },
            });
        expect(response.status).toBe(200);
        expect(response.body.result.instructions).toMatch(
            /^This MCP server manages the "Home repository" repository\./
        );
        // Existing backend-enabled guidance is still present after the prefix.
        expect(response.body.result.instructions).toMatch(/deb and rpm/);
    }));

    test("initialize names disabled backend in partial-disable instructions", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { enabledApi: { deb: true, rpm: false } } });
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "test", version: "1.0" },
                },
            });
        expect(response.status).toBe(200);
        expect(response.body.result.instructions).toMatch(/rpm backend is disabled/);
        expect(response.body.result.serverInfo.description).toMatch(/Enabled backends: deb/);
    }));

    test("list_package_files returns resource_link blocks with https download URIs (rpm)", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const names = await importRpmFixtures(app);
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .set("Authorization", "Bearer test-token")
            .send(jsonRpc("tools/call", {
                name: "list_package_files",
                arguments: { format: "rpm", source: "srm-hello" },
            }));
        expect(response.status).toBe(200);
        expect(response.body.result.isError).toBeFalsy();

        const { files, touchedTargets } = response.body.result.structuredContent;
        expect(touchedTargets).toBe(1);
        expect(files).toHaveLength(names.length);
        expect(files).toEqual(expect.arrayContaining([
            expect.objectContaining({
                filename: "srm-hello-1.0-1.fc42.src.rpm",
                path: "rpm/fedora/42/Packages/s/srm-hello/srm-hello-1.0-1.fc42.src.rpm",
                downloadUrl: expect.stringMatching(/^https?:\/\/.+\/rpm\/fedora\/42\/Packages\/s\/srm-hello\/srm-hello-1\.0-1\.fc42\.src\.rpm$/),
                method: "GET",
            }),
        ]));
        for (const f of files) {
            expect(f).not.toHaveProperty("headers");
            expect(f).toHaveProperty("downloadUrl");
            expect(typeof f.downloadUrl).toBe("string");
        }

        const links = response.body.result.content.filter(
            (c: { type: string }) => c.type === "resource_link"
        );
        expect(links.length).toBe(files.length);
        const srcLink = links.find((l: { name: string }) => l.name === "srm-hello-1.0-1.fc42.src.rpm");
        expect(srcLink.uri).toMatch(/^https?:\/\/.+\/rpm\/fedora\/42\/Packages\/s\/srm-hello\/srm-hello-1\.0-1\.fc42\.src\.rpm$/);
        expect(srcLink.mimeType).toBe("application/x-rpm");

        const binLink = links.find((l: { name: string }) => l.name === "srm-hello-1.0-1.fc42.x86_64.rpm");
        expect(binLink.mimeType).toBe("application/x-rpm");
    }));

    test("list_package_files empty match returns isError:false and zero resource_links", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/call", {
                name: "list_package_files",
                arguments: { source: "does-not-exist" },
            }));
        expect(response.status).toBe(200);
        expect(response.body.result.isError).toBeFalsy();
        expect(response.body.result.structuredContent.files).toEqual([]);
        expect(response.body.result.structuredContent.touchedTargets).toBe(0);
        expect(response.body.result.content.filter(
            (c: { type: string }) => c.type === "resource_link"
        )).toHaveLength(0);
        expect(response.body.result.content[0].text).toMatch(/No packages matched does-not-exist/);
    }));

    test("list_package_files with explicit unknown distro is Not found", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/call", {
                name: "list_package_files",
                arguments: { format: "rpm", distribution: "nope", release: "0", source: "clevis" },
            }));
        expect(response.status).toBe(200);
        expect(response.body.result.isError).toBe(true);
        expect(response.body.result.content[0].text).toMatch(/Not found/);
    }));

    test("list_package_files rejects empty source at schema layer", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/call", {
                name: "list_package_files",
                arguments: { source: "" },
            }));
        expect(response.status).toBe(200);
        const isRpcError = response.body.error !== undefined;
        const isToolError = response.body.result?.isError === true;
        expect(isRpcError || isToolError).toBe(true);
    }));

    test("list_package_files is absent when both backends disabled", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { enabledApi: { deb: false, rpm: false } } });
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/list"));
        expect(response.status).toBe(200);
        const names = response.body.result.tools.map((t: { name: string }) => t.name);
        expect(names).not.toContain("list_package_files");
    }));
});

describe("MCP tools by access", () => {
    test("Anonymous tools/list shows only server_status and the three list tools when publicRead is on", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { publicRead: true, bearerAuth: BEARER } });

        const response = await mcpPost(app, "tools/list");

        expect(toolNames(response)).toEqual(READ_TOOLS);
        expect(JSON.stringify(response.body.result.tools)).not.toMatch(/prepare_upload|import_repository|remove_package/);
    }));

    test("Authenticated tools/list shows all seven tools", withLocalTmpDir(async () => {
        for (const publicRead of [true, false]) {
            const app = await createTestApp({ upload: { publicRead, basicAuth: BASIC, bearerAuth: BEARER } });

            expect(toolNames(await mcpPost(app, "tools/list").set("Authorization", AUTH))).toEqual(ALL_TOOLS);
            expect(toolNames(await mcpPost(app, "tools/list").auth("upload", "pw", { type: "basic" }))).toEqual(ALL_TOOLS);
        }
    }));

    test("Invalid credentials get 401 rather than the read tools when publicRead is on", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { publicRead: true, bearerAuth: BEARER } });

        const response = await mcpPost(app, "tools/list").set("Authorization", "Bearer wrong");

        expect(response.status).toBe(401);
        expect(response.headers["www-authenticate"]).toBe('Basic realm="API", Bearer realm="API"');
    }));

    test("The IP allowlist keeps the write tools from other callers when publicRead is on", withLocalTmpDir(async () => {
        const denied = await createTestApp({ upload: { publicRead: true, allowedIps: () => false } });
        expect(toolNames(await mcpPost(denied, "tools/list"))).toEqual(READ_TOOLS);

        const deniedWithToken = await createTestApp({ upload: { publicRead: true, allowedIps: () => false, bearerAuth: BEARER } });
        expect(toolNames(await mcpPost(deniedWithToken, "tools/list").set("Authorization", AUTH))).toEqual(READ_TOOLS);

        const allowed = await createTestApp({ upload: { publicRead: true, allowedIps: () => true } });
        expect(toolNames(await mcpPost(allowed, "tools/list"))).toEqual(ALL_TOOLS);

        const allowedWithCredentials = await createTestApp({ upload: { publicRead: true, allowedIps: () => true, bearerAuth: BEARER } });
        expect(toolNames(await mcpPost(allowedWithCredentials, "tools/list"))).toEqual(READ_TOOLS);
    }));

    test("The read-only tool set is logged when the allowlist refuses writes, also for valid credentials", withLocalTmpDir(async () => {
        const infoSpy = jest.spyOn(logger, "info");
        const downgrades = () => infoSpy.mock.calls.map(c => String(c[0])).filter(m => m.includes("gets only the MCP read tools"));
        const app = await createTestApp({ upload: { publicRead: true, bearerAuth: BEARER } });
        const denied = await createTestApp({ upload: { publicRead: true, allowedIps: () => false, bearerAuth: BEARER } });

        expect(toolNames(await mcpPost(app, "tools/list"))).toEqual(READ_TOOLS);
        expect(downgrades()).toEqual([]);

        expect(toolNames(await mcpPost(denied, "tools/list").set("Authorization", AUTH))).toEqual(READ_TOOLS);
        expect(toolNames(await mcpPost(denied, "tools/list"))).toEqual(READ_TOOLS);
        expect(downgrades()).toEqual([
            expect.stringMatching(/: IP not in the allowlist$/),
            expect.stringMatching(/: IP not in the allowlist$/),
        ]);
    }));

    test("A JSON-RPC batch with an anonymous remove_package call removes nothing", withLocalTmpDir(async () => {
        await importedApp("packages/rpm");
        const paths = await poolPaths("rpm/fedora/42", "rpm/fedora/42/Packages/s/srm-hello");
        const app = await createTestApp({ upload: { publicRead: true, bearerAuth: BEARER } });

        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send([
                jsonRpc("tools/list", {}, 1),
                jsonRpc("tools/call", { name: "remove_package", arguments: { source: "srm-hello", immediate: true } }, 2),
            ]);

        expect(response.status).toBe(200);
        const byId = Object.fromEntries(response.body.map((r: { id: number }) => [r.id, r]));
        expect(byId[1].result.tools.map((t: { name: string }) => t.name).sort()).toEqual(READ_TOOLS);
        expect(byId[2].result.isError).toBe(true);
        expect(byId[2].result.content[0].text).toContain("Tool remove_package not found");
        expect(await servedStatuses(app, paths)).toEqual(paths.map(() => 200));
        expect(poolRemovedAt()).toEqual(Object.fromEntries(paths.map(p => [p, null])));
    }));

    test.each([
        ["malformed", 400, "application/json", "{", expect.any(String)],
        ["oversized", 413, "application/json", JSON.stringify(jsonRpc("tools/list", { padding: "x".repeat(200 * 1024) })),
            "request entity too large"],
        ["koi8-r", 415, "application/json; charset=koi8-r", JSON.stringify(jsonRpc("tools/list")), 'unsupported charset "KOI8-R"'],
    ])("An anonymous %s MCP body gets %i with one warning and no error log", (_kind, status, contentType, body, message) => withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { publicRead: true, bearerAuth: BEARER } });
        const warnSpy = jest.spyOn(logger, "warn").mockReturnValue(logger);
        const errorSpy = jest.spyOn(logger, "error").mockReturnValue(logger);
        try {
            const response = await request(app)
                .post("/api/v1/mcp")
                .set("Content-Type", contentType)
                .set("Accept", "application/json, text/event-stream")
                .send(body);

            expect(response.status).toBe(status);
            expect(response.body).toEqual({ correlation: { id: expect.any(String) }, message });
            expect(warnSpy.mock.calls).toEqual([[expect.stringContaining("sent an invalid request")]]);
            expect(errorSpy).not.toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
            errorSpy.mockRestore();
        }
    })());

    test("Anonymous calls to write tools fail as unknown tools when publicRead is on", withLocalTmpDir(async () => {
        await importedApp("packages/rpm");
        const paths = await poolPaths("rpm/fedora/42", "rpm/fedora/42/Packages/s/srm-hello");
        const app = await createTestApp({ upload: { publicRead: true, bearerAuth: BEARER } });

        const calls: [string, Record<string, unknown>][] = [
            ["remove_package", { source: "srm-hello", immediate: true }],
            ["import_repository", {}],
            ["prepare_upload", { format: "rpm", distribution: "fedora", release: "42", filenames: "x.rpm" }],
        ];
        for (const [name, args] of calls) {
            const result = await callTool(app, name, args);
            expect(result.isError).toBe(true);
            expect(result.content).toEqual([{ type: "text", text: expect.stringContaining(`Tool ${ name } not found`) }]);
        }

        expect(await servedStatuses(app, paths)).toEqual(paths.map(() => 200));
        expect(poolRemovedAt()).toEqual(Object.fromEntries(paths.map(p => [p, null])));
    }));

    test("initialize instructions follow the registered tool set", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { publicRead: true, bearerAuth: BEARER } });

        const anonymous = await mcpPost(app, "initialize", INITIALIZE);
        const authenticated = await mcpPost(app, "initialize", INITIALIZE).set("Authorization", AUTH);

        expect(anonymous.body.result.instructions)
            .toBe("Use these tools to list deb and rpm packages from the configured repositories.");
        expect(authenticated.body.result.instructions)
            .toBe("Use these tools to list, upload, import, and remove deb and rpm packages from the configured repositories.");

        const debOnly = await createTestApp({ upload: { publicRead: true, bearerAuth: BEARER, enabledApi: { rpm: false } } });
        expect((await mcpPost(debOnly, "initialize", INITIALIZE)).body.result.instructions)
            .toBe("Use these tools to list deb packages. The rpm backend is disabled in the current server configuration.");
    }));
});

describe("MCP paging and removal modes", () => {
    const SOURCES = [
        { format: "deb", distribution: "debian", release: "bookworm", source: "srm-gz", version: "0.1-1" },
        { format: "deb", distribution: "debian", release: "trixie", source: "srm-hello", version: "1.0-1" },
        { format: "deb", distribution: "ubuntu", release: "noble", source: "srm-zst", version: "2:3.0-1" },
        { format: "rpm", distribution: "fedora", release: "42", source: "srm-hello", version: "1.0-1.fc42" },
    ];

    test("list_source_packages pages with nextCursor", withLocalTmpDir(async () => {
        const app = await importedApp("packages");

        const unpaged = await callTool(app, "list_source_packages", {});
        expect(unpaged.structuredContent).toEqual({ packages: SOURCES });
        expect(unpaged.content[0].text).toBe("Found 4 source packages.");
        expect((await callTool(app, "list_source_packages", { limit: 1 })).content[0].text)
            .toBe("Found 1 source package. More results follow; pass nextCursor as cursor to get them.");

        const pages = await listByPage(app, "list_source_packages", {}, SOURCES.length);
        expect(pages.map(p => p.packages)).toEqual(SOURCES.map(s => [s]));
        expect(pages.slice(0, -1).map(p => typeof p.nextCursor)).toEqual(SOURCES.slice(1).map(() => "string"));
        expect(pages.at(-1)).not.toHaveProperty("nextCursor");
    }));

    test("list_package_files pages with nextCursor", withLocalTmpDir(async () => {
        const app = await importedApp("packages");

        const unpaged = (await callTool(app, "list_package_files", { source: "srm-hello" })).structuredContent;
        expect(unpaged).not.toHaveProperty("nextCursor");
        const paths = unpaged.files.map((f: { path: string }) => f.path);
        expect(paths.length).toBeGreaterThan(1);

        const pages = await listByPage(app, "list_package_files", { source: "srm-hello" }, paths.length);
        expect(pages.map(p => p.files.map((f: { path: string }) => f.path))).toEqual(paths.map((p: string) => [p]));
        expect(pages.map(p => p.touchedTargets)).toEqual(paths.map(() => 1));
        expect(pages.at(-1)).not.toHaveProperty("nextCursor");
    }));

    test.each([
        ["list_source_packages", {}],
        ["list_package_files", { source: "srm-hello" }],
    ])("%s rejects a limit outside 1 to 1000 and an invalid cursor", (name, args) => withLocalTmpDir(async () => {
        const app = await createTestApp();

        for (const limit of [0, 1001, 1.5]) {
            const result = await callTool(app, name, { ...args, limit });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toMatch(/Input validation error.*limit/s);
        }
        const result = await callTool(app, name, { ...args, cursor: "bogus" });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe("Invalid argument: Invalid cursor");
    })());

    test("remove_package immediate removes files at once", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian");
        const hello = await poolPaths("deb/debian/trixie/main", "deb/debian/pool/main/s/srm-hello");
        const gz = await poolPaths("deb/debian/bookworm/main", "deb/debian/pool/main/s/srm-gz");

        const result = await callTool(app, "remove_package", {
            format: "deb", distribution: "debian", release: "trixie", source: "srm-hello", immediate: true,
        });

        expect(result.isError).toBe(false);
        expect(result.structuredContent.files.map((f: { path: string }) => f.path).sort()).toEqual(hello);
        expect(await servedStatuses(app, hello)).toEqual(hello.map(() => 404));
        expect(await servedStatuses(app, gz)).toEqual(gz.map(() => 200));
    }));

    test("remove_package keeps files for garbage collection by default", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian");
        const hello = await poolPaths("deb/debian/trixie/main", "deb/debian/pool/main/s/srm-hello");

        const result = await callTool(app, "remove_package", {
            format: "deb", distribution: "debian", release: "trixie", source: "srm-hello",
        });

        expect(result.isError).toBe(false);
        expect(result.structuredContent.files.map((f: { path: string }) => f.path).sort()).toEqual(hello);
        expect(await servedStatuses(app, hello)).toEqual(hello.map(() => 200));
        const removedAt = poolRemovedAt();
        expect(hello.map(p => typeof removedAt[p])).toEqual(hello.map(() => "number"));
    }));
});
