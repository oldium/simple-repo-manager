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
        expect(res.headers["retry-after"]).toBeUndefined();
        expect(res.body.message).toEqual(expect.any(String));
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
        expect(res.headers["retry-after"]).toBeUndefined();
        expect(res.body.message).toEqual(expect.any(String));
    }));

    test("400 when source is `-`", withLocalTmpDir(async () => {
        mockExecution(0, "", "");
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp();
        const res = await request(app).delete("/api/v1/repo/rpm/fedora/41/-/22");
        expect(res.status).toBe(400);
    }));

    test("404 when format is `-`", withLocalTmpDir(async () => {
        mockExecution(0, "", "");
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp();
        const res = await request(app).delete("/api/v1/repo/-/fedora/41/clevis/22");
        expect(res.status).toBe(404);
    }));

    test("identifiers with leading dash are not wildcards",
        withLocalTmpDir(async () => {
        // `-foo` is a plain identifier under PACKAGE_IDENTIFIER_REGEX; only
        // the lone `-` is the wildcard. The unknown distro should 404, not 400.
        mockExecution(0, "", "");
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: { incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo",
                repreproBin: "reprepro" }
        });
        const res = await request(app).delete("/api/v1/repo/rpm/-foo/41/clevis/22");
        expect(res.status).toBe(404);
    }));

    test("identifiers containing a dash still work (not treated as wildcard)",
        withLocalTmpDir(async () => {
        mockExecution(0, "", "");
        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: { incomingDir: "incoming", repoStateDir: "repo-state", repoDir: "repo",
                repreproBin: "reprepro" }
        });
        // `bookworm-security` is a valid identifier; the handler must not 400.
        // The distribution doesn't exist → 404 expected.
        const res = await request(app)
            .delete("/api/v1/repo/deb/debian/bookworm-security/clevis/21");
        expect(res.status).toBe(404);
    }));
});
