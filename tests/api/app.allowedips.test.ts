// noinspection DuplicatedCode

import createTestApp from "../testapp.ts";
import { sendRawHttp, withLocalTmpDir } from "../utils.ts";
import proxyAddr from "proxy-addr";
import net from "net";
import dedent from "dedent";
import type { Server } from "node:http";
import express from "express";

async function listen(host: string, app: express.Express) {
    return await new Promise<Server>((resolve, reject) => {
        let server: Server;
        // eslint-disable-next-line prefer-const
        server = app.listen(0, host, (err) => err ? reject(err) : resolve(server));
    });
}

describe('Test allowed IP address filter', () => {
    test('Check that request with no address filter succeeds', withLocalTmpDir(async () => {
        const app = await createTestApp();

        const server = await listen("127.0.0.1", app);
        try {
            const port = (server.address() as net.AddressInfo).port;

            const response = await sendRawHttp(server, {
                headers: dedent`
                    GET /api/v1/status HTTP/1.1
                    Host: 127.0.0.1:${ port }
                    Connection: close\n\n
                `
            })

            expect(response).toStartWith("HTTP/1.1 200 OK\r\n");
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }));

    test('Check that request address within the range succeeds', withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { allowedIps: proxyAddr.compile("127.0.1.0/24") } });

        const server = await listen("127.0.0.1", app);
        try {
            const port = (server.address() as net.AddressInfo).port;

            const response = await sendRawHttp(server, {
                localAddress: "127.0.1.1",
                headers: dedent`
                    GET /api/v1/status HTTP/1.1
                    Host: 127.0.0.1:${ port }
                    Connection: close\n\n
                `
            })

            expect(response).toStartWith("HTTP/1.1 200 OK\r\n");
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }));

    test('Check that request address out of the range fails', withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { allowedIps: proxyAddr.compile("127.0.1.0/24") } });

        const server = await listen("127.0.0.1", app);
        try {
            const port = (server.address() as net.AddressInfo).port;

            const response = await sendRawHttp(server, {
                localAddress: "127.0.2.1",
                headers: dedent`
                    GET /api/v1/status HTTP/1.1
                    Host: 127.0.0.1:${ port }
                    Connection: close\n\n
                `
            })

            expect(response).toStartWith("HTTP/1.1 403 Forbidden\r\n");
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }));

    test('Check that request within multiple ranges succeeds', withLocalTmpDir(async () => {
        const app = await createTestApp(
            { upload: { allowedIps: proxyAddr.compile(["127.0.1.0/24", "127.0.2.0/24"]) } });

        const server = await listen("127.0.0.1", app);
        try {
            const port = (server.address() as net.AddressInfo).port;

            const res1 = await sendRawHttp(server, {
                localAddress: "127.0.1.1",
                headers: dedent`
                    GET /api/v1/status HTTP/1.1
                    Host: 127.0.0.1:${ port }
                    Connection: close\n\n
                `
            });
            expect(res1).toStartWith("HTTP/1.1 200 OK\r\n");

            const res2 = await sendRawHttp(server, {
                localAddress: "127.0.2.1",
                headers: dedent`
                    GET /api/v1/status HTTP/1.1
                    Host: 127.0.0.1:${ port }
                    Connection: close\n\n
                `
            });
            expect(res2).toStartWith("HTTP/1.1 200 OK\r\n");
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }));

    test('Check that request out pf multiple ranges fails', withLocalTmpDir(async () => {
        const app = await createTestApp(
            { upload: { allowedIps: proxyAddr.compile(["127.0.1.0/24", "127.0.2.0/24"]) } });

        const server = await listen("127.0.0.1", app);
        try {
            const port = (server.address() as net.AddressInfo).port;

            const response = await sendRawHttp(server, {
                localAddress: "127.0.3.1",
                headers: dedent`
                    GET /api/v1/status HTTP/1.1
                    Host: 127.0.0.1:${ port }
                    Connection: close\n\n
                `
            });
            expect(response).toStartWith("HTTP/1.1 403 Forbidden\r\n");
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }));

    test('Check that correct IP is checked when forwarded from trusted proxy', withLocalTmpDir(async () => {
        const app = await createTestApp({
            security: { trustProxy: proxyAddr.compile("127.0.1.1/32") },
            upload: { allowedIps: proxyAddr.compile("127.0.2.0/24") }
        });

        const server = await listen("127.0.0.1", app);
        try {
            const port = (server.address() as net.AddressInfo).port;

            const response = await sendRawHttp(server, {
                localAddress: "127.0.1.1",
                headers: dedent`
                    GET /api/v1/status HTTP/1.1
                    Host: 127.0.0.1:${ port }
                    X-Forwarded-For: 127.0.2.1
                    Connection: close\n\n
                `
            });
            expect(response).toStartWith("HTTP/1.1 200 OK\r\n");
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }));

    test('Check that forwarded header is not trusted', withLocalTmpDir(async () => {
        const app = await createTestApp({
            security: { trustProxy: proxyAddr.compile("127.0.1.1/32") },
            upload: { allowedIps: proxyAddr.compile("127.0.2.0/24") }
        });

        const server = await listen("127.0.0.1", app);
        try {
            const port = (server.address() as net.AddressInfo).port;

            const response = await sendRawHttp(server, {
                localAddress: "127.0.1.2",
                headers: dedent`
                    GET /api/v1/status HTTP/1.1
                    Host: 127.0.0.1:${ port }
                    X-Forwarded-For: 127.0.2.1
                    Connection: close\n\n
                `
            });
            expect(response).toStartWith("HTTP/1.1 403 Forbidden\r\n");
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }));
});
