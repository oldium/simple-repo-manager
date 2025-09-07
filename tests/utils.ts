import type { TmpDirCallback } from "with-local-tmp-dir";
import { default as withLocalTmpDirFunc } from "with-local-tmp-dir";
import type { Application } from "express";
import request from "supertest";
import net from "net";
import osPath from "path";
import fsExtra from "fs-extra/esm";
import fs from "fs/promises";
import type { Server } from "node:http";

export function withLocalTmpDir<T>(what: TmpDirCallback<T>) {
    return async () => {
        await fsExtra.ensureDir("tmp");
        return withLocalTmpDirFunc({ unsafeCleanup: true, dir: "tmp" }, what);
    }
}

export function uploadFileByPost(app: Application, url: string, files: { name: string, content: Buffer }[],
    fieldName?: string) {

    let req = request(app).post(url);
    files.forEach(file => {
        req = req.attach(fieldName ?? 'package', file.content, { filename: file.name });
    });
    return req;
}

export function uploadFileByPut(app: Application, url: string, content: Buffer) {
    const req = request(app).put(url);
    req.type('application/octet-stream');
    return req.send(content);
}

export async function sendRawHttp(server: Server, opts: { localAddress?: string, headers: string, content?: Buffer }): Promise<string> {
    const serverAddress = (server.address() as net.AddressInfo);

    let responseData = '';
    let requestHeaders = opts.headers.split(/\r?\n/).join("\r\n");
    if (!requestHeaders.match(/^Connection:\s*close/gi)) {
        requestHeaders = requestHeaders.replace(/\r\n\r\n/, '\r\nConnection: close\r\n\r\n');
    }

    const response = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection({ port: serverAddress.port, host: serverAddress.address, localAddress: opts.localAddress }, () => {
            socket.write(requestHeaders);
            if (opts.content) {
                socket.write(opts.content);
            }
        });

        socket.on('data', (data) => {
            responseData += data.toString();
        });

        socket.on('end', () => {
            resolve(responseData);
        });

        socket.on('error', (err) => {
            reject(err);
        });
    });

    return response;
}

export async function uploadFileByPutRawIncomplete(app: Application, requestHeaders: string,
    buffer: Buffer<ArrayBuffer>) {
    const server = app.listen(0);
    const port = (server.address() as net.AddressInfo).port;

    const socket = net.createConnection({ port }, async () => {
        // Send headers and part of the body
        socket.write(requestHeaders);
        socket.write(buffer); // Only partial content
        await new Promise((resolve) => {
            server.on('request', resolve);
        });
        socket.end();
    });

    await new Promise<void>((resolve) => {
        server.on('request', async (_req, res) => {
            res.on('close', async () => {
                // Give it enough full cycles to finish
                for (let i = 0; i < 50; i++) {
                    await new Promise<void>((innerResolve) => setImmediate(innerResolve));
                }
                resolve();
            })
        });
    });

    server.close();
}

export async function createFiles(files: Record<string, string | undefined>) {
    for (const [filePath, fileContent] of Object.entries(files)) {
        if (fileContent === undefined) {
            await fsExtra.ensureDir(filePath);
        } else {
            const fileDir = osPath.dirname(filePath);
            if (fileDir.length > 0) {
                await fsExtra.ensureDir(fileDir);
            }
            await fs.writeFile(filePath, fileContent, "utf8");
        }
    }
}
