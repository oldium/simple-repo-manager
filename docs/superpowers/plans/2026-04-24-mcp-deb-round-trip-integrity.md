# MCP Debian Round-Trip Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Debian packages round-trippable across Simple Repo Manager instances via MCP by fixing `list_package_files` coverage, introducing per-file status in `import_repository`, preserving `.changes` / `.buildinfo` in the pool, and aligning tool/README wording with the supported workflow.

**Architecture:** Six scoped changes in four existing files plus one new file. A new `server/lib/deb-listfilter.ts` module owns the listfilter format string + regex-free parser. `server/lib/deb.ts` consumes that module to rewrite `listPackageFiles`, adds a directory-discovery step for `.changes`/`.buildinfo`, and implements a snapshot-diff around the existing `processincoming` loop. `server/lib/repo-service.ts` exports a new `ImportFile` / `ImportResult` shape. `server/api/mcp/tools.ts` drops the echoed `Authorization` header from `list_package_files`, updates three tool descriptions, and composes the new import summary. README gets four scoped wording updates.

**Tech Stack:** TypeScript 5.x, Node.js, Express, Jest, `reprepro` 5.4.x, Debian control-file format (RFC 822 paragraphs).

**Spec:** `docs/superpowers/specs/2026-04-24-mcp-deb-round-trip-integrity-design.md`.

**Worktree suggestion:** Work on a feature branch off `master`; the spec is already committed to master. Use `git checkout -b feature/oj-mcp-deb-round-trip-integrity` (personal-repo initial-convention per git-expert rules).

---

## Task 1: Commit the pending `Tracking:` distribution-config edit

The tracking-options change at `server/lib/deb.ts:190` is already in the working tree (from earlier investigation, task #11). It must land first so subsequent integration tests can rely on `.changes` and `.buildinfo` appearing in the pool.

**Files:**
- Modify: `server/lib/deb.ts` (already modified in working tree)

- [ ] **Step 1: Verify the working-tree change is what the spec requires**

Run:
```bash
git diff server/lib/deb.ts
```
Expected diff:
```diff
-            Tracking: minimal
+            Tracking: minimal includechanges includebuildinfos
```

If a different change is staged, stash it and reapply the line above manually.

- [ ] **Step 2: Run the existing deb-related tests to confirm no regression from the config line alone**

Run:
```bash
npm test -- tests/api/app.repo.deb.test.ts tests/api/app.repo.list.deb.test.ts tests/api/app.repo.remove.deb.test.ts
```
Expected: all pass.

- [ ] **Step 3: Stage and commit**

```bash
git add server/lib/deb.ts
git commit -m "Keep .changes and .buildinfo in pool via reprepro tracking flags"
```

---

## Task 2: Create `server/lib/deb-listfilter.ts` with types and format constant

Scaffold the new module with the exported types and the format-string constant. No parser logic yet — start from a stub that throws so the first parser test fails deterministically.

**Files:**
- Create: `server/lib/deb-listfilter.ts`

- [ ] **Step 1: Write the module**

```ts
// server/lib/deb-listfilter.ts
import { posix } from "node:path";

/**
 * reprepro `--list-format` string used by `listPackageFiles`.
 *
 * Four fields per record, TAB-separated, NUL-terminated:
 *   1. ${$type}       — one of "deb" / "ddeb" / "udeb" / "dsc"
 *   2. ${Filename}    — pool-relative path for binaries; empty for source
 *   3. ${Directory}   — pool directory for source; empty for binaries
 *   4. ${Files}       — raw `Files:` control-field body for source;
 *                       empty for binaries
 *
 * TAB is safe as a field separator because no chunk field stored by
 * reprepro contains tabs. NUL is safe as a record separator because
 * Debian control files are text (RFC 822) and cannot contain NUL.
 */
export const LISTFILTER_FORMAT =
    "${$type}\\t${Filename}\\t${Directory}\\t${Files}\\0";

export type ListFilterType = "deb" | "ddeb" | "udeb" | "dsc";

export interface ListFilterEntry {
    type: ListFilterType;
    path: string; // pool-relative, e.g. "pool/main/c/clevis/clevis_22…dsc"
}

export function parseListFilterOutput(_stdout: string): ListFilterEntry[] {
    throw new Error("not implemented");
}

const _posix = posix; // silence unused-import linter until parser uses posix.join
void _posix;
```

- [ ] **Step 2: Confirm TypeScript compiles**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/lib/deb-listfilter.ts
git commit -m "Add deb-listfilter module skeleton"
```

---

## Task 3: Unit-test `parseListFilterOutput` for binary rows (deb / ddeb / udeb)

Binary rows carry the pool path directly in `${Filename}`. `${Directory}` and `${Files}` are empty.

**Files:**
- Create: `tests/lib/deb-listfilter.test.ts`
- Modify: `server/lib/deb-listfilter.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/deb-listfilter.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { parseListFilterOutput } from "../../server/lib/deb-listfilter.ts";

describe("parseListFilterOutput", () => {
    it("parses a single deb record with pool path in Filename", () => {
        // record layout: type\tFilename\tDirectory\tFiles\0
        const stdout =
            "deb\tpool/main/c/clevis/clevis_22-1_amd64.deb\t\t\0";
        expect(parseListFilterOutput(stdout)).toEqual([
            { type: "deb", path: "pool/main/c/clevis/clevis_22-1_amd64.deb" },
        ]);
    });

    it("parses ddeb rows with ddeb type", () => {
        const stdout =
            "ddeb\tpool/universe/c/foo/foo-dbgsym_1_amd64.ddeb\t\t\0";
        expect(parseListFilterOutput(stdout)).toEqual([
            { type: "ddeb", path: "pool/universe/c/foo/foo-dbgsym_1_amd64.ddeb" },
        ]);
    });

    it("parses udeb rows with udeb type", () => {
        const stdout =
            "udeb\tpool/main/d/debian-installer/di_1_amd64.udeb\t\t\0";
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
```

- [ ] **Step 2: Run to confirm it fails**

Run:
```bash
npm test -- tests/lib/deb-listfilter.test.ts
```
Expected: test fails with "not implemented".

- [ ] **Step 3: Implement the binary-row branch**

Replace the stub in `server/lib/deb-listfilter.ts` with:

```ts
export function parseListFilterOutput(stdout: string): ListFilterEntry[] {
    const results: ListFilterEntry[] = [];
    for (const record of stdout.split("\0")) {
        if (record.length === 0) continue;
        const parts = record.split("\t");
        if (parts.length !== 4) {
            throw new Error(
                `malformed listfilter record (expected 4 fields, got ${ parts.length })`,
            );
        }
        const [type, filename /*, directory, files */] = parts;
        if (type === "deb" || type === "ddeb" || type === "udeb") {
            results.push({ type, path: filename });
        }
        // dsc branch added in Task 4
    }
    return results;
}
```

- [ ] **Step 4: Run to confirm tests pass**

Run:
```bash
npm test -- tests/lib/deb-listfilter.test.ts
```
Expected: all four binary-row tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/lib/deb-listfilter.ts tests/lib/deb-listfilter.test.ts
git commit -m "Parse binary listfilter rows in deb-listfilter"
```

---

## Task 4: Extend `parseListFilterOutput` for source rows (dsc + tarballs)

Source rows have an empty `${Filename}`, a pool `${Directory}`, and a multi-line `${Files}` block whose each line has shape `[<leading-space>]<md5> <size> <filename>`.

**Files:**
- Modify: `server/lib/deb-listfilter.ts`
- Modify: `tests/lib/deb-listfilter.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/deb-listfilter.test.ts`:

```ts
describe("parseListFilterOutput — dsc rows", () => {
    it("expands the Files block to one entry per file in the Directory", () => {
        // dsc row: type="dsc", Filename="", Directory="pool/main/c/clevis",
        // Files = "<md5> <size> <filename>\n <md5> <size> <filename>\n <md5> <size> <filename>"
        // Note: first Files line has no leading space (chunk_getwholedata behavior);
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
```

- [ ] **Step 2: Run to confirm they fail**

Run:
```bash
npm test -- tests/lib/deb-listfilter.test.ts
```
Expected: three dsc tests fail (binary tests still pass).

- [ ] **Step 3: Extend the parser with the dsc branch**

Replace the parser body in `server/lib/deb-listfilter.ts` with:

```ts
export function parseListFilterOutput(stdout: string): ListFilterEntry[] {
    const results: ListFilterEntry[] = [];
    for (const record of stdout.split("\0")) {
        if (record.length === 0) continue;
        const parts = record.split("\t");
        if (parts.length !== 4) {
            throw new Error(
                `malformed listfilter record (expected 4 fields, got ${ parts.length })`,
            );
        }
        const [type, filename, directory, files] = parts;
        if (type === "dsc") {
            for (const line of files.split("\n")) {
                // shape: "[leading-space]<md5> <size> <filename>"
                let start = 0;
                while (start < line.length && line.charCodeAt(start) === 0x20) start++;
                if (start === line.length) continue;                // blank line
                const lastSpace = line.lastIndexOf(" ");
                if (lastSpace < start) continue;                    // malformed — skip
                results.push({
                    type: "dsc",
                    path: posix.join(directory, line.slice(lastSpace + 1)),
                });
            }
        } else if (type === "deb" || type === "ddeb" || type === "udeb") {
            results.push({ type, path: filename });
        }
        // unknown types silently ignored (forward-compat)
    }
    return results;
}
```

Remove the `_posix` / `void _posix` scaffolding line from Task 2.

- [ ] **Step 4: Run to confirm all tests pass**

Run:
```bash
npm test -- tests/lib/deb-listfilter.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/lib/deb-listfilter.ts tests/lib/deb-listfilter.test.ts
git commit -m "Parse source listfilter rows and expand Files block"
```

---

## Task 5: Add edge-case tests for `parseListFilterOutput`

Lock down malformed-record rejection and forward-compat behavior.

**Files:**
- Modify: `tests/lib/deb-listfilter.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/lib/deb-listfilter.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to confirm they pass (no implementation change needed — the parser already covers these)**

Run:
```bash
npm test -- tests/lib/deb-listfilter.test.ts
```
Expected: all pass.

If any fail, reconcile with the implementation — the edge cases are already designed into the parser from Task 4.

- [ ] **Step 3: Commit**

```bash
git add tests/lib/deb-listfilter.test.ts
git commit -m "Add edge-case tests for deb-listfilter parser"
```

---

## Task 6: Rewrite `listPackageFiles` to use the new parser

Replace the `listfilter`-default-format path with the new format + parser. Remove the now-dead `parseListfilterLine` and `listfilterToRemovalFiles`. Add a new exec helper that passes `--list-format`.

**Files:**
- Modify: `server/lib/deb.ts` — delete lines 679-706 (old helpers), add format-aware exec + rewrite `listPackageFiles` (around line 728).

- [ ] **Step 1: Delete `parseListfilterLine` and `listfilterToRemovalFiles`**

In `server/lib/deb.ts`, remove the two functions:

```ts
// DELETE: lines 679-685 (parseListfilterLine)
// DELETE: lines 691-706 (listfilterToRemovalFiles)
```

Keep `sourcePoolPrefix` (lines 687-689) — unused by `listPackageFiles` after this task, but still used by `listfilterToRemovalFiles`'s callers elsewhere; verify via grep and remove if truly unreferenced:

```bash
grep -n sourcePoolPrefix server/lib/deb.ts
```

If the only remaining hits are the function definition itself, delete it too.

- [ ] **Step 2: Add a format-aware listfilter exec helper**

Just above the existing `repreproListFilterExec` (currently line 708), add:

```ts
export async function repreproListFilterWithFormatExec(
    repreproBin: string,
    confDir: string,
    release: string,
    formula: string,
    listFormat: string,
): Promise<ActionResult & { stdout: string }> {
    const repreproConfDir = path.isAbsolute(confDir) ? confDir : `+b/${ confDir }`;
    let stdout = "";
    const result = await execOpt({
        levelFn: (stdio, line) => {
            if (stdio === "stdout") {
                stdout += line + "\n";
                return "debug";
            }
            return "warn";
        },
    }, repreproBin,
       "--confdir", repreproConfDir,
       "--list-format", listFormat,
       "listfilter", release, formula);
    return { ...result, stdout };
}
```

**Important:** The stdout capture adds `"\n"` per chunk. The logger's stream-end handler emits one final `\n` *after* the last record's `\0`, so a strict 4-field parser will see a spurious single-byte `"\n"` record at the end and throw. The exec helper must strip exactly one trailing `\n` before returning: `stdout = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;`. Do NOT drop the per-chunk `"\n"` — it preserves the embedded newlines inside `${Files}` bodies that the parser needs to iterate.

- [ ] **Step 3: Import the new module at the top of `server/lib/deb.ts`**

Add (near the other imports at the top of the file):

```ts
import { LISTFILTER_FORMAT, parseListFilterOutput } from "./deb-listfilter.ts";
```

- [ ] **Step 4: Rewrite `listPackageFiles`**

Replace the body of `listPackageFiles` (currently at line 728 in the unmodified file; line numbers shift after Step 1 deletions — find by function name):

```ts
export async function listPackageFiles(
    paths: Paths,
    distro: string,
    release: string,
    source: string,
    version: VersionFilter,
): Promise<DebListResult> {
    assert(paths.repreproBin, "repreproBin is not available");

    const distroMap = await readDistributions(paths.repoStateDir, distro, release);
    if (!distroMap[distro] || !distroMap[distro].releases[release]) {
        return { notFound: true };
    }

    const confDir = path.join(paths.repoStateDir, `deb-${ distro }`, "conf");
    const formula = buildRemoveFormulaForTarget(source, version);

    const listResult = await repreproListFilterWithFormatExec(
        paths.repreproBin, confDir, release, formula, LISTFILTER_FORMAT,
    );
    if (listResult.result !== "success") {
        return { notFound: false, files: [], action: listResult };
    }

    const entries = parseListFilterOutput(listResult.stdout);
    const files: DebRemovalFile[] = entries.map((e) => ({
        filename: path.posix.basename(e.path),
        status: "ok" as const,
        path: path.posix.join("deb", distro, e.path),
    }));
    return { notFound: false, files };
}
```

- [ ] **Step 5: Compile and run the existing deb listing tests**

```bash
npx tsc --noEmit
npm test -- tests/api/app.repo.list.deb.test.ts
```
Expected: compile clean; existing tests may fail because they check for exact filenames — update any test expectation that depended on the old filename reconstruction. Do **not** relax the ddeb and tarball expectations — those become new assertions in Task 7/8.

- [ ] **Step 6: Commit**

```bash
git add server/lib/deb.ts
git commit -m "Rewrite listPackageFiles to use deb-listfilter parser"
```

---

## Task 7: Integration test — tarballs and ddeb appear in `list_package_files`

Regression coverage for the two old bugs: `.orig.tar.*` / `.debian.tar.*` were missing; `.ddeb` rows were misparsed.

**Files:**
- Modify: `tests/api/app.repo.list.deb.test.ts`

- [ ] **Step 1: Inspect the existing test structure**

Run:
```bash
head -60 tests/api/app.repo.list.deb.test.ts
```

Identify the test-data fixture path used, the helper that imports a bundle, and the assertion shape for the list endpoint.

- [ ] **Step 2: Add a test that imports the debian/trixie bundle and asserts tarballs are present**

Append a test in `tests/api/app.repo.list.deb.test.ts` (preserve existing imports / helpers):

```ts
it("returns source tarballs alongside the dsc", async () => {
    // Import packages-initial/deb/debian/trixie/main (19 files incl. .changes).
    await importBundle("packages-initial/deb/debian/trixie/main"); // use repo's existing helper

    const res = await fetch(`${baseUrl}/api/v1/repo/deb/debian/trixie/clevis/22-1+tpm1u0+deb13`, {
        headers: { Authorization: `Bearer ${ token }` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const filenames = new Set(body.files.map((f: { filename: string }) => f.filename));

    expect(filenames.has("clevis_22-1+tpm1u0+deb13.dsc")).toBe(true);
    expect(filenames.has("clevis_22.orig.tar.gz")).toBe(true);
    expect(filenames.has("clevis_22-1+tpm1u0+deb13.debian.tar.xz")).toBe(true);
    expect(filenames.has("clevis_22-1+tpm1u0+deb13_amd64.deb")).toBe(true);
});
```

If the exact helper name / fixture-mounting convention differs, translate the spirit (upload + import the bundle, then assert). The existing tests in the file are the authoritative reference.

- [ ] **Step 3: Add a test that imports ubuntu/noble/universe and asserts ddebs parse correctly**

Append:

```ts
it("parses ddeb rows with the right type and pool path", async () => {
    await importBundle("packages-initial/deb/ubuntu/noble/universe"); // 10 deb + 4 ddeb + dsc + tarballs + changes + buildinfo

    const res = await fetch(`${baseUrl}/api/v1/repo/deb/ubuntu/noble/clevis/22-1+tpm1u0+ubuntu24.04`, {
        headers: { Authorization: `Bearer ${ token }` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ddebs = body.files.filter((f: { filename: string }) =>
        f.filename.endsWith(".ddeb"),
    );
    expect(ddebs).toHaveLength(4);
    for (const f of ddebs) {
        expect(f.path).toMatch(/pool\/universe\/c\/clevis\/.*\.ddeb$/);
        expect(f.status).toBe("ok");
    }
});
```

- [ ] **Step 4: Run both tests**

```bash
npm test -- tests/api/app.repo.list.deb.test.ts
```
Expected: both new tests pass. If either fails, inspect the actual response body and reconcile (either a real implementation bug — fix in Task 6 — or a test-helper mismatch).

- [ ] **Step 5: Commit**

```bash
git add tests/api/app.repo.list.deb.test.ts
git commit -m "Integration tests: tarballs and ddeb surface in list_package_files"
```

---

## Task 8: Directory-discovery for `.changes` / `.buildinfo`

Add a helper that scans the source pool directory for `<dscBase>_<arch-chunk>.changes` and `<dscBase>_<arch-chunk>.buildinfo` where `<arch-chunk>` contains no `_`. Wire it into `listPackageFiles`.

**Files:**
- Modify: `server/lib/deb.ts`
- Modify: `tests/api/app.repo.list.deb.test.ts`

- [ ] **Step 1: Add a discovery helper near `listPackageFiles`**

In `server/lib/deb.ts`, add:

```ts
/**
 * Discover .changes and .buildinfo files in the source's pool directory
 * (enabled via `Tracking: … includechanges includebuildinfos` in the
 * distribution config). Returns pool-relative paths; empty array when the
 * tracking flags are off or the files were never present.
 */
async function discoverChangesAndBuildinfo(
    absoluteRepoDir: string,
    distro: string,
    sourceDir: string,           // pool-relative, e.g. "pool/main/c/clevis"
    dscFilename: string,         // e.g. "clevis_22-1+tpm1u0+deb13.dsc"
): Promise<DebRemovalFile[]> {
    const dscBase = dscFilename.endsWith(".dsc")
        ? dscFilename.slice(0, -".dsc".length)
        : dscFilename;
    const prefix = `${ dscBase }_`;
    const absolutePoolDir = path.join(absoluteRepoDir, "deb", distro, sourceDir);

    let names: string[];
    try {
        names = await fs.readdir(absolutePoolDir);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
    }

    const extra: DebRemovalFile[] = [];
    for (const name of names) {
        if (!name.startsWith(prefix)) continue;
        const rest = name.slice(prefix.length);
        if (rest.includes("_")) continue;
        if (!rest.endsWith(".changes") && !rest.endsWith(".buildinfo")) continue;
        extra.push({
            filename: name,
            status: "ok" as const,
            path: path.posix.join("deb", distro, sourceDir, name),
        });
    }
    return extra;
}
```

Ensure `fs` is imported as `import { promises as fs } from "node:fs";` (check existing imports — may already be present).

- [ ] **Step 2: Call it from `listPackageFiles`**

At the bottom of `listPackageFiles`, replace the `return { notFound: false, files };` with:

```ts
// Augment with .changes/.buildinfo when preserved in the pool by tracking flags.
const dscEntry = entries.find((e) => e.type === "dsc" && e.path.endsWith(".dsc"));
if (dscEntry !== undefined) {
    const sourceDir = path.posix.dirname(dscEntry.path);
    const dscFilename = path.posix.basename(dscEntry.path);
    const extras = await discoverChangesAndBuildinfo(
        paths.repoDir, distro, sourceDir, dscFilename,
    );
    files.push(...extras);
}
return { notFound: false, files };
```

- [ ] **Step 3: Add an integration test**

Append to `tests/api/app.repo.list.deb.test.ts`:

```ts
it("returns .changes and .buildinfo when tracking preserves them", async () => {
    await importBundle("packages-initial/deb/debian/trixie/main");

    const res = await fetch(`${baseUrl}/api/v1/repo/deb/debian/trixie/clevis/22-1+tpm1u0+deb13`, {
        headers: { Authorization: `Bearer ${ token }` },
    });
    const body = await res.json();
    const extensions = new Set(
        body.files.map((f: { filename: string }) => f.filename.replace(/^.*?(\.\w+)$/, "$1")),
    );
    // Actually simpler:
    const filenames: string[] = body.files.map((f: { filename: string }) => f.filename);
    expect(filenames.some((n) => n.endsWith(".changes"))).toBe(true);
    expect(filenames.some((n) => n.endsWith(".buildinfo"))).toBe(true);
});
```

- [ ] **Step 4: Run**

```bash
npm test -- tests/api/app.repo.list.deb.test.ts
```
Expected: new test passes.

- [ ] **Step 5: Commit**

```bash
git add server/lib/deb.ts tests/api/app.repo.list.deb.test.ts
git commit -m "List .changes and .buildinfo via pool directory discovery"
```

---

## Task 9: Drop `Authorization` echo from `list_package_files`

The pool route is unauthenticated; echoing the caller's bearer token into each slot leaks it unnecessarily. Drop the `headers` field and the trailing "(same auth as this request)" clause from the text summary.

**Files:**
- Modify: `server/api/mcp/tools.ts`
- Modify: `tests/api/mcp.test.ts`

- [ ] **Step 1: Remove the echo in the list_package_files handler**

In `server/api/mcp/tools.ts`, around line 231-274, change:

```ts
const callerAuth = req.headers.authorization;
const fileEntries = files.map((f) => {
    const downloadUrl = getUriNoQuery(req, "/" + f.path);
    const entry: {
        filename: string;
        path: string;
        downloadUrl: string;
        method: "GET";
        headers?: { Authorization: string };
    } = {
        filename: f.filename,
        path: f.path,
        downloadUrl,
        method: "GET",
    };
    if (callerAuth) entry.headers = { Authorization: callerAuth };
    return entry;
});
```

to:

```ts
const fileEntries = files.map((f) => ({
    filename: f.filename,
    path: f.path,
    downloadUrl: getUriNoQuery(req, "/" + f.path),
    method: "GET" as const,
}));
```

- [ ] **Step 2: Change the text summary**

Replace:
```ts
: `Found ${ files.length } file(s) across ${ touchedTargets } release(s). `
+ `GET each downloadUrl (same auth as this request) to fetch.`;
```
with:
```ts
: `Found ${ files.length } file(s) across ${ touchedTargets } release(s). `
+ `GET each downloadUrl to fetch; the pool is served without authentication.`;
```

- [ ] **Step 3: Add an MCP integration test that asserts no `headers` field is present**

In `tests/api/mcp.test.ts`, add:

```ts
it("list_package_files does not echo the caller's Authorization header", async () => {
    await importBundle("packages-initial/deb/debian/trixie/main");
    const res = await callTool("list_package_files", {
        format: "deb",
        distribution: "debian",
        release: "trixie",
        source: "clevis",
        version: "22-1+tpm1u0+deb13",
    });
    for (const f of res.structuredContent.files) {
        expect(f).not.toHaveProperty("headers");
    }
});
```

Use the file's existing `callTool` / `importBundle` helper names; adapt if they differ.

- [ ] **Step 4: Run**

```bash
npm test -- tests/api/mcp.test.ts
```
Expected: new test passes.

- [ ] **Step 5: Commit**

```bash
git add server/api/mcp/tools.ts tests/api/mcp.test.ts
git commit -m "Stop echoing caller's Authorization header in list_package_files"
```

---

## Task 10: REST-endpoint parity for Authorization-header echo

Verify the REST endpoint that backs source-file listing doesn't re-implement the same header echo. If it does, drop it.

**Files:**
- Modify (possibly): `server/api/repo/*.ts` or wherever the REST handler for `/api/v1/repo/.../<source>/<version>` lives.

- [ ] **Step 1: Locate the REST handler**

Run:
```bash
grep -rn "downloadUrl" server/api --include='*.ts'
grep -rn "callerAuth\|req.headers.authorization" server/api --include='*.ts' | grep -v mcp
```

If no hit outside `server/api/mcp/`, the REST endpoint already doesn't echo the header — skip to Step 4.

- [ ] **Step 2: If the REST handler has an echo pattern, remove it**

Apply the same structural change as Task 9: drop the conditional `headers: { Authorization: ... }` assignment.

- [ ] **Step 3: Add/update a REST test to pin the behavior**

In `tests/api/app.repo.list.deb.test.ts`, assert no `headers` field appears in REST responses (mirror the assertion shape from Task 9 adapted to the REST response).

- [ ] **Step 4: Run the listing tests**

```bash
npm test -- tests/api/app.repo.list.deb.test.ts tests/api/app.repo.list.rpm.test.ts
```
Expected: all pass.

- [ ] **Step 5: Commit (if anything changed)**

```bash
git add -A server/api tests/api
git commit -m "Ensure REST list endpoint does not echo Authorization header"
```

If Step 1 showed no changes needed, skip the commit.

---

## Task 11: Update `list_package_files` tool description

Align the description with the new coverage (tarballs, ddeb, changes/buildinfo) and drop the stale "same Authorization header" wording.

**Files:**
- Modify: `server/api/mcp/tools.ts`
- Modify: `tests/api/mcp.test.ts`

- [ ] **Step 1: Rewrite the description**

In `server/api/mcp/tools.ts`, replace the `list_package_files` tool's `description` field with:

```ts
        description: "List files belonging to a source package across one "
            + "or many (format, distribution, release) triples. For deb, "
            + "results include the .dsc, source tarballs, binary .deb / "
            + ".ddeb / .udeb, and — when present — the .changes and "
            + ".buildinfo needed to reconstruct an uploadable bundle. For "
            + "rpm, results include the .src.rpm and all its binaries. "
            + "Each result includes a direct HTTPS download URL that can "
            + "be fetched without authentication. Use remove_package to "
            + "delete instead.",
```

- [ ] **Step 2: Update mcp.test.ts if it snapshots tool descriptions**

Run:
```bash
grep -n 'Authorization header the caller used' tests/api/mcp.test.ts
```

If any match, rewrite those snapshots to match the new description. Otherwise no change needed here.

- [ ] **Step 3: Run the mcp tests**

```bash
npm test -- tests/api/mcp.test.ts
```
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add server/api/mcp/tools.ts tests/api/mcp.test.ts
git commit -m "Update list_package_files tool description for full file coverage"
```

---

## Task 12: Define new `ImportFile` / `ImportResult` types

Prepare the shape before the logic lands. This lets subsequent tasks compile cleanly.

**Files:**
- Modify: `server/lib/repo-service.ts` (around line 89, where `ImportResult` lives today)

- [ ] **Step 1: Replace the existing `ImportResult` export**

In `server/lib/repo-service.ts`, replace:

```ts
export interface ImportResult {
    ok: boolean;
    correlationId?: string;
}
```

with:

```ts
export type ImportFileStatus = "ok" | "skipped" | "failed";

export interface ImportFile {
    filename: string;
    /**
     * Import-style path mirroring the upload URL:
     *   deb/<distro>/<release>/<component>[/<subcomponent>]/<filename>
     */
    path: string;
    status: ImportFileStatus;
    reason?: string;
}

export interface ImportResult {
    /** true iff no entry has status === "failed" */
    ok: boolean;
    files: ImportFile[];
}
```

- [ ] **Step 2: Compile — expect failures in callers**

```bash
npx tsc --noEmit
```
Expected: type errors at the call sites of `importRepository` (in `server/api/mcp/tools.ts`) and the implementation inside `server/lib/repo-service.ts` / `server/lib/deb.ts`. Those get fixed in Tasks 13-16.

- [ ] **Step 3: Commit**

```bash
git add server/lib/repo-service.ts
git commit -m "Introduce ImportFile shape for per-file import status"
```

---

## Task 13: Implement pre-scan / post-scan of the `process/deb/` tree

Pure filesystem helpers. Testable in isolation.

**Files:**
- Modify: `server/lib/deb.ts`
- Modify: `tests/lib/repo-service.test.ts` (or create a focused `tests/lib/deb-snapshot.test.ts` if simpler — check convention)

- [ ] **Step 1: Add the types and helper near the top of `server/lib/deb.ts`**

Add (below existing imports):

```ts
interface StagingDirSnapshot {
    /** directory path relative to `process/deb/`, e.g. "debian/trixie/main" */
    dirRel: string;
    /** basenames of files present in this directory */
    files: string[];
    /** true iff at least one file is named "*.changes" */
    hasChanges: boolean;
}

/**
 * Recursively scan process/deb/ and return a flat list of leaf
 * directories with their file basenames and whether a .changes is present.
 */
export async function scanProcessDebTree(
    incomingDebRoot: string,
): Promise<StagingDirSnapshot[]> {
    const snapshots: StagingDirSnapshot[] = [];
    await walk(incomingDebRoot, "", snapshots);
    return snapshots;
}

async function walk(
    root: string, rel: string, out: StagingDirSnapshot[],
): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
        entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
    }
    const files: string[] = [];
    let hasChanges = false;
    let sawSubdir = false;
    for (const e of entries) {
        if (e.isDirectory()) {
            sawSubdir = true;
            await walk(root, path.posix.join(rel, e.name), out);
        } else if (e.isFile()) {
            files.push(e.name);
            if (e.name.endsWith(".changes")) hasChanges = true;
        }
    }
    if (files.length > 0 && !sawSubdir) {
        out.push({ dirRel: rel, files, hasChanges });
    }
}
```

- [ ] **Step 2: Test the scanner**

In a new test file `tests/lib/deb-snapshot.test.ts`:

```ts
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

    it("collects leaf directories with their files", async () => {
        await fs.mkdir(join(root, "debian/trixie/main"), { recursive: true });
        await fs.writeFile(join(root, "debian/trixie/main/a.deb"), "");
        await fs.writeFile(join(root, "debian/trixie/main/a.changes"), "");

        const snaps = await scanProcessDebTree(root);
        expect(snaps).toHaveLength(1);
        expect(snaps[0].dirRel).toBe("debian/trixie/main");
        expect(snaps[0].files.sort()).toEqual(["a.changes", "a.deb"]);
        expect(snaps[0].hasChanges).toBe(true);
    });

    it("marks directories without a .changes correctly", async () => {
        await fs.mkdir(join(root, "debian/forky/main"), { recursive: true });
        await fs.writeFile(join(root, "debian/forky/main/a.deb"), "");

        const snaps = await scanProcessDebTree(root);
        expect(snaps[0].hasChanges).toBe(false);
    });
});
```

- [ ] **Step 3: Run**

```bash
npm test -- tests/lib/deb-snapshot.test.ts
```
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add server/lib/deb.ts tests/lib/deb-snapshot.test.ts
git commit -m "Add recursive scanner for process/deb staging tree"
```

---

## Task 14: Implement snapshot-diff classification inside `processIncoming`

Wrap the existing import loop with pre-scan / post-scan and build the `ImportFile[]` from the diff.

**Files:**
- Modify: `server/lib/deb.ts` (the `processIncoming` function at line 622)

- [ ] **Step 1: Import the new types and correlation-id helper**

Near the top of `server/lib/deb.ts`:

```ts
import type { ImportFile, ImportFileStatus } from "./repo-service.ts";
import { getCorrelationId } from "./logger.ts";  // if not already imported
```

- [ ] **Step 2: Change the return signature**

Change `processIncoming`'s signature:

```ts
// was:
export default async function processIncoming(paths: Paths, gpg: Gpg): Promise<Record<string, ActionResult>> {

// becomes:
export default async function processIncoming(paths: Paths, gpg: Gpg): Promise<ImportFile[]> {
```

- [ ] **Step 3: Rewrite the body to snapshot-diff**

Replace the body of `processIncoming`:

```ts
    assert(paths.repreproBin, "repreproBin is not available");

    const incomingDebRoot = path.join(paths.incomingDir, "process", "deb");

    // Pre-scan: snapshot files + .changes presence per leaf directory.
    const preSnaps = await scanProcessDebTree(incomingDebRoot);
    const preIndex = new Map<string, StagingDirSnapshot>();
    for (const s of preSnaps) preIndex.set(s.dirRel, s);

    const changesMap = await findAndOrganizeChangesFiles(incomingDebRoot);
    const distroMap: DebDistributionMap = await readDistributions(paths.repoStateDir);
    const changesMetadataMap: Record<string, ChangesDirectoryMap> = {};
    const failedDirs = new Set<string>();  // dirRel values of dirs where processincoming errored

    if (Object.keys(changesMap).length !== 0) {
        await ensureDebRootExists(paths, gpg);
        for (const [distro, directoryChangesFiles] of Object.entries(changesMap)) {
            changesMetadataMap[distro] = await parseChangesDirectoryMap(incomingDebRoot, directoryChangesFiles);
        }
        await mergeDistributionsWithChanges(changesMetadataMap, distroMap);

        for (const [distro, directoryChangesFiles] of Object.entries(changesMap)) {
            const distroResults = await processDistribution(
                distro,
                directoryChangesFiles,
                changesMetadataMap[distro],
                distroMap,
                incomingDebRoot,
                paths,
            );
            for (const [dirKey, result] of Object.entries(distroResults)) {
                if (result.result === "error" || result.result === "script") {
                    // dirKey looks like "deb/<distro>/<release>/<component>"
                    failedDirs.add(dirKey.replace(/^deb\//, ""));
                }
            }
        }
    }

    if (!_.isEmpty(distroMap)) {
        await ensureDebRootExists(paths, gpg);
        await reexportAndCleanupDistributions(distroMap, paths);
    }

    // Post-scan: any file still present that was in the pre-snapshot didn't
    // move to the pool.
    const postSnaps = await scanProcessDebTree(incomingDebRoot);
    const postIndex = new Map<string, Set<string>>();
    for (const s of postSnaps) postIndex.set(s.dirRel, new Set(s.files));

    const sharedCid = getCorrelationId();
    const files: ImportFile[] = [];
    for (const pre of preSnaps) {
        const postFiles = postIndex.get(pre.dirRel) ?? new Set<string>();
        for (const name of pre.files) {
            const stillHere = postFiles.has(name);
            const logicalPath = path.posix.join("deb", pre.dirRel, name);

            let status: ImportFileStatus;
            let reason: string | undefined;

            if (!stillHere) {
                status = "ok";
            } else if (!pre.hasChanges) {
                status = "skipped";
                reason = "no .changes file in staging directory";
            } else if (failedDirs.has(pre.dirRel)) {
                status = "failed";
                reason = sharedCid
                    ? `import failed, correlation id=${ sharedCid }`
                    : "import failed";
            } else {
                // Had a .changes, reprepro didn't error on the dir, but file
                // is still present — reprepro skipped it (e.g. duplicate,
                // unused buildinfo, older version rejected). Treat as failed
                // without a correlation id; operator can inspect the log.
                status = "failed";
                reason = "reprepro left file in staging";
            }

            files.push({ filename: name, path: logicalPath, status, ...(reason ? { reason } : {}) });
        }
    }

    return files;
```

Note: the existing `reexportAndCleanupDistributions` is now called unconditionally when `distroMap` isn't empty — same as before. The previous return-value composition is removed.

- [ ] **Step 4: Compile**

```bash
npx tsc --noEmit
```

Expect errors at `importRepository` in `repo-service.ts` — fixed in Task 15.

- [ ] **Step 5: Commit**

```bash
git add server/lib/deb.ts
git commit -m "Compute per-file import status via snapshot-diff of process/deb"
```

---

## Task 15: Update `importRepository` in `repo-service.ts` to return the new shape

Wire the `processIncoming` new return into the service's public API.

**Files:**
- Modify: `server/lib/repo-service.ts`

- [ ] **Step 1: Rewrite `importRepository`**

Around line 233, replace the body:

```ts
public async importRepository(): Promise<ImportResult> {
    if (!this.upload.enabledApi.deb && !this.upload.enabledApi.rpm) {
        throw new RepoServiceUnavailableError("No repository tool available");
    }
    return await lock.forExecOnce(async () => {
        await moveAll(
            osPath.join(this.paths.incomingDir, "staging"),
            osPath.join(this.paths.incomingDir, "process"),
        );

        const files: ImportFile[] = [];
        if (this.upload.enabledApi.deb) {
            files.push(...(await processIncomingDeb(this.paths, this.gpg)));
        }
        if (this.upload.enabledApi.rpm) {
            // RPM keeps its existing return shape for now; translate to ImportFile
            // entries with status="ok" for imported files. RPM-side snapshot-diff
            // is out of scope for this change (see spec §Non-goals).
            const rpmResults = await processIncomingRpm(this.paths, this.gpg);
            for (const [dirKey, result] of Object.entries(rpmResults)) {
                if (result.result === "error" || result.result === "script") {
                    files.push({
                        filename: "(directory)",
                        path: dirKey,
                        status: "failed",
                        reason: "rpm import failed",
                    });
                }
                // Successful RPM directories are not enumerated file-by-file
                // in this iteration — same as before; RPM listing APIs cover it.
            }
        }

        const ok = !files.some((f) => f.status === "failed");
        return { ok, files };
    });
}
```

- [ ] **Step 2: Compile**

```bash
npx tsc --noEmit
```
Expected: errors move to `server/api/mcp/tools.ts` — fixed in Task 16.

- [ ] **Step 3: Commit**

```bash
git add server/lib/repo-service.ts
git commit -m "Return per-file ImportResult from repo-service.importRepository"
```

---

## Task 16: Update `import_repository` MCP wrapper

Emit the new shape in the MCP tool response.

**Files:**
- Modify: `server/api/mcp/tools.ts`

- [ ] **Step 1: Replace the handler body**

In `server/api/mcp/tools.ts`, replace the `import_repository` registration block (around line 168-194) with:

```ts
server.registerTool("import_repository", {
    title: "Import staged uploads",
    description: "Run the repository rebuild for all staged files. "
        + "**Debian imports are .changes-driven:** staged directories "
        + "without a .changes are skipped (reported with "
        + 'status: "skipped"); upload the missing .changes and call '
        + "again to complete them. **RPM imports** process every file, "
        + "but binaries without their .src.rpm won't be reachable by "
        + "list_package_files / remove_package. Returns {ok, files} "
        + "where each file entry carries filename, path, status "
        + "(ok/skipped/failed) and optional reason.",
    inputSchema: {},
}, withLogging("import_repository", async () => {
    try {
        const result = await service.importRepository();
        const imported = result.files.filter((f) => f.status === "ok").length;
        const skipped = result.files.filter((f) => f.status === "skipped").length;
        const failed = result.files.filter((f) => f.status === "failed").length;
        const parts = [
            imported > 0 ? `imported ${ imported } file(s)` : "",
            skipped > 0 ? `skipped ${ skipped } file(s) (no .changes)` : "",
            failed > 0 ? `failed on ${ failed } file(s)` : "",
        ].filter(Boolean);
        const msg = parts.length === 0 ? "nothing to import" : parts.join("; ");
        return successResult(msg, { ok: result.ok, files: result.files });
    } catch (err) {
        return errorResult(err);
    }
}));
```

- [ ] **Step 2: Compile**

```bash
npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add server/api/mcp/tools.ts
git commit -m "Emit per-file import summary in import_repository MCP tool"
```

---

## Task 17: Integration test — `import_repository` ok / skipped / failed outcomes

Drive three staged directories and verify each file's status.

**Files:**
- Create: `tests/api/app.repo.import.deb.test.ts`

- [ ] **Step 1: Write the test**

Use the existing testapp fixture. Skeleton:

```ts
import { describe, expect, it, beforeEach } from "@jest/globals";
import { setupApp, callMcpTool, uploadFilesViaMcp, stageRawFiles } from "./testapp.ts";
// adapt import names to whatever helpers already exist

describe("import_repository — per-file status", () => {
    let ctx: Awaited<ReturnType<typeof setupApp>>;

    beforeEach(async () => {
        ctx = await setupApp();
    });

    it("reports imported, skipped, and failed entries together", async () => {
        // ok dir: full bundle with .changes.
        await uploadFilesViaMcp(ctx, {
            format: "deb",
            distribution: "debian",
            release: "trixie",
            component: "main",
            fixtureDir: "packages-initial/deb/debian/trixie/main",
        });

        // skipped dir: upload only the .dsc + a .deb, no .changes.
        await stageRawFiles(ctx, "deb/debian/bookworm/main", [
            "packages-initial/deb/debian/bookworm/main/clevis_22-1+tpm1u0+deb12.dsc",
            "packages-initial/deb/debian/bookworm/main/clevis_22-1+tpm1u0+deb12_amd64.deb",
        ]);

        // failed dir: upload a .changes referencing a file that isn't present.
        await stageRawFiles(ctx, "deb/debian/forky/main", [
            "packages-initial/deb/debian/forky/main/clevis_22-1+tpm1u0+deb14_amd64.changes",
            // deliberately omit the files listed inside the .changes
        ]);

        const res = await callMcpTool(ctx, "import_repository", {});
        const { ok, files } = res.structuredContent as { ok: boolean; files: Array<{ filename: string; path: string; status: string; reason?: string }> };

        expect(ok).toBe(false); // at least one "failed"

        const byStatus = {
            ok: files.filter((f) => f.status === "ok"),
            skipped: files.filter((f) => f.status === "skipped"),
            failed: files.filter((f) => f.status === "failed"),
        };
        expect(byStatus.ok.length).toBeGreaterThan(0);
        expect(byStatus.skipped.length).toBeGreaterThan(0);
        expect(byStatus.failed.length).toBeGreaterThan(0);

        for (const f of byStatus.ok) {
            expect(f.path).toMatch(/^deb\/debian\/trixie\/main\//);
        }
        for (const f of byStatus.skipped) {
            expect(f.reason).toMatch(/no .changes file/);
            expect(f.path).toMatch(/^deb\/debian\/bookworm\/main\//);
        }
        for (const f of byStatus.failed) {
            expect(f.reason).toMatch(/correlation id=/);
            expect(f.path).toMatch(/^deb\/debian\/forky\/main\//);
        }
    });
});
```

Adjust helper names to what the testapp exposes (see `tests/api/testapp.ts` for the conventions used in this codebase).

- [ ] **Step 2: Run**

```bash
npm test -- tests/api/app.repo.import.deb.test.ts
```
Expected: passes. If the "failed" case doesn't produce a correlation id in `reason`, revisit Task 14 step 4.

- [ ] **Step 3: Commit**

```bash
git add tests/api/app.repo.import.deb.test.ts
git commit -m "Integration test: import_repository reports ok/skipped/failed"
```

---

## Task 18: Update `prepare_upload` + `import_repository` tool descriptions

`import_repository`'s description was rewritten in Task 16; `prepare_upload` still carries the bland one-liner.

**Files:**
- Modify: `server/api/mcp/tools.ts`

- [ ] **Step 1: Rewrite `prepare_upload.description`**

In `server/api/mcp/tools.ts`, replace the `description` of `prepare_upload` (around line 116):

```ts
    description: "Return one PUT URL per filename. Agents upload each "
        + "file then call import_repository. **For deb format:** bundles "
        + "must include the .changes file plus every file it references "
        + "(source .dsc, source tarballs, binary .deb / .ddeb / .udeb, "
        + "and .buildinfo). Partial bundles remain staged and are "
        + 'reported as skipped on import until the matching .changes is '
        + "uploaded. **For rpm format:** upload the .src.rpm alongside "
        + "binary .rpm files — without the source RPM, the source-"
        + "indexed APIs (list_package_files, remove_package) cannot "
        + "enumerate or remove the binaries.",
```

- [ ] **Step 2: Update `mcp.test.ts` if it snapshots tool descriptions**

Run:
```bash
grep -n 'Return one PUT URL per filename' tests/api/mcp.test.ts
```

Update the snapshot value to match the new description.

- [ ] **Step 3: Run the mcp tests**

```bash
npm test -- tests/api/mcp.test.ts
```
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add server/api/mcp/tools.ts tests/api/mcp.test.ts
git commit -m "Expand prepare_upload tool description with deb/rpm requirements"
```

---

## Task 19: README updates

Four scoped edits in `README.md`; each corresponds to a spec §6 item.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add `.changes` requirement in the Deb Upload API section**

Around line 388-410 (existing Debian upload docs), append a short note:

```markdown
> [!IMPORTANT]
> A Debian upload bundle must include the `.changes` file along with
> every file it references (source `.dsc`, source tarballs, binary
> `.deb` / `.ddeb` / `.udeb`, and `.buildinfo`). If any are missing,
> `import_repository` will report the directory's files as `skipped`
> until the complete bundle is staged.
```

- [ ] **Step 2: Update the listing-API section to note `.changes` / `.buildinfo` inclusion**

Around line 744-784:

After the `"files": [...]` example, add:

```markdown
For Debian, the response includes the `.changes` and `.buildinfo`
files when they have been preserved in the pool (enabled by default
via the `Tracking: ... includechanges includebuildinfos` distribution
config). Packages imported before this configuration was in place
will not have them — re-import to backfill.
```

- [ ] **Step 3: Replace the `Authorization header` sentence**

Around line 781:

```markdown
Each `downloadUrl` is an absolute URL pointing at the pool path and
can be fetched without authentication. `touchedTargets` counts the
`(format, distribution, release)` triples that contributed at least
one matching file.
```

- [ ] **Step 4: Add an RPM note at the end of the RPM Upload API section**

Around line 530-600:

```markdown
> [!NOTE]
> Upload the `.src.rpm` alongside its binaries — without the source
> RPM, `list_package_files` and `remove_package` cannot enumerate or
> remove the binaries. This applies to both removal (see §Package
> Removal API) and source-package listing (§Package Listing API).
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "Document .changes bundle requirement and round-trip listing behavior"
```

---

## Task 20: Full test run + cleanup verification

Final confirmation that everything passes together.

- [ ] **Step 1: Clean any temporary state from prior ad-hoc tests**

```bash
rm -f tmp/parse-listfilter.mjs tmp/fmt-final.bin
# leave tmp/clevis-transfer/ alone — it is a useful fixture for manual
# transfer testing and is not part of the normal build.
```

- [ ] **Step 2: Run the entire test suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 3: Run typecheck + lint**

```bash
npx tsc --noEmit
npx eslint server tests
```
Expected: clean.

- [ ] **Step 4: Confirm the branch is ready for PR**

```bash
git log --oneline master..HEAD
```
Expected: one commit per task (roughly 17-19 commits, depending on how Tasks 10/18's "no change" outcomes played out).

- [ ] **Step 5: Push the branch and open a PR via `gh`**

```bash
git push -u origin feature/oj-mcp-deb-round-trip-integrity
gh pr create --title "Make MCP deb round-trip lossless" --body "$(cat <<'EOF'
## Summary
- Preserves `.changes` and `.buildinfo` in the pool via reprepro tracking flags
- Rewrites `list_package_files` to cover source tarballs and `.ddeb` debug packages
- Discovers `.changes`/`.buildinfo` via pool directory scan; omits when absent (retroactive gap)
- Drops the echoed `Authorization` header from `list_package_files` responses
- `import_repository` returns per-file status (`ok` / `skipped` / `failed`) with reason
- Aligns three tool descriptions and README with the `.changes`-driven workflow

Design: `docs/superpowers/specs/2026-04-24-mcp-deb-round-trip-integrity-design.md`

## Test plan
- Unit tests for `deb-listfilter` parser cover binary/source/edge cases
- Integration tests exercise tarballs, `.ddeb`, `.changes`/`.buildinfo` inclusion
- New integration test drives `import_repository` with ok / skipped / failed dirs
EOF
)"
```
