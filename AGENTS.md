# AGENTS.md — E2E experimentation guide

This project ships a deb/rpm repository manager. Most behaviours are
easiest to verify end-to-end against a running instance rather than via
mocks. This file tells future agents how to drive the system through its
public surfaces (REST + MCP), how to inspect and rebuild the repository
database, and how the on-disk state under `./data/` is laid out.

## Test packages

Apart from the small synthetic fixtures under `tests/fixtures/packages/`
(`deb/debian/bookworm`, `deb/debian/trixie`, `deb/ubuntu/noble`,
`rpm/fedora/42`), `tests/fixtures/packages-arm64/` (a binary-only arm64
upload) and `tests/fixtures/packages-udeb/`, this repo does **not** ship
test packages. When the user asks you to run
end-to-end tests, ask them where their test packages are unless they've
already told you. A typical answer is a directory tree shaped like the
upload paths the server accepts:

```
<TEST_DATA_DIR>/deb/<distro>/<release>/<component>[/<subcomponent>]/...
<TEST_DATA_DIR>/rpm/<distro>/<release>/...
```

Each leaf dir under `deb/` should be a complete `dput` bundle: a
`.changes` plus every file it references (`.dsc`, source tarballs,
`.buildinfo`, the `.deb` / `.ddeb` / `.udeb` binaries). Each leaf dir
under `rpm/` is just `.rpm` / `.src.rpm` files (no `.changes`).

If the user offers something differently shaped — e.g. a flat dir, a
single bundle, packages organised by source name — adapt the upload
loops below to walk it. Don't assume a specific layout, distro, release,
component, or version pair; pick targets out of what the user gives you
and confirm any non-obvious mapping with them before running. **Never
upload anything outside the directory the user pointed you at.**

## Compose stack

`docker compose` (`compose.yaml` + `compose.override.yaml`) runs the
server on `http://127.0.0.1:80` (and `[::1]:80`), with `./data/`
bind-mounted to `/app/data` inside the container. The override mounts
the repo signing key (`./repo-key.gpg` → `/app/repo-key.gpg`) read-only;
the server derives the published public keyrings from it. With that key an
import refuses what it did not sign, so the unsigned fixtures fail there: sign
them with `signBundle` and `signRpm` from `tests/signing.ts`, or leave the key out.

`./data/` holds **all** mutable server state — incoming uploads, the
generated repository tree, and the repository database
`repo-state/repo.db` — and is safe to wipe between runs:

```bash
docker compose down
rm -rf ./data/incoming ./data/repo ./data/repo-state
docker compose up -d --build       # --build picks up code changes
until curl -fsS http://127.0.0.1:80/api/v1/status >/dev/null; do sleep 1; done
```

The server recreates the missing dirs. Wiping only `./data/repo-state`
while `./data/repo/deb` or `./data/repo/rpm` exists makes the next start
rebuild the database from the tree (see
[Rebuilding the database](#rebuilding-the-database)).
Rebuild the image
(`--build`) any time you change `server/`, `styles/`, etc. — the
container runs the sources baked into the image, not your checkout.

`.dockerignore` lets in only what lint, tests and the build read, so a
new file they need outside `server/`, `tests/`, `types/`, `public/` and
`styles/` needs a line there.

## Driving the server: REST upload + MCP import

The intended round-trip is **upload via REST, then import via MCP**.
REST uploads are the only entry that produces correctly-staged files in
`./data/incoming/staging/`; the MCP `import_repository` tool runs the
import and returns rich per-file status which the plain
`POST /api/v1/repo/import` REST endpoint does not.

### Upload (REST, multipart POST)

The upload field name is `package` (overridable via `UPLOAD_POST_FIELD`).
Server-side validation rejects filenames that don't match the expected
extensions (`.deb|.tar.*|.buildinfo|.changes|.dsc|.ddeb|.udeb` for deb,
`.rpm` for rpm). PUT is also supported — see `server/api/upload/put.ts`.

Endpoints:

- Debian: `POST /api/v1/upload/deb/<distro>/<release>/<component>[/<subcomponent>]`
- RPM:    `POST /api/v1/upload/rpm/<distro>/<release>` (no component)

Generic upload loop — fill in `SRC_DIR` and the path segments to match
whatever the user gave you:

```bash
SRC_DIR=<absolute-or-relative-path-to-one-leaf-bundle>
ARGS=""
for f in "$SRC_DIR"/*; do ARGS="$ARGS -F package=@$f"; done
# shellcheck disable=SC2086
curl -sS -X POST $ARGS \
  http://127.0.0.1:80/api/v1/upload/deb/<distro>/<release>/<component>
```

To upload many leaf dirs in one go, walk them and POST each to its
matching path. Don't hard-code a layout — derive the URL segments from
the directory structure the user provided.

### Import (MCP, JSON-RPC over HTTP)

The MCP transport at `/api/v1/mcp` is stateless (`sessionIdGenerator:
undefined`, `enableJsonResponse: true`), so a single POST works:

```bash
curl -sS -X POST http://127.0.0.1:80/api/v1/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"import_repository","arguments":{}}}'
```

`structuredContent` carries `{ ok: boolean, files: [{ filename, path,
status: "ok"|"skipped"|"failed", reason? }] }`. Other tools, all
callable the same way: `server_status`, `list_repositories`,
`list_source_packages`, `search_packages`, `list_package_files`, `prepare_upload`,
`get_setup_instructions`, `remove_package`. See `server/api/mcp/tools.ts` for the schemas.
With `API_PUBLIC_READ`, `/webmcp.js` offers the read tools to agents in the browser
(`server/api/mcp/webmcp.ts`); the Jest tests run it against a stand-in for the browser API.

A small helper for tallying responses:

```bash
... | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
  const sc=JSON.parse(d).result.structuredContent||{};
  const t={}; for (const f of sc.files||[]) t[f.status]=(t[f.status]||0)+1;
  console.log("counts:", t);
  console.log("reasons:", [...new Set((sc.files||[]).filter(f=>f.reason).map(f=>f.reason))]);
})'
```

## Inspecting the repository database

All repository state lives in `data/repo-state/repo.db` (SQLite, WAL);
the published tree under `data/repo/` is generated from it. The runtime
image has no `sqlite3` CLI, the devcontainer (`Dockerfile.dev`) has.
Open the database read-only, the server is its only writer:

```bash
sqlite3 -readonly data/repo-state/repo.db
```

```sql
.tables
SELECT format, distro, name FROM releases;
SELECT component, source, version FROM deb_sources WHERE source = '<source-name>';
SELECT kind, package, version, architecture FROM deb_binaries WHERE source = '<source-name>';
SELECT filename, source_name, source_version FROM rpm_packages WHERE source_name = '<source-name>';
-- files waiting for the hourly GC, removed_at in Unix seconds
SELECT path, removed_at FROM pool_files WHERE removed_at IS NOT NULL;
```

The schema is in `server/backend/db.ts`.

Notes:

- `data/incoming/{staging,process,tmp}` are the upload pipeline dirs. A
  REST upload lands in `staging/`; `import_repository` moves the tree
  to `process/` and imports from there. Skipped and failed files stay
  in `process/`; every later import, and the next start, retries them.
- `data/repo-state/shadow/` holds uncompressed copies of the published
  indexes, `data/repo-state/tmp/` temporary files.

## Rebuilding the database

`--rebuild` rebuilds `repo.db` from the published tree before the server
starts serving. A missing `repo.db` while `data/repo/deb` or
`data/repo/rpm` exists triggers the same rebuild at start (the one-time
migration from 2.x).
Any problem — an unreadable package, a checksum mismatch, a missing
file — is logged and aborts the start, with nothing on disk changed.

```bash
docker compose stop
docker compose run --rm simple-repo-manager \
  node server/server.ts --rebuild
# it keeps serving after the rebuild: Ctrl+C, then
docker compose up -d
```

## Behaviour notes (fixture-independent)

Every uploaded version stays published, and each Debian upload keeps
its `.changes` and `.buildinfo` in the source's pool directory.

- A full `dput` bundle drains the staging dir → every file `"ok"`.
- A directory with files but **no `.changes`** is never visited (Debian
  import is `.changes`-driven) → those files come back `"skipped"`.
- A `.changes` that references files that aren't present → `"failed"`;
  its files stay in `data/incoming/process/` and later imports retry
  them.
- A directory with a complete bundle plus an extra file not referenced
  by any `.changes` → bundle files `"ok"`, extra file `"skipped"`. (Hard
  to reach via REST because of upload-time filename validation.)

`"skipped"` reasons:

- Debian: "no .changes file references it", with "; <file> could not
  be parsed" appended when a `.changes` in that directory is unreadable.
- RPM: "not an .rpm file" and "not in a <distro>/<release> directory".

`"failed"` reasons carry the correlation id of the server log lines:
`import failed, correlation id=<cid>: <cause>` for validation errors
(missing or mismatching files, a release not in `Distribution:`, a
conflicting overwrite), only `import failed, correlation id=<cid>` for
unexpected errors, whose cause is in the log only.

## Common test loop

```bash
# 1. clean slate
docker compose down
rm -rf ./data/incoming ./data/repo ./data/repo-state
docker compose up -d --build
until curl -fsS http://127.0.0.1:80/api/v1/status >/dev/null; do sleep 1; done

# 2. upload (use the path segments / SRC_DIR for whatever fixtures the
#    user pointed you at)
SRC_DIR=<...>
ARGS=""; for f in "$SRC_DIR"/*; do ARGS="$ARGS -F package=@$f"; done
# shellcheck disable=SC2086
curl -sS -X POST $ARGS \
  http://127.0.0.1:80/api/v1/upload/<format>/<distro>/<release>[/<component>]

# 3. import
curl -sS -X POST http://127.0.0.1:80/api/v1/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"import_repository","arguments":{}}}'

# 4. inspect what landed, on the host: the image has no shell (adjust
#    the find path to match the format you tested)
find ./data/repo/deb -type f | head
```

## End-to-end scripts

From the repository root, each writing to `tmp/`:

- `bash tests/e2e/verify-native.sh`: the migration of a captured 2.x tree, uploads, removal and `docker kill` on the Compose stack, with real clients.
- `bash tests/e2e/chunk-compat.sh <golden tree>`: real apt and dnf against chunked indexes.
- `node tests/e2e/native-windows.mjs`: on Windows after `npm run build`, the server running natively on NTFS, with real clients in containers.

## Capturing slow output

When piping `curl` / `docker exec` output into a filter (`tail`, `grep`,
`jq`, ...) for non-trivial commands, save the full output via `tee` to a
file in `/tmp` first so the unfiltered text is available for re-querying
without redoing the work:

```bash
curl -sS ... | tee /tmp/srm-<desc>.log | jq '...'
```

Delete `/tmp/srm-*.log` once you're done.
