import type { Application } from "express";
import request from "supertest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import osPath from "path";
import { fileURLToPath } from "url";
import createTestApp from "./testapp.ts";
import { uploadFileByPut } from "./utils.ts";

const FIXTURES = fileURLToPath(new URL("fixtures/", import.meta.url));
const TRIXIE = "deb/debian/trixie/main";

/** The sorted file names in tests/fixtures/<dir> */
export async function fixtureNames(dir: string): Promise<string[]> {
    const entries = await fs.readdir(osPath.join(FIXTURES, ...dir.split("/")), { withFileTypes: true });
    return entries.filter(e => e.isFile()).map(e => e.name).sort();
}

/** The content of tests/fixtures/<file> */
export function readFixture(file: string): Promise<Buffer> {
    return fs.readFile(osPath.join(FIXTURES, ...file.split("/")));
}

/** PUTs tests/fixtures/<tree>/<upload path>, e.g. "packages/rpm/fedora/42/<name>", to that upload path or into uploadDir */
export async function uploadFixtureFile(app: Application, file: string, uploadDir?: string): Promise<void> {
    const [, ...uploadPath] = file.split("/");
    const url = `/api/v1/upload/${ uploadDir === undefined ? uploadPath.join("/") : `${ uploadDir }/${ uploadPath.at(-1) }` }`;
    const res = await uploadFileByPut(app, url, await readFixture(file));
    if (res.status !== 201) {
        throw new Error(`PUT ${ url } answered ${ res.status }: ${ res.text }`);
    }
}

/** PUTs every file under tests/fixtures/<dir>, where dir is a fixture tree or a directory below one */
export async function uploadFixtureTree(app: Application, dir: string): Promise<void> {
    const entries = await fs.readdir(osPath.join(FIXTURES, ...dir.split("/")), { recursive: true, withFileTypes: true });
    const files = entries.filter(e => e.isFile())
        .map(e => osPath.relative(FIXTURES, osPath.join(e.parentPath, e.name)).split(osPath.sep).join("/"))
        .sort();
    for (const file of files) {
        await uploadFixtureFile(app, file);
    }
}

/** Uploads tests/fixtures/<dir> and imports it through REST */
export async function importFixtures(app: Application, dir: string): Promise<void> {
    await uploadFixtureTree(app, dir);
    const res = await request(app).post("/api/v1/repo/import");
    if (res.status !== 200) {
        throw new Error(`Import of ${ dir } answered ${ res.status }: ${ res.text }`);
    }
}

export async function importedApp(dir: string): Promise<Application> {
    const app = await createTestApp();
    await importFixtures(app, dir);
    return app;
}

/** A source-only srm-hello 1.0-2 whose .dsc reuses the 1.0-1 orig tarball without uploading it again; returns its file names */
export async function uploadSecondVersion(app: Application, release = "trixie"): Promise<string[]> {
    const dsc = (await readFixture(`packages/${ TRIXIE }/srm-hello_1.0-1.dsc`)).toString("utf8")
        .replace("Version: 1.0-1", "Version: 1.0-2")
        .replaceAll("srm-hello_1.0-1.debian.tar.xz", "srm-hello_1.0-2.debian.tar.xz");
    const files: [string, Buffer][] = [
        ["srm-hello_1.0-2.dsc", Buffer.from(dsc)],
        ["srm-hello_1.0-2.debian.tar.xz", await readFixture(`packages/${ TRIXIE }/srm-hello_1.0-1.debian.tar.xz`)],
    ];
    const hash = (algorithm: string, content: Buffer): string => crypto.createHash(algorithm).update(content).digest("hex");
    const changes = [
        "Source: srm-hello", "Version: 1.0-2", `Distribution: ${ release }`, "Architecture: source",
        "Checksums-Sha256:", ...files.map(([name, content]) => ` ${ hash("sha256", content) } ${ content.length } ${ name }`),
        "Files:", ...files.map(([name, content]) => ` ${ hash("md5", content) } ${ content.length } utils optional ${ name }`),
        "",
    ].join("\n");
    files.push(["srm-hello_1.0-2_source.changes", Buffer.from(changes)]);
    for (const [name, content] of files) {
        const url = `/api/v1/upload/deb/debian/${ release }/main/${ name }`;
        const res = await uploadFileByPut(app, url, content);
        if (res.status !== 201) {
            throw new Error(`PUT ${ url } answered ${ res.status }: ${ res.text }`);
        }
    }
    return files.map(([name]) => name);
}
