import { describe, expect, it, beforeEach, afterEach } from "@jest/globals";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProcessDebTree } from "../../server/lib/deb.ts";

describe("scanProcessDebTree", () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(join(tmpdir(), "srm-scan-"));
    });
    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    it("returns empty array when the root does not exist", async () => {
        expect(await scanProcessDebTree(join(root, "missing"))).toEqual([]);
    });

    it("returns empty array for an empty root", async () => {
        expect(await scanProcessDebTree(root)).toEqual([]);
    });

    it("collects leaf directories with their files", async () => {
        await fs.mkdir(join(root, "debian/trixie/main"), { recursive: true });
        await fs.writeFile(join(root, "debian/trixie/main/a.deb"), "");
        await fs.writeFile(join(root, "debian/trixie/main/a.changes"), "");

        const snaps = await scanProcessDebTree(root);
        expect(snaps).toHaveLength(1);
        expect(snaps[0].dirRel).toBe("debian/trixie/main");
        expect(snaps[0].files.sort()).toEqual(["a.changes", "a.deb"]);
    });

    it("collects multiple sibling leaf directories", async () => {
        await fs.mkdir(join(root, "debian/trixie/main"), { recursive: true });
        await fs.writeFile(join(root, "debian/trixie/main/a.deb"), "");
        await fs.mkdir(join(root, "ubuntu/noble/universe"), { recursive: true });
        await fs.writeFile(join(root, "ubuntu/noble/universe/b.deb"), "");

        const snaps = await scanProcessDebTree(root);
        const dirs = snaps.map((s) => s.dirRel).sort();
        expect(dirs).toEqual(["debian/trixie/main", "ubuntu/noble/universe"]);
    });

    it("does not treat an intermediate directory as a leaf even when it contains files alongside subdirs", async () => {
        // This is a defensive test for the leaf-only semantics: if a non-leaf dir
        // has both files and subdirs, we recurse into the subdirs AND we skip the
        // non-leaf files. The processIncoming flow shouldn't produce such mixed
        // directories in practice, but pinning the behavior keeps the scanner
        // predictable.
        await fs.mkdir(join(root, "debian/trixie/main/sub"), { recursive: true });
        await fs.writeFile(join(root, "debian/trixie/stray.txt"), "");
        await fs.writeFile(join(root, "debian/trixie/main/sub/a.deb"), "");

        const snaps = await scanProcessDebTree(root);
        const dirs = snaps.map((s) => s.dirRel);
        expect(dirs).toContain("debian/trixie/main/sub");
        // "debian/trixie" should NOT appear as a leaf — it has a subdir.
        expect(dirs).not.toContain("debian/trixie");
    });
});
