import { jest } from "@jest/globals";
import type { Application } from "express";
import request from "supertest";
import vm from "node:vm";
import * as cheerio from "cheerio";
import _ from "lodash";

import createTestApp from "../testapp.ts";
import { importedApp } from "../fixture-upload.ts";
import { withLocalTmpDir } from "../utils.ts";

const BEARER = ["token-abc"];
const SCRIPT = "/webmcp.js";

type Tool = { name: string; execute: (args: object, options: { signal: AbortSignal }) => Promise<Record<string, unknown>> };

/** Runs the served script with a stand-in for the browser API; the browser's own registration is a live check */
async function runScript(app: Application, where: "document" | "navigator" | "none" = "document") {
    const script = (await request(app).get(SCRIPT)).text;
    const tools: Tool[] = [];
    const modelContext = { registerTool: async (tool: Tool) => void tools.push(tool) };
    const requests: RequestInit[] = [];
    const fetch = async (url: string, init: RequestInit) => {
        requests.push(init);
        const response = await request(app).post(url).set(init.headers as Record<string, string>).send(JSON.parse(init.body as string));
        return { json: async () => response.body };
    };
    const warn = jest.fn();
    vm.runInNewContext(script, {
        document: where === "document" ? { modelContext } : {},
        navigator: where === "navigator" ? { modelContext } : {},
        fetch,
        console: { warn },
    });
    await new Promise(resolve => setImmediate(resolve));
    return { tools, requests, warn };
}

function page(app: Application) {
    return request(app).get("/").then(res => cheerio.load(res.text));
}

describe("WebMCP", () => {
    test("Without public read there is no script and no page loads one", withLocalTmpDir(async () => {
        const app = await createTestApp();

        expect((await request(app).get(SCRIPT)).status).toBe(404);
        expect((await page(app))("script[src]")).toHaveLength(0);
    }));

    test("With public read the pages load the script", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { publicRead: true } });

        const script = await request(app).get(SCRIPT);

        expect(script.status).toBe(200);
        expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
        expect((await page(app))("script[src]").attr("src")).toBe(SCRIPT);
    }));

    test("A browser that has the script does not get it again", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { publicRead: true } });

        const first = await request(app).get(SCRIPT);
        const again = await request(app).get(SCRIPT).set("If-None-Match", first.headers.etag);

        expect(again.status).toBe(304);
    }));

    test("The script holds exactly what tools/list says about the read tools", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { publicRead: true, bearerAuth: BEARER } });
        const listed = (await request(app).post("/api/v1/mcp").set("Accept", "application/json, text/event-stream")
            .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).body.result.tools as { name: string; execution?: unknown }[];
        const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
        // execution is about the MCP transport
        const expected = listed.map(tool => _.omit(tool, "execution")).sort(byName);

        const { tools } = await runScript(app);

        // JSON leaves out execute, and the objects come from another context
        expect(JSON.parse(JSON.stringify(tools)).sort(byName)).toEqual(expected);
    }));

    test("The write tools stay out of the script", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { publicRead: true } });

        expect((await request(app).get(SCRIPT)).text).not.toMatch(/prepare_upload|import_repository|remove_package/);
    }));

    test("A tool answers through the MCP endpoint without credentials", withLocalTmpDir(async () => {
        await importedApp("packages/rpm/fedora/42");
        const app = await createTestApp({ upload: { publicRead: true, bearerAuth: BEARER } });
        const { tools, requests } = await runScript(app);
        const tool = (name: string) => tools.find(t => t.name === name)!;
        const { signal } = new AbortController();

        const found = await tool("search_packages").execute({ name: "srm-hello-doc" }, { signal });

        expect(found.files).toEqual([expect.objectContaining({ package: "srm-hello-doc", kind: "binary", downloadUrl: expect.stringContaining("/rpm/fedora/42/") })]);
        expect(requests[0].credentials).toBe("omit");
        expect(requests[0].signal).toBe(signal);

        const setup = await tool("get_setup_instructions").execute({ format: "rpm", distribution: "fedora", release: "42" }, { signal });
        expect(setup.markdown).toStartWith("# Fedora 42\n");
    }));

    test("A tool that fails says why instead of rejecting", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { publicRead: true } });
        const { tools } = await runScript(app);

        const result = await tools.find(t => t.name === "get_setup_instructions")!
            .execute({ format: "rpm", distribution: "fedora", release: "42" }, { signal: new AbortController().signal });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("No such repository rpm/fedora/42");
    }));

    test("It also registers where Chromium first had the API", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { publicRead: true } });

        expect((await runScript(app, "navigator")).tools.length).toBeGreaterThan(0);
    }));

    test("A browser without the API runs it without a word", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { publicRead: true } });

        const { tools, requests, warn } = await runScript(app, "none");

        expect(tools).toEqual([]);
        expect(requests).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
    }));
});
