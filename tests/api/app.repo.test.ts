// noinspection DuplicatedCode

import { withLocalTmpDir } from "../utils.ts";
import request from "supertest";
import { jest } from "@jest/globals";

afterEach(() => {
    jest.resetModules();
})

describe('Test repository API', () => {
    test('Check that repo endpoint is unavailable when the tools are unavailable', withLocalTmpDir(async () => {
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoStateDir: "repo-state",
                repoDir: "repo",
                repreproBin: null,
                createrepoScript: null,
            },
            upload: {
                enabledApi: {
                    deb: false,
                    rpm: false,
                }
            }
        });

        const res = await request(app).post("/api/v1/repo/import");
        expect(res.status).toBe(503);
    }));
});
