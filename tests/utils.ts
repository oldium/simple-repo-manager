import type { TmpDirCallback } from "with-local-tmp-dir";
import { default as withLocalTmpDirFunc } from "with-local-tmp-dir";
import type { Application } from "express";
import request from "supertest";
import net from "net";
import osPath from "path";
import fsExtra from "fs-extra/esm";
import fs from "fs/promises";
import type { Server } from "node:http";
import { closeBackends } from "../server/backend/registry.ts";

export function withLocalTmpDir<T>(what: TmpDirCallback<T>) {
    return async () => {
        // Default to a project-local `tmp/` so debugging leftovers stay
        // visible alongside the source. Override via `TEST_TMP_DIR` when
        // you want fast fs — e.g. pointing at a tmpfs to bypass slow
        // bind-mount syscalls (Docker Desktop for Windows).
        const dir = process.env.TEST_TMP_DIR ?? "tmp";
        await fsExtra.ensureDir(dir);
        return withLocalTmpDirFunc({ unsafeCleanup: true, dir }, async () => {
            // Windows cannot delete an open SQLite file; a failing test keeps its own error
            let result: Awaited<T>;
            try {
                result = await what();
            } catch (err) {
                await closeBackends(process.cwd()).catch(() => undefined);
                throw err;
            }
            await closeBackends(process.cwd());
            return result;
        });
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

    // `res.close` fires when the underlying connection is terminated —
    // on an aborted PUT that happens before the handler's own cleanup
    // runs. Defer the resolve via `process.nextTick` so any other
    // listeners on the same `close` event fire first. Callers that
    // want to observe the server's post-close state should still
    // wrap their assertions in `waitForAssertion` (below).
    await new Promise<void>((resolve) => {
        server.on('request', (_req, res) => {
            res.on('close', () => process.nextTick(resolve));
        });
    });

    server.close();
}

/**
 * Retry an assertion until it passes or a deadline elapses.
 *
 * Phase 1 — microtask drain: try up to 50 times with a `setImmediate`
 * between attempts. This is enough when the server still has queued
 * microtasks to work through.
 *
 * Phase 2 — timer polling: if phase 1 is exhausted, keep trying with a
 * 1ms `setTimeout` between attempts until `maxMs` has elapsed. This is
 * needed on bind-mount filesystems (notably Docker Desktop for Windows)
 * where a dirent cache can lag an `unlink` call by a few milliseconds.
 *
 * Final attempt: re-run once more and let any thrown error propagate
 * so Jest reports the real assertion failure.
 */
export async function waitForAssertion<T>(
    assertion: () => T | Promise<T>,
    maxMs = 200,
): Promise<T> {
    for (let i = 0; i < 50; i++) {
        try {
            return await assertion();
        } catch {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    }
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        try {
            return await assertion();
        } catch {
            await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
    }
    // Let the final assertion's error surface to the caller.
    return await assertion();
}

export function tarEntry(name: string, body: string, type = "0"): Buffer {
    const header = Buffer.alloc(512);
    header.write(name);
    header.write(`${ body.length.toString(8).padStart(11, "0") }\0`, 124);
    header.write(" ".repeat(8), 148);
    header.write(type, 156);
    header.write(`${ header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") }\0 `, 148);
    return Buffer.concat([header, Buffer.from(body), Buffer.alloc((512 - body.length % 512) % 512)]);
}

export function tarBytes(...entries: Buffer[]): Buffer {
    return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

/** An uncompressed .deb with this control member, for metadata no packaging tool would write */
export function debWithControlTar(controlTar: Buffer): Buffer {
    const parts = [Buffer.from("!<arch>\n")];
    for (const [name, body] of [["debian-binary", Buffer.from("2.0\n")], ["control.tar", controlTar], ["data.tar", tarBytes(tarEntry("./usr/bin/x", "x"))]] as const) {
        const header = Buffer.alloc(60, " ");
        header.write(name, 0, "latin1");
        header.write(String(body.length), 48, "latin1");
        header.write("`\n", 58, "latin1");
        parts.push(header, body);
    }
    return Buffer.concat(parts);
}

export function debWithControl(fields: Record<string, string>): Buffer {
    const control = Object.entries(fields).map(([name, value]) => `${ name }: ${ value }\n`).join("");
    return debWithControlTar(tarBytes(tarEntry("./control", control)));
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
