import type { Request, RequestHandler, Response } from "express";
import authMiddleware from "../../server/lib/auth.ts";

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

describe("authMiddleware Basic+Bearer", () => {
    test("Accepts Basic credentials", async () => {
        const mws = authMiddleware(undefined, ["upload:pw"], undefined);
        const { req, res } = makeReqRes({
            authorization: `Basic ${ Buffer.from("upload:pw").toString("base64") }`,
        });
        expect(await run(mws, req, res)).toBe(true);
    });

    test("Accepts Bearer token", async () => {
        const mws = authMiddleware(undefined, undefined, ["token-abc"]);
        const { req, res } = makeReqRes({ authorization: "Bearer token-abc" });
        expect(await run(mws, req, res)).toBe(true);
    });

    test("Rejects mismatched Bearer with 401 and combined WWW-Authenticate", async () => {
        const mws = authMiddleware(undefined, ["upload:pw"], ["token-abc"]);
        const { req, res } = makeReqRes({ authorization: "Bearer bad" });
        expect(await run(mws, req, res)).toBe(false);
        expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
        expect((res as unknown as { headers: Record<string, string> }).headers["WWW-Authenticate"])
            .toBe('Basic realm="API", Bearer realm="API"');
    });

    test("Rejects missing header with 401 when credentials are configured", async () => {
        const mws = authMiddleware(undefined, ["upload:pw"], undefined);
        const { req, res } = makeReqRes({});
        expect(await run(mws, req, res)).toBe(false);
        expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
    });

    test("Returns empty handler list when no credentials and no ip list", () => {
        expect(authMiddleware(undefined, undefined, undefined)).toEqual([]);
    });

    test("Tokens compared in constant time (length mismatch still 401)", async () => {
        const mws = authMiddleware(undefined, undefined, ["abcdefghij"]);
        const { req, res } = makeReqRes({ authorization: "Bearer short" });
        expect(await run(mws, req, res)).toBe(false);
        expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
    });
});
