import express from "express";
import type { Request, Response } from "express";
import request from "supertest";
import proxyAddr from "proxy-addr";
import { getHostname, getUriNoQuery } from "../../server/lib/req.ts";

function uriApp(trustProxy?: string, publicUrl?: string) {
    const app = express();
    if (trustProxy) {
        app.set("trust proxy", proxyAddr.compile(trustProxy));
    }
    if (publicUrl) {
        app.set("public url", new URL(publicUrl));
    }
    app.get("/hostname", (req: Request, res: Response) => {
        res.send(getHostname(req));
    });
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

    test("Uses the public URL instead of the Host header", async () => {
        const res = await request(uriApp(undefined, "https://repo.example.com/packages")).get("/")
            .set("Host", "attacker.example.com")
            .set("X-Forwarded-Host", "attacker.example.com");
        expect(res.text).toBe("https://repo.example.com/packages/deb/archive-keyring.asc");
    });

    test("Keeps the port of the public URL", async () => {
        const res = await request(uriApp(undefined, "https://repo.example.com:8443/packages")).get("/")
            .set("Host", "attacker.example.com:8080");
        expect(res.text).toBe("https://repo.example.com:8443/packages/deb/archive-keyring.asc");
    });

    test("Uses the public URL behind a trusted proxy without forwarded URL headers", async () => {
        const res = await request(uriApp("loopback", "https://repo.example.com/packages")).get("/")
            .set("Host", "simple-repo-manager:3000")
            .set("X-Forwarded-For", "192.0.2.1");
        expect(res.text).toBe("https://repo.example.com/packages/deb/archive-keyring.asc");
    });

    test("Lets a trusted proxy override the public URL", async () => {
        const res = await request(uriApp("loopback", "https://repo.example.com/packages")).get("/")
            .set("Host", "simple-repo-manager:3000")
            .set("X-Forwarded-Proto", "http")
            .set("X-Forwarded-Host", "mirror.example.com")
            .set("X-Forwarded-Port", "8080")
            .set("X-Forwarded-Path", "/");
        expect(res.text).toBe("http://mirror.example.com:8080/deb/archive-keyring.asc");
    });

    test("Takes the host name from the public URL", async () => {
        const res = await request(uriApp(undefined, "https://repo.example.com:8443")).get("/hostname")
            .set("Host", "attacker.example.com");
        expect(res.text).toBe("repo.example.com");
    });
});
