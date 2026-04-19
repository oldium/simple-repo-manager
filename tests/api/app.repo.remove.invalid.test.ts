import { withLocalTmpDir } from "../utils.ts";
import request from "supertest";
import { jest } from "@jest/globals";
import { mockExecution } from "../mocks.ts";

afterEach(() => { jest.resetModules(); });

describe("DELETE invalid requests", () => {
    test.each([
        ["/api/v1/repo/rpm/fedora/41/foo bar/1", "source contains space"],
        ["/api/v1/repo/rpm/fedora/41/foo%2Fbar/1", "source contains slash (decoded)"],
        ["/api/v1/repo/rpm/fedora/41/foo/1%3Brm", "version contains semicolon"],
        ["/api/v1/repo/rpm/fedora%3B/41/foo/1", "distribution contains semicolon"],
        ["/api/v1/repo/rpm/fedora/41%3B/foo/1", "release contains semicolon"],
    ])("400 for %s (%s)", (url) => withLocalTmpDir(async () => {
        mockExecution(0, "", "");
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp();
        const res = await request(app).delete(url);
        expect(res.status).toBe(400);
    })());

    test("404 for unknown format", withLocalTmpDir(async () => {
        mockExecution(0, "", "");
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp();
        const res = await request(app).delete("/api/v1/repo/oci/foo/1/bar/2");
        expect(res.status).toBe(404);
    }));

    test("503 when RPM API disabled", withLocalTmpDir(async () => {
        mockExecution(0, "", "");
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: { createrepoScript: null },
            upload: { enabledApi: { rpm: false, deb: true } }
        });
        const res = await request(app).delete("/api/v1/repo/rpm/fedora/41/foo/1");
        expect(res.status).toBe(503);
    }));

    test("503 when Debian API disabled", withLocalTmpDir(async () => {
        mockExecution(0, "", "");
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: { repreproBin: null },
            upload: { enabledApi: { rpm: true, deb: false } }
        });
        const res = await request(app).delete("/api/v1/repo/deb/debian/bookworm/foo/1");
        expect(res.status).toBe(503);
    }));
});
