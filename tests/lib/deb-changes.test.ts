import { describe, expect, it } from "@jest/globals";
import { parseChangesContent } from "../../server/lib/deb-changes.ts";

describe("parseChangesContent — basic fields", () => {
    it("extracts Source, Version, Distribution, Architecture", () => {
        const content = [
            "Format: 1.8",
            "Source: clevis",
            "Version: 22-1",
            "Distribution: bookworm",
            "Architecture: source amd64",
            "Files:",
            " abc 100 main misc clevis_22-1.dsc",
            "",
        ].join("\n");
        const parsed = parseChangesContent(content);
        expect(parsed.source).toBe("clevis");
        expect(parsed.version).toBe("22-1");
        expect(parsed.distributions).toEqual(["bookworm"]);
        expect([...parsed.architectures].sort()).toEqual(["amd64", "source"]);
        expect(parsed.hasDdeb).toBe(false);
    });

    it("returns undefined source/version when missing", () => {
        const content = "Format: 1.8\nDistribution: trixie\n";
        const parsed = parseChangesContent(content);
        expect(parsed.source).toBeUndefined();
        expect(parsed.version).toBeUndefined();
        expect(parsed.distributions).toEqual(["trixie"]);
        expect([...parsed.architectures]).toEqual([]);
    });

    it("returns empty distributions and architectures when fields missing", () => {
        const content = "Format: 1.8\nSource: foo\nVersion: 1\n";
        const parsed = parseChangesContent(content);
        expect(parsed.distributions).toEqual([]);
        expect([...parsed.architectures]).toEqual([]);
        expect(parsed.hasDdeb).toBe(false);
    });
});

describe("parseChangesContent — multi-value fields", () => {
    it("splits multiple distributions on space", () => {
        const content = "Distribution: bookworm bookworm-backports trixie\n";
        expect(parseChangesContent(content).distributions)
            .toEqual(["bookworm", "bookworm-backports", "trixie"]);
    });

    it("splits multiple architectures on space, deduping via Set", () => {
        const content = "Architecture: source amd64 i386 amd64\n";
        const arches = parseChangesContent(content).architectures;
        expect([...arches].sort()).toEqual(["amd64", "i386", "source"]);
    });

    it("filters empty tokens from consecutive spaces", () => {
        const content = "Architecture:  amd64   i386 \n";
        expect([...parseChangesContent(content).architectures].sort())
            .toEqual(["amd64", "i386"]);
    });
});

describe("parseChangesContent — Files block and hasDdeb", () => {
    it("detects .ddeb in any continuation line", () => {
        const content = [
            "Source: foo",
            "Files:",
            " abc 100 main misc foo_1.dsc",
            " def 200 main misc foo_1_amd64.deb",
            " 012 50 main misc foo-dbgsym_1_amd64.ddeb",
            "",
        ].join("\n");
        expect(parseChangesContent(content).hasDdeb).toBe(true);
    });

    it("returns false when no continuation line ends with .ddeb", () => {
        const content = [
            "Files:",
            " abc 100 main misc foo_1.dsc",
            " def 200 main misc foo_1_amd64.deb",
            "",
        ].join("\n");
        expect(parseChangesContent(content).hasDdeb).toBe(false);
    });

    it("recognises tab-indented continuation lines", () => {
        const content = [
            "Files:",
            "\tabc 100 main misc foo-dbgsym_1_amd64.ddeb",
            "",
        ].join("\n");
        expect(parseChangesContent(content).hasDdeb).toBe(true);
    });

    it("stops Files block at first blank line", () => {
        const content = [
            "Files:",
            " abc 100 main misc foo_1.dsc",
            "",
            "Trailer-Section: not-a-continuation foo.ddeb",
        ].join("\n");
        expect(parseChangesContent(content).hasDdeb).toBe(false);
    });

    it("stops Files block at first non-indented line", () => {
        const content = [
            "Files:",
            " abc 100 main misc foo_1.dsc",
            "Some-Other-Field: value foo.ddeb",
        ].join("\n");
        expect(parseChangesContent(content).hasDdeb).toBe(false);
    });

    it("handles Files: at the very start of content", () => {
        const content = "Files:\n abc 100 main misc foo-dbgsym_1.ddeb\n";
        expect(parseChangesContent(content).hasDdeb).toBe(true);
    });
});

describe("parseChangesContent — robustness", () => {
    it("ignores fields inside a PGP signature block", () => {
        const content = [
            "Source: real-source",
            "Version: 1-1",
            "Distribution: bookworm",
            "",
            "-----BEGIN PGP SIGNATURE-----",
            "Version: GnuPG v2",
            "Source: tampered",
            "",
            "iQEz...",
            "-----END PGP SIGNATURE-----",
        ].join("\n");
        const parsed = parseChangesContent(content);
        expect(parsed.source).toBe("real-source");
        expect(parsed.version).toBe("1-1");
    });

    it("handles CRLF line endings on the .ddeb check", () => {
        const content = [
            "Files:",
            " abc 100 main misc foo-dbgsym_1.ddeb",
            "",
        ].join("\r\n");
        expect(parseChangesContent(content).hasDdeb).toBe(true);
    });

    it("first occurrence wins for single-line fields", () => {
        const content = "Source: first\nSource: second\n";
        expect(parseChangesContent(content).source).toBe("first");
    });

    it("returns Architecture as a Set instance", () => {
        const content = "Architecture: amd64\n";
        expect(parseChangesContent(content).architectures).toBeInstanceOf(Set);
    });
});
