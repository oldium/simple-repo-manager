import request from "supertest";

import createTestApp from "../testapp.ts";
import { withLocalTmpDir } from "../utils.ts";

describe("Bearer/Basic authentication on /api/v1", () => {
    test("Bearer token succeeds", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { bearerAuth: ["token-abc"] } });
        const response = await request(app)
            .get("/api/v1/status")
            .set("Authorization", "Bearer token-abc");
        expect(response.status).toBe(200);
    }));

    test("Mismatched Bearer is rejected with combined challenge", withLocalTmpDir(async () => {
        const app = await createTestApp({
            upload: { basicAuth: ["u:p"], bearerAuth: ["token-abc"] }
        });
        const response = await request(app)
            .get("/api/v1/status")
            .set("Authorization", "Bearer wrong");
        expect(response.status).toBe(401);
        expect(response.headers["www-authenticate"]).toBe('Basic realm="API", Bearer realm="API"');
    }));

    test("Basic still works when Bearer is configured", withLocalTmpDir(async () => {
        const app = await createTestApp({
            upload: { basicAuth: ["u:p"], bearerAuth: ["token-abc"] }
        });
        const response = await request(app)
            .get("/api/v1/status")
            .auth("u", "p", { type: "basic" });
        expect(response.status).toBe(200);
    }));

    test("Empty bearer array behaves as no credentials", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { bearerAuth: [] } });
        const response = await request(app).get("/api/v1/status");
        expect(response.status).toBe(200);
    }));

    test("Bearer without trailing token returns 401", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { bearerAuth: ["token-abc"] } });
        const response = await request(app)
            .get("/api/v1/status")
            .set("Authorization", "Bearer   ");
        expect(response.status).toBe(401);
    }));
});
