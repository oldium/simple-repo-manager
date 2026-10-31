import { jest } from "@jest/globals";
import crypto from "crypto";
import fs from "fs";
import osPath from "path";
import { Database } from "node:sqlite";
import { getBackend } from "../../server/backend/index.ts";
import logger from "../../server/lib/logger.ts";
import createTestApp from "../testapp.ts";
import { uploadFileByPost, uploadFileByPut, uploadFileByPutRawIncomplete, waitForAssertion, withLocalTmpDir } from "../utils.ts";

type StagedRow = { rel_path: string; size: number; mtime_ms: number; md5: string; sha1: string; sha256: string; sha512: string };

const PATHS = { incomingDir: "incoming", repoStateDir: "repo-state" };

function stagedRows(): StagedRow[] {
    const db = new Database(osPath.join(PATHS.repoStateDir, "repo.db"), { readOnly: true });
    try {
        return db.prepare("SELECT rel_path, size, mtime_ms, md5, sha1, sha256, sha512 FROM staged_digests ORDER BY rel_path")
            .all() as StagedRow[];
    } finally {
        db.close();
    }
}

function digest(name: string, content: Buffer): string {
    return crypto.createHash(name).update(content).digest("hex");
}

/** The row the upload must have recorded: digests of the content, size and mtime of the file where it was staged */
function expectedRow(relPath: string, content: Buffer): StagedRow {
    const stat = fs.statSync(osPath.join(PATHS.incomingDir, "staging", ...relPath.split("/")));
    return {
        rel_path: relPath, size: content.length, mtime_ms: Math.trunc(stat.mtimeMs),
        md5: digest("md5", content), sha1: digest("sha1", content), sha256: digest("sha256", content), sha512: digest("sha512", content),
    };
}

function byRelPath(a: StagedRow, b: StagedRow): number {
    return a.rel_path < b.rel_path ? -1 : a.rel_path > b.rel_path ? 1 : 0;
}

describe("Checksums recorded during upload", () => {
    test("PUT records size and four checksums for the staged file", withLocalTmpDir(async () => {
        // A size limit puts the limiting stream in front of the hashing one
        const app = await createTestApp({ paths: PATHS, upload: { sizeLimit: 1024 * 1024 } });
        const rel = "deb/debian/trixie/main/srm-hello_1.0-1_amd64.deb";
        const content = crypto.randomBytes(300 * 1024);

        const res = await uploadFileByPut(app, `/api/v1/upload/${ rel }`, content);

        expect(res.status).toBe(201);
        expect(stagedRows()).toEqual([expectedRow(rel, content)]);
    }));

    test("Re-PUT of the same name replaces the row", withLocalTmpDir(async () => {
        const app = await createTestApp({ paths: PATHS });
        const rel = "rpm/fedora/42/srm-hello-1.0-1.fc42.x86_64.rpm";
        const first = crypto.randomBytes(2048);
        const second = crypto.randomBytes(1000);

        expect((await uploadFileByPut(app, `/api/v1/upload/${ rel }`, first)).status).toBe(201);
        const before = stagedRows();
        expect((await uploadFileByPut(app, `/api/v1/upload/${ rel }`, second)).status).toBe(201);

        expect(before).toHaveLength(1);
        expect(before[0]).toMatchObject({ rel_path: rel, size: first.length, sha256: digest("sha256", first) });
        expect(stagedRows()).toEqual([expectedRow(rel, second)]);
    }));

    test("Two parts of one POST under one name stay apart until staged", withLocalTmpDir(async () => {
        const app = await createTestApp({ paths: PATHS });
        const name = "srm-hello-1.0-1.fc42.x86_64.rpm";
        const rel = `rpm/fedora/42/${ name }`;
        const contents = [crypto.randomBytes(200 * 1024), crypto.randomBytes(200 * 1024)];

        const res = await uploadFileByPost(app, "/api/v1/upload/rpm/fedora/42", contents.map(content => ({ name, content })));

        expect(res.status).toBe(201);
        const staged = fs.readFileSync(osPath.join(PATHS.incomingDir, "staging", ...rel.split("/")));
        expect(contents).toContainEqual(staged);
        expect(stagedRows()).toEqual([expectedRow(rel, staged)]);
    }));

    test("A long name goes through PUT and POST", withLocalTmpDir(async () => {
        const app = await createTestApp({ paths: PATHS });
        const content = crypto.randomBytes(100);
        const name = (extra: string) => `${ "a".repeat(236) }${ extra }.rpm`;

        expect((await uploadFileByPut(app, `/api/v1/upload/rpm/fedora/42/${ name("") }`, content)).status).toBe(201);
        expect((await uploadFileByPost(app, "/api/v1/upload/rpm/fedora/41", [{ name: name(""), content }])).status).toBe(201);
    }));

    test("POST records checksums for every uploaded file", withLocalTmpDir(async () => {
        const app = await createTestApp({ paths: PATHS });
        const files = [
            { name: "srm-hello_1.0-1_amd64.deb", content: crypto.randomBytes(150 * 1024) },
            { name: "srm-hello_1.0-1.dsc", content: crypto.randomBytes(700) },
            { name: "srm-hello_1.0-1_amd64.changes", content: crypto.randomBytes(1500) },
        ];

        const res = await uploadFileByPost(app, "/api/v1/upload/deb/debian/trixie/main", files);

        expect(res.status).toBe(201);
        expect(stagedRows()).toEqual(files.map(f => expectedRow(`deb/debian/trixie/main/${ f.name }`, f.content)).sort(byRelPath));
    }));

    test("Upload still succeeds when recording the checksums fails", withLocalTmpDir(async () => {
        const app = await createTestApp({ paths: PATHS });
        const recordSpy = jest.spyOn(getBackend(PATHS.repoStateDir), "recordStagedDigest")
            .mockImplementation(() => { throw new Error("database closed"); });
        const warnSpy = jest.spyOn(logger, "warn").mockReturnValue(logger);
        try {
            const uploads: [string, Buffer][] = [
                ["deb/debian/trixie/main/srm-hello_1.0-1_amd64.deb", crypto.randomBytes(1024)],
                ["rpm/fedora/42/srm-hello-1.0-1.fc42.x86_64.rpm", crypto.randomBytes(1024)],
            ];
            const [[putRel, putContent], [postRel, postContent]] = uploads;

            expect((await uploadFileByPut(app, `/api/v1/upload/${ putRel }`, putContent)).status).toBe(201);
            expect((await uploadFileByPost(app, `/api/v1/upload/${ osPath.posix.dirname(postRel) }`,
                [{ name: osPath.posix.basename(postRel), content: postContent }])).status).toBe(201);

            expect(recordSpy).toHaveBeenCalledTimes(2);
            for (const [rel, content] of uploads) {
                const staged = osPath.join(PATHS.incomingDir, "staging", ...rel.split("/"));
                expect(fs.readFileSync(staged)).toEqual(content);
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(staged), { err: expect.any(Error) });
            }
            expect(stagedRows()).toEqual([]);
            expect(fs.readdirSync(osPath.join(PATHS.incomingDir, "tmp"))).toHaveLength(0);
        } finally {
            jest.restoreAllMocks();
        }
    }));

    test("Concurrent uploads of one name record the digests of the file that stays", withLocalTmpDir(async () => {
        const app = await createTestApp({ paths: PATHS });
        const rel = "deb/debian/trixie/main/srm-hello_1.0-1_amd64.deb";
        const staged = osPath.join(PATHS.incomingDir, "staging", ...rel.split("/"));
        const first = crypto.randomBytes(4096);
        const second = crypto.randomBytes(2048);

        // Holds the first upload between its move and its stat: the window the second upload's move must stay out of
        const release = Promise.withResolvers<void>();
        let held = false;
        const originalStat = fs.promises.stat;
        const statSpy = jest.spyOn(fs.promises, "stat").mockImplementation((async (p: fs.PathLike, opts?: fs.StatOptions) => {
            if (!held && p === staged) {
                held = true;
                await release.promise;
            }
            return originalStat(p, opts);
        }) as typeof fs.promises.stat);
        try {
            const a = uploadFileByPut(app, `/api/v1/upload/${ rel }`, first).then(res => res.status);
            await waitForAssertion(() => expect(held).toBe(true), 5_000);
            const b = uploadFileByPut(app, `/api/v1/upload/${ rel }`, second).then(res => res.status);
            // Lets the second upload misbehave, were it not serialized behind the first one
            await Promise.race([b, new Promise(resolve => setTimeout(resolve, 200))]);
            release.resolve();
            expect(await a).toBe(201);
            expect(await b).toBe(201);
        } finally {
            statSpy.mockRestore();
        }

        expect(fs.readFileSync(staged)).toEqual(second);
        expect(stagedRows()).toEqual([expectedRow(rel, second)]);
    }));

    test("No row is recorded for an upload over the size limit or aborted", withLocalTmpDir(async () => {
        const app = await createTestApp({ paths: PATHS, upload: { sizeLimit: 100 * 1024 } });
        const tooBig = Buffer.alloc(200 * 1024, "A");

        expect((await uploadFileByPost(app, "/api/v1/upload/deb/debian/trixie/main",
            [{ name: "largefile.deb", content: tooBig }])).status).toBe(413);
        expect((await uploadFileByPut(app, "/api/v1/upload/rpm/fedora/42/largefile.rpm", tooBig)).status).toBe(413);

        const putHeaders = [
            "PUT /api/v1/upload/rpm/fedora/42/aborted.rpm HTTP/1.1",
            "Host: localhost",
            `Content-Length: ${ 400 * 1024 }`,
            "Content-Type: application/octet-stream",
            "Connection: close",
            "",
            "",
        ].join("\r\n");
        await uploadFileByPutRawIncomplete(app, putHeaders, Buffer.alloc(50 * 1024, "A"));

        const boundary = "srm-upload-boundary";
        const postHeaders = [
            "POST /api/v1/upload/deb/debian/trixie/main HTTP/1.1",
            "Host: localhost",
            `Content-Type: multipart/form-data; boundary=${ boundary }`,
            `Content-Length: ${ 400 * 1024 }`,
            "Connection: close",
            "",
            "",
        ].join("\r\n");
        const part = `--${ boundary }\r\nContent-Disposition: form-data; name="package"; filename="aborted.deb"\r\n` +
            "Content-Type: application/octet-stream\r\n\r\n";
        await uploadFileByPutRawIncomplete(app, postHeaders, Buffer.concat([Buffer.from(part), Buffer.alloc(50 * 1024, "A")]));

        await waitForAssertion(() => {
            expect(fs.readdirSync(osPath.join(PATHS.incomingDir, "tmp"))).toHaveLength(0);
        });
        for (const rel of ["deb/debian/trixie/main/largefile.deb", "rpm/fedora/42/largefile.rpm", "rpm/fedora/42/aborted.rpm",
            "deb/debian/trixie/main/aborted.deb"]) {
            expect(osPath.join(PATHS.incomingDir, "staging", ...rel.split("/"))).not.toPathExist();
        }
        expect(stagedRows()).toEqual([]);
    }));
});
