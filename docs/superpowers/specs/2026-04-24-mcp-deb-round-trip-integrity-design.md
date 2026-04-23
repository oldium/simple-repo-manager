# MCP Debian Round-Trip Integrity

## Problem

A transfer of a clevis source package from one Simple Repo Manager instance
(the "home" repo) to a fresh development instance via the MCP surface
exposed three latent issues:

1. **`list_package_files` omits source-auxiliary files.** The tool's
   implementation derives file names from `reprepro listfilter` output, which
   only enumerates entries in `packages.db`. The `.orig.tar.*` and
   `.debian.tar.*` source tarballs are referenced by the `.dsc` but are not
   packages in reprepro's data model, so they never appear in the listing.
   Additionally, Ubuntu-style `.ddeb` debug packages carry a leading `d|`
   in their listfilter identifier that the current parser regex doesn't
   handle — any `.ddeb` row is misinterpreted and emitted with the wrong
   extension.

2. **The caller's bearer token is echoed into the MCP response.**
   `list_package_files` attaches `headers: { Authorization: <caller's
   token> }` to every entry and the tool description tells the caller to
   "fetch each downloadUrl with the same Authorization header the caller
   used". In practice the pool URLs are served by the unauthenticated
   static-file middleware and return 200 without any header; the echoed
   token is unnecessary and leaks the credential into a tool result that
   may be logged or forwarded.

3. **`import_repository` silently succeeds when there is nothing to
   import.** The server's `.changes`-driven import path only enumerates
   directories that contain a `.changes` file. A staged directory with
   only `.dsc` + `.deb` files (e.g. produced by a client that followed
   `list_package_files` output without the missing tarballs) is not
   picked up by `processincoming`, but the tool still returns
   `{ok: true}` — the client has no signal that the upload wasn't
   processed.

In addition, the underlying round-trip was structurally impossible:
reprepro's `processincoming` requires a `.changes` file, and the
`.changes` / `.buildinfo` are consumed during import and not stored in
the pool under the default `Tracking: minimal` configuration. A client
fetching `list_package_files` output from the home repo cannot obtain
the `.changes` needed to feed the development repo's import.

## Goal

The MCP surface is self-describing and lossless for Debian packages:

- Every file needed to reconstruct an uploadable bundle for a given
  `(format, distribution, release, source, version)` is returned by
  `list_package_files` — including source tarballs, `.ddeb` debug
  packages, and (when stored in the pool) the `.changes` and
  `.buildinfo`.
- `prepare_upload` and `import_repository` tool descriptions state
  exactly what the server requires: for deb, a `.changes` file and
  every file it references; for rpm, the `.src.rpm` alongside its
  binaries.
- `import_repository` reports a per-file outcome so a client can react
  to partial bundles without reading server logs.
- `list_package_files` does not echo the caller's credentials in its
  response; pool URLs are documented as unauthenticated.

## Non-goals

- No `.dsc`-only import fallback code path. Staged directories without a
  `.changes` file are reported as `skipped`, not imported via
  `reprepro includedsc`.
- No `.changes` synthesis. Clients must upload a genuine `.changes`.
- No `reprepro includedeb` / `includedsc` / `includeddeb` / `includeudeb`
  usage added to the server.
- No retroactive backfill of `.changes` / `.buildinfo` for packages
  imported before this change. Operators re-import if they need the
  historical data.
- No RPM behavioural changes beyond documentation wording.
- No MCP server-level `instructions` string change. Per-tool
  descriptions are authoritative.

## Design

### 1. Tracking options keep `.changes` and `.buildinfo` in the pool

`server/lib/deb.ts` (`generateDistributionContent`) emits the generated
`conf/distributions` with `Tracking: minimal includechanges
includebuildinfos` instead of `Tracking: minimal`. The two added flags
instruct reprepro to preserve the `.changes` and `.buildinfo` files in
the pool alongside the source package after a successful
`processincoming`. The files are tracked as types `c` and `i` with
refcount 0 in `dumptracks` output and remain at
`pool/<component>/<prefix>/<source>/<src>_<version>_<arches>.changes` /
`<src>_<version>_<arch>.buildinfo` indefinitely (subject to reprepro's
existing `clearvanished` cleanup when the source is removed).

This change is idempotent on re-import — reprepro regenerates the
`conf/distributions` content from the in-memory distribution map on
every import, so the flags take effect immediately for the next
`processincoming` call against any release.

**Retroactive gap.** Packages imported before this change do not have
`.changes` / `.buildinfo` in the pool; there is no mechanism to
backfill them. `list_package_files` silently skips missing files.

### 2. `list_package_files` — listfilter with format, regex-free parser

**New file `server/lib/deb-listfilter.ts`** exports:

```ts
export const LISTFILTER_FORMAT =
    "${$type}\\t${Filename}\\t${Directory}\\t${Files}\\0";

export type ListFilterEntry = {
    type: "deb" | "ddeb" | "udeb" | "dsc";
    path: string;   // pool-relative, e.g. "pool/main/c/clevis/clevis_…dsc"
};

export function parseListFilterOutput(stdout: string): ListFilterEntry[];
```

The format uses NUL as the record separator (guaranteed not to appear
in any chunk field — Debian control format is text) and TAB as the
field separator (guaranteed not to appear in `${$type}`,
`${Filename}`, or `${Directory}` — pool paths have no whitespace;
`${$type}` is an enum). Each record has exactly four fields; the
parser rejects malformed records.

For binary rows (`deb`, `ddeb`, `udeb`), `${Filename}` holds the exact
pool path of the binary — no filename reconstruction is needed. For
source rows (`dsc`), `${Filename}` is empty and `${Directory}` +
`${Files}` together hold the source-package manifest.

The `${Files}` value is the raw `Files:` block from the Sources
chunk — a multi-line `md5 size filename` block with RFC 822
continuation. Debian source filenames contain no whitespace, so the
parser splits by lines, trims leading spaces, and takes the substring
after the last space on each non-blank line.

**`server/lib/deb.ts`** changes:

- Remove `parseListfilterLine` and `listfilterToRemovalFiles` — the
  current buggy parse path (misparses `.ddeb`, never emits tarballs).
- Add a `repreproListFilterWithFormatExec` helper that invokes reprepro
  with `--list-format LISTFILTER_FORMAT`. Signature parallels the
  existing `repreproListFilterExec`.
- Rewrite `listPackageFiles` to call the new exec, parse with
  `parseListFilterOutput`, then augment the result with `.changes` /
  `.buildinfo` (see §3).

The filter formula stays as today: `($Source (== <source>),
$SourceVersion (= <version>))` via `buildRemoveFormulaForTarget`.

### 3. `.changes` / `.buildinfo` — directory discovery

After `parseListFilterOutput` returns, `listPackageFiles` derives the
pool directory from the source row's `Directory` field and the dsc
basename by stripping `.dsc` from the dsc row's filename. For example
`clevis_22-1+tpm1u0+deb13.dsc` yields `dscBase =
"clevis_22-1+tpm1u0+deb13"`.

Debian naming rules guarantee that source names and versions contain no
underscore, architectures are `[a-z0-9]+` joined by `+`, and the
architecture component contains no underscore. So:

```
<dscBase>_<arches>.changes
<dscBase>_<arch>.buildinfo
```

each have exactly one `_` after `dscBase`, and the arch portion
contains no `_`. The implementation reads the pool directory once via
`fs.readdir` and admits files matching the pattern:

```ts
const prefix = `${dscBase}_`;
for (const name of await fs.readdir(absolutePoolDir)) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    if (rest.includes("_")) continue;
    if (rest.endsWith(".changes") || rest.endsWith(".buildinfo")) {
        files.push({
            filename: name,
            path: posix.join("deb", distro, sourceDir, name),
            status: "ok",
        });
    }
}
```

where `sourceDir` comes from the source row's `${Directory}` field
(e.g. `pool/main/c/clevis`), so the full path matches the shape
returned for the other entries: `deb/<distro>/pool/<component>/<prefix>/<source>/<filename>`.

This does not attempt to reproduce reprepro's architecture-joining
algorithm (observed variants include `_amd64.changes`,
`_source+amd64.changes`, `_all+amd64+i386.changes`); the pattern match
accepts whatever reprepro produced. For packages imported without the
tracking flags, the readdir simply returns no matches and
`list_package_files` returns the dsc + tarballs + binaries only.

### 4. Drop `Authorization` echo from `list_package_files`

`server/api/mcp/tools.ts` currently echoes `req.headers.authorization`
into two places:

- `prepare_upload` slot entries — **keep**. PUT uploads target
  `/api/v1/upload/...` which is authenticated; the caller genuinely
  needs the same credential.
- `list_package_files` entries — **drop**. Download URLs target the
  pool path which is served without authentication.

The `headers` field and the `if (callerAuth) entry.headers = ...`
assignment are removed from the `list_package_files` result
construction. The tool description's sentence about "fetch each
downloadUrl with the same Authorization header the caller used" is
replaced with "Each result includes a direct HTTPS download URL that
can be fetched without authentication."

**REST endpoint parity.** The `/api/v1/repo/...` REST endpoint that
backs listing is checked for the same echo pattern. If present, the
same one-line fix applies; if not, no action.

### 5. `import_repository` result shape — snapshot-diff of staging

**New types** in `server/lib/repo-service.ts`:

```ts
export type ImportFileStatus = "ok" | "skipped" | "failed";
export type ImportFile = {
    filename: string;
    path: string;      // deb/<distro>/<release>/<component>[/<sub>]/<filename>
    status: ImportFileStatus;
    reason?: string;   // present for "skipped" and "failed"
};
export type ImportResult = {
    ok: boolean;       // true iff no entry has status === "failed"
    files: ImportFile[];
};
```

`processIncoming` in `server/lib/deb.ts` computes outcomes via a
snapshot-diff around the existing per-directory `processincoming`
loop:

1. **Pre-scan** `data/incoming/process/deb/` recursively. Record for
   each directory whether it contains a `.changes` file, and the list
   of file basenames.
2. **Run** the existing per-directory loop unchanged. For each
   directory that had a `.changes`, `updateIncomingConfigFile` points
   reprepro's `IncomingDir` at that directory; `processincoming`
   either succeeds (moving all files to pool) or fails (leaving them
   in place — reprepro's processincoming is all-or-nothing per
   `.changes`).
3. **Post-scan** the same tree.
4. **Classify** each file from the pre-snapshot:

| Condition | `status` | `reason` |
|---|---|---|
| File gone from `process/` | `"ok"` | — |
| File still in `process/`, dir had `.changes` | `"failed"` | `"import failed, correlation id=<cid>"` |
| File still in `process/`, dir had no `.changes` | `"skipped"` | `"no .changes file in staging directory"` |

All entries use the same **import-style path** shape
`deb/<distro>/<release>/<component>[/<subcomponent>]/<filename>` — the
path the client used to PUT the file. The pool location for imported
files is not surfaced in `import_repository`; it belongs to
`list_package_files`.

The `ok` flag is `true` unless at least one entry is `"failed"`.
Skipped is not a failure — it's a deliberate policy outcome
(report-and-retain). Clients complete a skipped bundle by uploading
the missing `.changes` and calling `import_repository` again;
reprepro deduplicates already-staged files on the second pass.

**MCP wrapper** (`server/api/mcp/tools.ts`, `import_repository`
handler) composes a human-readable summary from the counts and
returns the full `files[]` in `structuredContent`:

```ts
const imported = files.filter((f) => f.status === "ok").length;
const skipped  = files.filter((f) => f.status === "skipped").length;
const failed   = files.filter((f) => f.status === "failed").length;
const msg = [
    imported && `imported ${imported} file(s)`,
    skipped  && `skipped ${skipped} file(s) (no .changes)`,
    failed   && `failed on ${failed} file(s)`,
].filter(Boolean).join("; ") || "nothing to import";
return successResult(msg, { ok, files });
```

The pre-existing error text `"Import failed. Check server logs with
correlation id=..."` is retired for the per-directory-failure case;
the correlation id is now carried in each failed file's `reason`
field. Hard errors thrown from `importRepository` (e.g.
`RepoServiceUnavailableError` when no backends are enabled, filesystem
I/O failures during the pre-scan / post-scan) continue to propagate
through the existing `errorResult` path.

### 6. Tool description and README wording

**`server/api/mcp/tools.ts`** — three tool descriptions are updated:

- **`prepare_upload`**:

  > Return one PUT URL per filename. Agents upload each file then call
  > `import_repository`. **For deb format:** bundles must include the
  > `.changes` file plus every file it references (source `.dsc`,
  > source tarballs, binary `.deb` / `.ddeb` / `.udeb`, and
  > `.buildinfo`). Partial bundles remain staged and are reported as
  > `skipped` on import until the matching `.changes` is uploaded.
  > **For rpm format:** upload the `.src.rpm` alongside binary `.rpm`
  > files — without the source RPM, the source-indexed APIs
  > (`list_package_files`, `remove_package`) cannot enumerate or
  > remove the binaries.

- **`import_repository`**:

  > Run the repository rebuild for all staged files. **Debian imports
  > are `.changes`-driven:** staged directories without a `.changes`
  > are skipped (reported with `status: "skipped"`); upload the
  > missing `.changes` and call again to complete them. **RPM
  > imports** process every file, but binaries without their
  > `.src.rpm` won't be reachable by `list_package_files` /
  > `remove_package`. Returns `{ok, files}` where each file entry
  > carries `filename`, `path`, `status` (`ok`/`skipped`/`failed`)
  > and optional `reason`.

- **`list_package_files`**:

  > List files belonging to a source package across one or many
  > (format, distribution, release) triples. For deb, results include
  > the `.dsc`, source tarballs, binary `.deb` / `.ddeb` / `.udeb`,
  > and — when present — the `.changes` and `.buildinfo` needed to
  > reconstruct an uploadable bundle. For rpm, results include the
  > `.src.rpm` and all its binaries. Each result includes a direct
  > HTTPS download URL that can be fetched without authentication. Use
  > `remove_package` to delete instead.

**`README.md`** — scoped additions, each a sentence or two near
pre-existing sections:

1. **Deb Upload API section**: note that all files referenced by the
   `.changes` must be uploaded alongside it; partial bundles are
   reported as `skipped` by `import_repository`.
2. **RPM Upload API section**: note that uploading the `.src.rpm`
   together with binaries is required for `list_package_files` /
   `remove_package` to enumerate or remove them.
3. **Package Listing API section**: note that `.changes` and
   `.buildinfo` are included for deb packages when present in the
   pool (enabled by default via the `Tracking:` distribution config);
   packages imported before this option was enabled won't have them.
4. **Replace** the "`GET` it with the same authentication used for
   the listing request" sentence in the listing response description
   with "Each `downloadUrl` is an absolute URL pointing at the pool
   path and can be fetched without authentication."

### Testing

**Unit (`tests/lib/`):**

- **New `deb-listfilter.test.ts`** — pure string-in / entries-out
  tests for `parseListFilterOutput` using fixture strings. Covers
  binary-only record, dsc record with 3 files in `Files:` block,
  mixed ddeb row, malformed record count (throws), empty stdout,
  leading-space-first-line and leading-space-subsequent-line both,
  source filenames with `+` and `.` characters.
- **Extend `repo-service.test.ts`** — `importRepository` result
  shape: mock the underlying `processIncoming` to return deterministic
  pre/post snapshots; assert `files[]` has correct `status`, `path`,
  and `reason`.

**Integration (`tests/api/`):**

- **Extend `app.repo.list.deb.test.ts`** — after importing the full
  test-data bundle, `GET /api/v1/repo/deb/debian/trixie/clevis/<ver>`
  returns entries for `.dsc`, `.orig.tar.gz`, `.debian.tar.xz`, all
  `.deb`s, **and** `.changes` + `.buildinfo`. A second case exercises
  a package imported without the tracking flags and asserts the
  response excludes `.changes` / `.buildinfo` but includes all other
  files. Every response is asserted to not contain `headers.Authorization`
  on any entry.
- **Ubuntu `.ddeb` coverage** in the same file — importing
  `test-data/packages-initial/deb/ubuntu/noble/universe` (10 `.deb`
  + 4 `.ddeb` + dsc + tarballs), assert all `.ddeb` entries appear
  with the right pool path. Regression test for the `d|` prefix bug.
- **New `app.repo.import.deb.test.ts`** — drive the MCP
  `import_repository` tool against three staged directories: one
  with a valid `.changes`, one with only `.deb`s / `.dsc` and no
  `.changes`, one with a `.changes` that references a missing file.
  Assert the result `files[]` contains entries with
  `status: "ok"`, `"skipped"`, `"failed"` respectively, each with the
  import-style `path`, and `reason` populated for non-ok.
- **Update `mcp.test.ts`** — snapshot the updated tool descriptions.

**Fixtures.** Use `test-data/packages-initial/deb/...` unmodified. For
the "skipped" integration case, stage a sub-set into the incoming dir
without a `.changes` — trivial to construct in the test setup.
