// The built server running natively on Windows, on a real NTFS volume: uploads, hostile requests, readers holding files open,
// a kill during an import, a rebuild, the console closing, and real apt and dnf clients in containers. Needs Docker for the clients.
// After `npm run build`: node tests/e2e/native-windows.mjs [work directory] [port]
/* global Buffer, File, FormData, console, fetch, process, setTimeout */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { openSync, existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import osPath from "node:path";
import { stripVTControlCharacters } from "node:util";
import zlib from "node:zlib";
import * as openpgp from "openpgp";
import { signBundle, signRpm } from "../signing.ts";

const repo = osPath.resolve(import.meta.dirname, "..", "..");
const [workArg = osPath.join(repo, "tmp", "native-windows"), portArg = "38473"] = process.argv.slice(2);
const work = osPath.resolve(workArg);
const port = Number(portArg);
if (process.platform !== "win32" || !existsSync(osPath.join(repo, "dist", "style.css"))) {
    console.error("This runs on Windows, after npm run build");
    process.exit(2);
}
const base = `http://127.0.0.1:${ port }`;
const fixtures = osPath.join(repo, "tests", "fixtures", "packages");
const env = {
    ...process.env, NODE_ENV: "production", HTTP_PORT: String(port), HTTP_HOST: "127.0.0.1",
    INCOMING_DIR: "incoming", REPO_DIR: "repo", REPO_STATE_DIR: "state", TEMPLATES_DIR: "", GPG_REPO_PRIVATE_KEY_FILE: "key.asc",
};
const results = [];

function check(name, ok, detail = "") {
    results.push([ok, name]);
    console.log(`${ ok ? "PASS" : "FAIL" } ${ name }${ detail ? `: ${ detail }` : "" }`);
}

function sha256(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

let server;
let logIndex = 0;

async function start() {
    logIndex++;
    server = spawn(process.execPath, [osPath.join(repo, "server", "server.ts")], {
        cwd: work, env, stdio: ["ignore", openSync(osPath.join(work, `server${ logIndex }.log`), "w"), openSync(osPath.join(work, `server${ logIndex }.err`), "w")],
    });
    for (let i = 0; i < 600; i++) {
        try {
            if ((await fetch(`${ base }/api/v1/status`)).ok) return;
        } catch { /* not yet */ }
        if (server.exitCode !== null) throw new Error(`server exited ${ server.exitCode }, see server${ logIndex }.err`);
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error("server did not start");
}

async function kill() {
    const exited = new Promise(resolve => server.once("exit", resolve));
    server.kill();
    await exited;
}

async function get(urlPath) {
    const res = await fetch(`${ base }${ urlPath }`);
    return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}

/** Raw path, so that nothing normalizes or encodes it on the way */
function raw(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: body ? { "Content-Length": body.length } : {} }, res => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", reject);
        req.end(body);
    });
}

async function mcp(name, args = {}) {
    const res = await fetch(`${ base }/api/v1/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const { result } = await res.json();
    return result.structuredContent ?? { isError: result.isError, text: result.content?.map(c => c.text).join(" ") };
}

// The server takes nothing unsigned with a key set, so what goes up is a signed copy
let copies = 0;

const uploadKey = async () => openpgp.readPrivateKey({ armoredKey: await fs.readFile(osPath.join(work, "key.asc"), "utf8") });

async function signedCopy(dir, rename) {
    const copy = osPath.join(work, "signed-copies", String(++copies));
    await fs.mkdir(copy, { recursive: true });
    for (const name of await fs.readdir(dir)) {
        const [uploaded, bytes] = rename(name, await fs.readFile(osPath.join(dir, name)));
        await fs.writeFile(osPath.join(copy, uploaded), bytes);
    }
    const key = await uploadKey();
    await signBundle(copy, key);
    for (const name of (await fs.readdir(copy)).filter(n => n.endsWith(".rpm"))) {
        await fs.writeFile(osPath.join(copy, name), await signRpm(await fs.readFile(osPath.join(copy, name)), key));
    }
    return copy;
}

async function uploadDir(target, unsigned, rename = (name, bytes) => [name, bytes]) {
    const form = new FormData();
    const dir = await signedCopy(unsigned, rename);
    for (const name of (await fs.readdir(dir)).sort()) {
        form.append("package", new File([await fs.readFile(osPath.join(dir, name))], name));
    }
    return (await fetch(`${ base }/api/v1/upload/${ target }`, { method: "POST", body: form })).status;
}

const statuses = sc => (sc.files ?? []).reduce((all, f) => ({ ...all, [f.status]: (all[f.status] ?? 0) + 1 }), {});

const DEB_RELEASES = [["debian", "trixie", "main"], ["debian", "bookworm", "main"], ["ubuntu", "noble", "universe"]];
const DEB_DIRS = DEB_RELEASES.map(([distro, release, component]) => ({ target: `deb/${ distro }/${ release }/${ component }`, dir: osPath.join(fixtures, "deb", distro, release, component) }));

async function uploadAll() {
    const codes = [];
    for (const { target, dir } of DEB_DIRS) codes.push(await uploadDir(target, dir));
    codes.push(await uploadDir("rpm/fedora/42", osPath.join(fixtures, "rpm", "fedora", "42")));
    return codes;
}

let publicKey;

async function verifySigned(cleartext) {
    const message = await openpgp.readCleartextMessage({ cleartextMessage: cleartext.toString("utf8") });
    const { signatures } = await openpgp.verify({ message, verificationKeys: publicKey });
    await signatures[0].verified;
}

async function verifyDetached(content, signature) {
    const message = await openpgp.createMessage({ binary: content });
    const { signatures } = await openpgp.verify({ message, signature: await openpgp.readSignature({ armoredSignature: signature.toString("utf8") }), verificationKeys: publicKey });
    await signatures[0].verified;
}

/** Everything a client follows, over HTTP: signatures, every listed index, every package and source file */
async function verifyTree() {
    const problems = [];
    const expectFile = async (url, hash, size) => {
        const { status, bytes } = await get(url);
        if (status !== 200) problems.push(`${ url }: ${ status }`);
        else if (sha256(bytes) !== hash) problems.push(`${ url }: checksum`);
        else if (size !== undefined && bytes.length !== Number(size)) problems.push(`${ url }: size`);
    };
    let files = 0;
    for (const [distro, release] of DEB_RELEASES) {
        const root = `/deb/${ distro }/dists/${ release }`;
        const inRelease = await get(`${ root }/InRelease`);
        const releaseFile = await get(`${ root }/Release`);
        const gpg = await get(`${ root }/Release.gpg`);
        try {
            await verifySigned(inRelease.bytes);
            await verifyDetached(releaseFile.bytes, gpg.bytes);
        } catch (err) {
            problems.push(`${ root }: signature: ${ err.message }`);
        }
        const text = releaseFile.bytes.toString("utf8");
        const section = text.slice(text.indexOf("SHA256:")).split("\n").slice(1);
        for (const line of section) {
            const match = /^ ([0-9a-f]{64}) +(\d+) (\S+)$/.exec(line);
            if (!match) break;
            // Listed for clients to check after decompressing: only the compressed file is published
            if (!/\.(gz|xz|zst)$/.test(match[3]) && !match[3].endsWith("Release") && !section.some(other => other.endsWith(` ${ match[3] }`) === false && other.endsWith(` ${ match[3] }.gz`)) === false) {
                const { status, bytes } = await get(`${ root }/${ match[3] }.gz`);
                const plain = status === 200 ? zlib.gunzipSync(bytes) : Buffer.alloc(0);
                if (sha256(plain) !== match[1] || plain.length !== Number(match[2])) problems.push(`${ root }/${ match[3] }: does not match its .gz`);
                if ((await get(`${ root }/${ match[3] }`)).status !== 404) problems.push(`${ root }/${ match[3] }: published uncompressed`);
            } else {
                await expectFile(`${ root }/${ match[3] }`, match[1], match[2]);
            }
            files++;
            if (match[3].includes("\\")) problems.push(`${ root }: backslash in ${ match[3] }`);
            if (match[3].endsWith("/Packages.gz")) {
                const { bytes } = await get(`${ root }/${ match[3] }`);
                for (const stanza of zlib.gunzipSync(bytes).toString("utf8").split("\n\n").filter(Boolean)) {
                    const filename = /^Filename: (.+)$/m.exec(stanza)?.[1];
                    if (filename === undefined || filename.includes("\\")) problems.push(`${ match[3] }: Filename ${ filename }`);
                    else { await expectFile(`/deb/${ distro }/${ filename }`, /^SHA256: (.+)$/m.exec(stanza)[1]); files++; }
                }
            }
            if (match[3].endsWith("/Sources.gz")) {
                const { bytes } = await get(`${ root }/${ match[3] }`);
                for (const stanza of zlib.gunzipSync(bytes).toString("utf8").split("\n\n").filter(Boolean)) {
                    const directory = /^Directory: (.+)$/m.exec(stanza)?.[1];
                    if (directory === undefined || directory.includes("\\")) problems.push(`${ match[3] }: Directory ${ directory }`);
                    const listed = stanza.slice(stanza.indexOf("Checksums-Sha256:")).split("\n").slice(1);
                    for (const entry of listed) {
                        const file = /^ ([0-9a-f]{64}) +(\d+) (\S+)$/.exec(entry);
                        if (!file) break;
                        await expectFile(`/deb/${ distro }/${ directory }/${ file[3] }`, file[1], file[2]);
                        files++;
                    }
                }
            }
        }
    }
    const repodata = "/rpm/fedora/42/repodata";
    const repomd = await get(`${ repodata }/repomd.xml`);
    try {
        await verifyDetached(repomd.bytes, (await get(`${ repodata }/repomd.xml.asc`)).bytes);
    } catch (err) {
        problems.push(`repomd: signature: ${ err.message }`);
    }
    for (const data of repomd.bytes.toString("utf8").matchAll(/<data type="(\w+)">([\s\S]*?)<\/data>/g)) {
        const hash = /<checksum type="sha256">(\w+)</.exec(data[2])[1];
        const href = /<location href="([^"]+)"/.exec(data[2])[1];
        await expectFile(`/rpm/fedora/42/${ href }`, hash);
        files++;
        if (data[1] === "primary") {
            const { bytes } = await get(`/rpm/fedora/42/${ href }`);
            for (const pkg of zlib.zstdDecompressSync(bytes).toString("utf8").matchAll(/<package [\s\S]*?<\/package>/g)) {
                const location = /<location href="([^"]+)"/.exec(pkg[0])[1];
                if (!/^Packages\/[a-z0-9]\/[^/\\]+\/[^/\\]+$/.test(location)) problems.push(`primary: ${ location }`);
                await expectFile(`/rpm/fedora/42/${ location }`, /<checksum type="sha256"[^>]*>(\w+)</.exec(pkg[0])[1]);
                files++;
            }
        }
    }
    return { problems, files };
}

async function expectTree(name) {
    const { problems, files } = await verifyTree();
    check(name, problems.length === 0 && files > 20, problems.length ? problems.slice(0, 5).join("; ") : `${ files } files verified`);
}

async function listTree(dir) {
    const root = osPath.join(work, dir);
    const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
    return entries.filter(e => e.isFile()).map(e => osPath.relative(root, osPath.join(e.parentPath, e.name)).split(osPath.sep).join("/")).sort();
}

// ---------------------------------------------------------------- setup
await fs.rm(work, { recursive: true, force: true });
await fs.mkdir(osPath.join(work, "clients", "keys"), { recursive: true });
const key = await openpgp.generateKey({ type: "rsa", rsaBits: 4096, userIDs: [{ name: "Native check", email: "native@example.invalid" }], format: "armored" });
await fs.writeFile(osPath.join(work, "key.asc"), key.privateKey);
await fs.writeFile(osPath.join(work, "clients", "keys", "pubkey.asc"), key.publicKey);
publicKey = await openpgp.readKey({ armoredKey: key.publicKey });

await start();
check("Server starts on this build", true);

// ---------------------------------------------------------------- upload, import, verify
const codes = await uploadAll();
check("Uploads of every fixture bundle", codes.every(code => code === 201), codes.join(","));
const imported = await mcp("import_repository");
check("Import of every fixture", imported.ok === true && !imported.files.some(f => f.status !== "ok"), JSON.stringify(statuses(imported)));
await expectTree("Signed tree verifies over HTTP");

// ---------------------------------------------------------------- what the key refuses
const UNSIGNED = "srm-hello-doc-1.0-1.fc42.noarch.rpm";
const unsignedCode = await raw("PUT", `/api/v1/upload/rpm/fedora/41/${ UNSIGNED }`, await fs.readFile(osPath.join(fixtures, "rpm", "fedora", "42", UNSIGNED)));
const unsignedImport = await mcp("import_repository");
check("An unsigned upload fails with the reason", unsignedCode === 201 && unsignedImport.files?.[0]?.status === "failed" && /is not signed/.test(unsignedImport.files?.[0]?.reason ?? ""), JSON.stringify(unsignedImport.files?.[0]));
await fs.rm(osPath.join(work, "incoming", "process", "rpm", "fedora", "41"), { recursive: true });

for (const page of ["/", "/deb/", "/rpm/fedora/42/", "/deb/debian/pool/main/s/srm-hello/"]) {
    check(`Browse ${ page }`, (await get(page)).status === 200);
}

// ---------------------------------------------------------------- hostile requests
const RELEASE = "/deb/debian/dists/trixie/Release";
for (const url of [
    `${ RELEASE }::$DATA`, `${ RELEASE }:$DATA`, `${ RELEASE }.`, `${ RELEASE }...`, `${ RELEASE }%20`, `${ RELEASE }%2E`, `${ RELEASE }%3A%3A$DATA`,
    "/deb/debian/dists/trixie/RELEAS~1", "/.env::$DATA", "/deb/con", "/deb/CON", "/deb/nul", "/deb/com1", "/deb/lpt%C2%B9", "/deb/conin$", "/aux/",
    "/deb/con.", "/deb/con%20", "/C:", "/C:/Windows/win.ini", "/C:%5CWindows%5Cwin.ini", "/%5C%5Clocalhost%5Cc$%5CWindows%5Cwin.ini",
    "/..%5C..%5Cstate%5Crepo.db", "/..%5Ckey.asc", "/..%2Fkey.asc", "/../key.asc", "/deb/../rpm/", "/./deb/", "/...", "/deb/.../x",
    "/deb/%00", "/deb/%0A", "/%E0%A4%A", "/%252e%252e/key.asc",
]) {
    check(`GET ${ url } answers 404`, await raw("GET", url) === 404);
}
for (const url of ["/deb//debian/", "//deb/", "/deb/debian//dists/trixie/Release"]) {
    check(`GET ${ url } answers 200`, await raw("GET", url) === 200);
}
check("Case alias of a public file stays",await raw("GET", "/deb/debian/dists/trixie/RELEASE") === 200);
const PUT_ROOT = "/api/v1/upload";
for (const url of [
    `${ PUT_ROOT }/deb/aux/trixie/main/x_1_all.deb`, `${ PUT_ROOT }/deb/debian/con/main/x_1_all.deb`, `${ PUT_ROOT }/deb/debian/trixie/nul/x_1_all.deb`,
    `${ PUT_ROOT }/deb/debian/trixie/main/lpt1/x_1_all.deb`, `${ PUT_ROOT }/rpm/prn/42/x.rpm`, `${ PUT_ROOT }/deb/C:/trixie/main/x_1_all.deb`,
    `${ PUT_ROOT }/deb/debian/trixie/main/x.tar.a:b`, `${ PUT_ROOT }/deb/debian/trixie/main/x.tar.a%20`, `${ PUT_ROOT }/deb/debian/trixie/main/foo~1.deb`,
    `${ PUT_ROOT }/deb/debian/trixie/main/git~1.dsc`, `${ PUT_ROOT }/deb/debian/trixie/main/x.tar.a%5Cb`, `${ PUT_ROOT }/deb/debian/trixie/main/x.tar.a%2Fb`,
    `${ PUT_ROOT }/deb/debian/trixie/main/..%5Cevil.deb`, `${ PUT_ROOT }/deb/debian/trixie/main/x.tar.a%00`,
    `${ PUT_ROOT }/deb/debian/trixie/main/source/x_1_all.deb`, `${ PUT_ROOT }/deb/debian/trixie/main/by-hash/x_1_all.deb`, `${ PUT_ROOT }/deb/debian/trixie/debug/x_1_all.deb`,
    `${ PUT_ROOT }/deb/debian/trixie/main/debian-installer/x_1_all.deb`, `${ PUT_ROOT }/deb/debian/trixie/main/binary-amd64/x_1_all.deb`, `${ PUT_ROOT }/deb/debian/trixie/release/x_1_all.deb`,
]) {
    check(`PUT ${ url } answers 400`, await raw("PUT", url, Buffer.from("x")) === 400);
}
const outsideEntries = (await fs.readdir(work)).sort().join(",");
check("Nothing escaped the data directories", !outsideEntries.includes("evil") && !existsSync(osPath.join(work, "incoming", "evil.deb")), outsideEntries);
await fs.rm(osPath.join(work, "incoming", "tmp"), { recursive: true, force: true });
await fs.mkdir(osPath.join(work, "incoming", "tmp"));
check("Device names with an extension are ordinary uploads", await raw("PUT", `${ PUT_ROOT }/deb/debian/sid/main/con.deb`, Buffer.from("x")) === 201 && await raw("PUT", `${ PUT_ROOT }/rpm/fedora/99/aux.rpm`, Buffer.from("x")) === 201);
await fs.rm(osPath.join(work, "incoming", "staging", "deb", "debian", "sid"), { recursive: true });
await fs.rm(osPath.join(work, "incoming", "staging", "rpm", "fedora", "99"), { recursive: true });

// ---------------------------------------------------------------- length limit
const longest = `${ "a".repeat(236) }.rpm`;
check("The longest allowed name uploads", await raw("PUT", `${ PUT_ROOT }/rpm/fedora/98/${ longest }`, Buffer.from("x")) === 201);
await fs.rm(osPath.join(work, "incoming", "staging", "rpm", "fedora", "98"), { recursive: true });
check("A longer name answers 400", await raw("PUT", `${ PUT_ROOT }/rpm/fedora/98/a${ longest }`, Buffer.from("x")) === 400);
check("A longer distribution answers 400", await raw("PUT", `${ PUT_ROOT }/rpm/${ "a".repeat(241) }/98/x.rpm`, Buffer.from("x")) === 400);
check("A longer URL segment answers 404", await raw("GET", `/deb/${ "a".repeat(241) }`) === 404);

// ---------------------------------------------------------------- active content
const pagePool = "/deb/debian/pool/main/s/srm-hello/srm-hello_1.0-1.dsc";
const pageHeaders = (await fetch(`${ base }${ pagePool }`)).headers;
check("A repository file is served sandboxed", pageHeaders.get("content-security-policy") === "sandbox" && pageHeaders.get("x-content-type-options") === "nosniff");

// ---------------------------------------------------------------- package metadata naming a device
const gzDir = osPath.join(fixtures, "deb", "debian", "bookworm", "main");
const auxCode = await uploadDir("deb/debian/sid/main", gzDir, (name, bytes) => name.endsWith(".changes") ? [name, Buffer.from(bytes.toString("utf8").replace(/^Source: srm-gz$/m, "Source: aux"))] : [name, bytes]);
const auxImport = await mcp("import_repository");
const auxChanges = auxImport.files?.find(f => f.path.endsWith(".changes"));
check("A source named aux fails with a reason, nothing moved", auxCode === 201 && auxChanges?.status === "failed" && /reserved name on Windows/.test(auxChanges?.reason ?? ""), `${ auxChanges?.status }: ${ auxChanges?.reason }`);
check("No pool directory aux", !existsSync(osPath.join(work, "repo", "deb", "debian", "pool", "main", "a")));
await fs.rm(osPath.join(work, "incoming", "process", "deb", "debian", "sid"), { recursive: true });

// ---------------------------------------------------------------- case-only names
const rpmDir = osPath.join(fixtures, "rpm", "fedora", "42");
const BIN = "srm-hello-1.0-1.fc42.x86_64.rpm";
const poolBin = osPath.join(work, "repo", "rpm", "fedora", "42", "Packages", "s", "srm-hello", BIN);
const poolHash = sha256(await fs.readFile(poolBin));
const otherContent = await signRpm(await fs.readFile(osPath.join(rpmDir, BIN)), await uploadKey());
const caseCode = await raw("PUT", `${ PUT_ROOT }/rpm/fedora/42/SRM-hello-1.0-1.fc42.x86_64.rpm`, otherContent);
const caseImport = await mcp("import_repository");
const caseFile = caseImport.files?.find(f => /SRM-hello/.test(f.path));
check("An RPM differing only in case fails with a reason", caseCode === 201 && caseFile?.status === "failed" && /does not match what it is signed for/.test(caseFile?.reason ?? ""), `${ caseFile?.status }: ${ caseFile?.reason }`);
check("The pool file is untouched", sha256(await fs.readFile(poolBin)) === poolHash);
await fs.rm(osPath.join(work, "incoming", "process", "rpm", "fedora", "42", "SRM-hello-1.0-1.fc42.x86_64.rpm"));

// ---------------------------------------------------------------- readers that share delete
const bookworm = "/deb/debian/dists/bookworm";
const onDisk = rel => osPath.join(work, "repo", ...rel.split("/"));
const gzPool = "deb/debian/pool/main/s/srm-gz/srm-gz_0.1-1_amd64.deb";
const readerRelease = await fs.open(onDisk("deb/debian/dists/bookworm/InRelease"), "r");
const readerPool = await fs.open(onDisk(gzPool), "r");
const releaseBefore = await readerRelease.readFile();
const poolBefore = await readerPool.readFile();
const removed = await mcp("remove_package", { format: "deb", distribution: "debian", release: "bookworm", source: "srm-gz", immediate: true });
check("Immediate removal with sharing readers open", (removed.files ?? []).length > 0 && !(removed.files ?? []).some(f => f.status === "failed"), JSON.stringify(statuses(removed)));
check("The removed pool file is gone", (await get(`/${ gzPool }`)).status === 404);
const releaseAfter = (await get(`${ bookworm }/InRelease`)).bytes;
check("InRelease changed for new readers", !releaseAfter.equals(releaseBefore));
await readerRelease.close();
await readerPool.close();
check("Readers kept their content to the end", poolBefore.length > 0 && releaseBefore.length > 0);
check("Upload again after removal", await uploadDir("deb/debian/bookworm/main", gzDir) === 201 && (await mcp("import_repository")).ok === true);
await expectTree("Tree verifies after removal and upload");

// ---------------------------------------------------------------- reader that does not share delete
const flag = osPath.join(work, "release-holder.flag");
const held = onDisk("deb/debian/dists/bookworm/Release");
const holder = spawn("pwsh", ["-NoProfile", "-Command",
    `$f=[IO.File]::Open('${ held }','Open','Read','Read'); 'held'; while(-not (Test-Path '${ flag }')){Start-Sleep -Milliseconds 100}; $f.Close()`], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise(resolve => holder.stdout.once("data", resolve));
const heldBefore = sha256((await get(`${ bookworm }/Release`)).bytes);
const blockedRemoval = await mcp("remove_package", { format: "deb", distribution: "debian", release: "bookworm", source: "srm-gz", immediate: true });
console.log("    while held:", JSON.stringify(blockedRemoval).slice(0, 400));
const heldStale = sha256((await get(`${ bookworm }/Release`)).bytes);
await fs.writeFile(flag, "");
await new Promise(resolve => holder.once("exit", resolve));
const reUpload = await uploadDir("deb/debian/bookworm/main", gzDir);
const repaired = await mcp("import_repository");
check("A non-sharing reader leaves Release stale", heldBefore === heldStale || blockedRemoval.isError === true, blockedRemoval.text ?? "");
check("The next import repairs a publish a non-sharing reader blocked", reUpload === 201 && repaired.ok === true, `Release before ${ heldStale.slice(0, 12) }, after ${ sha256((await get(`${ bookworm }/Release`)).bytes).slice(0, 12) }`);
await expectTree("Tree verifies after the repair, without a restart");

// ---------------------------------------------------------------- hard kill in the middle of an import, then restart
await mcp("remove_package", { format: "rpm", distribution: "fedora", release: "42", source: "srm-hello", immediate: true });
await uploadDir("rpm/fedora/42", rpmDir);
const interrupted = fetch(`${ base }/api/v1/mcp`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "import_repository", arguments: {} } }),
}).catch(() => undefined);
await new Promise(r => setTimeout(r, 25));
await kill();
await interrupted;
await start();
const afterKill = await mcp("import_repository");
check("Start after a hard kill during an import", afterKill.ok === true, JSON.stringify(statuses(afterKill)));
await expectTree("Tree verifies after the kill");

// ---------------------------------------------------------------- automatic rebuild
const poolBefore2 = (await listTree("repo")).filter(rel => rel.includes("/pool/") || rel.includes("/Packages/"));
await kill();
for (const suffix of ["", "-wal", "-shm"]) await fs.rm(osPath.join(work, "state", `repo.db${ suffix }`), { force: true });
// The letter directory of the 2.x layout, as a tree copied from Linux has it
const packagesDir = osPath.join(work, "repo", "rpm", "fedora", "42", "Packages");
await fs.rename(osPath.join(packagesDir, "s"), osPath.join(packagesDir, "S"));
check("The tree holds an upper-case letter directory", (await fs.readdir(packagesDir)).join() === "S");
await start();
check("The rebuild spelled the letter directory in lower case", (await fs.readdir(packagesDir)).join() === "s");
check("An import under that letter goes through after the rebuild", await uploadDir("rpm/fedora/42", rpmDir) === 201 && (await mcp("import_repository")).ok === true);
await expectTree("Tree verifies after an automatic rebuild");
const poolAfter = (await listTree("repo")).filter(rel => rel.includes("/pool/") || rel.includes("/Packages/"));
check("The rebuild kept every pool file", JSON.stringify(poolBefore2) === JSON.stringify(poolAfter), `${ poolAfter.length } files`);

// ---------------------------------------------------------------- real clients against this server, through Docker
const reach = spawnSync("docker", ["run", "--rm", "--network", "bridge", "fedora:42", "curl", "-fsS", "--max-time", "10", `http://host.docker.internal:${ port }/api/v1/status`], { encoding: "utf8" });
check("A container reaches the Windows-served repository", reach.status === 0, `${ reach.stdout ?? "" }${ reach.stderr ?? "" }`.trim().slice(0, 200));
if (reach.status === 0) {
    const clients = spawnSync("bash", [osPath.join(import.meta.dirname, "native-windows-clients.sh").split(osPath.sep).join("/"), osPath.join(work, "clients").split(osPath.sep).join("/"), String(port)], { encoding: "utf8" });
    for (const line of clients.stdout.split("\n").filter(l => /^(PASS|FAIL) /.test(l))) {
        check(`Client ${ line.slice(5) }`, line.startsWith("PASS"));
    }
    if (!/^PASS /m.test(clients.stdout)) check("Clients ran", false, `${ clients.stdout }${ clients.stderr }`.slice(-500));

    for (const [image, format, distribution, release] of [["debian:trixie", "deb", "debian", "trixie"], ["fedora:42", "rpm", "fedora", "42"]]) {
        const flow = spawnSync("docker", ["run", "--rm", "--network", "bridge", "-v", `${ osPath.join(import.meta.dirname, "agent-flow.sh") }:/agent-flow.sh:ro`, image,
            "bash", "/agent-flow.sh", `http://host.docker.internal:${ port }`, format, distribution, release, "srm-hello"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        check(`An agent on ${ image } installs from a download, then from the setup it gets`, flow.status === 0 && flow.stdout.includes("RESULT: ok"), `${ flow.stdout }${ flow.stderr }`.slice(-800));
    }
}

await kill();

// ---------------------------------------------------------------- wrong configuration
const refused = spawnSync(process.execPath, [osPath.join(repo, "server", "server.ts")], { cwd: work, env: { ...env, GPG_PUBLIC_KEYS_FILE: "missing.asc" }, encoding: "utf8", timeout: 60000 });
check("A configured key file that is missing refuses the start", refused.status !== 0 && refused.status !== null && `${ refused.stdout }${ refused.stderr }`.includes("GPG key file missing.asc does not exist"), `exit ${ refused.status }`);

// ---------------------------------------------------------------- the console closing
const consoleLog = osPath.join(work, "console.log");
const closing = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", osPath.join(import.meta.dirname, "native-windows-close.ps1"),
    "-CommandLine", `"${ process.execPath }" "${ osPath.join(repo, "server", "server.ts") }"`, "-ReadyUrl", `${ base }/api/v1/status`,
    "-Log", consoleLog], { cwd: work, env, encoding: "utf8", timeout: 120000 });
const consoleLines = existsSync(consoleLog)
    ? stripVTControlCharacters(await fs.readFile(consoleLog, "utf8")).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    : [];
check("Closing the console stops the server cleanly", closing.status === 0 && (consoleLines.at(-1)?.endsWith("Terminated") ?? false),
    `${ `${ closing.stdout }${ closing.stderr }`.trim() }; last line: ${ consoleLines.at(-1) ?? "none" }`.slice(0, 300));

const failed = results.filter(([ok]) => !ok);
console.log(`\n${ results.length - failed.length } passed, ${ failed.length } failed`);
for (const [, name] of failed) console.log(`  FAILED: ${ name }`);
process.exit(failed.length === 0 ? 0 : 1);
