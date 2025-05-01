// noinspection DuplicatedCode

import { transformMiddleware } from "../../server/lib/transform.ts";
import type { NextFunction, Request, Response } from "express";
import { withLocalTmpDir } from "../utils.ts";
import fs from "fs/promises";
import { jest } from "@jest/globals";

describe("Test of transform library", () => {
    test("Check that transform function is called", withLocalTmpDir(async () => {
        const file = "test.txt";
        await fs.writeFile(file, "test content", "utf8");

        const transformFn = jest.fn((content: string) => content.toUpperCase());
        const middleware = transformMiddleware(file, transformFn, "production");

        const req = { headers: {}, url: "/test.txt" } as unknown as Request;
        const res = {
            set: jest.fn(),
            type: jest.fn().mockReturnThis(),
            send: jest.fn(),
            status: jest.fn().mockReturnThis(),
            end: jest.fn()
        } as unknown as Response;
        const next = jest.fn() as NextFunction;

        await middleware(req, res, next);

        expect(transformFn).toHaveBeenCalledTimes(1);
        expect((res.set as jest.Mock)).toHaveBeenCalledTimes(1);
        expect((res.set as jest.Mock).mock.calls[0][0]).toBeObject();
        const headers: Record<string, string> = (res.set as jest.Mock).mock.calls[0][0] as Record<string, string>;
        expect(headers).toHaveProperty("Last-Modified");
        expect(headers).toHaveProperty("ETag");
        expect(headers).toHaveProperty("Cache-Control");
        expect(headers["Cache-Control"]).toBe("public, max-age=3600");

        expect((res.send as jest.Mock)).toHaveBeenCalledTimes(1);
        expect((res.send as jest.Mock).mock.calls[0][0]).toBe("TEST CONTENT");
        expect((next as jest.Mock)).not.toHaveBeenCalled();
    }));

    test("Check that development environment always re-checks", withLocalTmpDir(async () => {
        const file = "test.txt";
        await fs.writeFile(file, "test content", "utf8");

        const transformFn = jest.fn((content: string) => content.toUpperCase());
        const middleware = transformMiddleware(file, transformFn, "development");

        const req = { headers: {}, url: "/test.txt" } as unknown as Request;
        const res = {
            set: jest.fn(),
            type: jest.fn().mockReturnThis(),
            send: jest.fn(),
            status: jest.fn().mockReturnThis(),
            end: jest.fn()
        } as unknown as Response;
        const next = jest.fn() as NextFunction;

        await middleware(req, res, next);

        expect(transformFn).toHaveBeenCalledTimes(1);
        expect((res.set as jest.Mock)).toHaveBeenCalledTimes(1);
        expect((res.set as jest.Mock).mock.calls[0][0]).toBeObject();
        const headers: Record<string, string> = (res.set as jest.Mock).mock.calls[0][0] as Record<string, string>;
        expect(headers).toHaveProperty("Last-Modified");
        expect(headers).toHaveProperty("ETag");
        expect(headers).toHaveProperty("Cache-Control");
        expect(headers["Cache-Control"]).toBe("no-cache");

        expect((res.send as jest.Mock)).toHaveBeenCalledTimes(1);
        expect((res.send as jest.Mock).mock.calls[0][0]).toBe("TEST CONTENT");
        expect((next as jest.Mock)).not.toHaveBeenCalled();
    }));

    test("Check that transform function is not called when the file is not changed", withLocalTmpDir(async () => {
        const file = "test.txt";
        await fs.writeFile(file, "test content", "utf8");

        const transformFn = jest.fn((content: string) => content.toUpperCase());
        const middleware = transformMiddleware(file, transformFn, "production");

        const req1 = { headers: {}, url: "/test.txt" } as unknown as Request;
        const res = {
            set: jest.fn(),
            type: jest.fn().mockReturnThis(),
            send: jest.fn(),
            status: jest.fn().mockReturnThis(),
            end: jest.fn()
        } as unknown as Response;
        const next = jest.fn() as NextFunction;

        await middleware(req1, res, next);

        expect(transformFn).toHaveBeenCalledTimes(1);
        expect((res.set as jest.Mock)).toHaveBeenCalledTimes(1);
        expect((res.set as jest.Mock).mock.calls[0][0]).toBeObject();
        const headers: Record<string, string> = (res.set as jest.Mock).mock.calls[0][0] as Record<string, string>;
        expect(headers).toHaveProperty("Last-Modified");
        expect(headers).toHaveProperty("ETag");
        expect(headers).toHaveProperty("Cache-Control");
        expect(headers["Cache-Control"]).toBe("public, max-age=3600");
        expect((res.send as jest.Mock)).toHaveBeenCalledTimes(1);
        expect((res.send as jest.Mock).mock.calls[0][0]).toBe("TEST CONTENT");
        expect((next as jest.Mock)).not.toHaveBeenCalled();

        jest.clearAllMocks();

        const req2 = {
            headers: { "if-modified-since": headers["Last-Modified"], "if-none-match": headers["ETag"] },
            url: "/test.txt"
        } as unknown as Request;

        await middleware(req2, res, next);

        expect(transformFn).not.toHaveBeenCalled();
        expect((res.status as jest.Mock)).toHaveBeenCalledTimes(1);
        expect((res.status as jest.Mock).mock.calls[0][0]).toBe(304);
    }));

    test("Check that transform function is called when the file is changed", withLocalTmpDir(async () => {
        const file = "test.txt";
        await fs.writeFile(file, "test content", "utf8");
        const now = new Date();
        const oneMinuteAgo = new Date(now.getTime() - 60000);
        await fs.utimes(file, now, oneMinuteAgo);

        const transformFn = jest.fn((content: string) => content.toUpperCase());
        const middleware = transformMiddleware(file, transformFn, "production");

        const req1 = { headers: {}, url: "/test.txt" } as unknown as Request;
        const res = {
            set: jest.fn(),
            type: jest.fn().mockReturnThis(),
            send: jest.fn(),
            status: jest.fn().mockReturnThis(),
            end: jest.fn()
        } as unknown as Response;
        const next = jest.fn() as NextFunction;

        await middleware(req1, res, next);
        const headers: Record<string, string> = (res.set as jest.Mock).mock.calls[0][0] as Record<string, string>;

        expect(transformFn).toHaveBeenCalledTimes(1);
        expect((res.send as jest.Mock)).toHaveBeenCalledTimes(1);
        expect((res.send as jest.Mock).mock.calls[0][0]).toBe("TEST CONTENT");
        expect((next as jest.Mock)).not.toHaveBeenCalled();

        jest.clearAllMocks();

        // Modify the file
        await fs.writeFile(file, "modified content", "utf8");

        const req2 = {
            headers: { "if-modified-since": headers["Last-Modified"], "if-none-match": headers["ETag"] },
            url: "/test.txt"
        } as unknown as Request;

        await middleware(req2, res, next);

        expect(transformFn).toHaveBeenCalledTimes(1);
        expect((res.send as jest.Mock)).toHaveBeenCalledTimes(1);
        expect((res.send as jest.Mock).mock.calls[0][0]).toBe("MODIFIED CONTENT");
        expect((next as jest.Mock)).not.toHaveBeenCalled();
    }));

})
