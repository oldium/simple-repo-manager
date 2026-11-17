#!/bin/bash
# End-to-end verification of the native backend on the compose stack.
# Run from the repository root, with Docker running and after npm install:
#   bash tests/e2e/verify-native.sh
# Wipes ./data/{incoming,repo,repo-state}, builds the image and serves it with a throwaway
# signing key through tmp/verify-native/compose.yaml (never compose.override.yaml). Inputs:
# tmp/golden-real/initial (a 2.x tree), ../test-data/packages-update and tests/fixtures.
# Every check prints one PASS or FAIL line; full output goes to tmp/verify-native/logs/.
# Afterwards the stack is down and ./data holds state signed with that key: wipe those
# directories before starting the stack again.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/clients.sh"

# Container paths reach docker verbatim under Git Bash
export MSYS_NO_PATHCONV=1
# A PASS must cover the whole client matrix
unset CLIENTS

golden="tmp/golden-real/initial"
update="../test-data/packages-update"
work="tmp/verify-native"
logs="${work}/logs"
tool="${work}/tool.mjs"
signed="${work}/signed"
pubkey="${work}/keys/pubkey.asc"
override="${work}/compose.yaml"
base="http://127.0.0.1:80"
api="${base}/api"
root="$(pwd -W 2>/dev/null || pwd)"

# Versions from ../test-data that the removal check takes out again
deb_removal=(deb debian trixie clevis 22-1+tpm1u0+deb13)
rpm_removal=(rpm fedora 42 clevis 22-1.tpm1u0.fc42)
clients=(
    # name|image|kind|repo path|suites|components|packages
    "bullseye|debian:bullseye|deb|deb/debian|bullseye|main|clevis"
    "trixie|debian:trixie|deb|deb/debian|trixie|main|clevis"
    "forky|debian:forky|deb|deb/debian|forky|main|clevis"
    "noble|ubuntu:noble|deb|deb/ubuntu|noble|universe|clevis"
    # No requires, so dnf needs nothing from the distribution
    "fedora42|fedora:42|rpm|rpm/fedora/42|||clevis-debugsource"
    "stream9|quay.io/centos/centos:stream9|rpm|rpm/centos/9|||clevis-debugsource"
    "stream10|quay.io/centos/centos:stream10|rpm|rpm/centos/10|||clevis-debugsource"
)

die() {
    echo "$*" >&2
    exit 1
}

dc() {
    docker compose -f compose.yaml -f "${override}" "$@"
}

# step <name> <command>...: full output in ${logs}/<check>-<name>.log; on failure the first
# "problem:" line the command printed becomes the reason
step() {
    local name=$1 log="${logs}/${check}-$1.log" problem count
    shift
    "$@" > "${log}" 2>&1 && return 0
    problem=$(grep -m 1 '^problem: ' "${log}" || true)
    count=$(grep -c '^problem: ' "${log}" || true)
    reason="${problem#problem: }"
    [[ -n "${reason}" ]] || reason="${name} failed"
    if ((count > 1)); then reason+=" (+$((count - 1)) more)"; fi
    reason+=", see ${log}"
    return 1
}

server_up() {
    node "${tool}" ready "${api}" && return 0
    reason="the server is not answering"
    return 1
}

# Until the status endpoint answers; fails at once when the container stops
wait_ready() {
    local i
    for ((i = 0; i < 900; i++)); do
        node "${tool}" ready "${api}" && return 0
        if [[ -z "$(dc ps -q --status running simple-repo-manager)" ]]; then
            dc logs --no-color simple-repo-manager > "${logs}/server-stopped.log" 2>&1
            grep -o 'Rebuild: .*' "${logs}/server-stopped.log" | sed 's/^/problem: /' || true
            echo "problem: the server stopped, see ${logs}/server-stopped.log"
            return 1
        fi
        sleep 1
    done
    echo "problem: no status answer within 900 s"
    return 1
}

compare_restored() {
    find ./data/repo -type f | LC_ALL=C sort > "${work}/restored-files.txt"
    LC_ALL=C sort "${golden}/files.txt" | diff -u - "${work}/restored-files.txt" \
        || { echo "problem: the restored tree differs from ${golden}/files.txt"; return 1; }
    find ./data/repo -type l -printf '%p -> %l\n' | LC_ALL=C sort > "${work}/restored-links.txt"
    LC_ALL=C sort "${golden}/symlinks.txt" | diff -u - "${work}/restored-links.txt" \
        || { echo "problem: the restored symlinks differ from ${golden}/symlinks.txt"; return 1; }
}

state_digests() {
    (cd data/repo-state && find deb-* -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum)
}

# Runs as the server's user, so the server can move what it restores
restore_script=$(cat <<'EOF'
const crypto = require("node:crypto");
const fs = require("node:fs");
process.chdir("/app/data");
fs.mkdirSync("repo", { recursive: true });
for (const format of ["deb", "rpm"]) {
    fs.cpSync(`/golden/${format}`, `repo/${format}`, { recursive: true });
}
for (const line of fs.readFileSync("/golden/symlinks.txt", "utf8").split("\n").filter(Boolean)) {
    const at = line.indexOf(" -> ");
    fs.symlinkSync(line.slice(at + 4), `/app/${line.slice(0, at).replace(/^\.\//, "")}`);
}
// Stand-in for the reprepro state, which the capture lacks
for (const dir of fs.readdirSync("/golden/deb", { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const state = `repo-state/deb-${dir.name}`;
    fs.mkdirSync(`${state}/conf`, { recursive: true });
    fs.mkdirSync(`${state}/db`, { recursive: true });
    fs.writeFileSync(`${state}/conf/distributions`, "Codename: stand-in\nComponents: main\nArchitectures: amd64 source\n");
    fs.writeFileSync(`${state}/db/packages.db`, crypto.randomBytes(65536));
}
EOF
)

removed_at_script=$(cat <<'EOF'
const { Database } = require("node:sqlite");
const paths = require("node:fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
const db = new Database("data/repo-state/repo.db", { readOnly: true });
const select = db.prepare("SELECT removed_at FROM pool_files WHERE path = ?");
let bad = 0;
if (paths.length === 0) {
    console.log("problem: no paths to check");
    bad++;
}
for (const path of paths) {
    const removedAt = select.get(path)?.removed_at ?? null;
    console.log(`${removedAt} ${path}`);
    if (removedAt === null) {
        console.log(`problem: ${path} has no removed_at`);
        bad++;
    }
}
process.exit(bad > 0 ? 1 : 0);
EOF
)

removed_at() {
    dc exec -T simple-repo-manager node -e "${removed_at_script}" < "$1"
}

check_rebuild() {
    step restore dc run --rm --no-deps -T -v "${root}/${golden}:/golden:ro" simple-repo-manager \
        node -e "${restore_script}" || return 1
    step restored compare_restored || return 1
    state_digests > "${work}/state-before.txt" && [[ -s "${work}/state-before.txt" ]] \
        || { reason="cannot hash repo-state/deb-*"; return 1; }
    step start dc up -d || return 1
    step ready wait_ready || return 1
    dc logs --no-color simple-repo-manager > "${logs}/rebuild-server.log" 2>&1
    grep -q 'Rebuilding the repository database from the published tree' "${logs}/rebuild-server.log" \
        || { reason="the server did not rebuild, see ${logs}/rebuild-server.log"; return 1; }
    [[ -f data/repo-state/repo.db && ! -e data/repo-state/repo.db.rebuild ]] \
        || { reason="repo.db is missing or repo.db.rebuild is left over"; return 1; }
    state_digests > "${work}/state-after.txt" || { reason="cannot hash repo-state/deb-*"; return 1; }
    step state diff -u "${work}/state-before.txt" "${work}/state-after.txt" \
        || { reason="the reprepro state under repo-state/deb-* changed, see ${logs}/rebuild-state.log"; return 1; }
    step verify node "${tool}" verify data/repo "${pubkey}" strict || return 1
    step golden node "${tool}" golden "${golden}" data/repo || return 1
    step keyring node "${tool}" keyring "${base}" "${pubkey}" || return 1
    step leftovers node "${tool}" leftovers data/repo || return 1
}

check_clients() {
    server_up || return 1
    local cid net dir="${logs}/${check}"
    cid=$(dc ps -q simple-repo-manager)
    net=$(docker inspect -f '{{range $net, $config := .NetworkSettings.Networks}}{{$net}} {{end}}' "${cid}")
    net=${net%% *}
    mkdir -p "${dir}"
    run_clients srm-verify "${net}" "http://simple-repo-manager:3000" "${root}/${work}" "${dir}" "${clients[@]}" \
        > "${logs}/${check}.log" 2>&1 && return 0
    if ((${#client_results[@]} == 0)); then
        reason="no client ran"
    else
        reason="${client_failed[*]} failed, see ${dir}/"
    fi
    return 1
}

check_reupload() {
    server_up || return 1
    local trixie="data/repo/deb/debian/dists/trixie" conflict="${work}/conflict" name
    local -a staged=()
    step update-upload node "${tool}" upload "${api}" "${signed}/packages-update" . || return 1
    step update-import node "${tool}" import "${api}" all-ok || return 1
    # A full srm-hello build first, so the arm64 bundle lands next to amd64 and source
    step base-upload node "${tool}" upload "${api}" "${signed}/packages" deb/debian/trixie/main || return 1
    step base-import node "${tool}" import "${api}" all-ok || return 1
    step arm64-upload node "${tool}" upload "${api}" "${signed}/packages-arm64" . || return 1
    step arm64-import node "${tool}" import "${api}" all-ok || return 1
    step arm64 node "${tool}" listed "${trixie}" main/binary-arm64/Packages.gz Package=srm-hello Architecture=arm64 || return 1
    step amd64 node "${tool}" listed "${trixie}" main/binary-amd64/Packages.gz Package=srm-hello Architecture=amd64 || return 1
    step source node "${tool}" listed "${trixie}" main/source/Sources.gz Package=srm-hello || return 1
    step conflict-bundle node "${tool}" conflict tests/fixtures/packages/deb/debian/trixie/main \
        "${conflict}/deb/debian/bookworm/main" bookworm || return 1
    step conflict-sign node "${tool}" sign "${work}/keys/private.asc" "${conflict}" "${signed}/conflict" || return 1
    step conflict-upload node "${tool}" upload "${api}" "${signed}/conflict" . || return 1
    step conflict-import node "${tool}" import "${api}" failed srm-hello_1.0.orig.tar.gz "is in the pool with other content" || return 1
    step conflict-pool cmp tests/fixtures/packages/deb/debian/trixie/main/srm-hello_1.0.orig.tar.gz \
        data/repo/deb/debian/pool/main/s/srm-hello/srm-hello_1.0.orig.tar.gz || return 1
    # Failed files stay staged, and every later import would fail on them again
    for name in "${conflict}"/deb/debian/bookworm/main/*; do
        staged+=("data/incoming/process/deb/debian/bookworm/main/${name##*/}")
    done
    step conflict-cleanup dc exec -T simple-repo-manager \
        node -e 'for (const file of process.argv.slice(1)) require("node:fs").rmSync(file, { force: true })' "${staged[@]}" || return 1
    step verify node "${tool}" verify data/repo "${pubkey}" strict || return 1
}

check_removal() {
    server_up || return 1
    step immediate node "${tool}" removal "${api}" "${base}" true "${deb_removal[@]}" "${work}/freed-immediate.txt" || return 1
    step gc node "${tool}" removal "${api}" "${base}" false "${rpm_removal[@]}" "${work}/freed-gc.txt" || return 1
    step removed-at removed_at "${work}/freed-gc.txt" || return 1
    step verify node "${tool}" verify data/repo "${pubkey}" strict "${work}/freed-immediate.txt" "${work}/freed-gc.txt" || return 1
}

# Upload, import and remove srm-hello; the import and both removals republish
publish_cycle() {
    node "${tool}" upload "${api}" "${signed}/packages" deb/debian/trixie/main \
        && node "${tool}" upload "${api}" "${signed}/packages" rpm/fedora/42 \
        && node "${tool}" import "${api}" "$1" \
        && node "${tool}" remove "${api}" deb debian trixie srm-hello - false \
        && node "${tool}" remove "${api}" rpm fedora 42 srm-hello - false
}

publish_loop() {
    while publish_cycle any; do
        :
    done
}

# Restarts that found a publish a kill had interrupted
interrupted_publishes() {
    dc logs --no-color simple-repo-manager > "${logs}/crash-server.log" 2>&1
    grep -cE 'Startup reconciliation: .*(published|repaired)' "${logs}/crash-server.log" || true
}

check_crash() {
    server_up || return 1
    local begin cycle baseline delay i round=0 interrupted=0
    begin=${SECONDS}
    step warmup publish_cycle all-ok || return 1
    cycle=$((SECONDS - begin + 1))
    baseline=$(interrupted_publishes)
    # A kill can land between publishes, so repeat until enough landed inside one
    while ((interrupted < 3 && round < 8)); do
        round=$((round + 1))
        # Each third of the cycle in turn, so that kills reach the removals as well as the import
        delay=$((cycle * ((round - 1) % 3) / 3 + RANDOM % (cycle / 3 + 1) + 1))
        echo "round ${round}: kill after ${delay} s of a ${cycle} s cycle" >> "${logs}/crash.log"
        publish_loop > "${logs}/crash-loop-${round}.log" 2>&1 &
        loop_pid=$!
        sleep "${delay}"
        step "kill-${round}" dc kill simple-repo-manager || return 1
        # A request the kill cut off could otherwise hang until its timeout
        for ((i = 0; i < 30; i++)); do kill -0 "${loop_pid}" 2>/dev/null || break; sleep 1; done
        kill "${loop_pid}" 2>/dev/null || true
        wait "${loop_pid}" || true
        loop_pid=""
        # What a client sees before the restart: InRelease and repomd.xml list only files on disk
        step "client-view-${round}" node "${tool}" verify data/repo "${pubkey}" client || return 1
        step "restart-${round}" dc start simple-repo-manager || return 1
        step "ready-${round}" wait_ready || return 1
        step "reconciled-${round}" node "${tool}" verify data/repo "${pubkey}" strict || return 1
        interrupted=$(($(interrupted_publishes) - baseline))
    done
    echo "${interrupted} of ${round} kills interrupted a publish"
    ((interrupted > 0)) || { reason="no kill interrupted a publish, see ${logs}/crash.log"; return 1; }
    step final-upload-deb node "${tool}" upload "${api}" "${signed}/packages" deb/debian/trixie/main || return 1
    step final-upload-rpm node "${tool}" upload "${api}" "${signed}/packages" rpm/fedora/42 || return 1
    step final-import node "${tool}" import "${api}" all-ok || return 1
    step final-verify node "${tool}" verify data/repo "${pubkey}" strict || return 1
}

failed=0
run_check() {
    check=$1
    reason=""
    echo "== ${check}"
    if "$2"; then
        echo "PASS ${check}"
    else
        echo "FAIL ${check}: ${reason:-see ${logs}/}"
        failed=1
    fi
}

cleanup() {
    set +e
    if [[ -n "${loop_pid:-}" ]]; then
        kill "${loop_pid}" 2>/dev/null
        wait "${loop_pid}" 2>/dev/null
    fi
    if [[ -n "${started:-}" ]]; then
        dc logs --no-color > "${logs}/server.log" 2>&1
        dc down > "${logs}/down.log" 2>&1
        echo "The stack is down. ./data holds state signed with the throwaway key: wipe ./data/{incoming,repo,repo-state} before starting it again."
    fi
    remove_clients srm-verify "${clients[@]}"
}

[[ -f compose.yaml && -d node_modules/openpgp ]] || die "run from the repository root after npm install"
for input in "${golden}/files.txt" "${golden}/symlinks.txt" "${golden}/deb" "${golden}/rpm" "${update}" \
    tests/fixtures/packages/deb/debian/trixie/main tests/fixtures/packages/rpm/fedora/42 tests/fixtures/packages-arm64; do
    [[ -e "${input}" ]] || die "missing input: ${input}"
done
docker info > /dev/null 2>&1 || die "docker is not running"

rm -rf "${work}"
mkdir -p "${logs}"
write_client_scripts "${work}"
cat > "${override}" <<EOF
services:
  simple-repo-manager:
    volumes:
      - ./${work}/keys/private.asc:/app/verify-key.asc:ro
    environment:
      GPG_REPO_PRIVATE_KEY_FILE: /app/verify-key.asc
EOF

cat > "${tool}" <<'TOOL'
// verify-native.sh helper: node tool.mjs <command> <args>...; failures print "problem: ..." lines and exit 1
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, openAsBlob, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync, zstdDecompressSync } from "node:zlib";
import * as openpgp from "openpgp";

let problems = 0;

function problem(text) {
    problems++;
    console.log(`problem: ${text}`);
}

const hash = (alg, data) => createHash(alg).update(data).digest("hex");
const tag = (text, re) => text.match(re)?.[1] ?? "";
const unxml = (s) => s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e]);

function readText(file) {
    try {
        return readFileSync(file, "utf8");
    } catch (err) {
        if (err.code === "ENOENT") return undefined;
        throw err;
    }
}

/** Sorted names of the subdirectories (dirs) or the other entries of dir; none when it is missing */
function names(dir, dirs) {
    try {
        return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() === dirs).map((e) => e.name).sort();
    } catch (err) {
        if (err.code === "ENOENT") return [];
        throw err;
    }
}

const digests = new Map();

function digest(file) {
    if (!digests.has(file)) {
        let value;
        try {
            const data = readFileSync(file);
            value = { size: data.length, md5: hash("md5", data), sha256: hash("sha256", data) };
        } catch (err) {
            if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
        }
        digests.set(file, value);
    }
    return digests.get(file);
}

/** Control stanzas as maps; a continuation line keeps its text after the leading space */
function stanzas(text) {
    const out = [];
    for (const block of text.split("\n\n")) {
        const fields = new Map();
        let last;
        for (const line of block.split("\n")) {
            if (line.startsWith(" ") || line.startsWith("\t")) {
                if (last !== undefined) fields.set(last, `${fields.get(last)}\n${line.slice(1)}`);
            } else if (line.includes(":")) {
                last = line.slice(0, line.indexOf(":"));
                fields.set(last, line.slice(line.indexOf(":") + 1).trim());
            }
        }
        if (fields.size > 0) out.push(fields);
    }
    return out;
}

/** The continuation lines of a field, split into words */
function rows(value) {
    return (value ?? "").split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((r) => r[0]);
}

function render(fields) {
    return [...fields].map(([k, v]) => {
        const [first, ...rest] = v.split("\n");
        return [first ? `${k}: ${first}` : `${k}:`, ...rest.map((l) => ` ${l}`)].join("\n");
    }).join("\n") + "\n";
}

async function request(method, url, body, headers) {
    const res = await fetch(url, { method, body, headers, signal: AbortSignal.timeout(15 * 60 * 1000) });
    return { status: res.status, text: await res.text() };
}

const segments = (parts) => parts.map(encodeURIComponent).join("/");

async function listFiles(api, parts) {
    const paths = new Set();
    let cursor;
    do {
        const url = `${api}/v1/repo/${segments(parts)}?limit=1000${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
        const res = await request("GET", url);
        if (res.status !== 200) throw new Error(`GET ${url} answered ${res.status}: ${res.text}`);
        const body = JSON.parse(res.text);
        for (const f of body.files) paths.add(f.path);
        cursor = body.nextCursor;
    } while (cursor !== undefined);
    return [...paths].sort();
}

async function download(base, path) {
    const res = await fetch(`${base}/${segments(path.split("/"))}`, { signal: AbortSignal.timeout(120000) });
    await res.arrayBuffer();
    return res.status;
}

async function signedBy(verification) {
    try {
        for (const s of (await verification).signatures) {
            if (await s.verified.catch(() => false)) return true;
        }
        return false;
    } catch {
        return false;
    }
}

async function verifyDetached(text, armored, key, label) {
    const signature = armored === undefined ? undefined : await openpgp.readSignature({ armoredSignature: armored }).catch(() => undefined);
    const message = await openpgp.createMessage({ binary: Buffer.from(text, "utf8") });
    if (signature === undefined || !await signedBy(openpgp.verify({ message, signature, verificationKeys: key }))) {
        problem(`${label} is missing or does not verify`);
    }
}

/** The file's content when it has the listed size and digest */
function listedFile(file, label, listing, alg) {
    const d = digest(file);
    if (d === undefined) return problem(`${label} is missing`);
    if (d.size !== listing.size || d[alg] !== listing[alg]) return problem(`${label} does not match its listing`);
    return readFileSync(file);
}

function poolFile(repo, path, size, sha256, what, referenced) {
    referenced.add(path);
    const d = digest(join(repo, ...path.split("/")));
    if (d === undefined) problem(`${path} is missing (${what})`);
    else if (d.size !== size || d.sha256 !== sha256) problem(`${path} does not match ${what}`);
}

/**
 * Checks what InRelease lists. Both modes: its signature, by-hash/SHA256 files and the pool files their indexes name.
 * Strict adds Release and Release.gpg, the canonical names and by-hash/MD5Sum.
 */
async function verifyDeb(repo, distro, release, key, strict, referenced) {
    const rel = `deb/${distro}/dists/${release}`;
    const dist = join(repo, "deb", distro, "dists", release);
    const signed = readText(join(dist, "InRelease"));
    if (signed === undefined) return problem(`${rel}/InRelease is missing`);
    const message = await openpgp.readCleartextMessage({ cleartextMessage: signed }).catch(() => undefined);
    if (message === undefined || !await signedBy(openpgp.verify({ message, verificationKeys: key }))) {
        return problem(`${rel}/InRelease is not signed by the key`);
    }
    const text = message.getText();
    if (strict) {
        const plain = readText(join(dist, "Release"));
        if (plain !== text) problem(`${rel}/Release differs from the text InRelease signs`);
        else await verifyDetached(plain, readText(join(dist, "Release.gpg")), key, `${rel}/Release.gpg`);
    }
    const [fields = new Map()] = stanzas(text);
    if (fields.get("Acquire-By-Hash") !== "yes") problem(`${rel}/InRelease lacks Acquire-By-Hash: yes`);
    const listed = new Map();
    for (const [field, alg] of [["MD5Sum", "md5"], ["SHA256", "sha256"]]) {
        for (const [sum, size, name] of rows(fields.get(field))) {
            listed.set(name, { ...listed.get(name), [alg]: sum, size: Number(size) });
        }
    }
    if (listed.size === 0) problem(`${rel}/InRelease lists no files`);
    const unpacked = new Map();
    for (const [name, e] of listed) {
        if (e.md5 === undefined || e.sha256 === undefined) {
            problem(`${rel}: ${name} lacks an MD5Sum or SHA256 entry`);
            continue;
        }
        if (!name.endsWith(".gz")) continue;
        const dir = posix.dirname(name);
        let data = listedFile(join(dist, ...dir.split("/"), "by-hash", "SHA256", e.sha256), `${rel}/${dir}/by-hash/SHA256/${e.sha256}`, e, "sha256");
        if (strict) {
            listedFile(join(dist, ...dir.split("/"), "by-hash", "MD5Sum", e.md5), `${rel}/${dir}/by-hash/MD5Sum/${e.md5}`, e, "md5");
            data = listedFile(join(dist, ...name.split("/")), `${rel}/${name}`, e, "sha256");
        }
        if (data !== undefined) unpacked.set(name.slice(0, -3), gunzipSync(data));
    }
    for (const name of listed.keys()) {
        if (!name.endsWith(".gz") && !listed.has(`${name}.gz`)) problem(`${rel}: ${name} is listed without its .gz`);
    }
    for (const [name, raw] of unpacked) {
        const e = listed.get(name);
        if (e !== undefined && (raw.length !== e.size || hash("sha256", raw) !== e.sha256 || hash("md5", raw) !== e.md5)) {
            problem(`${rel}/${name}.gz does not unpack to the listed ${name}`);
        }
        const label = `${rel}/${name}`;
        for (const s of stanzas(raw.toString("utf8"))) {
            if (posix.basename(name) === "Packages") {
                poolFile(repo, `deb/${distro}/${s.get("Filename")}`, Number(s.get("Size")), s.get("SHA256"), `${label} ${s.get("Package")}`, referenced);
            } else if (posix.basename(name) === "Sources") {
                for (const [sum, size, file] of rows(s.get("Checksums-Sha256"))) {
                    poolFile(repo, `deb/${distro}/${s.get("Directory")}/${file}`, Number(size), sum, `${label} ${s.get("Package")}`, referenced);
                }
            }
        }
    }
}

function rpmPackages(xml) {
    return [...xml.matchAll(/<package type="rpm">([\s\S]*?)<\/package>/g)].map(([, p]) => ({
        name: tag(p, /<name>([^<]*)</),
        arch: tag(p, /<arch>([^<]*)</),
        version: ["epoch", "ver", "rel"].map((a) => tag(p, new RegExp(`<version [^>]*\\b${a}="([^"]*)"`))).join(":"),
        pkgid: tag(p, /<checksum type="sha256" pkgid="YES">([0-9a-f]+)</),
        size: Number(tag(p, /<size package="(\d+)"/)),
        href: unxml(tag(p, /<location href="([^"]+)"/)),
        sourcerpm: unxml(tag(p, /<rpm:sourcerpm>([^<]*)</)),
    }));
}

/** Checks repomd.xml: the metadata files and the packages primary names; strict adds repomd.xml.asc */
async function verifyRpm(repo, distro, release, key, strict, referenced) {
    const rel = `rpm/${distro}/${release}`;
    const dir = join(repo, "rpm", distro, release);
    const xml = readText(join(dir, "repodata", "repomd.xml"));
    if (xml === undefined) return problem(`${rel}/repodata/repomd.xml is missing`);
    if (strict) await verifyDetached(xml, readText(join(dir, "repodata", "repomd.xml.asc")), key, `${rel}/repodata/repomd.xml.asc`);
    const data = [...xml.matchAll(/<data type="([^"]+)">([\s\S]*?)<\/data>/g)];
    if (data.length === 0) problem(`${rel}/repodata/repomd.xml lists no metadata`);
    for (const [, type, block] of data) {
        const href = unxml(tag(block, /<location href="([^"]+)"/));
        const listing = { size: Number(tag(block, /<size>(\d+)</)), sha256: tag(block, /<checksum type="sha256">([0-9a-f]+)</) };
        const zst = listedFile(join(dir, ...href.split("/")), `${rel}/${href}`, listing, "sha256");
        if (zst === undefined) continue;
        const raw = zstdDecompressSync(zst);
        if (raw.length !== Number(tag(block, /<open-size>(\d+)</)) || hash("sha256", raw) !== tag(block, /<open-checksum type="sha256">([0-9a-f]+)</)) {
            problem(`${rel}/${href} does not unpack to its open-checksum`);
        }
        if (type === "primary") {
            for (const p of rpmPackages(raw.toString("utf8"))) poolFile(repo, `${rel}/${p.href}`, p.size, p.pkgid, `${rel} primary ${p.name}`, referenced);
        }
    }
}

/** Entries of every Packages and Sources index the Release of dist lists, by index name */
function debIndexes(dist) {
    const indexes = new Map();
    const [fields = new Map()] = stanzas(readText(join(dist, "Release")) ?? "");
    for (const [, , name] of rows(fields.get("SHA256"))) {
        const kind = posix.basename(name);
        if (kind !== "Packages.gz" && kind !== "Sources.gz") continue;
        const text = gunzipSync(readFileSync(join(dist, ...name.split("/")))).toString("utf8");
        indexes.set(name, new Set(stanzas(text).map((s) => kind === "Packages.gz"
            ? ["Package", "Version", "Architecture", "Filename", "Size", "SHA256"].map((f) => s.get(f)).join(" ")
            : [s.get("Package"), s.get("Version"), s.get("Directory"), ...rows(s.get("Checksums-Sha256")).map((r) => r.join(" ")).sort()].join(" "))));
    }
    return indexes;
}

function primaryOf(dir) {
    const block = tag(readText(join(dir, "repodata", "repomd.xml")) ?? "", /<data type="primary">([\s\S]*?)<\/data>/);
    const href = unxml(tag(block, /<location href="([^"]+)"/));
    if (href === "") {
        problem(`${dir} has no primary metadata`);
        return [];
    }
    return rpmPackages(zstdDecompressSync(readFileSync(join(dir, ...href.split("/")))).toString("utf8"));
}

function compareSets(label, before, after) {
    const lost = [...before].filter((x) => !after.has(x));
    const gained = [...after].filter((x) => !before.has(x));
    for (const x of lost) console.log(`only in 2.x: ${label}: ${x}`);
    for (const x of gained) console.log(`only now: ${label}: ${x}`);
    if (lost.length > 0) problem(`${label}: ${lost.length} 2.x entries are missing, first: ${lost[0]}`);
    if (gained.length > 0) problem(`${label}: ${gained.length} entries the 2.x index lacks, first: ${gained[0]}`);
}

const commands = {
    async keygen(dir) {
        const { privateKey, publicKey } = await openpgp.generateKey({
            type: "rsa", rsaBits: 4096, userIDs: [{ name: "verify-native throwaway", email: "verify-native@example.invalid" }],
        });
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "private.asc"), privateKey);
        writeFileSync(join(dir, "pubkey.asc"), publicKey);
    },

    async ready(api) {
        try {
            const res = await fetch(`${api}/v1/status`, { signal: AbortSignal.timeout(5000) });
            await res.arrayBuffer();
            return res.status === 200;
        } catch {
            return false;
        }
    },

    /** POSTs the files of every directory below root/sub to the upload path of that directory relative to root */
    async upload(api, root, sub) {
        const walk = (dir) => [...(names(dir, false).length > 0 ? [dir] : []), ...names(dir, true).flatMap((d) => walk(join(dir, d)))];
        const dirs = walk(join(root, sub));
        if (dirs.length === 0) problem(`nothing to upload below ${join(root, sub)}`);
        for (const dir of dirs) {
            const target = relative(root, dir).split(sep).join("/");
            const form = new FormData();
            for (const name of names(dir, false)) form.append("package", await openAsBlob(join(dir, name)), name);
            const res = await request("POST", `${api}/v1/upload/${segments(target.split("/"))}`, form);
            console.log(`${res.status} ${target}: ${res.text}`);
            if (res.status !== 201) problem(`POST ${target} answered ${res.status}`);
        }
    },

    /** MCP import_repository; expect all-ok, "failed <file name> <text of its reason>" or any */
    async import(api, expect = "any", name = "", reason = "") {
        const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "import_repository", arguments: {} } });
        const res = await request("POST", `${api}/v1/mcp`, body, { "Content-Type": "application/json", Accept: "application/json, text/event-stream" });
        console.log(`${res.status} ${res.text}`);
        if (res.status !== 200) return problem(`import answered ${res.status}`);
        const result = JSON.parse(res.text).result?.structuredContent;
        if (result === undefined) return problem("import answered without structuredContent");
        const files = result.files ?? [];
        if (expect === "all-ok") {
            if (result.ok !== true) problem("import reported ok: false");
            if (files.length === 0) problem("import reported no files");
            for (const f of files.filter((f) => f.status !== "ok")) problem(`${f.path}: ${f.status}${f.reason ? ` (${f.reason})` : ""}`);
        } else if (expect === "failed") {
            const file = files.find((f) => f.filename === name);
            if (result.ok !== false) problem("import reported ok: true");
            if (file?.status !== "failed" || !file.reason?.includes(reason)) problem(`${name} is not reported failed with a reason containing "${reason}"`);
            else console.log(`reason: ${file.reason}`);
        }
    },

    async remove(api, format, distro, release, source, version, immediate) {
        const res = await request("DELETE", `${api}/v1/repo/${segments([format, distro, release, source, version])}?immediate=${immediate}`);
        console.log(`${res.status} ${res.text}`);
        if (res.status !== 200) problem(`DELETE answered ${res.status}`);
    },

    /** Removes a version and checks the downloads; writes the files no other version references to out */
    async removal(api, base, immediate, format, distro, release, source, version, out) {
        const what = [format, distro, release, source, version];
        const before = await listFiles(api, what);
        console.log(`before:\n${before.join("\n")}`);
        if (before.length === 0) return problem(`${what.join("/")} lists no files to remove`);
        await commands.remove(api, ...what, immediate);
        if (problems > 0) return;
        const after = await listFiles(api, what);
        if (after.length > 0) problem(`still listed after the removal: ${after.join(", ")}`);
        const remaining = new Set(await listFiles(api, [format, distro, "-", source, "-"]));
        const freed = before.filter((p) => !remaining.has(p));
        writeFileSync(out, freed.map((p) => `${p}\n`).join(""));
        if (freed.length === 0) problem("every file is still referenced elsewhere, so the removal frees nothing");
        for (const p of before) {
            const want = immediate === "true" && !remaining.has(p) ? 404 : 200;
            const got = await download(base, p);
            console.log(`${got} ${p}`);
            if (got !== want) problem(`${p} answered ${got}, expected ${want}`);
        }
    },

    /** mode strict or client (what clients see after a crash); every absent file lists paths no index may name */
    async verify(repo, pubkey, mode, ...absent) {
        const key = await openpgp.readKey({ armoredKey: readFileSync(pubkey, "utf8") });
        const strict = mode === "strict";
        const referenced = new Set();
        let releases = 0;
        for (const distro of names(join(repo, "deb"), true)) {
            for (const release of names(join(repo, "deb", distro, "dists"), true)) {
                releases++;
                await verifyDeb(repo, distro, release, key, strict, referenced);
            }
        }
        for (const distro of names(join(repo, "rpm"), true)) {
            for (const release of names(join(repo, "rpm", distro), true)) {
                releases++;
                await verifyRpm(repo, distro, release, key, strict, referenced);
            }
        }
        if (releases === 0) problem(`no releases below ${repo}`);
        for (const file of absent) {
            for (const p of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
                if (referenced.has(p)) problem(`${p} is still listed by an index`);
            }
        }
        console.log(`${mode}: ${releases} releases, ${referenced.size} pool files listed`);
    },

    /** The published indexes list what the 2.x ones did, RPMs moved to Packages/<c>/<source>/ */
    async golden(goldenDir, repo) {
        let indexes = 0;
        let packages = 0;
        for (const distro of names(join(goldenDir, "deb"), true)) {
            for (const release of names(join(goldenDir, "deb", distro, "dists"), true)) {
                const rel = `deb/${distro}/dists/${release}`;
                const before = debIndexes(join(goldenDir, ...rel.split("/")));
                const after = debIndexes(join(repo, ...rel.split("/")));
                for (const name of new Set([...before.keys(), ...after.keys()])) {
                    if (!after.has(name)) problem(`${rel}/${name} is no longer published`);
                    else if (!before.has(name)) problem(`${rel}/${name} was not published by 2.x`);
                    else compareSets(`${rel}/${name}`, before.get(name), after.get(name));
                    indexes++;
                }
            }
        }
        for (const distro of names(join(goldenDir, "rpm"), true)) {
            for (const release of names(join(goldenDir, "rpm", distro), true)) {
                const rel = `rpm/${distro}/${release}`;
                const before = primaryOf(join(goldenDir, ...rel.split("/")));
                const after = primaryOf(join(repo, ...rel.split("/")));
                const key = (p) => [posix.basename(p.href), p.name, p.arch, p.version, p.pkgid, p.size].join(" ");
                compareSets(`${rel} primary`, new Set(before.map(key)), new Set(after.map(key)));
                packages += after.length;
                for (const p of after) {
                    const source = p.sourcerpm === "" ? p.name : p.sourcerpm.slice(0, -".src.rpm".length).split("-").slice(0, -2).join("-");
                    if (p.href !== `Packages/${source[0].toLowerCase()}/${source.toLowerCase()}/${posix.basename(p.href)}`) problem(`${rel}/${p.href} is not in Packages/<c>/<source>/`);
                }
                for (const p of before) {
                    if (existsSync(join(repo, ...rel.split("/"), ...p.href.split("/")))) problem(`${rel}/${p.href} is still at its 2.x path`);
                }
            }
        }
        console.log(`golden: compared ${indexes} Debian indexes and ${packages} RPM packages with 2.x`);
    },

    /** Files at uncompressed names Release lists: the backend never writes them, so they go stale when the index changes */
    async leftovers(repo) {
        let checked = 0;
        for (const distro of names(join(repo, "deb"), true)) {
            for (const release of names(join(repo, "deb", distro, "dists"), true)) {
                const dist = join(repo, "deb", distro, "dists", release);
                const [fields = new Map()] = stanzas(readText(join(dist, "Release")) ?? "");
                for (const [, , name] of rows(fields.get("SHA256"))) {
                    if (name.endsWith(".gz")) continue;
                    checked++;
                    if (digest(join(dist, ...name.split("/"))) !== undefined) {
                        problem(`deb/${distro}/dists/${release}/${name} is a 2.x leftover at a name Release lists`);
                    }
                }
            }
        }
        console.log(`leftovers: checked ${checked} uncompressed names Release lists`);
    },

    /** Some stanza of the index below dist has every field=value */
    async listed(dist, index, ...pairs) {
        const wanted = pairs.map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]);
        const text = gunzipSync(readFileSync(join(dist, ...index.split("/")))).toString("utf8");
        if (!stanzas(text).some((s) => wanted.every(([k, v]) => s.get(k) === v))) problem(`${index} has no stanza with ${pairs.join(" ")}`);
    },

    async keyring(base, pubkey) {
        const fingerprint = (await openpgp.readKey({ armoredKey: readFileSync(pubkey, "utf8") })).getFingerprint();
        for (const path of ["deb/archive-keyring.asc", "rpm/RPM-GPG-KEY.asc"]) {
            const res = await request("GET", `${base}/${path}`);
            const fingerprints = [];
            for (const armoredKeys of res.text.match(/-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]+?-----END PGP PUBLIC KEY BLOCK-----/g) ?? []) {
                for (const k of await openpgp.readKeys({ armoredKeys })) fingerprints.push(k.getFingerprint());
            }
            console.log(`${res.status} ${path}: ${fingerprints.join(" ")}`);
            if (res.status !== 200 || !fingerprints.includes(fingerprint)) problem(`${path} does not carry the signing key`);
        }
    },

    /** A source-only upload for release whose orig tarball has the fixture's name but other bytes */
    // A copy of a tree with its uploads signed, as the server takes nothing else with a key set
    async sign(keyFile, from, to) {
        const { signBundle, signRpm } = await import(pathToFileURL(join(process.cwd(), "tests", "signing.ts")).href);
        const privateKey = await openpgp.readPrivateKey({ armoredKey: readFileSync(keyFile, "utf8") });
        cpSync(from, to, { recursive: true });
        const walk = async dir => {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries.filter(e => e.isDirectory())) {
                await walk(join(dir, entry.name));
            }
            if (entries.some(e => e.name.endsWith(".changes"))) {
                await signBundle(dir, privateKey);
            }
            for (const entry of entries.filter(e => e.isFile() && e.name.endsWith(".rpm"))) {
                writeFileSync(join(dir, entry.name), await signRpm(readFileSync(join(dir, entry.name)), privateKey));
            }
        };
        await walk(to);
    },

    async conflict(fixtureDir, outDir, release) {
        const all = names(fixtureDir, false);
        const dscName = all.find((n) => n.endsWith(".dsc"));
        const changesName = all.find((n) => n.endsWith(".changes"));
        const [dsc] = stanzas(readFileSync(join(fixtureDir, dscName), "utf8"));
        const [changes] = stanzas(readFileSync(join(fixtureDir, changesName), "utf8"));
        const source = dsc.get("Source");
        const version = `${dsc.get("Version")}+conflict`;
        const fileVersion = version.slice(version.indexOf(":") + 1);
        const listed = rows(dsc.get("Checksums-Sha256")).map((r) => r[2]);
        const orig = listed.find((n) => n.includes(".orig.tar.") && n.endsWith(".gz"));
        const debian = listed.find((n) => n.includes(".debian.tar."));
        if (orig === undefined || debian === undefined) return problem(`${dscName} lists no .orig.tar.gz and .debian.tar.*`);
        const files = new Map();
        // An empty gzip member changes the bytes and keeps the tarball valid
        files.set(orig, Buffer.concat([readFileSync(join(fixtureDir, orig)), gzipSync(Buffer.alloc(0))]));
        const newDebian = `${source}_${fileVersion}${debian.slice(debian.indexOf(".debian.tar."))}`;
        files.set(newDebian, readFileSync(join(fixtureDir, debian)));
        const sums = (list, alg) => "\n" + list.map((n) => `${hash(alg, files.get(n))} ${files.get(n).length} ${n}`).join("\n");
        dsc.set("Version", version);
        dsc.set("Checksums-Sha1", sums([orig, newDebian], "sha1"));
        dsc.set("Checksums-Sha256", sums([orig, newDebian], "sha256"));
        dsc.set("Files", sums([orig, newDebian], "md5"));
        const newDsc = `${source}_${fileVersion}.dsc`;
        files.set(newDsc, Buffer.from(render(dsc)));
        const [, , section, priority] = rows(changes.get("Files")).find((r) => r[4] === dscName) ?? [];
        const upload = [newDsc, orig, newDebian];
        files.set(`${source}_${fileVersion}_source.changes`, Buffer.from(render(new Map([
            ["Format", "1.8"], ["Date", changes.get("Date")], ["Source", source], ["Architecture", "source"], ["Version", version],
            ["Distribution", release], ["Urgency", "medium"], ["Maintainer", dsc.get("Maintainer")], ["Changed-By", dsc.get("Maintainer")],
            ["Changes", `\n${source} (${version}) ${release}; urgency=medium\n.\n  * Conflicting orig tarball.`],
            ["Checksums-Sha1", sums(upload, "sha1")], ["Checksums-Sha256", sums(upload, "sha256")],
            ["Files", "\n" + upload.map((n) => `${hash("md5", files.get(n))} ${files.get(n).length} ${section} ${priority} ${n}`).join("\n")],
        ]))));
        mkdirSync(outDir, { recursive: true });
        for (const [n, data] of files) writeFileSync(join(outDir, n), data);
        console.log(`wrote ${[...files.keys()].join(", ")} to ${outDir}`);
    },
};

const [command, ...args] = process.argv.slice(2);
if (!Object.hasOwn(commands, command)) {
    console.log(`problem: unknown command ${command}`);
    process.exit(2);
}
let ok;
try {
    ok = await commands[command](...args);
} catch (err) {
    problem(err.message);
    console.log(err.stack);
}
process.exit(problems > 0 || ok === false ? 1 : 0);
TOOL

node "${tool}" keygen "${work}/keys" > "${logs}/keygen.log" 2>&1 || die "key generation failed, see ${logs}/keygen.log"
for tree in tests/fixtures/packages tests/fixtures/packages-arm64 "${update}"; do
    node "${tool}" sign "${work}/keys/private.asc" "${tree}" "${signed}/${tree##*/}" > "${logs}/sign.log" 2>&1 || die "signing ${tree} failed, see ${logs}/sign.log"
done

trap cleanup EXIT
echo "== image"
dc build > "${logs}/build.log" 2>&1 || die "image build failed, see ${logs}/build.log"
dc down > "${logs}/down-before.log" 2>&1 || die "compose down failed, see ${logs}/down-before.log"
rm -rf ./data/incoming ./data/repo ./data/repo-state
mkdir -p ./data
started=1

run_check rebuild check_rebuild
run_check clients-after-rebuild check_clients
run_check reupload check_reupload
run_check clients-after-reupload check_clients
run_check removal check_removal
run_check crash check_crash
exit "${failed}"
