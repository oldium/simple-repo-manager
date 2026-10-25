import { withLocalTmpDir } from "../utils.ts";
import fs from "fs/promises";
import { Access, checkAccess } from "../../server/lib/fs.ts";

// Root and Windows ignore the permission bits
const canDeny = process.platform !== "win32" && process.getuid?.() !== 0;

describe("Tests for checkAccess", () => {
    test("Accepts a readable file", withLocalTmpDir(async () => {
        await fs.writeFile("file.txt", "content");
        expect(await checkAccess("Test file", "file.txt", Access.ReadOnly)).toBeUndefined();
    }));

    test("Accepts a writable directory", withLocalTmpDir(async () => {
        expect(await checkAccess("Test directory", ".", Access.Writable)).toBeUndefined();
    }));

    test("Accepts a missing directory in a writable directory", withLocalTmpDir(async () => {
        expect(await checkAccess("Test directory", "missing/nested", Access.Creatable)).toBeUndefined();
    }));

    test("Reports a missing file with the error code", withLocalTmpDir(async () => {
        expect(await checkAccess("Test file", "missing.txt", Access.ReadOnly))
            .toMatch(/^Test file .*missing\.txt is not readable for .*: ENOENT$/);
    }));

    (canDeny ? test : test.skip)("Reports a read-only directory with its owner and mode",
        withLocalTmpDir(async () => {
            await fs.mkdir("dir", { mode: 0o555 });
            try {
                expect(await checkAccess("Test directory", "dir", Access.Writable))
                    .toMatch(/ is not writable for UID \d+, GID \d+ \(owner \d+:\d+, mode 0555\): EACCES$/);
            } finally {
                await fs.chmod("dir", 0o755);
            }
        }));

    (canDeny ? test : test.skip)("Reports the read-only parent of a missing directory",
        withLocalTmpDir(async () => {
            await fs.mkdir("dir", { mode: 0o555 });
            try {
                expect(await checkAccess("Test directory", "dir/missing/nested", Access.Creatable))
                    .toMatch(new RegExp("^Test directory .*dir/missing/nested cannot be created, directory .*dir " +
                        "is not writable for UID \\d+, GID \\d+ \\(owner \\d+:\\d+, mode 0555\\): EACCES$"));
            } finally {
                await fs.chmod("dir", 0o755);
            }
        }));
});
