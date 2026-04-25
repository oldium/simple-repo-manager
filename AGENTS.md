# AGENTS.md — E2E experimentation guide

This project ships a deb/rpm repository manager. Most behaviours are
easiest to verify end-to-end against a running instance rather than via
mocks. This file tells future agents how to drive the system through its
public surfaces (REST + MCP), how to drop into the container for
free-form `reprepro` / `createrepo_c` experiments, and how the on-disk
state under `./data/` is laid out.

## Test packages

This repo does **not** ship test packages. When the user asks you to run
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
the repo signing key (`./repo-key.gpg` → `/repo-key.gpg`) and the public
keyring asset (`./archive-keyring.asc` → `/archive-keyring.asc`).

`./data/` holds **all** mutable server state — incoming uploads, the
generated repository tree, and the per-distribution `reprepro` config —
and is safe to wipe between runs:

```bash
docker compose down
rm -rf ./data/incoming ./data/repo ./data/repo-state
docker compose up -d --build       # --build picks up code changes
until curl -fsS http://127.0.0.1:80/api/v1/status >/dev/null; do sleep 1; done
```

The entrypoint recreates the missing dirs on startup. Rebuild the image
(`--build`) any time you change `server/`, `tsconfig.json`, etc. — the
container runs the baked-in `dist/`, not source.

`.dockerignore` excludes `tmp/*` (except its tracked `.gitignore` and
`README.md`) so scratch files in `tmp/` don't break the in-image lint
step.

## Driving the server: REST upload + MCP import

The intended round-trip is **upload via REST, then import via MCP**.
REST uploads are the only entry that produces correctly-staged files in
`./data/incoming/staging/`; the MCP `import_repository` tool drives the
reprepro / createrepo_c side and returns rich per-file status which the
plain `POST /api/v1/repo/import` REST endpoint does not.

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
`list_source_packages`, `list_package_files`, `prepare_upload`,
`remove_package`. See `server/api/mcp/tools.ts` for the schemas.

A small helper for tallying responses:

```bash
... | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
  const sc=JSON.parse(d).result.structuredContent||{};
  const t={}; for (const f of sc.files||[]) t[f.status]=(t[f.status]||0)+1;
  console.log("counts:", t);
  console.log("reasons:", [...new Set((sc.files||[]).filter(f=>f.reason).map(f=>f.reason))]);
})'
```

## Free-form experiments inside the container

The image carries `reprepro` (5.4.x) and `createrepo_c`. To run them by
hand against the same on-disk state the server uses:

```bash
docker compose exec simple-repo-manager bash

# inside the container:
cd /app
ls data/repo-state/                    # one dir per deb distribution
ls data/repo-state/deb-<distro>/conf/  # distributions, incoming, override

# reprepro takes its conf via --confdir; the project uses one conf dir
# per distribution under data/repo-state/deb-<distro>/conf/.
reprepro --confdir +b/data/repo-state/deb-<distro>/conf list <release>
reprepro --confdir +b/data/repo-state/deb-<distro>/conf listfilter <release> \
  '$Source (== <source-name>)'
reprepro --confdir +b/data/repo-state/deb-<distro>/conf processincoming default

# rpm side: createrepo_c rewrites repodata for one (distro, release).
createrepo_c --update data/repo/rpm/<distro>/<release>
```

Notes:

- `+b/` is reprepro's "basedir-relative" prefix and matches what the
  server passes when invoking it. Absolute paths also work.
- The signing script (`scripts/sign.sh`) is referenced from the
  generated `distributions` file; rebuilds via `processincoming` will
  sign `Release` files using the GPG key mounted at `/repo-key.gpg`.
- `data/incoming/{staging,process,tmp}` are the upload pipeline dirs. A
  REST upload lands in `staging/`; `import_repository` moves the tree
  to `process/` and runs the indexers from there.

## Behaviour notes (config-derived, fixture-independent)

`distributions` is generated with `Limit: 0` (unlimited per-package
versions kept) and `Tracking: minimal includechanges includebuildinfos`.
Under that config:

- A full `dput` bundle drains the staging dir → every file `"ok"`.
- A directory with files but **no `.changes`** is never visited by
  reprepro (it is `.changes`-driven) → those files come back `"skipped"`.
- A `.changes` that references files that aren't present → reprepro
  errors → `"failed"` with a correlation id.
- A directory with a complete bundle plus an extra file not referenced
  by any `.changes` → bundle files `"ok"`, extra file `"skipped"`. (Hard
  to reach via REST because of upload-time filename validation.)

The only `"skipped"` reason emitted is "no .changes file references it".

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

# 4. inspect what landed (adjust the find path to match the format
#    you tested)
docker compose exec simple-repo-manager bash -lc \
  'find /app/data/repo/deb -type f | head'
```

## Capturing slow output

When piping `curl` / `docker exec` output into a filter (`tail`, `grep`,
`jq`, ...) for non-trivial commands, save the full output via `tee` to a
file in `/tmp` first so the unfiltered text is available for re-querying
without redoing the work:

```bash
curl -sS ... | tee /tmp/srm-<desc>.log | jq '...'
```

Delete `/tmp/srm-*.log` once you're done.
