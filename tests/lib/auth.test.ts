import type { Application, Request, RequestHandler, Response } from "express";
import request from "supertest";
import { jest } from "@jest/globals";
import { classifyAuth, writeAuthMiddleware } from "../../server/lib/auth.ts";
import logger from "../../server/lib/logger.ts";
import createTestApp from "../testapp.ts";
import { withLocalTmpDir } from "../utils.ts";

const CHALLENGE = 'Basic realm="API", Bearer realm="API"';
const BASIC = ["upload:pw"];
const BEARER = ["token-abc"];
const LIST_URL = "/api/v1/repo/-/-/-/hello";
const BAD_PARAM_URL = "/api/v1/repo/a/b/c/%ZZ";
const DENY_ALL_IPS = () => false;

type MockRes = Response & {
    statusCode: number;
    headers: Record<string, string>;
    sent: boolean;
    onSend?: () => void;
};

function makeReqRes(headers: Record<string, string>, ip = "127.0.0.1") {
    const req = { headers, ip } as unknown as Request;
    const res = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        sent: false,
        setHeader(name: string, value: string) { this.headers[name] = value; },
        status(code: number) { this.statusCode = code; return this; },
        send() {
            this.sent = true;
            this.onSend?.();
            return this;
        },
    } as unknown as MockRes;
    return { req, res };
}

async function run(mws: RequestHandler[], req: Request, res: Response): Promise<boolean> {
    const mockRes = res as MockRes;
    for (const mw of mws) {
        let called = false;
        await new Promise<void>((resolve, reject) => {
            mockRes.onSend = () => resolve();
            try {
                mw(req, res, (err?: unknown) => { called = !err; resolve(); });
            } catch (err) {
                reject(err);
            }
        });
        mockRes.onSend = undefined;
        if (!called) return false;
    }
    return true;
}

describe("writeAuthMiddleware Basic+Bearer", () => {
    test("Accepts Basic credentials", async () => {
        const mws = writeAuthMiddleware(undefined, ["upload:pw"], undefined);
        const { req, res } = makeReqRes({
            authorization: `Basic ${ Buffer.from("upload:pw").toString("base64") }`,
        });
        expect(await run(mws, req, res)).toBe(true);
    });

    test("Accepts Bearer token", async () => {
        const mws = writeAuthMiddleware(undefined, undefined, ["token-abc"]);
        const { req, res } = makeReqRes({ authorization: "Bearer token-abc" });
        expect(await run(mws, req, res)).toBe(true);
    });

    test("Rejects mismatched Bearer with 401 and combined WWW-Authenticate", async () => {
        const mws = writeAuthMiddleware(undefined, ["upload:pw"], ["token-abc"]);
        const { req, res } = makeReqRes({ authorization: "Bearer bad" });
        expect(await run(mws, req, res)).toBe(false);
        expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
        expect((res as unknown as { headers: Record<string, string> }).headers["WWW-Authenticate"])
            .toBe('Basic realm="API", Bearer realm="API"');
    });

    test("Rejects missing header with 401 when credentials are configured", async () => {
        const mws = writeAuthMiddleware(undefined, ["upload:pw"], undefined);
        const { req, res } = makeReqRes({});
        expect(await run(mws, req, res)).toBe(false);
        expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
    });

    test("Returns empty handler list when no credentials and no ip list", () => {
        expect(writeAuthMiddleware(undefined, undefined, undefined)).toEqual([]);
    });

    test("Tokens compared in constant time (length mismatch still 401)", async () => {
        const mws = writeAuthMiddleware(undefined, undefined, ["abcdefghij"]);
        const { req, res } = makeReqRes({ authorization: "Bearer short" });
        expect(await run(mws, req, res)).toBe(false);
        expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
    });
});

function mcpToolsList(app: Application) {
    return request(app)
        .post("/api/v1/mcp")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
}

describe("classifyAuth", () => {
    test("Tells anonymous, authenticated and invalid callers apart", () => {
        const classify = (headers: Record<string, string>) => classifyAuth(makeReqRes(headers).req, BASIC, BEARER);
        expect(classify({})).toBe("anonymous");
        expect(classify({ authorization: `Basic ${ Buffer.from("upload:pw").toString("base64") }` }))
            .toBe("authenticated");
        expect(classify({ authorization: "Bearer token-abc" })).toBe("authenticated");
        expect(classify({ authorization: "Bearer wrong" })).toBe("invalid");
        expect(classify({ authorization: "Bearer   " })).toBe("invalid");
    });
});

describe("Public reads and protected writes", () => {
    test("publicRead lets anonymous GET /api/v1/repo through", withLocalTmpDir(async () => {
        const app = await createTestApp({
            upload: { publicRead: true, allowedIps: DENY_ALL_IPS, basicAuth: BASIC, bearerAuth: BEARER }
        });
        const response = await request(app).get(LIST_URL);
        expect(response.status).toBe(200);
        expect(response.body.files).toEqual([]);
        expect((await request(app).get("/api/v1/status")).status).toBe(200);
    }));

    test("publicRead still requires credentials for DELETE", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { publicRead: true, basicAuth: BASIC, bearerAuth: BEARER } });
        const response = await request(app).delete(LIST_URL);
        expect(response.status).toBe(401);
        expect(response.headers["www-authenticate"]).toBe(CHALLENGE);
        expect((await request(app).delete(BAD_PARAM_URL)).status).toBe(401);
        expect((await request(app).post("/api/v1/repo/import")).status).toBe(401);
        expect((await request(app).put("/api/v1/upload/deb/debian/bookworm/main/hello_1.0_all.deb")).status)
            .toBe(401);
        expect((await request(app).get("/api/v1/unknown")).status).toBe(401);
        expect((await request(app).delete(LIST_URL).set("Authorization", "Bearer token-abc")).status).toBe(200);

        const denied = await createTestApp({ upload: { publicRead: true, allowedIps: DENY_ALL_IPS, bearerAuth: BEARER } });
        expect((await request(denied).delete(LIST_URL).set("Authorization", "Bearer token-abc")).status).toBe(403);
    }));

    test("publicRead without credentials opens reads to any IP and keeps writes to the allowlist", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { publicRead: true, allowedIps: DENY_ALL_IPS } });
        expect((await request(app).get(LIST_URL)).status).toBe(200);
        expect((await request(app).get(LIST_URL).set("Authorization", "Bearer anything")).status).toBe(200);
        expect((await request(app).delete(LIST_URL)).status).toBe(403);
    }));

    test("A malformed percent-encoding past the gate gets 400 and one warning", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { publicRead: true, basicAuth: BASIC, bearerAuth: BEARER } });
        const warnSpy = jest.spyOn(logger, "warn").mockReturnValue(logger);
        const errorSpy = jest.spyOn(logger, "error").mockReturnValue(logger);
        try {
            const response = await request(app).get(BAD_PARAM_URL);
            expect(response.status).toBe(400);
            expect(response.body).toEqual({
                correlation: { id: expect.any(String) },
                message: "Invalid percent-encoding in path segment",
            });
            expect(warnSpy.mock.calls).toEqual([[expect.stringContaining("Failed to decode param '%ZZ'")]]);
            expect(errorSpy).not.toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
            errorSpy.mockRestore();
        }
        expect((await request(app).get(BAD_PARAM_URL).set("Authorization", "Bearer token-abc")).status).toBe(400);
        expect((await request(app).delete(BAD_PARAM_URL).set("Authorization", "Bearer token-abc")).status).toBe(400);
    }));

    test("Invalid bearer on a public read gets 401", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { publicRead: true, basicAuth: BASIC, bearerAuth: BEARER } });
        const response = await request(app).get(LIST_URL).set("Authorization", "Bearer wrong");
        expect(response.status).toBe(401);
        expect(response.headers["www-authenticate"]).toBe(CHALLENGE);
        expect((await request(app).get("/api/v1/status").auth("upload", "wrong", { type: "basic" })).status)
            .toBe(401);
        expect((await request(app).get(LIST_URL).set("Authorization", "Bearer token-abc")).status).toBe(200);
    }));

    test("publicRead off behaves as today", withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { publicRead: false, basicAuth: BASIC, bearerAuth: BEARER } });
        expect([
            (await request(app).get(LIST_URL)).status,
            (await request(app).get("/api/v1/status")).status,
            (await mcpToolsList(app)).status,
            (await request(app).get("/api/v1/unknown")).status,
            (await request(app).options(LIST_URL)).status,
            (await request(app).get(BAD_PARAM_URL)).status,
        ]).toEqual([401, 401, 401, 401, 401, 401]);
        expect((await request(app).get(LIST_URL).set("Authorization", "Bearer token-abc")).status).toBe(200);
        expect((await request(app).get(BAD_PARAM_URL).set("Authorization", "Bearer token-abc")).status).toBe(400);
        const options = await request(app).options(LIST_URL).set("Authorization", "Bearer token-abc");
        expect(options.status).toBe(200);
        expect(options.headers.allow).toBe("DELETE, GET, HEAD");

        const denied = await createTestApp({ upload: { publicRead: false, allowedIps: DENY_ALL_IPS, bearerAuth: BEARER } });
        expect([
            (await request(denied).get(LIST_URL).set("Authorization", "Bearer token-abc")).status,
            (await request(denied).get("/api/v1/status")).status,
            (await mcpToolsList(denied)).status,
            (await request(denied).get(BAD_PARAM_URL)).status,
        ]).toEqual([403, 403, 403, 403]);
    }));
});
