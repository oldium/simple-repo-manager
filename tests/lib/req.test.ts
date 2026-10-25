import express from "express";
import type { Request, Response } from "express";
import request from "supertest";
import proxyAddr from "proxy-addr";
import { getUriNoQuery } from "../../server/lib/req.ts";

function uriApp(trustProxy?: string) {
    const app = express();
    if (trustProxy) {
        app.set("trust proxy", proxyAddr.compile(trustProxy));
    }
    app.use((req: Request, res: Response) => {
        res.send(getUriNoQuery(req, "/deb/archive-keyring.asc"));
    });
    return app;
}

describe("Tests for getUriNoQuery", () => {
    test("Uses the Host header as sent", async () => {
        const res = await request(uriApp()).get("/").set("Host", "repo.example.com");
        expect(res.text).toBe("http://repo.example.com/deb/archive-keyring.asc");
    });

    test("Keeps the port of the Host header", async () => {
        const res = await request(uriApp()).get("/").set("Host", "repo.example.com:8080");
        expect(res.text).toBe("http://repo.example.com:8080/deb/archive-keyring.asc");
    });

    test("Ignores forwarded headers from an untrusted client", async () => {
        const res = await request(uriApp()).get("/")
            .set("Host", "repo.example.com")
            .set("X-Forwarded-Proto", "https")
            .set("X-Forwarded-Host", "attacker.example.com");
        expect(res.text).toBe("http://repo.example.com/deb/archive-keyring.asc");
    });

    test("Takes the URL from a trusted proxy", async () => {
        const res = await request(uriApp("loopback")).get("/")
            .set("Host", "simple-repo-manager:3000")
            .set("X-Forwarded-Proto", "https")
            .set("X-Forwarded-Host", "repo.example.com")
            .set("X-Forwarded-Port", "8443")
            .set("X-Forwarded-Path", "/packages");
        expect(res.text).toBe("https://repo.example.com:8443/packages/deb/archive-keyring.asc");
    });
});
