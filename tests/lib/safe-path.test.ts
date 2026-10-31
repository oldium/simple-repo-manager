import { afterEach, describe, expect, test } from "@jest/globals";
import { execFileSync } from "child_process";
import fs from "fs/promises";
import osPath from "path";
import { fileURLToPath } from "url";
import { withLocalTmpDir } from "../utils.ts";
import { parseControl, parseFileList, stripClearsign } from "../../server/backend/control.ts";
import { binarySource, requiredField } from "../../server/backend/deb/stanzas.ts";
import { checkPosixPath, segmentProblem, segmentsProblem, toOsPath, toPosixPath, urlPathProblem } from "../../server/lib/safe-path.ts";
import { checkFileName, checkSafeName, checkVersion } from "../../server/backend/staging.ts";
import { RepoValidationError } from "../../server/lib/errors.ts";
import { resetFileNaming, setFileNaming } from "../../server/lib/file-naming.ts";
import { validateFilename } from "../../server/lib/validations.ts";

const windowsTest = process.platform === "win32" ? test : test.skip;

afterEach(resetFileNaming);

const DEVICES = ["con", "prn", "aux", "nul", "conin$", "conout$",
    ...[..."0123456789¹²³"].flatMap(digit => [`com${ digit }`, `lpt${ digit }`])];

const CASES = (name: string): string[] => [name, name.toUpperCase(), name[0].toUpperCase() + name.slice(1)];

// Only the full name is reserved: with an extension these are ordinary files on Windows 11
const RESERVED = DEVICES.flatMap(device => CASES(device).flatMap(name => [name, `${ name } `]));
const WITH_EXTENSION = DEVICES.flatMap(device => CASES(device).flatMap(name => [`${ name }.txt`, `${ name }.tar.gz`, `${ name }.deb`, `${ name }.rpm`, `${ name }.a.b`]));

const WINDOWS_REFUSED = ['a"b', "a*b", "a:b", "a<b", "a>b", "a?b", "a|b", "C:", "c:", "Release::$DATA", ".env::$DATA", "Release:$DATA", "Release:stream",
    "foo.", "foo..", "foo ", "foo. ", "foo .", " ", ...DEVICES.flatMap(CASES).map(name => `${ name }.`), "con. ", "con.txt.", "con.txt "];

const SHORT_NAMES = ["FOO~1.RPM", "foo~1.rpm", "git~1", "GIT~1", "RELEAS~1", "INRELE~1.TXT", "HIDDEN~1", "a~1", "abcdef~1", "abcdef~1.abc", "abc~123", "a-b_c~99.x", "~1", "a~b~1",
    // What NTFS really generated: lossy characters, hashes after collisions, a tilde kept from the long name, and each character it keeps
    "AB_1~1.DSC", "ab_1~1.dsc", "abcd_1~1.dsc", "ABCDE~12", "ABCD~100", "a~123456", "A~1234~1.TXT", "AB_C~1~1.DSC", "_E264~1.TXT", "CBB1~1.TXT", "12A99A~1.3", "FOOTAR~1.GZ", "LO48D8~1.TXT",
    "A!BCDE~1.TXT", "A#BCDE~1.TXT", "A$BCDE~1.TXT", "A%BCDE~1.TXT", "A&BCDE~1.TXT", "A'BCDE~1.TXT", "A(BCDE~1.TXT", "A)BCDE~1.TXT", "A-BCDE~1.TXT", "A@BCDE~1.TXT", "A^BCDE~1.TXT", "A_BCDE~1.TXT", "A`BCDE~1.TXT", "A{BCDE~1.TXT", "A}BCDE~1.TXT", "A~BCDE~1.TXT"];

// Close to a short name without being one, and the real names around them
const NOT_SHORT_NAMES = ["srm-hello_1.0~1_amd64.deb", "1.0~rc1", "1.0~1", "clevis_22~rc1-1_amd64.deb", "abcdefg~1", "abcdef~1.abcd", "foo~", "foo~a", "foo~1a", "foo~1.a.b", "a.b~1", "~", "~a", "foo~1-1.deb",
    // A base over 8, a number NTFS never starts from, characters it never keeps
    "abcdef~12", "abcde~123", "abcd_11~1.dsc", "x~0", "x~0.dsc", "ab_1~0.dsc", "ab~01.dsc", "a+b~1.dsc", "a,b~1", "a;b~1", "a=b~1", "a[b~1", "a]b~1", "a b~1", "é~1", "日~1", "foo~1.a+b", "foo~1.é", "foo~1.t x"];

const EVERY_OS_REFUSED = ["", ".", "..", "...", "....", "..........", "a/b", "/", "a\\b", "\\", "\\\\server\\share", "..\\", "..\\..\\x", "C:\\Windows", "\0", "a\0b", "con\0", "\t", "a\nb",
    "\u0001", "\u001f", "\u007f", "a\u0085b"];

// Real names, and close to a reserved one without being it
const ANY_OS_ACCEPTED = ["srm-hello_1.0-1_amd64.deb", "srm-hello_1.0.orig.tar.gz", "clevis-pkcs11-dbgsym_22-1+tpm1u0+deb13_amd64.deb", "1.0~rc1", "libstdc++6", "..foo", "..hidden.deb",
    ".well-known", "by-hash", "Release", "console", "control", "auxiliary", "aux1", "aux-1.0-1.x86_64.rpm", "aux_1.0_all.deb", "con-1.0.tar.gz", "a.con", "null", "nul-1", "com10", "lpt10", "com", "lpt",
    "comx", "com⁴", "lpt⁰", "..%5C", "..%2F", "%00", "con$", "conin", "a b", " con", "ünï", ".env", ".hidden", "...foo", ".a.b", ...NOT_SHORT_NAMES];

const FIXTURE_ROOTS = ["packages", "packages-arm64", "packages-udeb"].map(name => fileURLToPath(new URL(`../fixtures/${ name }/`, import.meta.url)));
const TEST_DATA_ROOTS = ["packages-initial", "packages-update"].map(name => osPath.resolve(fileURLToPath(new URL("../../../test-data/", import.meta.url)), name));

async function filesBelow(root: string): Promise<string[]> {
    const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
    return entries.filter(entry => entry.isFile()).map(entry => osPath.join(entry.parentPath, entry.name));
}

describe("Tests for the segment rules", () => {
    test.each(RESERVED)("Windows refuses %j as a device name", name => {
        expect(segmentProblem(name, "win32")).toBe(`${ JSON.stringify(name) } is a reserved name on Windows`);
    });

    test.each(RESERVED)("Linux keeps %j", name => {
        expect(segmentProblem(name, "linux")).toBeUndefined();
    });

    test.each(WITH_EXTENSION)("With an extension %j passes on any OS", name => {
        expect(segmentProblem(name, "win32")).toBeUndefined();
        expect(segmentProblem(name, "linux")).toBeUndefined();
    });

    test.each(["con.tar.gz", "CON.txt", "aux.deb", "nul.txt", "com1.rpm", "lpt1.a.b"])("%s is an ordinary file on Windows", name => {
        expect(segmentProblem(name, "win32")).toBeUndefined();
    });

    test.each(WINDOWS_REFUSED)("Windows refuses %j for its characters or ending", name => {
        expect(segmentProblem(name, "win32")).toMatch(/holds a character or an ending that Windows refuses in a file name$/);
    });

    test.each(SHORT_NAMES)("Windows refuses %j for the shape of a short name", name => {
        expect(segmentProblem(name, "win32")).toBe(`${ JSON.stringify(name) } has the shape of a Windows 8.3 short name`);
    });

    test.each(SHORT_NAMES)("Linux keeps %j", name => {
        expect(segmentProblem(name, "linux")).toBeUndefined();
    });

    test.each(WINDOWS_REFUSED)("Linux keeps %j", name => {
        expect(segmentProblem(name, "linux")).toBeUndefined();
    });

    describe.each(["win32", "linux"] as const)("On %s", platform => {
        test.each(EVERY_OS_REFUSED)("Refuses %j", name => {
            expect(segmentProblem(name, platform)).toMatch(/is an empty path segment$|is made only of dots$|holds a path separator$|holds a control character$/);
        });

        test.each(ANY_OS_ACCEPTED)("Accepts %j", name => {
            expect(segmentProblem(name, platform)).toBeUndefined();
        });
    });

    test("The answer does not depend on earlier calls", () => {
        // The regex factories hand out a g flag; a shared regex would remember its position
        for (let i = 0; i < 3; i++) {
            expect(segmentProblem("a:b", "win32")).toBeDefined();
            expect(segmentProblem("con", "win32")).toBeDefined();
        }
    });

    test("A hostile value stays out of the message raw", () => {
        expect(segmentProblem("a\nb", "linux")).toBe(String.raw`"a\nb" holds a control character`);
    });

    test("The first problem among the segments is named", () => {
        expect(segmentsProblem(["deb", "con", "a:b"], "win32")).toBe('"con" is a reserved name on Windows');
        expect(segmentsProblem(["deb", "con", "a:b"], "linux")).toBeUndefined();
    });
});

describe("Tests for URL paths", () => {
    test.each(["/", "/deb", "/deb/", "/deb/debian/dists/trixie/Release", "/.well-known/x", "/deb/debian/pool/main/s/srm-hello/srm-hello_1.0-1_amd64.deb"])("On any OS %j is fine", url => {
        expect(urlPathProblem(url, "linux")).toBeUndefined();
        expect(urlPathProblem(url, "win32")).toBeUndefined();
    });

    test.each(["//", "/deb//", "/deb//debian/", "//deb/", "///deb///x", "/rpm//fedora/42/repodata/repomd.xml", "//localhost/c$/Windows/win.ini"])("On any OS %j is fine, an empty segment names nothing", url => {
        expect(urlPathProblem(url, "linux")).toBeUndefined();
        expect(urlPathProblem(url, "win32")).toBeUndefined();
    });

    test.each(["//..//..//outside.txt", "/deb//..//..//outside.txt", "//./deb/", "/deb//...//x", "//deb/.."])("On any OS %j is refused, every other segment is still checked", url => {
        expect(urlPathProblem(url, "linux")).toBeDefined();
        expect(urlPathProblem(url, "win32")).toBeDefined();
    });

    test.each(["//C:/Windows/win.ini", "/deb//aux//x", "//deb//Release::$DATA"])("Only Windows refuses %j, also next to an empty segment", url => {
        expect(urlPathProblem(url, "win32")).toBeDefined();
        expect(urlPathProblem(url, "linux")).toBeUndefined();
    });

    test.each(["/./deb/", "/deb/./", "/deb/../rpm/", "/../x", "/..", "/deb/..", "/...", "/deb/.../x", "/....", "/..\\x", "/deb\\debian/", "/a\0b", "/a\nb",
        decodeURIComponent("/..%5Cx"), decodeURIComponent("/..%2F..%2Fx"), decodeURIComponent("/x%00"), "/\\\\server\\share"])("On any OS %j is refused", url => {
        expect(urlPathProblem(url, "linux")).toBeDefined();
        expect(urlPathProblem(url, "win32")).toBeDefined();
    });

    test.each(["/deb/CON.tar.gz", "/aux.deb/x", "/deb/nul.txt"])("On any OS %j is fine, the name has an extension", url => {
        expect(urlPathProblem(url, "linux")).toBeUndefined();
        expect(urlPathProblem(url, "win32")).toBeUndefined();
    });

    test.each(["/deb/Release::$DATA", "/.env::$DATA", "/deb/RELEAS~1", "/HIDDEN~1/x", "/deb/FOO~1.RPM", "/deb/Release.", "/deb/Release ", "/deb/con", "/deb/con.", "/deb/con ", "/aux/x", "/C:/Windows", "/deb/lpt¹"])("Only Windows refuses %j", url => {
        expect(urlPathProblem(url, "win32")).toBeDefined();
        expect(urlPathProblem(url, "linux")).toBeUndefined();
    });

    test("A case alias stays", () => {
        expect(urlPathProblem("/deb/RELEASE", "win32")).toBeUndefined();
    });
});

describe("Tests for toOsPath", () => {
    test("Joins with the separators of the platform", () => {
        expect(toOsPath("C:\\repo", "deb/debian/pool/main/x.deb", "win32")).toBe("C:\\repo\\deb\\debian\\pool\\main\\x.deb");
        expect(toOsPath("C:/repo/", "deb", "win32")).toBe("C:\\repo\\deb");
        expect(toOsPath("\\\\server\\share\\repo", "deb/x", "win32")).toBe("\\\\server\\share\\repo\\deb\\x");
        expect(toOsPath("/repo", "deb/debian/pool/main/x.deb", "linux")).toBe("/repo/deb/debian/pool/main/x.deb");
    });

    test("Keeps a relative root relative", () => {
        expect(toOsPath("repo", "deb/x", "win32")).toBe("repo\\deb\\x");
        expect(toOsPath("repo", "deb/x", "linux")).toBe("repo/deb/x");
    });

    test("By default follows this system", () => {
        expect(toOsPath("repo", "deb/x")).toBe(osPath.join("repo", "deb", "x"));
    });

    test("A literal percent is only a name on any OS", () => {
        expect(toOsPath("/repo", "..%5C/x", "linux")).toBe("/repo/..%5C/x");
        expect(toOsPath("C:\\repo", "..%5C/x", "win32")).toBe("C:\\repo\\..%5C\\x");
    });

    test.each(["", "/", "/etc/passwd", "//server/share", "../x", "a/../b", "a/..", "./a", "a/./b", "a//b", "a/", "...", "a/.../b", "..\\x", "a\\..\\..\\b", "\\\\server\\share", "\\\\?\\C:\\x", "C:\\Windows", "a\0b", "a/\0"])(
        "On any OS refuses %j", posixPath => {
            for (const [root, platform] of [["C:\\repo", "win32"], ["/repo", "linux"]] as const) {
                expect(() => toOsPath(root, posixPath, platform)).toThrow(RepoValidationError);
                expect(() => checkPosixPath(posixPath, platform)).toThrow(RepoValidationError);
            }
        });

    test("A device name with an extension converts on any OS", () => {
        expect(toOsPath("C:\\repo", "deb/x/NUL.tar.gz", "win32")).toBe("C:\\repo\\deb\\x\\NUL.tar.gz");
        expect(toOsPath("/repo", "deb/x/NUL.tar.gz", "linux")).toBe("/repo/deb/x/NUL.tar.gz");
        expect(toPosixPath("C:\\repo", "C:\\repo\\aux.deb", "win32")).toBe("aux.deb");
    });

    test.each(["C:", "C:/Windows", "c:/x", "deb/C:", "con", "deb/aux/x", "deb/x/NUL", "COM1", "aux.deb/con", "a:b", "deb/RELEAS~1", "deb/FOO~1.RPM", "git~1/x", "deb/Release::$DATA", "deb/Release.", "deb/Release ", "deb/con.", "deb/x?"])(
        "Only on Windows refuses %j", posixPath => {
            expect(() => toOsPath("C:\\repo", posixPath, "win32")).toThrow(RepoValidationError);
            expect(toOsPath("/repo", posixPath, "linux")).toBe(`/repo/${ posixPath }`);
        });

    test("The message names the path and the segment", () => {
        expect(() => toOsPath("C:\\repo", "deb/con/x", "win32"))
            .toThrow(new RepoValidationError('Malformed path "deb/con/x": "con" is a reserved name on Windows'));
    });

    test.each(["linux", "win32"] as const)("On %s a segment may hold 240 bytes, not more", platform => {
        const longest = "a".repeat(240);
        expect(segmentProblem(longest, platform)).toBeUndefined();
        expect(segmentProblem(`${ longest }a`, platform)).toBe(`"${ "a".repeat(64) }…" is longer than 240 bytes`);
        expect(segmentProblem("é".repeat(121), platform)).toBe(`"${ "é".repeat(64) }…" is longer than 240 bytes`);
        expect(() => toOsPath("/repo", `deb/${ longest }a/x`, platform)).toThrow(RepoValidationError);
        expect(() => checkSafeName("rpmName", `${ longest }a`, "source name", platform)).toThrow(new RepoValidationError(`Malformed source name: "${ "a".repeat(64) }…" is longer than 240 bytes`));
    });
});

describe("Tests for toPosixPath", () => {
    test("Turns the separators of the platform into slashes", () => {
        expect(toPosixPath("C:\\repo", "C:\\repo\\deb\\debian\\x.deb", "win32")).toBe("deb/debian/x.deb");
        expect(toPosixPath("C:\\repo", "C:/repo/deb/x.deb", "win32")).toBe("deb/x.deb");
        expect(toPosixPath("/repo", "/repo/deb/debian/x.deb", "linux")).toBe("deb/debian/x.deb");
        expect(toPosixPath("repo", osPath.join("repo", "deb", "x"))).toBe("deb/x");
    });

    test("Reverses toOsPath", () => {
        for (const posixPath of ["deb", "deb/debian/pool/main/s/srm-hello/srm-hello_1.0-1_amd64.deb", "rpm/fedora/42/repodata/repomd.xml", "..foo/bar"]) {
            expect(toPosixPath("C:\\repo", toOsPath("C:\\repo", posixPath, "win32"), "win32")).toBe(posixPath);
            expect(toPosixPath("/repo", toOsPath("/repo", posixPath, "linux"), "linux")).toBe(posixPath);
        }
    });

    test.each([["C:\\repo", "C:\\repo"], ["C:\\repo", "C:\\other\\x"], ["C:\\repo", "C:\\repo2\\x"], ["C:\\repo", "C:\\repo\\..\\x"], ["C:\\repo", "D:\\repo\\x"],
        ["C:\\repo", "\\\\server\\share\\x"], ["C:\\repo", "C:\\repo\\con"], ["C:\\repo", "C:\\repo\\a:b"], ["C:\\repo", "C:\\repo\\Release."]])("On Windows below %s refuses %s", (root, file) => {
        expect(() => toPosixPath(root, file, "win32")).toThrow(RepoValidationError);
    });

    test.each([["/repo", "/repo"], ["/repo", "/other/x"], ["/repo", "/repo2/x"], ["/repo", "/repo/../x"], ["/repo", "/repo/a\\b"], ["/repo", "/repo/a\0b"]])("On Linux below %s refuses %j", (root, file) => {
        expect(() => toPosixPath(root, file, "linux")).toThrow(RepoValidationError);
    });

    test("What Linux allows in a name stays", () => {
        expect(toPosixPath("/repo", "/repo/a:b/con", "linux")).toBe("a:b/con");
    });
});

describe("Tests for the checks of package metadata", () => {
    test.each(["aux", "con", "NUL", "com1", "foo."])("A source named %s fails on Windows only", name => {
        const refused = /^Malformed Source: ".*" (is a reserved name on Windows|holds a character or an ending that Windows refuses in a file name)$/;
        const kind = name === "NUL" ? "rpmName" : "debName";
        expect(() => checkSafeName(kind, name, "Source", "win32")).toThrow(refused);
        expect(() => checkSafeName(kind, name, "Source", "linux")).not.toThrow();
    });

    test.each(["con.foo", "aux.x"])("A source named %s passes on any OS, its pool directory is an ordinary name", name => {
        expect(() => checkSafeName("debName", name, "Source", "win32")).not.toThrow();
        expect(() => checkSafeName("debName", name, "Source", "linux")).not.toThrow();
    });

    test("A file name may hold what only Windows refuses on Linux", () => {
        expect(() => checkFileName("a:b.deb", "x", "linux")).not.toThrow();
        expect(() => checkFileName("con", "x", "linux")).not.toThrow();
        expect(() => checkFileName("a:b.deb", "x", "win32")).toThrow(new RepoValidationError('Malformed x: "a:b.deb" holds a character or an ending that Windows refuses in a file name'));
        expect(() => checkFileName("con", "x", "win32")).toThrow(new RepoValidationError('Malformed x: "con" is a reserved name on Windows'));
    });

    test.each(["con.deb", "aux.tar.gz", "nul.txt", "com1.rpm"])("A file named %s passes on any OS", name => {
        expect(() => checkFileName(name, "x", "win32")).not.toThrow();
        expect(() => checkFileName(name, "x", "linux")).not.toThrow();
    });

    test.each(["git~1", "FOO~1.RPM", "foo~1.xz"])("A file named %s fails on Windows only", name => {
        expect(() => checkFileName(name, "x", "win32")).toThrow(new RepoValidationError(`Malformed x: ${ JSON.stringify(name) } has the shape of a Windows 8.3 short name`));
        expect(() => checkFileName(name, "x", "linux")).not.toThrow();
    });

    test.each(["srm-hello_1.0~1_amd64.deb", "clevis_22~rc1-1_amd64.deb"])("A file named %s passes on any OS", name => {
        expect(() => checkFileName(name, "x", "win32")).not.toThrow();
        expect(() => checkFileName(name, "x", "linux")).not.toThrow();
    });

    test("A version keeps its epoch and tilde on any OS: it names no file", () => {
        expect(() => checkVersion("2:3.0~1-1", "x")).not.toThrow();
        expect(() => checkVersion("git~1", "x")).not.toThrow();
    });

    test.each([".", "..", "...", "....."])("Neither a file name nor a version may be %j", value => {
        for (const platform of ["win32", "linux"] as const) {
            expect(() => checkFileName(value, "x", platform)).toThrow(new RepoValidationError(`Malformed x: ${ JSON.stringify(value) }`));
        }
        expect(() => checkVersion(value, "x")).toThrow(new RepoValidationError(`Malformed x: ${ JSON.stringify(value) }`));
    });

    test.each(["a b.deb", "a\\b.deb", "a/b.deb", "..", ""])("A file name may not be %j on any OS", name => {
        expect(() => checkFileName(name, "x", "linux")).toThrow(RepoValidationError);
        expect(() => checkFileName(name, "x", "win32")).toThrow(RepoValidationError);
    });
});

describe("Tests for the 8.3 rule following the file naming", () => {
    const shortNameProblem = (name: string): string => `${ JSON.stringify(name) } has the shape of a Windows 8.3 short name`;

    test.each(SHORT_NAMES)("Turned on off Windows it refuses %j", name => {
        setFileNaming({ caseSensitive: false, shortNames: true }, "linux");
        expect(segmentProblem(name, "linux")).toBe(shortNameProblem(name));
    });

    test.each(SHORT_NAMES)("Turned off on Windows it lets %j through", name => {
        setFileNaming({ caseSensitive: false, shortNames: false }, "win32");
        expect(segmentProblem(name, "win32")).toBeUndefined();
    });

    test.each(NOT_SHORT_NAMES)("Turned on off Windows it keeps %j, not a short name", name => {
        setFileNaming({ caseSensitive: false, shortNames: true }, "linux");
        expect(segmentProblem(name, "linux")).toBeUndefined();
    });

    test("Turned on off Windows it leaves device names and reserved characters alone", () => {
        setFileNaming({ caseSensitive: false, shortNames: true }, "linux");
        for (const name of [...RESERVED, ...WINDOWS_REFUSED]) {
            expect(segmentProblem(name, "linux")).toBeUndefined();
        }
    });

    test("Turned off on Windows it leaves device names and reserved characters refused", () => {
        setFileNaming({ caseSensitive: true, shortNames: false }, "win32");
        for (const name of RESERVED) {
            expect(segmentProblem(name, "win32")).toBe(`${ JSON.stringify(name) } is a reserved name on Windows`);
        }
        for (const name of WINDOWS_REFUSED) {
            expect(segmentProblem(name, "win32")).toMatch(/holds a character or an ending that Windows refuses in a file name$/);
        }
    });

    test("An injected platform keeps its meaning, whatever another one resolved", () => {
        setFileNaming({ caseSensitive: true, shortNames: false }, "win32");
        expect(segmentProblem("git~1", "linux")).toBeUndefined();
        setFileNaming({ caseSensitive: false, shortNames: true }, "win32");
        expect(segmentProblem("git~1", "linux")).toBeUndefined();

        setFileNaming({ caseSensitive: true, shortNames: false }, "linux");
        expect(segmentProblem("git~1", "win32")).toBe(shortNameProblem("git~1"));
        setFileNaming({ caseSensitive: false, shortNames: true }, "linux");
        expect(segmentProblem("git~1", "win32")).toBe(shortNameProblem("git~1"));
    });

    test("Every check without a platform follows what this system resolved", () => {
        setFileNaming({ caseSensitive: true, shortNames: true });
        expect(segmentProblem("git~1")).toBe(shortNameProblem("git~1"));
        expect(urlPathProblem("/deb/RELEAS~1")).toBe(shortNameProblem("RELEAS~1"));
        expect(() => toOsPath("repo", "deb/git~1")).toThrow(RepoValidationError);
        expect(() => checkFileName("foo~1.xz", "x")).toThrow(new RepoValidationError(`Malformed x: ${ shortNameProblem("foo~1.xz") }`));
        expect(validateFilename("deb", "foo~1.deb")).toBe(false);

        setFileNaming({ caseSensitive: true, shortNames: false });
        expect(segmentProblem("git~1")).toBeUndefined();
        expect(urlPathProblem("/deb/RELEAS~1")).toBeUndefined();
        expect(toOsPath("repo", "deb/git~1")).toBe(osPath.join("repo", "deb", "git~1"));
        expect(() => checkFileName("foo~1.xz", "x")).not.toThrow();
        expect(validateFilename("deb", "foo~1.deb")).toBe(true);
    });
});

describe("Tests for real names", () => {
    const existing = async (roots: string[]): Promise<{ root: string; file: string }[]> =>
        (await Promise.all(roots.map(async root => (await filesBelow(root)).map(file => ({ root, file }))))).flat();

    test.each([["win32", true], ["win32", false], ["linux", true], ["linux", false]] as const)("On %s with short names %s every name of the fixtures passes", async (platform, shortNames) => {
        setFileNaming({ caseSensitive: !shortNames, shortNames }, platform);
        const fixtures = await existing(FIXTURE_ROOTS);
        expect(fixtures.length).toBeGreaterThan(0);
        for (const { root, file } of fixtures) {
            expect(() => checkPosixPath(osPath.relative(root, file).split(osPath.sep).join("/"), platform)).not.toThrow();
        }
    });

    test("Every name of the fixtures and of ../test-data passes on any OS", async () => {
        const fixtures = await existing(FIXTURE_ROOTS);
        expect(fixtures.length).toBeGreaterThan(0);
        for (const { root, file } of [...fixtures, ...await existing(TEST_DATA_ROOTS)]) {
            const rel = osPath.relative(root, file).split(osPath.sep).join("/");
            expect(() => checkPosixPath(rel, "win32")).not.toThrow();
            expect(() => checkPosixPath(rel, "linux")).not.toThrow();
        }
    });

    test("Every Source and listed file of their .changes passes on any OS", async () => {
        const changes = (await existing([...FIXTURE_ROOTS, ...TEST_DATA_ROOTS])).filter(({ file }) => file.endsWith(".changes"));
        expect(changes.length).toBeGreaterThan(0);
        for (const { file } of changes) {
            const [stanza] = parseControl(stripClearsign(await fs.readFile(file, "utf8")));
            for (const platform of ["win32", "linux"] as const) {
                expect(() => checkSafeName("debName", binarySource(stanza).source, "Source", platform)).not.toThrow();
                for (const listed of parseFileList(requiredField(stanza, "Files"), true)) {
                    expect(() => checkFileName(listed.name, "file name", platform)).not.toThrow();
                }
            }
        }
    });
});

describe("Tests against real Windows", () => {
    windowsTest("Every short name this volume generates reaches its file and is refused", withLocalTmpDir(async () => {
        const collisions = Array.from({ length: 7 }, (_, i) => `longname_collision_${ i }.txt`);
        for (const name of ["ab+1.dsc", "a+b_1.dsc", "foo.html", "foo.tar.gz", ".foo", ".foo.txt", "a.b.c.d", "abcdefghi.txt", "InRelease", "+.txt", "日本語日本語日本語.txt", "a~1234567.txt", "ab+c~1.dsc", "srm-hello_1.0-1_amd64.deb", ...collisions]) {
            await fs.writeFile(name, name);
        }
        const shortNames = execFileSync("powershell", ["-NoProfile", "-Command",
            "$fso = New-Object -ComObject Scripting.FileSystemObject; Get-ChildItem -Force -File | ForEach-Object { $fso.GetFile($_.FullName).ShortName }"], { encoding: "utf8" })
            .split(/\r?\n/).filter(name => name.includes("~"));
        // A volume with 8.3 names off generates none
        for (const name of shortNames) {
            await fs.access(name);
            expect(segmentProblem(name, "win32")).toBe(`${ JSON.stringify(name) } has the shape of a Windows 8.3 short name`);
        }
        if (shortNames.length > 0) {
            expect(await fs.readFile("ab_1~1.dsc", "utf8")).toBe("ab+1.dsc");
        }
    }));

    windowsTest("A stream name really opens the file, and is refused", withLocalTmpDir(async () => {
        await fs.writeFile("Release", "text");
        expect(await fs.readFile("Release::$DATA", "utf8")).toBe("text");
        expect(segmentProblem("Release::$DATA")).toBeDefined();
    }));

    windowsTest("Node really creates a device or trailing-dot name no other tool can open, and they are refused", withLocalTmpDir(async () => {
        await fs.writeFile("aux", "x");
        await fs.writeFile("foo.", "x");
        expect((await fs.readdir(".")).sort()).toEqual(["aux", "foo."]);
        expect(segmentProblem("aux")).toBeDefined();
        expect(segmentProblem("foo.")).toBeDefined();
    }));

    windowsTest("This system applies the Windows rules by default", () => {
        expect(() => toOsPath("repo", "deb/con")).toThrow(RepoValidationError);
        expect(() => toOsPath("repo", "deb/Release::$DATA")).toThrow(RepoValidationError);
        expect(() => toOsPath("repo", "C:/Windows")).toThrow(RepoValidationError);
        expect(toOsPath("repo", "deb/x")).toBe("repo\\deb\\x");
    });
});
