import { jest } from "@jest/globals";
import { withLocalTmpDir } from "../utils.ts";
import { renameOverOpenFile } from "../../server/backend/win-rename.ts";
import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import { Database } from "node:sqlite";
import { openDatabase, SCHEMA_VERSION, transaction } from "../../server/backend/db.ts";
import { listFiles, moveFile, placeFile, removeQuietly, writeFileAtomic } from "../../server/backend/publish-fs.ts";
import { readdirQuietly } from "../../server/backend/gc.ts";
import logger from "../../server/lib/logger.ts";

const INSERT_RELEASE = "INSERT INTO releases (format, distro, name) VALUES ('deb', 'debian', 'trixie')";
const COUNT_RELEASES = "SELECT count(*) AS n FROM releases";

async function tempLeftovers(dir: string): Promise<string[]> {
    return (await fs.readdir(dir)).filter(name => name.includes(".tmp-"));
}

async function contentOf(handle: FileHandle): Promise<string> {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
}

function errno(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${ code }: simulated`), { code });
}

/** Runs fn as off Windows, where only the delete-and-rename fallback exists */
async function withoutWindowsRename(fn: () => Promise<void>): Promise<void> {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    try {
        await fn();
    } finally {
        Object.defineProperty(process, "platform", platform);
    }
}

const windowsTest = process.platform === "win32" ? test : test.skip;

describe("Tests for walking a directory", () => {
    // What each system can really hold; Node creates the Windows ones literally
    const UNREACHABLE = process.platform === "win32" ? ["aux", "dot.", "space "] : ["a\\b", "a\u0001b"];

    async function withUnreachable(): Promise<void> {
        await fs.mkdir("root/sub", { recursive: true });
        await fs.writeFile("root/sub/ok.txt", "x");
        for (const name of UNREACHABLE) {
            await fs.writeFile(`root/${ name }`, "x");
            await fs.mkdir(`root/sub/${ name }`);
            await fs.writeFile(`root/sub/${ name }/inside.txt`, "x");
        }
    }

    test("An entry no URL or repo-relative path can reach stays out of the walk", withLocalTmpDir(async () => {
        await withUnreachable();
        const warn = jest.spyOn(logger, "warn").mockImplementation(() => logger);
        try {
            expect(await listFiles("root")).toEqual(["sub/ok.txt"]);
            expect(warn).toHaveBeenCalledTimes(UNREACHABLE.length * 2);
            expect((await readdirQuietly("root")).map(entry => entry.name)).toEqual(["sub"]);
        } finally {
            warn.mockRestore();
        }
    }));

    test("A device name with an extension is an entry like any", withLocalTmpDir(async () => {
        await fs.mkdir("root");
        await fs.writeFile("root/con.txt", "x");
        await fs.writeFile("root/aux.tar.gz", "x");
        expect(await listFiles("root")).toEqual(["aux.tar.gz", "con.txt"]);
        expect((await readdirQuietly("root")).map(entry => entry.name).sort()).toEqual(["aux.tar.gz", "con.txt"]);
    }));

    test("Paths come back with forward slashes, in name order, and skip sees them too", withLocalTmpDir(async () => {
        await fs.mkdir("root/b/c", { recursive: true });
        await fs.mkdir("root/skipped", { recursive: true });
        await fs.writeFile("root/a.txt", "x");
        await fs.writeFile("root/b/c/d.txt", "x");
        await fs.writeFile("root/skipped/e.txt", "x");
        const seen: string[] = [];
        expect(await listFiles("root", dir => {
            seen.push(dir);
            return dir === "skipped";
        })).toEqual(["a.txt", "b/c/d.txt"]);
        expect(seen).toEqual(["b", "b/c", "skipped"]);
    }));

    test("A missing root lists nothing", withLocalTmpDir(async () => {
        expect(await listFiles("missing")).toEqual([]);
    }));
});

describe("Tests for openDatabase", () => {
    test("Creates schema version 1 with WAL and foreign keys", withLocalTmpDir(async () => {
        const db = openDatabase("repo.db");
        try {
            expect(SCHEMA_VERSION).toBe(1);
            expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
            expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
            expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
            expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
            expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
            expect(db.prepare("PRAGMA page_size").get()).toEqual({ page_size: 16384 });
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
                .map(row => row.name);
            expect(tables).toEqual([
                "deb_binaries", "deb_binary_paths", "deb_source_files", "deb_sources", "deb_upload_files",
                "deb_uploads", "dirty_keys", "index_chunks", "index_files", "pool_files", "releases",
                "rpm_packages", "staged_digests", "superseded_files",
            ]);
        } finally {
            db.close();
        }
    }));

    test("Enforces foreign keys", withLocalTmpDir(async () => {
        const db = openDatabase("repo.db");
        try {
            expect(() => db.prepare(`
                INSERT INTO deb_sources (release_id, component, source, version, sort_key, stanza)
                VALUES (999, 'main', 'srm-hello', '1.0-1', 'k', '')`).run()).toThrow(/FOREIGN KEY constraint failed/);
        } finally {
            db.close();
        }
    }));

    test("transaction commits and returns the result", withLocalTmpDir(async () => {
        const db = openDatabase("repo.db");
        try {
            expect(transaction(db, () => {
                db.prepare(INSERT_RELEASE).run();
                return 42;
            })).toBe(42);
            expect(db.isTransaction).toBe(false);
            expect(db.prepare(COUNT_RELEASES).get()).toEqual({ n: 1 });
        } finally {
            db.close();
        }
    }));

    test("transaction rolls back on throw", withLocalTmpDir(async () => {
        const db = openDatabase("repo.db");
        try {
            expect(() => transaction(db, () => {
                db.prepare(INSERT_RELEASE).run();
                throw new Error("boom");
            })).toThrow("boom");
            expect(db.isTransaction).toBe(false);
            expect(db.prepare(COUNT_RELEASES).get()).toEqual({ n: 0 });
        } finally {
            db.close();
        }
    }));

    test("Rejects a database newer than SCHEMA_VERSION", withLocalTmpDir(async () => {
        const raw = new Database("repo.db");
        raw.exec("PRAGMA user_version = 99");
        raw.close();
        expect(() => openDatabase("repo.db")).toThrow(/newer than supported/);
        const check = new Database("repo.db");
        try {
            expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: 99 });
        } finally {
            check.close();
        }
    }));

    test("Reopening keeps data and version", withLocalTmpDir(async () => {
        const first = openDatabase("repo.db");
        first.prepare(INSERT_RELEASE).run();
        first.close();

        const second = openDatabase("repo.db");
        try {
            expect(second.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
            expect(second.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
            expect(second.prepare("PRAGMA page_size").get()).toEqual({ page_size: 16384 });
            expect(second.prepare(COUNT_RELEASES).get()).toEqual({ n: 1 });
        } finally {
            second.close();
        }
    }));
});

describe("Tests for writeFileAtomic", () => {
    test("writeFileAtomic replaces an existing file", withLocalTmpDir(async () => {
        await fs.mkdir("dir");
        await fs.writeFile("dir/Release", "old");
        await writeFileAtomic("dir/Release", "new");
        expect(await fs.readFile("dir/Release", "utf8")).toBe("new");
        expect(await tempLeftovers("dir")).toEqual([]);
    }));

    test("writeFileAtomic creates a missing file from bytes", withLocalTmpDir(async () => {
        await writeFileAtomic("Packages.gz", new Uint8Array([0x1f, 0x8b, 0x08]));
        expect(await fs.readFile("Packages.gz")).toEqual(Buffer.from([0x1f, 0x8b, 0x08]));
        expect(await tempLeftovers(".")).toEqual([]);
    }));

    test("writeFileAtomic replaces a file a reader still holds open", withLocalTmpDir(async () => {
        await fs.writeFile("Release", "old");
        const reader = await fs.open("Release");
        try {
            await writeFileAtomic("Release", "new");

            expect(await fs.readFile("Release", "utf8")).toBe("new");
            expect(await contentOf(reader)).toBe("old");
        } finally {
            await reader.close();
        }
        expect(await tempLeftovers(".")).toEqual([]);
    }));

    test("Off Windows a canonical name is deleted and renamed again after EPERM", withLocalTmpDir(async () => {
        await fs.writeFile("stored", "new");
        await fs.writeFile("Release", "old");
        const spy = jest.spyOn(fs, "rename").mockRejectedValueOnce(errno("EPERM"));
        try {
            await withoutWindowsRename(() => placeFile("stored", "stored", ["Release"]));
            expect(spy).toHaveBeenCalledTimes(2);
        } finally {
            spy.mockRestore();
        }
        expect(await fs.readFile("Release", "utf8")).toBe("new");
        expect(await tempLeftovers(".")).toEqual([]);
    }));

    test("writeFileAtomic leaves the target alone on any other rename error", withLocalTmpDir(async () => {
        await fs.writeFile("Release", "old");
        const spy = jest.spyOn(fs, "rename").mockRejectedValueOnce(errno("EACCES"));
        try {
            await expect(writeFileAtomic("Release", "new")).rejects.toThrow(/EACCES/);
            expect(spy).toHaveBeenCalledTimes(1);
        } finally {
            spy.mockRestore();
        }
        expect(await fs.readFile("Release", "utf8")).toBe("old");
        expect(await tempLeftovers(".")).toEqual([]);
    }));

    test("writeFileAtomic fails and keeps the target when it cannot be deleted after EPERM", withLocalTmpDir(async () => {
        await fs.writeFile("Release", "old");
        const unlink = fs.unlink;
        const renameSpy = jest.spyOn(fs, "rename").mockRejectedValue(errno("EPERM"));
        const unlinkSpy = jest.spyOn(fs, "unlink").mockImplementation(async file => {
            if (file === "Release") {
                throw errno("EBUSY");
            }
            return unlink(file);
        });
        try {
            await withoutWindowsRename(() => expect(writeFileAtomic("Release", "new")).rejects.toThrow(/EBUSY/));
        } finally {
            renameSpy.mockRestore();
            unlinkSpy.mockRestore();
        }
        expect(await fs.readFile("Release", "utf8")).toBe("old");
        expect(await tempLeftovers(".")).toEqual([]);
    }));
});

describe("Tests for renameOverOpenFile", () => {
    windowsTest("Replaces an open file without the name ever going away", withLocalTmpDir(async () => {
        await fs.writeFile("Release", "old");
        const unlink = jest.spyOn(fs, "unlink");
        const reader = await fs.open("Release");
        try {
            await writeFileAtomic("Release", "new");

            expect(await fs.readFile("Release", "utf8")).toBe("new");
            expect(await contentOf(reader)).toBe("old");
            expect(unlink.mock.calls.filter(([file]) => file === "Release")).toEqual([]);
        } finally {
            unlink.mockRestore();
            await reader.close();
        }
    }));

    windowsTest("Takes a relative path and leaves no temp name when both are links to one file", withLocalTmpDir(async () => {
        await fs.writeFile("Packages.gz", "same");
        await fs.link("Packages.gz", "Packages.gz.link");

        expect(await renameOverOpenFile("Packages.gz.link", "Packages.gz")).toBe(true);

        expect(await fs.readdir(".")).toEqual(["Packages.gz"]);
        expect(await fs.readFile("Packages.gz", "utf8")).toBe("same");
    }));

    windowsTest("Answers false and changes nothing when it cannot rename", withLocalTmpDir(async () => {
        await fs.writeFile("source", "new");
        await fs.mkdir("directory");

        expect(await renameOverOpenFile("missing", "target")).toBe(false);
        expect(await renameOverOpenFile("source", "directory")).toBe(false);

        expect(await fs.readFile("source", "utf8")).toBe("new");
        expect((await fs.stat("directory")).isDirectory()).toBe(true);
    }));

    windowsTest("Loads node:ffi without printing its experimental warning", withLocalTmpDir(async () => {
        const warnings: string[] = [];
        const listener = (warning: Error) => warnings.push(warning.name);
        process.on("warning", listener);
        try {
            await fs.writeFile("source", "new");
            await renameOverOpenFile("source", "target");
            await new Promise(resolve => setImmediate(resolve));
        } finally {
            process.off("warning", listener);
        }
        expect(warnings).toEqual([]);
    }));
});

describe("Tests for placeFile", () => {
    test("placeFile links the canonical name to the stored file", withLocalTmpDir(async () => {
        await fs.mkdir("tmp");
        await fs.writeFile("tmp/upload", "stanza data");
        await placeFile("tmp/upload", "by-hash/SHA256/abc", ["by-hash/MD5Sum/def", "binary-amd64/Packages.gz"]);

        await expect(fs.stat("tmp/upload")).rejects.toThrow(/ENOENT/);
        expect(await fs.readFile("by-hash/SHA256/abc", "utf8")).toBe("stanza data");
        expect(await fs.readFile("by-hash/MD5Sum/def", "utf8")).toBe("stanza data");
        expect(await fs.readFile("binary-amd64/Packages.gz", "utf8")).toBe("stanza data");
        const stored = await fs.stat("by-hash/SHA256/abc");
        if (stored.nlink > 1) {
            expect((await fs.stat("by-hash/MD5Sum/def")).ino).toBe(stored.ino);
            expect((await fs.stat("binary-amd64/Packages.gz")).ino).toBe(stored.ino);
        }
        expect(await tempLeftovers("by-hash/MD5Sum")).toEqual([]);
        expect(await tempLeftovers("binary-amd64")).toEqual([]);
    }));

    test("placeFile keeps an existing identical stored file", withLocalTmpDir(async () => {
        await fs.mkdir("pool", { recursive: true });
        await fs.writeFile("pool/a_1.0_amd64.deb", "same bytes");
        const before = await fs.stat("pool/a_1.0_amd64.deb");
        await fs.writeFile("upload.deb", "same bytes");

        await placeFile("upload.deb", "pool/a_1.0_amd64.deb", []);

        await expect(fs.stat("upload.deb")).rejects.toThrow(/ENOENT/);
        const after = await fs.stat("pool/a_1.0_amd64.deb");
        expect(after.ino).toBe(before.ino);
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(await fs.readFile("pool/a_1.0_amd64.deb", "utf8")).toBe("same bytes");
    }));

    test("placeFile replaces a stored file of a different size", withLocalTmpDir(async () => {
        await fs.mkdir("pool");
        await fs.writeFile("pool/a.deb", "short");
        await fs.writeFile("upload.deb", "a longer upload");

        await placeFile("upload.deb", "pool/a.deb", []);

        await expect(fs.stat("upload.deb")).rejects.toThrow(/ENOENT/);
        expect(await fs.readFile("pool/a.deb", "utf8")).toBe("a longer upload");
    }));

    test("placeFile replaces a canonical name without touching its old target", withLocalTmpDir(async () => {
        await fs.mkdir("by-hash");
        await fs.writeFile("by-hash/old", "generation 1");
        await fs.link("by-hash/old", "Packages.gz");
        await fs.writeFile("upload", "generation 2");

        await placeFile("upload", "by-hash/new", ["Packages.gz"]);

        expect(await fs.readFile("Packages.gz", "utf8")).toBe("generation 2");
        expect(await fs.readFile("by-hash/old", "utf8")).toBe("generation 1");
        expect((await fs.stat("by-hash/old")).nlink).toBe(1);
    }));

    test("placeFile replaces a canonical name a reader still holds open", withLocalTmpDir(async () => {
        await fs.mkdir("by-hash");
        await fs.writeFile("by-hash/old", "generation 1");
        await fs.link("by-hash/old", "Packages.gz");
        await fs.writeFile("upload", "generation 2");
        const reader = await fs.open("Packages.gz");
        try {
            await placeFile("upload", "by-hash/new", ["Packages.gz"]);

            expect(await fs.readFile("Packages.gz", "utf8")).toBe("generation 2");
            expect(await contentOf(reader)).toBe("generation 1");
        } finally {
            await reader.close();
        }
        expect(await fs.readFile("by-hash/old", "utf8")).toBe("generation 1");
        expect(await tempLeftovers(".")).toEqual([]);
    }));

    test("placeFile removes a stale temp link before linking", withLocalTmpDir(async () => {
        await fs.writeFile(`Packages.gz.tmp-${ process.pid }`, "stale");
        await fs.writeFile("upload", "fresh");

        await placeFile("upload", "by-hash/new", ["Packages.gz"]);

        expect(await fs.readFile("Packages.gz", "utf8")).toBe("fresh");
        expect(await tempLeftovers(".")).toEqual([]);
    }));

    test("placeFile removes its temp link when the canonical rename fails", withLocalTmpDir(async () => {
        await fs.mkdir("Packages.gz/nested", { recursive: true });
        await fs.writeFile("Packages.gz/nested/file", "a directory sits on the canonical name");
        await fs.writeFile("upload", "fresh");

        await expect(placeFile("upload", "by-hash/new", ["Packages.gz"])).rejects.toThrow();

        expect(await fs.readFile("by-hash/new", "utf8")).toBe("fresh");
        expect(await tempLeftovers(".")).toEqual([]);
    }));

    test("placeFile only links when the stored file is the temp file", withLocalTmpDir(async () => {
        await fs.mkdir("by-hash");
        await fs.writeFile("by-hash/abc", "already stored");

        await placeFile("by-hash/abc", "by-hash/abc", ["Packages.gz"]);

        expect(await fs.readFile("by-hash/abc", "utf8")).toBe("already stored");
        expect(await fs.readFile("Packages.gz", "utf8")).toBe("already stored");
    }));

    test("placeFile places the same stored file twice without leaving a temp link", withLocalTmpDir(async () => {
        await fs.mkdir("tmp");
        await fs.writeFile("tmp/first", "same bytes");
        await fs.writeFile("tmp/second", "same bytes");
        await placeFile("tmp/first", "by-hash/SHA256/abc", ["by-hash/MD5Sum/def", "Packages.gz"]);
        const before = await fs.stat("by-hash/SHA256/abc");

        await placeFile("tmp/second", "by-hash/SHA256/abc", ["by-hash/MD5Sum/def", "Packages.gz"]);
        await placeFile("by-hash/SHA256/abc", "by-hash/SHA256/abc", ["Packages.gz"]);

        await expect(fs.stat("tmp/second")).rejects.toThrow(/ENOENT/);
        expect((await fs.stat("by-hash/SHA256/abc")).ino).toBe(before.ino);
        expect(await fs.readdir("by-hash/MD5Sum")).toEqual(["def"]);
        expect((await fs.readdir(".")).sort()).toEqual(["Packages.gz", "by-hash", "tmp"]);
        expect(await fs.readFile("by-hash/MD5Sum/def", "utf8")).toBe("same bytes");
        expect(await fs.readFile("Packages.gz", "utf8")).toBe("same bytes");
        if (before.nlink > 1) {
            expect((await fs.stat("by-hash/SHA256/abc")).nlink).toBe(3);
        }
    }));
});

describe("Moves across volumes and over open files", () => {
    /** Runs fn with every rename of the given source failing as on another volume */
    async function acrossVolumes(source: string, fn: () => Promise<void>): Promise<void> {
        const rename = fs.rename;
        const spy = jest.spyOn(fs, "rename").mockImplementation(async (from, to) => {
            if (from === source) {
                throw errno("EXDEV");
            }
            return rename(from, to);
        });
        try {
            await fn();
        } finally {
            spy.mockRestore();
        }
    }

    test("placeFile moves the temp file from another volume", withLocalTmpDir(async () => {
        await fs.writeFile("upload", "from the state directory");

        await acrossVolumes("upload", () => placeFile("upload", "by-hash/new", ["Packages.gz"]));

        await expect(fs.stat("upload")).rejects.toThrow(/ENOENT/);
        expect(await fs.readFile("by-hash/new", "utf8")).toBe("from the state directory");
        expect(await fs.readFile("Packages.gz", "utf8")).toBe("from the state directory");
        expect(await tempLeftovers("by-hash")).toEqual([]);
    }));

    test("moveFile replaces the temp file a crashed move left and uses its place, whatever process that was", withLocalTmpDir(async () => {
        await fs.writeFile("upload", "whole");
        await fs.writeFile("target.tmp-0", "half");

        await acrossVolumes("upload", () => moveFile("upload", "target"));

        expect(await fs.readFile("target", "utf8")).toBe("whole");
        expect(await tempLeftovers(".")).toEqual([]);
        await expect(fs.stat("upload")).rejects.toThrow(/ENOENT/);
    }));

    test("A move on one volume needs no temp file", withLocalTmpDir(async () => {
        await fs.writeFile("upload", "whole");

        await moveFile("upload", "target");

        expect(await fs.readFile("target", "utf8")).toBe("whole");
        expect(await tempLeftovers(".")).toEqual([]);
    }));

    test("moveFile replaces a target a reader still holds open", withLocalTmpDir(async () => {
        await fs.writeFile("upload", "new");
        await fs.writeFile("target", "old");
        const reader = await fs.open("target");
        try {
            await moveFile("upload", "target");

            expect(await fs.readFile("target", "utf8")).toBe("new");
            expect(await contentOf(reader)).toBe("old");
        } finally {
            await reader.close();
        }
        await expect(fs.stat("upload")).rejects.toThrow(/ENOENT/);
    }));

    test("moveFile from another volume replaces a target a reader still holds open", withLocalTmpDir(async () => {
        await fs.writeFile("upload", "new");
        await fs.writeFile("target", "old");
        const reader = await fs.open("target");
        try {
            await acrossVolumes("upload", () => moveFile("upload", "target"));

            expect(await fs.readFile("target", "utf8")).toBe("new");
            expect(await contentOf(reader)).toBe("old");
        } finally {
            await reader.close();
        }
        await expect(fs.stat("upload")).rejects.toThrow(/ENOENT/);
        expect(await tempLeftovers(".")).toEqual([]);
    }));
});

describe("Tests for removeQuietly", () => {
    test("removeQuietly removes a file and ignores a missing one", withLocalTmpDir(async () => {
        await fs.writeFile("file", "x");
        await removeQuietly("file");
        await expect(fs.stat("file")).rejects.toThrow(/ENOENT/);
        await expect(removeQuietly("file")).resolves.toBeUndefined();
    }));

    test("removeQuietly reports other errors", withLocalTmpDir(async () => {
        await fs.mkdir("dir");
        await expect(removeQuietly("dir")).rejects.toThrow();
    }));
});
