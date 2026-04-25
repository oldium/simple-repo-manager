import { describe, expect, it } from "@jest/globals";
import {
    parseListFilterOutput,
    parseSourcePackageListFilterOutput,
} from "../../server/lib/deb-listfilter.ts";

describe("parseListFilterOutput — binary rows", () => {
    it("parses a single deb record with pool path in Filename", () => {
        const stdout = "deb\tpool/main/c/clevis/clevis_22-1_amd64.deb\t\t\0";
        expect(parseListFilterOutput(stdout)).toEqual([
            { type: "deb", path: "pool/main/c/clevis/clevis_22-1_amd64.deb" },
        ]);
    });

    it("parses ddeb rows with ddeb type", () => {
        const stdout = "ddeb\tpool/universe/c/foo/foo-dbgsym_1_amd64.ddeb\t\t\0";
        expect(parseListFilterOutput(stdout)).toEqual([
            { type: "ddeb", path: "pool/universe/c/foo/foo-dbgsym_1_amd64.ddeb" },
        ]);
    });

    it("parses udeb rows with udeb type", () => {
        const stdout = "udeb\tpool/main/d/debian-installer/di_1_amd64.udeb\t\t\0";
        expect(parseListFilterOutput(stdout)).toEqual([
            { type: "udeb", path: "pool/main/d/debian-installer/di_1_amd64.udeb" },
        ]);
    });

    it("parses multiple binary records", () => {
        const stdout =
            "deb\tpool/main/c/clevis/clevis_22-1_amd64.deb\t\t\0" +
            "deb\tpool/main/c/clevis/clevis-luks_22-1_amd64.deb\t\t\0";
        expect(parseListFilterOutput(stdout)).toHaveLength(2);
    });
});

describe("parseListFilterOutput — dsc rows", () => {
    it("expands the Files block to one entry per file in the Directory", () => {
        // First Files line has no leading space (chunk_getwholedata behavior);
        // subsequent continuation lines have a leading space.
        const filesBody =
            "646a6d9254b8818e6f230ba4d46a48cd 2932 clevis_22-1.dsc\n" +
            " 505a3a791e88b81aad96e28f7d6a2d65 112648 clevis_22.orig.tar.gz\n" +
            " c7cb3b4485919a441d6e537d4557e5ea 43448 clevis_22-1.debian.tar.xz";
        const stdout = `dsc\t\tpool/main/c/clevis\t${ filesBody }\0`;
        expect(parseListFilterOutput(stdout)).toEqual([
            { type: "dsc", path: "pool/main/c/clevis/clevis_22-1.dsc" },
            { type: "dsc", path: "pool/main/c/clevis/clevis_22.orig.tar.gz" },
            { type: "dsc", path: "pool/main/c/clevis/clevis_22-1.debian.tar.xz" },
        ]);
    });

    it("handles Files where all lines have leading spaces", () => {
        const filesBody =
            " 646a6d9254b8818e6f230ba4d46a48cd 2932 clevis_22-1.dsc\n" +
            " 505a3a791e88b81aad96e28f7d6a2d65 112648 clevis_22.orig.tar.gz";
        const stdout = `dsc\t\tpool/main/c/clevis\t${ filesBody }\0`;
        expect(parseListFilterOutput(stdout)).toHaveLength(2);
    });

    it("mixes binary and dsc records in order", () => {
        const stdout =
            "deb\tpool/main/c/clevis/clevis_22-1_amd64.deb\t\t\0" +
            "dsc\t\tpool/main/c/clevis\t" +
                "646a6d9254b8818e6f230ba4d46a48cd 2932 clevis_22-1.dsc\n" +
                " 505a3a791e88b81aad96e28f7d6a2d65 112648 clevis_22.orig.tar.gz" +
            "\0";
        expect(parseListFilterOutput(stdout)).toEqual([
            { type: "deb", path: "pool/main/c/clevis/clevis_22-1_amd64.deb" },
            { type: "dsc", path: "pool/main/c/clevis/clevis_22-1.dsc" },
            { type: "dsc", path: "pool/main/c/clevis/clevis_22.orig.tar.gz" },
        ]);
    });
});

describe("parseListFilterOutput — edge cases", () => {
    it("returns empty array for empty stdout", () => {
        expect(parseListFilterOutput("")).toEqual([]);
    });

    it("throws on records with the wrong field count", () => {
        const stdout = "deb\tonly-two-fields\0";
        expect(() => parseListFilterOutput(stdout)).toThrow(/4 fields, got 2/);
    });

    it("silently ignores unknown types", () => {
        const stdout = "mystery\tpath\t\t\0";
        expect(parseListFilterOutput(stdout)).toEqual([]);
    });

    it("drops blank lines inside the Files body", () => {
        const stdout =
            "dsc\t\tpool/main/c/clevis\t" +
            "646a6d9254b8818e6f230ba4d46a48cd 2932 clevis_22-1.dsc\n" +
            "\n" +
            " 505a3a791e88b81aad96e28f7d6a2d65 112648 clevis_22.orig.tar.gz" +
            "\0";
        expect(parseListFilterOutput(stdout)).toHaveLength(2);
    });

    it("preserves filenames containing + and . characters", () => {
        const stdout =
            "dsc\t\tpool/main/c/clevis\t" +
            "0123456789abcdef0123456789abcdef 100 clevis_22-1+tpm1u0+deb13.dsc" +
            "\0";
        expect(parseListFilterOutput(stdout)).toEqual([
            { type: "dsc", path: "pool/main/c/clevis/clevis_22-1+tpm1u0+deb13.dsc" },
        ]);
    });
});

describe("parseSourcePackageListFilterOutput", () => {
    it("parses a single source record", () => {
        const stdout = "clevis\t22-1+deb13\0";
        expect(parseSourcePackageListFilterOutput(stdout)).toEqual([
            { source: "clevis", version: "22-1+deb13" },
        ]);
    });

    it("parses multiple distinct sources", () => {
        const stdout = "clevis\t22-1\0foo\t1.2.3-1\0";
        expect(parseSourcePackageListFilterOutput(stdout)).toEqual([
            { source: "clevis", version: "22-1" },
            { source: "foo", version: "1.2.3-1" },
        ]);
    });

    it("dedupes the same (source, version) across components", () => {
        const stdout = "clevis\t22-1\0clevis\t22-1\0";
        expect(parseSourcePackageListFilterOutput(stdout)).toEqual([
            { source: "clevis", version: "22-1" },
        ]);
    });

    it("keeps distinct versions of the same source", () => {
        const stdout = "clevis\t22-1\0clevis\t22-2\0";
        expect(parseSourcePackageListFilterOutput(stdout)).toEqual([
            { source: "clevis", version: "22-1" },
            { source: "clevis", version: "22-2" },
        ]);
    });

    it("preserves epoch and tilde characters in versions", () => {
        const stdout = "foo\t1:2.0~rc1-3\0";
        expect(parseSourcePackageListFilterOutput(stdout)).toEqual([
            { source: "foo", version: "1:2.0~rc1-3" },
        ]);
    });

    it("returns empty array for empty stdout", () => {
        expect(parseSourcePackageListFilterOutput("")).toEqual([]);
    });

    it("throws on records with the wrong field count", () => {
        expect(() => parseSourcePackageListFilterOutput("only-one-field\0"))
            .toThrow(/2 fields, got 1/);
    });

    it("throws on records with too many fields", () => {
        expect(() => parseSourcePackageListFilterOutput("a\tb\tc\0"))
            .toThrow(/2 fields, got 3/);
    });

    it("throws on records with an empty source field", () => {
        expect(() => parseSourcePackageListFilterOutput("\t1.0\0"))
            .toThrow(/empty field/);
    });

    it("throws on records with an empty version field", () => {
        expect(() => parseSourcePackageListFilterOutput("foo\t\0"))
            .toThrow(/empty field/);
    });
});
