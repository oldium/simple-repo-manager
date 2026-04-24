// noinspection DuplicatedCode

import { describe, expect, test, jest } from "@jest/globals";
import request from "supertest";

import { createFiles, withLocalTmpDir } from "../utils.ts";
import { mockExecution } from "../mocks.ts";

afterEach(() => {
    jest.resetModules();
});

describe("import_repository — rpm per-file status", () => {
    test("createrepo failure surfaces each staged file as failed",
        withLocalTmpDir(async () => {
            // createrepo fails with non-zero exit for every invocation.
            mockExecution(1, "", "createrepo failure simulated");

            const createTestApp = (await import("../testapp.ts")).default;
            const app = await createTestApp({
                paths: {
                    incomingDir: "incoming",
                    repoDir: "repo",
                    createrepoScript: "createrepo.sh",
                    signScript: "sign.sh",
                    repreproBin: null,
                },
                upload: {
                    enabledApi: {
                        deb: false,
                    },
                },
            });

            await createFiles({
                "incoming/staging/rpm/fedora/41/a.rpm": "",
                "incoming/staging/rpm/fedora/41/b.rpm": "",
            });

            const response = await request(app)
                .post("/api/v1/mcp")
                .set("Content-Type", "application/json")
                .set("Accept", "application/json, text/event-stream")
                .send({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: { name: "import_repository", arguments: {} },
                });

            expect(response.status).toBe(200);
            expect(response.body.result.isError).toBeFalsy();

            const { ok, files } = response.body.result.structuredContent as {
                ok: boolean,
                files: Array<{ filename: string, path: string, status: string, reason?: string }>,
            };

            expect(ok).toBe(false);
            expect(files).toHaveLength(2);
            const paths = files.map((f) => f.path).sort();
            expect(paths).toEqual([
                "rpm/fedora/41/a.rpm",
                "rpm/fedora/41/b.rpm",
            ]);
            for (const f of files) {
                expect(f.status).toBe("failed");
                expect(f.reason).toMatch(/metadata build failed/i);
                expect(f.reason).toMatch(/correlation id=/);
            }
        }),
        15000,
    );

    test("createrepo success reports each staged file as ok",
        withLocalTmpDir(async () => {
            mockExecution(0, "stdout data", "");

            const createTestApp = (await import("../testapp.ts")).default;
            const app = await createTestApp({
                paths: {
                    incomingDir: "incoming",
                    repoDir: "repo",
                    createrepoScript: "createrepo.sh",
                    signScript: "sign.sh",
                    repreproBin: null,
                },
                upload: {
                    enabledApi: {
                        deb: false,
                    },
                },
            });

            await createFiles({
                "incoming/staging/rpm/fedora/41/a.rpm": "",
            });

            const response = await request(app)
                .post("/api/v1/mcp")
                .set("Content-Type", "application/json")
                .set("Accept", "application/json, text/event-stream")
                .send({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: { name: "import_repository", arguments: {} },
                });

            expect(response.status).toBe(200);
            const { ok, files } = response.body.result.structuredContent as {
                ok: boolean,
                files: Array<{ filename: string, path: string, status: string, reason?: string }>,
            };
            expect(ok).toBe(true);
            expect(files).toEqual([
                { filename: "a.rpm", path: "rpm/fedora/41/a.rpm", status: "ok" },
            ]);
        }),
        15000,
    );
});
