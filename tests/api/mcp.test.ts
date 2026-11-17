import request from "supertest";
import type { Application } from "express";
import fs from "node:fs/promises";
import osPath from "path";
import { fileURLToPath } from "url";
import { jest } from "@jest/globals";
import dedent from "dedent";
import * as openpgp from "openpgp";

import createTestApp from "../testapp.ts";
import { createFiles, poolRemovedAt, servedStatuses, uploadFileByPost, withLocalTmpDir } from "../utils.ts";
import { fixtureNames, importFixtures, importedApp, uploadSecondVersion } from "../fixture-upload.ts";
import logger from "../../server/lib/logger.ts";

const RPM_FIXTURES = fileURLToPath(new URL("../fixtures/packages/rpm/fedora/42/", import.meta.url));
const BASIC = ["upload:pw"];
const BEARER = ["token-abc"];
const AUTH = "Bearer token-abc";
const READ_TOOLS = ["get_setup_instructions", "list_package_files", "list_repositories", "list_source_packages", "search_packages", "server_status"];
const ALL_TOOLS = [
    "get_setup_instructions",
    "import_repository",
    "list_package_files",
    "list_repositories",
    "list_source_packages",
    "prepare_upload",
    "remove_package",
    "search_packages",
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

    test("tools/list returns all tools when both backends enabled", withLocalTmpDir(async () => {
        const app = await createTestApp();
        const response = await request(app)
            .post("/api/v1/mcp")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send(jsonRpc("tools/list"));
        expect(response.status).toBe(200);
        expect(toolNames(response)).toEqual(ALL_TOOLS);
    }));

    test("server_status reports both formats", withLocalTmpDir(async () => {
        const app = await createTestApp();
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
                deb: { enabled: true },
                rpm: { enabled: true },
            },
        });
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

});

describe("get_setup_instructions", () => {
    async function setup(app: Application, args: Record<string, unknown>): Promise<string> {
        const result = await callTool(app, "get_setup_instructions", args);
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({ ...args, markdown: result.content[0].text });
        return result.content[0].text.replace(/127\.0\.0\.1:\d+/g, "HOST");
    }

    test("A Debian release without a key gets its sources file", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian/trixie");

        expect(await setup(app, { format: "deb", distribution: "debian", release: "trixie" })).toBe(dedent`
            # Debian Trixie

            \`\`\`
            sudo tee /etc/apt/sources.list.d/127.0.0.1.sources >/dev/null <<'EOF'
            Types: deb deb-src
            URIs: http://HOST/deb/debian
            Suites: trixie
            Components: main
            EOF
            \`\`\`

            \`\`\`
            sudo apt update
            \`\`\`
        ` + "\n");
    }));

    test("An RPM release without a key gets its repo file", withLocalTmpDir(async () => {
        const app = await importedApp("packages/rpm/fedora/42");

        expect(await setup(app, { format: "rpm", distribution: "fedora", release: "42" })).toBe(dedent`
            # Fedora 42

            \`\`\`
            sudo tee /etc/yum.repos.d/127-0-0-1.repo >/dev/null <<'EOF'
            [127-0-0-1]
            name=Repository 127.0.0.1
            baseurl=http://HOST/rpm/fedora/42
            enabled=1
            metadata_expire=12h
            EOF
            \`\`\`

            \`\`\`
            sudo dnf -q makecache -y --disablerepo='*' --enablerepo=127-0-0-1
            \`\`\`
        ` + "\n");
    }));

    test("With a signing key, the setup installs the key too", withLocalTmpDir(async () => {
        const unsigned = await createTestApp();
        await importFixtures(unsigned, "packages/deb/debian/trixie");
        await importFixtures(unsigned, "packages/rpm/fedora/42");
        const { privateKey } = await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "t" }], format: "armored" });
        await fs.writeFile("key.asc", privateKey);
        const app = await createTestApp({ gpg: { gpgRepoPrivateKeyFile: "key.asc" } });

        const deb = await setup(app, { format: "deb", distribution: "debian", release: "trixie" });
        expect(deb).toContain("curl -fsSL http://HOST/deb/archive-keyring.asc |\nsudo gpg --dearmor -o /etc/apt/trusted.gpg.d/127.0.0.1.gpg");
        expect(deb).toContain("Signed-By: /etc/apt/trusted.gpg.d/127.0.0.1.gpg");

        const rpm = await setup(app, { format: "rpm", distribution: "fedora", release: "42" });
        expect(rpm).toContain("sudo curl -fsSL http://HOST/rpm/RPM-GPG-KEY.asc -o /etc/pki/rpm-gpg/RPM-GPG-KEY-127-0-0-1");
        expect(rpm).toContain("gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-127-0-0-1");
        expect(rpm).toContain("sudo rpm --import /etc/pki/rpm-gpg/RPM-GPG-KEY-127-0-0-1 && \\\nsudo dnf");
    }));

    test("A custom template counts here as on the browse page", withLocalTmpDir(async () => {
        await createFiles({ "my-templates/deb-debian-trixie.eta.html": "<h2>For <%= distroName %></h2>\n<p>Then:</p>\n<pre>apt update</pre>\n" });
        const app = await createTestApp({ paths: { templateDir: "my-templates" } });
        await importFixtures(app, "packages/deb/debian/trixie");

        expect(await setup(app, { format: "deb", distribution: "debian", release: "trixie" })).toBe(
            "# Debian Trixie\n\n## For Debian\n\nThen:\n\n```\napt update\n```\n");
    }));

    test("A template that does not render is an error, without its details", withLocalTmpDir(async () => {
        await createFiles({ "my-templates/deb-debian-trixie.eta.html": "<%= noSuchValue.at.all %>" });
        const app = await createTestApp({ paths: { templateDir: "my-templates" } });
        await importFixtures(app, "packages/deb/debian/trixie");

        const result = await callTool(app, "get_setup_instructions", { format: "deb", distribution: "debian", release: "trixie" });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/^Internal error; check server logs/);
    }));

    test.each([
        ["format", "rpm", "debian", "trixie", "rpm/debian/trixie"],
        ["distribution", "deb", "ubuntu", "trixie", "deb/ubuntu/trixie"],
        ["release", "deb", "debian", "sid", "deb/debian/sid"],
    ])("Another %s is not found", (_, format, distribution, release, named) => withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian/trixie");

        const result = await callTool(app, "get_setup_instructions", { format, distribution, release });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe(`Not found: No such repository ${ named }`);
    })());

    test("Anonymous callers get it when publicRead is on", withLocalTmpDir(async () => {
        await importedApp("packages/rpm/fedora/42");
        const app = await createTestApp({ upload: { publicRead: true, bearerAuth: BEARER } });

        expect(await setup(app, { format: "rpm", distribution: "fedora", release: "42" })).toStartWith("# Fedora 42\n");
    }));
});

describe("search_packages", () => {
    type Found = { format: string; distribution: string; release: string; kind: string; package: string; version: string; architecture: string;
        source: string; sourceVersion: string; filename: string; path: string; downloadUrl: string };
    type Entry = { format: string; distribution: string; release: string; kind: string; package: string; source: string;
        versions: { version: string; architectures: string[] }[] };

    async function search(app: Application, args: Record<string, unknown>): Promise<Found[]> {
        const result = await callTool(app, "search_packages", args);
        expect(result.isError).toBe(false);
        return result.structuredContent.files;
    }

    async function searchPackages(app: Application, args: Record<string, unknown>): Promise<Entry[]> {
        const result = await callTool(app, "search_packages", { ...args, results: "packages" });
        expect(result.isError).toBe(false);
        return result.structuredContent.packages;
    }

    const names = (found: Found[]) => found.map(f => `${ f.kind } ${ f.package } ${ f.version } ${ f.architecture }`);

    test("A name matches exactly, ignoring case, with what is needed to get the file", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian/trixie");

        const found = await search(app, { name: "srm-hello" });

        expect(names(found)).toEqual(["binary srm-hello 1.0-1 amd64", "source srm-hello 1.0-1 source"]);
        expect(found[0]).toEqual({
            format: "deb",
            distribution: "debian",
            release: "trixie",
            kind: "binary",
            package: "srm-hello",
            version: "1.0-1",
            architecture: "amd64",
            source: "srm-hello",
            sourceVersion: "1.0-1",
            filename: "srm-hello_1.0-1_amd64.deb",
            path: "deb/debian/pool/main/s/srm-hello/srm-hello_1.0-1_amd64.deb",
            downloadUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/deb\/debian\/pool\/main\/s\/srm-hello\/srm-hello_1\.0-1_amd64\.deb$/),
        });
        expect(found[1].filename).toBe("srm-hello_1.0-1.dsc");
        expect((await request(app).get("/" + found[0].path)).status).toBe(200);
        expect(names(await search(app, { name: "SRM-HELLO-DOC" }))).toEqual(["binary srm-hello-doc 1.0-1 all"]);
        expect(await search(app, { name: "hello" })).toEqual([]);
    }));

    test("The wildcards * and ? match, what SQL takes as wildcards counts as itself", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian/trixie");

        expect(names(await search(app, { name: "srm-*" }))).toEqual(["binary srm-hello 1.0-1 amd64", "source srm-hello 1.0-1 source", "binary srm-hello-doc 1.0-1 all"]);
        expect(names(await search(app, { name: "*-DOC" }))).toEqual(["binary srm-hello-doc 1.0-1 all"]);
        expect(names(await search(app, { name: "srm?hello" }))).toEqual(["binary srm-hello 1.0-1 amd64", "source srm-hello 1.0-1 source"]);
        for (const name of ["%", "_", "srm_hello", "!", "srm%hello", "srm!hello"]) {
            expect(await search(app, { name })).toEqual([]);
        }
    }));

    test("A source finds what is built from it, also under other names; with a name both have to match", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/ubuntu/noble");

        expect(names(await search(app, { source: "srm-zst" }))).toEqual([
            "binary srm-zst 2:3.0-1 amd64",
            "source srm-zst 2:3.0-1 source",
            "debug srm-zst-dbgsym 2:3.0-1 amd64",
        ]);
        expect(names(await search(app, { source: "srm-*", name: "*dbgsym" }))).toEqual(["debug srm-zst-dbgsym 2:3.0-1 amd64"]);
        expect(await search(app, { source: "srm-hello", name: "srm-zst" })).toEqual([]);
    }));

    test("Name or source is required", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian/trixie");

        const result = await callTool(app, "search_packages", { distribution: "debian", release: "trixie" });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe("Invalid argument: name or source is required");
    }));

    test("A udeb is an installer package", withLocalTmpDir(async () => {
        const app = await importedApp("packages-udeb/deb/debian/trixie");

        expect(names(await search(app, { name: "*udeb*" }))).toEqual(["installer srm-hello-udeb 1.0-1 amd64"]);
    }));

    test("RPM packages come with their kind and the source they were built from", withLocalTmpDir(async () => {
        const app = await importedApp("packages/rpm/fedora/42");

        const found = await search(app, { source: "srm-hello" });

        expect(names(found)).toEqual([
            "source srm-hello 1.0-1.fc42 src",
            "binary srm-hello 1.0-1.fc42 x86_64",
            "binary srm-hello-doc 1.0-1.fc42 noarch",
        ]);
        expect(found[1]).toMatchObject({ format: "rpm", distribution: "fedora", release: "42", source: "srm-hello", sourceVersion: "1.0-1.fc42" });
        expect(found[1].filename).toBe("srm-hello-1.0-1.fc42.x86_64.rpm");
        expect((await request(app).get("/" + found[1].path)).status).toBe(200);
    }));

    test("Kind and architecture narrow what is found; a source's architecture is the one its format names", withLocalTmpDir(async () => {
        const app = await createTestApp();
        await importFixtures(app, "packages/deb/debian/trixie");
        await importFixtures(app, "packages/rpm/fedora/42");
        const deb = { source: "srm-hello", format: "deb" };

        expect(names(await search(app, { ...deb, kind: ["binary"] }))).toEqual(["binary srm-hello 1.0-1 amd64", "binary srm-hello-doc 1.0-1 all"]);
        expect(names(await search(app, { ...deb, kind: ["source"] }))).toEqual(["source srm-hello 1.0-1 source"]);
        expect(names(await search(app, { ...deb, architecture: ["all"] }))).toEqual(["binary srm-hello-doc 1.0-1 all"]);
        expect(names(await search(app, { ...deb, architecture: ["arm64", "all", "source"] })))
            .toEqual(["source srm-hello 1.0-1 source", "binary srm-hello-doc 1.0-1 all"]);
        expect(await search(app, { ...deb, kind: ["source"], architecture: ["amd64"] })).toEqual([]);
        expect(names(await search(app, { source: "srm-hello", format: "rpm", architecture: ["noarch"] }))).toEqual(["binary srm-hello-doc 1.0-1.fc42 noarch"]);
        expect(names(await search(app, { source: "srm-hello", format: "rpm", architecture: ["src"] }))).toEqual(["source srm-hello 1.0-1.fc42 src"]);
        expect(await search(app, { source: "srm-hello", format: "rpm", architecture: ["source"] })).toEqual([]);
    }));

    test("The filters narrow the search across formats and releases", withLocalTmpDir(async () => {
        const app = await createTestApp();
        await importFixtures(app, "packages/deb/debian/trixie");
        await importFixtures(app, "packages/rpm/fedora/42");

        const where = (found: Found[]) => [...new Set(found.map(f => `${ f.format }/${ f.distribution }/${ f.release }`))];
        expect(where(await search(app, { name: "srm-hello" }))).toEqual(["deb/debian/trixie", "rpm/fedora/42"]);
        expect(where(await search(app, { name: "srm-hello", format: "rpm" }))).toEqual(["rpm/fedora/42"]);
        expect(where(await search(app, { name: "srm-hello", distribution: "debian", release: "trixie" }))).toEqual(["deb/debian/trixie"]);
    }));

    test("Pages go over all results, each one once, in both shapes", withLocalTmpDir(async () => {
        const app = await createTestApp();
        await importFixtures(app, "packages/deb/debian/trixie");
        await importFixtures(app, "packages/rpm/fedora/42");

        const whole = await search(app, { source: "srm-hello" });
        const pages = await listByPage(app, "search_packages", { source: "srm-hello" }, whole.length);
        expect(whole).toHaveLength(6);
        expect(pages.flatMap(page => page.files.map((f: Found) => f.path))).toEqual(whole.map(f => f.path));

        const entries = await searchPackages(app, { source: "srm-hello" });
        const entryPages = await listByPage(app, "search_packages", { source: "srm-hello", results: "packages" }, entries.length);
        expect(entries).toHaveLength(6);
        expect(entryPages.flatMap(page => page.packages)).toEqual(entries);

        const mixed = await callTool(app, "search_packages", { source: "srm-hello", results: "packages", limit: 1, cursor: pages[0].nextCursor });
        expect(mixed.content[0].text).toBe("Invalid argument: Invalid cursor");
    }));

    test("results: packages lists each package once, with its versions newest first", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian/trixie");
        await uploadSecondVersion(app);
        expect((await request(app).post("/api/v1/repo/import")).status).toBe(200);

        const entries = await searchPackages(app, { source: "srm-hello" });

        expect(entries).toEqual([
            { format: "deb", distribution: "debian", release: "trixie", kind: "binary", package: "srm-hello", source: "srm-hello",
                versions: [{ version: "1.0-1", architectures: ["amd64"] }] },
            { format: "deb", distribution: "debian", release: "trixie", kind: "source", package: "srm-hello", source: "srm-hello",
                versions: [{ version: "1.0-2", architectures: ["source"] }, { version: "1.0-1", architectures: ["source"] }] },
            { format: "deb", distribution: "debian", release: "trixie", kind: "binary", package: "srm-hello-doc", source: "srm-hello",
                versions: [{ version: "1.0-1", architectures: ["all"] }] },
        ]);
        expect((await searchPackages(app, { name: "srm-hello", kind: ["source"], latest: true }))[0].versions)
            .toEqual([{ version: "1.0-2", architectures: ["source"] }]);
        const result = await callTool(app, "search_packages", { name: "srm-hello", results: "packages" });
        expect(result.content[0].text).toBe("Found 2 packages.");
    }));

    test("An agent finds the latest version, and every build of a version", withLocalTmpDir(async () => {
        const app = await importedApp("packages/deb/debian/trixie");
        await uploadSecondVersion(app);
        expect((await request(app).post("/api/v1/repo/import")).status).toBe(200);

        expect(names(await search(app, { name: "srm-hello", latest: true }))).toEqual(["binary srm-hello 1.0-1 amd64", "source srm-hello 1.0-2 source"]);
        expect(names(await search(app, { name: "srm-hello", version: "1.0", kind: ["source"] })))
            .toEqual(["source srm-hello 1.0-1 source", "source srm-hello 1.0-2 source"]);
        expect(names(await search(app, { name: "srm-hello", version: "1.0", kind: ["source"], latest: true }))).toEqual(["source srm-hello 1.0-2 source"]);

        const invalid = await callTool(app, "search_packages", { name: "srm-hello", version: "a:1" });
        expect(invalid.isError).toBe(true);
        expect(invalid.content[0].text).toBe("Invalid argument: Invalid version a:1: the epoch is not a number");
    }));

    test("A name longer than any file name is refused", withLocalTmpDir(async () => {
        const app = await createTestApp();

        for (const args of [{ name: "a".repeat(256) }, { source: "a".repeat(256) }]) {
            const result = await callTool(app, "search_packages", args);
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toMatch(/Input validation error.*(name|source)/s);
        }
    }));

    test("An unknown repository is an error, an unknown package is not", withLocalTmpDir(async () => {
        const app = await importedApp("packages/rpm/fedora/42");

        const unknown = await callTool(app, "search_packages", { name: "srm-hello", distribution: "fedora", release: "41" });
        expect(unknown.isError).toBe(true);
        expect(unknown.content[0].text).toBe("Not found: No such repository -/fedora/41");

        const none = await callTool(app, "search_packages", { name: "no-such-package", distribution: "fedora", release: "42" });
        expect(none.isError).toBe(false);
        expect(none.content[0].text).toBe("Found 0 files.");
    }));

    test("Anonymous callers can search when publicRead is on", withLocalTmpDir(async () => {
        await importedApp("packages/rpm/fedora/42");
        const app = await createTestApp({ upload: { publicRead: true, bearerAuth: BEARER } });

        expect(await search(app, { name: "srm-hello-doc" })).toHaveLength(1);
    }));
});

describe("MCP tools by access", () => {
    test("The read tools say they change nothing, the others do not", withLocalTmpDir(async () => {
        const app = await createTestApp();

        const tools = (await mcpPost(app, "tools/list")).body.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];

        expect(tools.filter(t => t.annotations?.readOnlyHint).map(t => t.name).sort()).toEqual(READ_TOOLS);
    }));

    test("A client that reads only the text gets the results too", withLocalTmpDir(async () => {
        const app = await importedApp("packages/rpm/fedora/42");

        const result = await callTool(app, "list_repositories", {});

        expect(result.content[0].text).toBe("Found 1 repository.");
        expect(JSON.parse(result.content[1].text)).toEqual(result.structuredContent);
    }));

    test("Anonymous tools/list shows only the read tools when publicRead is on", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { publicRead: true, bearerAuth: BEARER } });

        const response = await mcpPost(app, "tools/list");

        expect(toolNames(response)).toEqual(READ_TOOLS);
        expect(JSON.stringify(response.body.result.tools)).not.toMatch(/prepare_upload|import_repository|remove_package/);
    }));

    test("Authenticated tools/list shows all tools", withLocalTmpDir(async () => {
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
            .toBe("Use these tools to list and search deb and rpm packages from the configured repositories.");
        expect(authenticated.body.result.instructions)
            .toBe("Use these tools to list, search, upload, import, and remove deb and rpm packages from the configured repositories.");
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
