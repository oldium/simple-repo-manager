import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { execFileSync } from "child_process";
import fs from "fs/promises";
import osPath from "path";
import { withLocalTmpDir } from "../utils.ts";
import { caseChecker, caseTwinProblem } from "../../server/backend/case-conflict.ts";
import { RepoValidationError } from "../../server/lib/errors.ts";
import { resetFileNaming, setFileNaming } from "../../server/lib/file-naming.ts";

const windowsTest = process.platform === "win32" ? test : test.skip;

const ROOT = osPath.resolve("Long Directory", "repo");
const BIN = "srm-hello-1.0-1.fc42.x86_64.rpm";
const BIN_IN_OTHER_CASE = "SRM-hello-1.0-1.fc42.x86_64.rpm";
const RPM_POOL = "rpm/fedora/42/Packages/s/srm-hello";
const DEB_POOL = "deb/debian/pool/main/s/srm-hello";
const DEB_FILE = "srm-hello_1.0-1_amd64.deb";
const DEB_FILE_IN_OTHER_CASE = "SRM-hello_1.0-1_amd64.deb";

function failure(code: string): Error {
    return Object.assign(new Error(code), { code });
}

function onVolume(relPath: string): string {
    return osPath.join(ROOT, ...relPath.split("/"));
}

function conflict(relPath: string, other: string): RepoValidationError {
    return new RepoValidationError(`${ relPath } differs only in case from ${ other }, which this file system cannot keep apart`);
}

/** Lists a case-insensitive volume holding the entries with their parents */
function volume(entries: string[]) {
    const listed = new Map<string, Set<string>>([[ROOT.toLowerCase(), new Set()]]);
    for (const entry of entries) {
        let dir = ROOT;
        for (const segment of entry.split("/")) {
            listed.get(dir.toLowerCase())!.add(segment);
            dir = osPath.join(dir, segment);
            if (!listed.has(dir.toLowerCase())) {
                listed.set(dir.toLowerCase(), new Set());
            }
        }
    }
    return jest.fn(async (dir: string): Promise<string[]> => {
        const names = listed.get(dir.toLowerCase());
        if (names === undefined) {
            throw failure("ENOENT");
        }
        return [...names];
    });
}

beforeEach(() => setFileNaming({ caseSensitive: false, shortNames: false }));
afterEach(resetFileNaming);

describe("Tests for the decision of one check", () => {
    test("Where case counts nothing is read and everything passes", async () => {
        setFileNaming({ caseSensitive: true, shortNames: false });
        const readdir = volume([`${ RPM_POOL }/${ BIN }`]);

        await caseChecker(ROOT, readdir)([`${ RPM_POOL }/${ BIN_IN_OTHER_CASE }`, `${ RPM_POOL }/${ BIN }`]);

        expect(readdir).not.toHaveBeenCalled();
    });

    test.each<[string, string, string]>([
        ["a pool file of rpm", `${ RPM_POOL }/${ BIN_IN_OTHER_CASE }`, `${ RPM_POOL }/${ BIN }`],
        ["a pool file of deb", `${ DEB_POOL }/${ DEB_FILE_IN_OTHER_CASE }`, `${ DEB_POOL }/${ DEB_FILE }`],
        ["a file at the root", BIN_IN_OTHER_CASE, BIN],
    ])("%s differing only in case is refused", async (_, relPath, existing) => {
        await expect(caseChecker(ROOT, volume([existing]))([relPath])).rejects.toStrictEqual(conflict(relPath, existing));
    });

    test.each([
        ["the same case", `${ RPM_POOL }/${ BIN }`, `${ RPM_POOL }/${ BIN }`],
        ["a new file next to others", `${ RPM_POOL }/srm-hello-doc-1.0-1.fc42.noarch.rpm`, `${ RPM_POOL }/${ BIN }`],
        ["a new release", `rpm/fedora/41/Packages/s/srm-hello/${ BIN }`, RPM_POOL],
        ["a new distribution", `deb/ubuntu/pool/universe/s/srm-hello/${ DEB_FILE }`, DEB_POOL],
        ["an empty tree", `${ DEB_POOL }/${ DEB_FILE }`, "unrelated"],
    ])("%s passes", async (_, relPath, existing) => {
        await caseChecker(ROOT, volume([existing]))([relPath]);
    });

    test.each([
        ["a format directory", `RPM/fedora/42/Packages/s/srm-hello/${ BIN }`],
        ["a distribution of rpm", `rpm/Fedora/42/Packages/s/srm-hello/${ BIN }`],
        ["a source directory of rpm", `rpm/fedora/42/Packages/s/SRM-hello/${ BIN }`],
        ["a distribution of deb", `deb/Debian/pool/main/s/srm-hello/${ DEB_FILE }`],
        ["a component of deb", `deb/debian/pool/Main/s/srm-hello/${ DEB_FILE }`],
    ])("%s in another case is no conflict", async (_, relPath) => {
        await caseChecker(ROOT, volume([`${ RPM_POOL }/${ BIN }`, `${ DEB_POOL }/${ DEB_FILE }`]))([relPath]);
    });

    test("A file name is still refused below a directory in another case, which the volume resolves", async () => {
        const relPath = `rpm/Fedora/42/Packages/s/srm-hello/${ BIN_IN_OTHER_CASE }`;

        await expect(caseChecker(ROOT, volume([`${ RPM_POOL }/${ BIN }`]))([relPath]))
            .rejects.toStrictEqual(conflict(relPath, `rpm/Fedora/42/Packages/s/srm-hello/${ BIN }`));
    });

    test("Only the directory of the target is read", async () => {
        const readdir = volume([`${ RPM_POOL }/${ BIN }`]);

        await caseChecker(ROOT, readdir)([`${ RPM_POOL }/${ BIN }`]);

        expect(readdir.mock.calls).toEqual([[onVolume(RPM_POOL)]]);
    });

    test("A name at the root reads the root", async () => {
        const readdir = volume([BIN]);

        await caseChecker(ROOT, readdir)([BIN]);

        expect(readdir.mock.calls).toEqual([[ROOT]]);
    });

    test.each(["ENOENT", "ENOTDIR"])("A directory that answers %s conflicts with nothing", async code => {
        const readdir = jest.fn(async (): Promise<string[]> => {
            throw failure(code);
        });

        await caseChecker(ROOT, readdir)([`${ RPM_POOL }/${ BIN }`]);

        expect(readdir).toHaveBeenCalledTimes(1);
    });

    test("Any other error is not taken for a missing path", async () => {
        const denied = failure("EACCES");
        const readdir = jest.fn(async (): Promise<string[]> => {
            throw denied;
        });

        await expect(caseChecker(ROOT, readdir)([`${ RPM_POOL }/${ BIN }`])).rejects.toBe(denied);
    });

    test("Two paths of one upload differing only in case are refused before anything is read", async () => {
        const readdir = volume([]);

        await expect(caseChecker(ROOT, readdir)([`${ DEB_POOL }/${ DEB_FILE }`, `${ DEB_POOL }/${ DEB_FILE_IN_OTHER_CASE }`]))
            .rejects.toStrictEqual(conflict(`${ DEB_POOL }/${ DEB_FILE_IN_OTHER_CASE }`, `${ DEB_POOL }/${ DEB_FILE }`));
        expect(readdir).not.toHaveBeenCalled();
    });

    test("Between paths of one call directories on the way count as well", () => {
        const paths = [`rpm/fedora/42/Packages/s/srm-hello/${ BIN }`, `rpm/fedora/42/Packages/s/SRM-hello/${ BIN }`];

        expect(caseTwinProblem(paths)).toBe(conflict("rpm/fedora/42/Packages/s/SRM-hello", "rpm/fedora/42/Packages/s/srm-hello").message);
        expect(caseTwinProblem([`rpm/fedora/42/${ BIN }`, `rpm/fedora/41/${ BIN }`, `rpm/fedora/42/${ BIN }`])).toBeUndefined();
    });

    test("Where case counts paths of one call never reach each other", () => {
        setFileNaming({ caseSensitive: true, shortNames: false });

        expect(caseTwinProblem([`${ RPM_POOL }/${ BIN }`, `${ RPM_POOL }/${ BIN_IN_OTHER_CASE }`])).toBeUndefined();
    });

    test("The same path twice is no conflict", async () => {
        await caseChecker(ROOT, volume([]))([`${ DEB_POOL }/${ DEB_FILE }`, `${ DEB_POOL }/${ DEB_FILE }`]);
    });

    test("A path the rules refuse does not reach the disk", async () => {
        const readdir = volume([]);

        await expect(caseChecker(ROOT, readdir)([`rpm/fedora/../${ BIN }`])).rejects.toThrow(RepoValidationError);

        expect(readdir).not.toHaveBeenCalled();
    });

    windowsTest("A path the Windows rules refuse does not reach the disk", async () => {
        const readdir = volume([]);

        await expect(caseChecker(ROOT, readdir)([`rpm/fedora/aux/${ BIN }`])).rejects.toThrow(RepoValidationError);

        expect(readdir).not.toHaveBeenCalled();
    });
});

describe("Tests for one checker over a run", () => {
    test("A directory is read once, also for the following paths", async () => {
        const readdir = volume([RPM_POOL]);
        const check = caseChecker(ROOT, readdir);

        await check([`${ RPM_POOL }/a.rpm`]);
        await check([`${ RPM_POOL }/b.rpm`]);
        await check([`${ RPM_POOL }/a.rpm`]);

        expect(readdir).toHaveBeenCalledTimes(1);
    });

    test("Each directory has its own listing", async () => {
        const readdir = volume([RPM_POOL]);
        const check = caseChecker(ROOT, readdir);

        await check([`${ RPM_POOL }/a.rpm`, `rpm/fedora/41/Packages/s/srm-hello/a.rpm`]);

        expect(readdir).toHaveBeenCalledTimes(2);
    });

    test("What passed counts as there, also in a directory that does not exist yet", async () => {
        const check = caseChecker(ROOT, volume(["rpm/fedora"]));
        const pool = "rpm/fedora/41/Packages/s/srm-hello";

        await check([`${ pool }/${ BIN }`]);

        await expect(check([`${ pool }/${ BIN_IN_OTHER_CASE }`])).rejects.toStrictEqual(conflict(`${ pool }/${ BIN_IN_OTHER_CASE }`, `${ pool }/${ BIN }`));
        await check([`${ pool }/other.rpm`]);
        await check([`${ pool }/${ BIN }`]);
    });

    test("A refused path leaves nothing behind", async () => {
        const check = caseChecker(ROOT, volume([`${ RPM_POOL }/${ BIN }`]));

        await expect(check([`rpm/fedora/41/${ BIN }`, `${ RPM_POOL }/${ BIN_IN_OTHER_CASE }`])).rejects.toThrow("differs only in case");

        await check([`rpm/fedora/41/${ BIN_IN_OTHER_CASE }`]);
    });

    test("Another checker reads the volume again", async () => {
        const readdir = volume([RPM_POOL]);

        await caseChecker(ROOT, readdir)([`${ RPM_POOL }/${ BIN }`]);
        await caseChecker(ROOT, readdir)([`${ RPM_POOL }/${ BIN }`]);

        expect(readdir).toHaveBeenCalledTimes(2);
    });
});

describe("Tests against a real directory", () => {
    function shortPath(file: string): string {
        return execFileSync("powershell", ["-NoProfile", "-Command", `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${ file }').ShortPath`], { encoding: "utf8" }).trim();
    }

    test("A directory on disk in another case is no conflict", withLocalTmpDir(async () => {
        await fs.mkdir(osPath.join("repo", "rpm", "fedora", "42"), { recursive: true });

        await caseChecker("repo")([`rpm/Fedora/42/${ BIN }`]);
        await caseChecker("repo")([`${ RPM_POOL }/${ BIN }`]);
    }));

    test("A file on disk conflicts under another case", withLocalTmpDir(async () => {
        await fs.mkdir(osPath.join("repo", ...RPM_POOL.split("/")), { recursive: true });
        await fs.writeFile(osPath.join("repo", ...RPM_POOL.split("/"), BIN), "x");

        await caseChecker("repo")([`${ RPM_POOL }/${ BIN }`]);
        await expect(caseChecker("repo")([`${ RPM_POOL }/${ BIN_IN_OTHER_CASE }`])).rejects.toStrictEqual(conflict(`${ RPM_POOL }/${ BIN_IN_OTHER_CASE }`, `${ RPM_POOL }/${ BIN }`));
    }));

    test("A file in the way of the path counts as nothing there", withLocalTmpDir(async () => {
        await fs.mkdir(osPath.join("repo", "rpm", "fedora"), { recursive: true });
        await fs.writeFile(osPath.join("repo", "rpm", "fedora", "42"), "x");

        await caseChecker("repo")([`rpm/fedora/42/${ BIN }`]);
    }));

    windowsTest.each(["rpm-data", "RPM", "rpm"])("Through a junction to a directory named %s only the file name counts", target => withLocalTmpDir(async () => {
        await fs.mkdir(osPath.join(target, "fedora", "42"), { recursive: true });
        await fs.mkdir("repo");
        await fs.symlink(osPath.resolve(target), osPath.join("repo", "rpm"), "junction");
        await fs.writeFile(osPath.join(target, "fedora", "42", BIN), "x");

        await caseChecker("repo")([`rpm/fedora/42/${ BIN }`]);
        await caseChecker("repo")(["rpm/fedora/42/other.rpm"]);
        await caseChecker("repo")(["rpm/Fedora/42/other.rpm"]);
        await caseChecker("repo")(["RPM/fedora/42/other.rpm"]);
        await expect(caseChecker("repo")([`rpm/fedora/42/${ BIN_IN_OTHER_CASE }`])).rejects.toStrictEqual(conflict(`rpm/fedora/42/${ BIN_IN_OTHER_CASE }`, `rpm/fedora/42/${ BIN }`));
        expect((await fs.readdir(".")).sort()).toEqual([target, "repo"].sort());
    })());

    windowsTest("A root in another case or through an 8.3 alias still finds the file", withLocalTmpDir(async () => {
        await fs.mkdir(osPath.join("Long Repository Name", "rpm"), { recursive: true });
        await fs.writeFile(osPath.join("Long Repository Name", "rpm", BIN), "x");
        const long = osPath.resolve("Long Repository Name");
        for (const root of ["LONG REPOSITORY NAME", long.toUpperCase(), shortPath(long)]) {
            await caseChecker(root)([`rpm/${ BIN }`]);
            await expect(caseChecker(root)([`rpm/${ BIN_IN_OTHER_CASE }`])).rejects.toStrictEqual(conflict(`rpm/${ BIN_IN_OTHER_CASE }`, `rpm/${ BIN }`));
        }
    }));
});
