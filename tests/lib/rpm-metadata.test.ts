import { describe, expect, test } from "@jest/globals";
import dedent from "dedent";
import osPath from "path";
import fs from "node:fs/promises";
import zlib from "node:zlib";
import { withLocalTmpDir } from "../utils.ts";
import {
    matchesSourceIdentity,
    resolvePrimaryLocation,
    sourceIdentityOf,
    streamPackages
} from "../../server/lib/rpm-metadata.ts";

const REPOMD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<repomd xmlns="http://linux.duke.edu/metadata/repo" xmlns:rpm="http://linux.duke.edu/metadata/rpm">
  <data type="filelists">
    <location href="repodata/abc-filelists.xml.zst"/>
  </data>
  <data type="primary">
    <location href="repodata/def-primary.xml.zst"/>
    <checksum type="sha256">def</checksum>
  </data>
  <data type="other">
    <location href="repodata/ghi-other.xml.zst"/>
  </data>
</repomd>
`;

describe("resolvePrimaryLocation", () => {
    test("extracts the primary href relative to the release dir", withLocalTmpDir(async () => {
        await fs.mkdir("repodata", { recursive: true });
        await fs.writeFile(osPath.join("repodata", "repomd.xml"), REPOMD_XML);

        const primary = await resolvePrimaryLocation(".");

        expect(primary).toEqual({
            path: osPath.join(".", "repodata", "def-primary.xml.zst"),
            compression: "zst"
        });
    }));

    test("returns null when repodata/repomd.xml does not exist", withLocalTmpDir(async () => {
        const primary = await resolvePrimaryLocation(".");
        expect(primary).toBeNull();
    }));

    test("detects .gz compression", withLocalTmpDir(async () => {
        await fs.mkdir("repodata", { recursive: true });
        await fs.writeFile(osPath.join("repodata", "repomd.xml"),
            REPOMD_XML.replace(/def-primary\.xml\.zst/, "def-primary.xml.gz"));

        const primary = await resolvePrimaryLocation(".");

        expect(primary?.compression).toBe("gz");
    }));

    test("throws on unsupported compression (e.g. .xz)", withLocalTmpDir(async () => {
        await fs.mkdir("repodata", { recursive: true });
        await fs.writeFile(osPath.join("repodata", "repomd.xml"),
            REPOMD_XML.replace(/def-primary\.xml\.zst/, "def-primary.xml.xz"));

        await expect(resolvePrimaryLocation(".")).rejects.toThrow(/unsupported/i);
    }));

    test("throws when no primary entry is present", withLocalTmpDir(async () => {
        await fs.mkdir("repodata", { recursive: true });
        await fs.writeFile(osPath.join("repodata", "repomd.xml"),
            `<?xml version="1.0" encoding="UTF-8"?><repomd/>`);

        await expect(resolvePrimaryLocation(".")).rejects.toThrow(/primary/i);
    }));
});

const PRIMARY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<metadata xmlns="http://linux.duke.edu/metadata/common" xmlns:rpm="http://linux.duke.edu/metadata/rpm" packages="2">
  <package type="rpm">
    <name>clevis</name>
    <arch>src</arch>
    <version epoch="0" ver="22" rel="1.tpm1.fc41"/>
    <location href="Packages/c/clevis-22-1.tpm1.fc41.src.rpm"/>
    <format>
      <rpm:sourcerpm></rpm:sourcerpm>
    </format>
  </package>
  <package type="rpm">
    <name>clevis-debuginfo</name>
    <arch>x86_64</arch>
    <version epoch="0" ver="22" rel="1.tpm1.fc41"/>
    <location href="Packages/c/clevis-debuginfo-22-1.tpm1.fc41.x86_64.rpm"/>
    <format>
      <rpm:sourcerpm>clevis-22-1.tpm1.fc41.src.rpm</rpm:sourcerpm>
    </format>
  </package>
</metadata>
`;

async function writeCompressedPrimary(dir: string, compression: "zst" | "gz", xml: string): Promise<string> {
    await fs.mkdir(osPath.join(dir, "repodata"), { recursive: true });
    const href = compression === "zst"
        ? "repodata/hash-primary.xml.zst"
        : "repodata/hash-primary.xml.gz";
    const repomd = `<?xml version="1.0" encoding="UTF-8"?>
<repomd xmlns="http://linux.duke.edu/metadata/repo">
  <data type="primary"><location href="${ href }"/></data>
</repomd>`;
    await fs.writeFile(osPath.join(dir, "repodata", "repomd.xml"), repomd);
    const compressed = compression === "zst"
        ? zlib.zstdCompressSync(Buffer.from(xml, "utf8"))
        : zlib.gzipSync(Buffer.from(xml, "utf8"));
    await fs.writeFile(osPath.join(dir, href), compressed);
    return href;
}

describe("streamPackages", () => {
    test("yields each package with name/arch/version/href/sourcerpm (zst)", withLocalTmpDir(async () => {
        await writeCompressedPrimary(".", "zst", PRIMARY_XML);

        const collected: unknown[] = [];
        for await (const pkg of streamPackages(".")) {
            collected.push(pkg);
        }

        expect(collected).toEqual([
            {
                name: "clevis",
                arch: "src",
                ver: "22",
                rel: "1.tpm1.fc41",
                href: "Packages/c/clevis-22-1.tpm1.fc41.src.rpm",
                sourcerpm: ""
            },
            {
                name: "clevis-debuginfo",
                arch: "x86_64",
                ver: "22",
                rel: "1.tpm1.fc41",
                href: "Packages/c/clevis-debuginfo-22-1.tpm1.fc41.x86_64.rpm",
                sourcerpm: "clevis-22-1.tpm1.fc41.src.rpm"
            }
        ]);
    }));

    test("works with gzip-compressed primary.xml", withLocalTmpDir(async () => {
        await writeCompressedPrimary(".", "gz", PRIMARY_XML);

        const names: string[] = [];
        for await (const pkg of streamPackages(".")) {
            names.push(pkg.name);
        }
        expect(names).toEqual(["clevis", "clevis-debuginfo"]);
    }));

    test("yields nothing when repodata/repomd.xml is absent", withLocalTmpDir(async () => {
        const collected: unknown[] = [];
        for await (const pkg of streamPackages(".")) {
            collected.push(pkg);
        }
        expect(collected).toEqual([]);
    }));

    test("unescapes XML entities in captured fields", withLocalTmpDir(async () => {
        // Contrived but valid: entities in every extracted field.
        // &amp;/&lt;/&gt;/&quot;/&apos; plus numeric char refs (&#45; = '-').
        const xml = dedent`\
            <?xml version="1.0" encoding="UTF-8"?>
            <metadata xmlns="http://linux.duke.edu/metadata/common" xmlns:rpm="http://linux.duke.edu/metadata/rpm" packages="1">
              <package type="rpm">
                <name>a&amp;b&lt;c&gt;d</name>
                <arch>x86_64</arch>
                <version epoch="0" ver="1&amp;2" rel="r&#45;1"/>
                <location href="Packages/a/a&amp;b-1&amp;2-r&#45;1.x86_64.rpm"/>
                <format>
                  <rpm:sourcerpm>a&amp;b-1&amp;2-r&#45;1.src.rpm</rpm:sourcerpm>
                </format>
              </package>
            </metadata>\n
        `;
        await writeCompressedPrimary(".", "zst", xml);

        const collected: unknown[] = [];
        for await (const pkg of streamPackages(".")) {
            collected.push(pkg);
        }

        expect(collected).toEqual([{
            name: "a&b<c>d",
            arch: "x86_64",
            ver: "1&2",
            rel: "r-1",
            href: "Packages/a/a&b-1&2-r-1.x86_64.rpm",
            sourcerpm: "a&b-1&2-r-1.src.rpm",
        }]);
    }));

    test("surfaces truncated primary.xml as an error", withLocalTmpDir(async () => {
        await writeCompressedPrimary(".", "zst", PRIMARY_XML.slice(0, 400));

        const run = async () => {
            for await (const pkg of streamPackages(".")) { void pkg; }
        };
        await expect(run()).rejects.toThrow();
    }));
});

describe("sourceIdentityOf", () => {
    test("reconstructs filename for arch=src", () => {
        expect(sourceIdentityOf({
            name: "clevis", arch: "src", ver: "22", rel: "1.tpm1.fc41",
            href: "Packages/c/clevis-22-1.tpm1.fc41.src.rpm", sourcerpm: ""
        })).toBe("clevis-22-1.tpm1.fc41.src.rpm");
    });

    test("returns sourcerpm for binary arch", () => {
        expect(sourceIdentityOf({
            name: "clevis-debuginfo", arch: "x86_64", ver: "22", rel: "1.tpm1.fc41",
            href: "Packages/c/clevis-debuginfo-22-1.tpm1.fc41.x86_64.rpm",
            sourcerpm: "clevis-22-1.tpm1.fc41.src.rpm"
        })).toBe("clevis-22-1.tpm1.fc41.src.rpm");
    });

    test("returns null for binary with empty sourcerpm", () => {
        expect(sourceIdentityOf({
            name: "weird", arch: "x86_64", ver: "1", rel: "1",
            href: "Packages/w/weird-1-1.x86_64.rpm", sourcerpm: ""
        })).toBeNull();
    });
});

describe("matchesSourceIdentity", () => {
    test("matches input with a single-segment OS tag", () => {
        expect(matchesSourceIdentity("clevis-22-1.tpm1", "clevis-22-1.tpm1.fc41.src.rpm")).toBe(true);
        expect(matchesSourceIdentity("clevis-22-1.tpm1", "clevis-22-1.tpm1.el9.src.rpm")).toBe(true);
        expect(matchesSourceIdentity("clevis-22-1.tpm1", "clevis-22-1.tpm1.el9_2.src.rpm")).toBe(true);
    });

    test("accepts release without distro tag (plain trailing .src.rpm)", () => {
        expect(matchesSourceIdentity("pkg-22-1", "pkg-22-1.src.rpm")).toBe(true);
    });

    test("rejects when input does not end at a full segment boundary", () => {
        expect(matchesSourceIdentity("clevis-2", "clevis-22-1.tpm1.fc41.src.rpm")).toBe(false);
        expect(matchesSourceIdentity("clevis-22-1", "clevis-22-1.tpm1.fc41.src.rpm")).toBe(false);
    });

    test("rejects non-src-rpm suffix", () => {
        expect(matchesSourceIdentity("clevis-22-1.tpm1",
            "clevis-22-1.tpm1.fc41.x86_64.rpm")).toBe(false);
    });

    test("escapes regex metacharacters in the input", () => {
        // '+' must be literal; wildcard-like interpretation would pick up non-matching prefixes.
        expect(matchesSourceIdentity("pkg+1-2", "pkg+1-2.fc41.src.rpm")).toBe(true);
        expect(matchesSourceIdentity("pkgx1-2", "pkg+1-2.fc41.src.rpm")).toBe(false);
    });

    test("rejects empty input", () => {
        expect(matchesSourceIdentity("", "x.fc41.src.rpm")).toBe(false);
    });
});
