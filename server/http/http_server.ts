import { createServer as createHttpServer, Server } from "http";
import { createServer as createHttpsServer } from "https";
import { TypedEmitter } from "tiny-typed-emitter";
import type { Http } from "../lib/config.ts";
import type { AddressInfo } from "node:net";
import express from "express";
import logger from "../lib/logger.ts";

interface HttpServerEvents {
    "listenHost": (proto: string, host: string, port: number) => void,
    "listeningAddress": (proto: string, address: AddressInfo) => void,
}

export class HttpServer extends TypedEmitter<HttpServerEvents> {
    private readonly httpServers: Server[] = [];

    constructor(private http: Http, private app: express.Express) {
        super();
    }

    public async listen(): Promise<void> {
        const httpListenPromises: Promise<void>[] = []
        const proto = this.http.secure ? "https" : "http";

        this.http.serverOptions.hosts?.forEach((host) => {
            this.http.serverOptions.ports?.forEach((port) => {
                this.emit("listenHost", proto, host, port);
            })
        });

        this.http.serverOptions.addresses.forEach((address) => {
            this.http.serverOptions.ports?.forEach((port) => {
                let httpServer;

                if (this.http.secure) {
                    httpServer = createHttpsServer(this.http.serverOptions, this.app);
                } else {
                    httpServer = createHttpServer(this.app);
                }
                const httpListening = new Promise<void>((resolve, reject) => {
                    httpServer.on("error", reject);
                    httpServer.listen(port, ...(address ? [address] : []), () => {
                        const address = httpServer.address() as AddressInfo;
                        this.emit("listeningAddress", proto, address);
                        httpServer.off("error", reject);
                        resolve();
                    });
                });
                this.httpServers.push(httpServer);
                httpListenPromises.push(httpListening);
            });
        });

        try {
            await Promise.all(httpListenPromises);
        } finally {
            await Promise.allSettled(httpListenPromises);
        }
    }

    public async close() {
        const stopPromises = this.httpServers.map((httpServer) => new Promise<void>((resolve, reject) => {
            if (httpServer.listening) {
                httpServer.close((err?: Error) => (err ? reject(err) : resolve()));
            } else {
                resolve();
            }
        }));

        try {
            await Promise.all(stopPromises);
        } catch (err) {
            logger.error("Error closing server:", { err });
        } finally {
            await Promise.allSettled(stopPromises);
        }
    }
}

export default function createServer(httpConfig: Http, app: express.Express): HttpServer {
    return new HttpServer(httpConfig, app);
}
