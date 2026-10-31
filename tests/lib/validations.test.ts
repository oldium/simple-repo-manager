import { afterEach, describe, expect, test } from "@jest/globals";
import { resetFileNaming, setFileNaming } from "../../server/lib/file-naming.ts";
import {
    invalidDistroMessage,
    invalidFilenameMessage,
    isAnyWildcard,
    KEYRING_FILES,
    RELEASE_FILES,
    reservedNameProblem,
    validateDistro,
    validateFilename,
    validatePackageIdentifier,
    validateWildcardOrIdentifier
} from "../../server/lib/validations.ts";

describe("validateDistro", () => {
    test.each([["deb", ["debian", "trixie", "main"]], ["deb", ["ubuntu", "noble", "universe", "sub"]], ["deb", ["debian", "trixie-backports", "non-free"]], ["rpm", ["fedora", "42"]]])("Accepts %s %j on any OS", (type, parts) => {
        expect(validateDistro(type as string, parts as string[], "linux")).toBe(true);
        expect(validateDistro(type as string, parts as string[], "win32")).toBe(true);
    });

    test.each([["deb", ["aux", "trixie", "main"]], ["deb", ["debian", "con", "main"]], ["deb", ["debian", "trixie", "nul"]], ["deb", ["debian", "trixie", "com1"]], ["deb", ["debian", "trixie", "main", "lpt9"]], ["rpm", ["prn", "42"]]])(
        "Refuses %s %j on Windows only", (type, parts) => {
            expect(validateDistro(type as string, parts as string[], "linux")).toBe(true);
            expect(validateDistro(type as string, parts as string[], "win32")).toBe(false);
        });

    test.each([["deb", ["debian", "trixie"]], ["deb", ["C:", "trixie", "main"]], ["deb", ["..", "trixie", "main"]], ["deb", ["debian", "trixie", "a\\b"]], ["deb", ["debian", "trixie", ""]], ["rpm", ["fedora", "con"]]])(
        "Refuses %s %j on any OS", (type, parts) => {
            expect(validateDistro(type as string, parts as string[], "linux")).toBe(false);
            expect(validateDistro(type as string, parts as string[], "win32")).toBe(false);
        });

    test.each([[["release"]], [["inrelease"]], [["release", "main"]]])("Refuses the component %j where case does not count, the release has a file of that name", component => {
        expect(validateDistro("deb", ["debian", "trixie", ...component], "linux")).toBe(true);
        expect(validateDistro("deb", ["debian", "trixie", ...component], "win32")).toBe(false);
    });

    test.each([[["source"]], [["main", "source"]], [["main", "by-hash"]], [["main", "debug"]], [["main", "debian-installer"]], [["main", "binary-amd64"]]])("Refuses the component %j on any OS, the publish writes that name", component => {
        expect(validateDistro("deb", ["debian", "trixie", ...component], "linux")).toBe(false);
        expect(validateDistro("deb", ["debian", "trixie", ...component], "win32")).toBe(false);
    });

    test.each([[["main", "release"]], [["main", "inrelease"]], [["releases"]], [["updates", "main"]]])("Accepts the component %j on any OS", component => {
        expect(validateDistro("deb", ["debian", "trixie", ...component], "linux")).toBe(true);
        expect(validateDistro("deb", ["debian", "trixie", ...component], "win32")).toBe(true);
    });

    test("The message says what is wrong with a name", () => {
        expect(invalidDistroMessage("deb", ["aux", "trixie", "main"], "win32")).toBe('Unknown or invalid distro: deb/aux/trixie/main: "aux" is a reserved name on Windows');
        expect(invalidDistroMessage("deb", ["Bad", "trixie", "main"], "win32")).toBe("Unknown or invalid distro: deb/Bad/trixie/main");
        expect(invalidDistroMessage("deb", ["debian", "trixie", "Release"], "win32")).toBe('Unknown or invalid distro: deb/debian/trixie/Release: "Release" cannot be a component, the release has a file of that name');
        expect(invalidDistroMessage("deb", ["debian", "trixie", "main", "source"], "linux")).toBe('Unknown or invalid distro: deb/debian/trixie/main/source: "source" cannot be a component, the publish writes that name below a component');
    });
});

describe("reservedNameProblem", () => {
    const INSENSITIVE = { caseSensitive: false, shortNames: false };
    const SENSITIVE = { caseSensitive: true, shortNames: false };
    const namedBy = (type: string, ...names: string[]): string | undefined => reservedNameProblem(type, ["debian", "trixie", ...names]);

    afterEach(resetFileNaming);

    describe.each([INSENSITIVE, SENSITIVE])("With %j", naming => {
        test.each(["source", "by-hash", "debug", "debian-installer", "binary-amd64", "binary-anything", "binary-", "Contents-amd64.gz", "Contents-udeb-amd64.gz"])("%s is written below a component, so no component at any level can be it", name => {
            setFileNaming(naming);
            const problem = `${ JSON.stringify(name) } cannot be a component, the publish writes that name below a component`;
            expect(namedBy("deb", name)).toBe(problem);
            expect(namedBy("deb", "main", name)).toBe(problem);
            expect(namedBy("deb", "a", "b", name, "c")).toBe(problem);
        });

        test.each([[[]], [["main"]], [["updates", "main"]], [["main", "release"]], [["main", "InRelease"]], [["sources"]], [["binary"]], [["debugger"]], [["by-hash2"]], [["Contents-amd64"]], [["contents"]], [["s"]], [["libs"]], [["i18n"]]])("%j is free", names => {
            setFileNaming(naming);
            expect(namedBy("deb", ...names)).toBeUndefined();
        });

        test.each(["Release", "InRelease", "Release.gpg"])("The component %s is a file of the release, also with a sub-component", name => {
            setFileNaming(naming);
            const problem = `${ JSON.stringify(name) } cannot be a component, the release has a file of that name`;
            expect(namedBy("deb", name)).toBe(problem);
            expect(namedBy("deb", name, "main")).toBe(problem);
        });

        test.each([["deb", "archive-keyring.asc"], ["rpm", "RPM-GPG-KEY.asc"]])("A %s distribution cannot be its keyring", (type, name) => {
            setFileNaming(naming);
            expect(reservedNameProblem(type, [name, "x"])).toBe(`${ JSON.stringify(name) } cannot be a distribution, the format has a keyring of that name`);
        });

        test.each([["deb", "RPM-GPG-KEY.asc"], ["rpm", "archive-keyring.asc"], ["rpm", "fedora"], ["other", "archive-keyring.asc"]])("A %s distribution can be %s", (type, name) => {
            setFileNaming(naming);
            expect(reservedNameProblem(type, [name, "42"])).toBeUndefined();
        });

        test("Below an rpm release the server writes no name a release could take", () => {
            setFileNaming(naming);
            expect(reservedNameProblem("rpm", ["fedora", "42", "source", "Release"])).toBeUndefined();
        });
    });

    test.each(["release", "RELEASE", "inrelease", "release.gpg"])("Only where case does not count the component %s is a file of the release, named as sent", name => {
        setFileNaming(INSENSITIVE);
        expect(namedBy("deb", name)).toBe(`${ JSON.stringify(name) } cannot be a component, the release has a file of that name`);
        setFileNaming(SENSITIVE);
        expect(namedBy("deb", name)).toBeUndefined();
    });

    test.each(["Source", "BY-HASH", "Debug", "Binary-amd64", "contents-amd64.gz", "CONTENTS-AMD64.GZ"])("Only where case does not count the component %s is written below a component, named as sent", name => {
        setFileNaming(INSENSITIVE);
        expect(namedBy("deb", "main", name)).toBe(`${ JSON.stringify(name) } cannot be a component, the publish writes that name below a component`);
        setFileNaming(SENSITIVE);
        expect(namedBy("deb", "main", name)).toBeUndefined();
    });

    test.each([["deb", "Archive-Keyring.ASC"], ["rpm", "rpm-gpg-key.asc"]])("Only where case does not count a %s distribution %s is the keyring", (type, name) => {
        setFileNaming(INSENSITIVE);
        expect(reservedNameProblem(type, [name, "x"])).toBeDefined();
        setFileNaming(SENSITIVE);
        expect(reservedNameProblem(type, [name, "x"])).toBeUndefined();
    });

    test("Every file the publish writes next to the components and every keyring is one", () => {
        setFileNaming(SENSITIVE);
        for (const name of RELEASE_FILES) {
            expect(namedBy("deb", name)).toBeDefined();
        }
        for (const [type, name] of Object.entries(KEYRING_FILES)) {
            expect(reservedNameProblem(type, [name])).toBeDefined();
        }
    });
});

describe("validateFilename", () => {
    test.each([["deb", "foo_1.0A-1_amd64.deb"], ["deb", "foo_1.0~RC1-1_amd64.deb"], ["deb", "foo_1.0A.orig.tar.gz"], ["deb", "foo_1.0A-1.dsc"], ["deb", "foo_1.0A-1_amd64.changes"], ["deb", "Foo_1.0-1_amd64.buildinfo"],
        ["rpm", "foo-1.0~rc1-1.fc42.x86_64.rpm"], ["rpm", "foo-1.0^git1-1.fc42.x86_64.rpm"], ["rpm", "foo-1.0~rc1^git1-1.fc42.src.rpm"], ["rpm", "NetworkManager-1.0-1.fc42.x86_64.rpm"], ["deb", "Con.deb"]])(
        "Takes %s %s, only directories have to be in lower case", (type, name) => {
            expect(validateFilename(type, name, "linux")).toBe(true);
            expect(validateFilename(type, name, "win32")).toBe(true);
        });

    test.each([["deb", "foo^1.deb"], ["deb", "-foo.deb"], ["deb", "~foo.deb"], ["deb", "foo.DEB"], ["rpm", "^foo.rpm"], ["rpm", "~foo.rpm"], ["rpm", "foo.RPM"], ["rpm", "foo bar.rpm"]])(
        "Still refuses %s %s", (type, name) => {
            expect(validateFilename(type, name, "linux")).toBe(false);
            expect(validateFilename(type, name, "win32")).toBe(false);
        });

    test.each([["deb", "clevis_21-1+tpm1u8+deb12.dsc"], ["deb", "srm-hello_1.0.orig.tar.gz"], ["deb", "aux_1.0_all.deb"], ["deb", "con-1.0.tar.gz"], ["rpm", "clevis-22-1.fc42.x86_64.rpm"], ["rpm", "NetworkManager-1.0-1.src.rpm"],
        ["deb", "srm-hello_1.0~1_amd64.deb"], ["deb", "clevis_22~rc1-1_amd64.deb"], ["deb", "abcdefg~1.deb"], ["deb", "foo~1.buildinfo"],
        ["deb", "con.deb"], ["deb", "aux.tar.gz"], ["deb", "nul.changes"], ["deb", "com1.dsc"], ["deb", "lpt0.buildinfo"], ["rpm", "CON.rpm"], ["rpm", "Aux.src.rpm"]])(
        "Accepts %s %s on any OS", (type, name) => {
            expect(validateFilename(type, name, "linux")).toBe(true);
            expect(validateFilename(type, name, "win32")).toBe(true);
        });

    test.each([["deb", "x.tar.a:b"], ["deb", "x.tar.a?"], ["deb", "x.tar.a "], ["deb", "x.tar.a*"], ["deb", "foo~1.deb"], ["deb", "git~1.dsc"], ["deb", "a~12.deb"]])(
        "Refuses %s %s on Windows only", (type, name) => {
            expect(validateFilename(type, name, "linux")).toBe(true);
            expect(validateFilename(type, name, "win32")).toBe(false);
        });

    test.each([["deb", "..."], ["rpm", "..."], ["deb", "x.tar.a\\b"], ["deb", "x.tar.a/b"], ["deb", "x.tar.a\u0000"], ["deb", "x.tar.a\nb"], ["deb", "..\\x.deb"], ["rpm", "a:b.rpm"], ["rpm", "..\\x.rpm"], ["invalid", "x.deb"]])(
        "Refuses %s %j on any OS", (type, name) => {
            expect(validateFilename(type, name, "linux")).toBe(false);
            expect(validateFilename(type, name, "win32")).toBe(false);
        });

    test("The message says what is wrong with a name", () => {
        expect(invalidFilenameMessage("con", "win32")).toBe('Invalid filename: con: "con" is a reserved name on Windows');
        expect(invalidFilenameMessage("x.tar.a:b", "win32")).toBe('Invalid filename: x.tar.a:b: "x.tar.a:b" holds a character or an ending that Windows refuses in a file name');
        expect(invalidFilenameMessage("x.exe", "win32")).toBe("Invalid filename: x.exe");
        expect(invalidFilenameMessage("x.tar.a\\b", "linux")).toBe(String.raw`Invalid filename: x.tar.a\b: "x.tar.a\\b" holds a path separator`);
    });
});

describe("validatePackageIdentifier", () => {
    test("accepts lowercase alphanumerics", () => {
        expect(validatePackageIdentifier("clevis")).toBe(true);
        expect(validatePackageIdentifier("22")).toBe(true);
    });

    test("accepts uppercase (for RPM names like Qt5, GConf2)", () => {
        expect(validatePackageIdentifier("Qt5")).toBe(true);
        expect(validatePackageIdentifier("GConf2")).toBe(true);
    });

    test("accepts Debian version specials", () => {
        expect(validatePackageIdentifier("21-1+tpm1u8+deb12")).toBe(true);
        expect(validatePackageIdentifier("1:2.3~rc1-1")).toBe(true);
        expect(validatePackageIdentifier("1.0.0")).toBe(true);
    });

    test("accepts RPM version specials", () => {
        expect(validatePackageIdentifier("1.0~rc1-1.fc42")).toBe(true);
        expect(validatePackageIdentifier("1.0^git1-1.fc42")).toBe(true);
    });

    test("accepts the RPM release-prefix form", () => {
        expect(validatePackageIdentifier("22-1.tpm1")).toBe(true);
    });

    test("rejects empty string", () => {
        expect(validatePackageIdentifier("")).toBe(false);
    });

    test("rejects slashes, spaces, and shell metacharacters", () => {
        expect(validatePackageIdentifier("foo/bar")).toBe(false);
        expect(validatePackageIdentifier("foo bar")).toBe(false);
        expect(validatePackageIdentifier("foo;rm -rf")).toBe(false);
        expect(validatePackageIdentifier("foo$bar")).toBe(false);
        expect(validatePackageIdentifier("foo\"bar")).toBe(false);
        expect(validatePackageIdentifier("foo'bar")).toBe(false);
        expect(validatePackageIdentifier("foo(bar)")).toBe(false);
    });

    test("rejects the lone dash (reserved as wildcard marker)", () => {
        expect(validatePackageIdentifier("-")).toBe(false);
    });
});

describe("isAnyWildcard", () => {
    test("only the lone dash is the wildcard", () => {
        expect(isAnyWildcard("-")).toBe(true);
        expect(isAnyWildcard("--")).toBe(false);
        expect(isAnyWildcard("a")).toBe(false);
        expect(isAnyWildcard("-foo")).toBe(false);
        expect(isAnyWildcard("")).toBe(false);
    });
});

describe("validateWildcardOrIdentifier", () => {
    test("accepts the lone dash wildcard", () => {
        expect(validateWildcardOrIdentifier("-")).toBe(true);
    });

    test("accepts plain identifiers", () => {
        expect(validateWildcardOrIdentifier("bookworm")).toBe(true);
        expect(validateWildcardOrIdentifier("21-1+tpm1u8+deb12")).toBe(true);
        expect(validateWildcardOrIdentifier("Qt5")).toBe(true);
    });

    test("accepts dash-containing identifiers (not treated as wildcard)", () => {
        // Existing PACKAGE_IDENTIFIER_REGEX admits leading/trailing/internal
        // dashes. The new validator must not regress them. Only the lone
        // `-` is the wildcard; `-foo` / `bookworm-` / `-bookworm` remain
        // plain identifiers.
        expect(validateWildcardOrIdentifier("-foo")).toBe(true);
        expect(validateWildcardOrIdentifier("bookworm-")).toBe(true);
        expect(validateWildcardOrIdentifier("-bookworm")).toBe(true);
        expect(validateWildcardOrIdentifier("bookworm-security")).toBe(true);
    });

    test("double-dash is not the wildcard and not a plain identifier rule-breaker", () => {
        // `--` is allowed by PACKAGE_IDENTIFIER_REGEX (all chars are in
        // the class); it's not special and not the lone-dash wildcard.
        expect(validateWildcardOrIdentifier("--")).toBe(true);
    });

    test("rejects empty string", () => {
        expect(validateWildcardOrIdentifier("")).toBe(false);
    });

    test("rejects slashes, spaces, and shell metacharacters", () => {
        expect(validateWildcardOrIdentifier("a/b")).toBe(false);
        expect(validateWildcardOrIdentifier("a b")).toBe(false);
        expect(validateWildcardOrIdentifier("a;b")).toBe(false);
    });
});
