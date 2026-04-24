import request from "supertest";
import fsExtra from "fs-extra/esm";
import fs from "node:fs/promises";
import osPath from "path";
import zlib from "node:zlib";
import { jest } from "@jest/globals";

import createTestApp from "../testapp.ts";
import { withLocalTmpDir } from "../utils.ts";
import logger from "../../server/lib/logger.ts";

function jsonRpc(method: string, params: Record<string, unknown> = {}, id = 1) {
    return { jsonrpc: "2.0", id, method, params };
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

    test("list_repositories enumerates rpm trees", withLocalTmpDir(async () => {
        const root = osPath.join("repo", "rpm", "fedora", "40");
        await fsExtra.ensureDir(osPath.join(root, "repodata"));
        await fs.writeFile(
            osPath.join(root, "repodata", "repomd.xml"),
            `<?xml version="1.0"?><repomd><data type="primary"><location href="repodata/hash-primary.xml.zst"/></data></repomd>`
        );
        await fs.writeFile(
            osPath.join(root, "repodata", "hash-primary.xml.zst"),
            zlib.zstdCompressSync(Buffer.from(
                `<?xml version="1.0" encoding="UTF-8"?>\n<metadata xmlns="http://linux.duke.edu/metadata/common" xmlns:rpm="http://linux.duke.edu/metadata/rpm" packages="0"></metadata>\n`,
                "utf8"
            ))
        );
        const app = await createTestApp();
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/call", { name: "list_repositories", arguments: {} }));
        expect(response.status).toBe(200);
        const result = response.body.result;
        expect(result.structuredContent.repositories).toEqual([
            { format: "rpm", distribution: "fedora", release: "40" },
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
        jest.resetModules();
        const actual = await import("../../server/lib/rpm-metadata.ts");
        jest.unstable_mockModule("../../server/lib/rpm-metadata.ts", () => ({
            __esModule: true,
            ...actual,
            streamPackages: jest.fn(async function* () {
                yield { name: "clevis", arch: "src", ver: "21", rel: "1",
                    href: "Packages/c/clevis-21-1.src.rpm", sourcerpm: "" };
                yield { name: "clevis", arch: "x86_64", ver: "21", rel: "1",
                    href: "Packages/c/clevis-21-1.x86_64.rpm",
                    sourcerpm: "clevis-21-1.src.rpm" };
            }),
        }));
        jest.resetModules();
        await fsExtra.ensureDir(osPath.join("repo", "rpm", "fedora", "40", "repodata"));
        await fs.writeFile(
            osPath.join("repo", "rpm", "fedora", "40", "repodata", "repomd.xml"),
            `<?xml version="1.0"?><repomd/>`);
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp();
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .set("Authorization", "Bearer test-token")
            .send(jsonRpc("tools/call", {
                name: "list_package_files",
                arguments: { format: "rpm", source: "clevis" },
            }));
        expect(response.status).toBe(200);
        expect(response.body.result.isError).toBeFalsy();

        const { files, touchedTargets } = response.body.result.structuredContent;
        expect(touchedTargets).toBe(1);
        expect(files).toEqual(expect.arrayContaining([
            expect.objectContaining({
                filename: "clevis-21-1.src.rpm",
                path: "rpm/fedora/40/Packages/c/clevis-21-1.src.rpm",
                downloadUrl: expect.stringMatching(/^https?:\/\/.+\/rpm\/fedora\/40\/Packages\/c\/clevis-21-1\.src\.rpm$/),
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
        const srcLink = links.find((l: { name: string }) => l.name === "clevis-21-1.src.rpm");
        expect(srcLink.uri).toMatch(/^https?:\/\/.+\/rpm\/fedora\/40\/Packages\/c\/clevis-21-1\.src\.rpm$/);
        expect(srcLink.mimeType).toBe("application/x-rpm");

        const binLink = links.find((l: { name: string }) => l.name === "clevis-21-1.x86_64.rpm");
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
