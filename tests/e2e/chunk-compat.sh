#!/bin/bash
# Client compatibility gate for chunked indexes.
# Run from the repository root:
#   bash tests/e2e/chunk-compat.sh <golden-dir>
# Copies <golden-dir>/{deb,rpm} to tmp/chunk-compat/tree, republishes every
# Packages/Sources/Contents-* as concatenated gzip members and every
# primary/filelists/other as concatenated zstd frames (64 KiB of records per
# chunk), rewrites Release/repomd.xml, re-signs them through openpgp.js with a
# throwaway RSA-4096 key, serves the tree on a docker network and runs apt,
# apt-file and dnf clients against it. Full client output: tmp/chunk-compat/logs/.
# Env: CHUNK_RECORDS records per chunk (default 1, 0 = size limit only),
#      CHUNK_MIN minimum chunks per file (default 2; 1 = single chunk when small),
#      CHUNK_NO_INRELEASE=1 drop InRelease so apt verifies Release + Release.gpg,
#      CLIENTS space-separated subset of client names.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/clients.sh"

golden_dir="${1:?usage: $0 <golden-dir>}"
[[ -f package.json && -d node_modules/openpgp ]] || { echo "run from the repository root after npm install" >&2; exit 1; }
[[ -d "${golden_dir}/deb" && -d "${golden_dir}/rpm" ]] || { echo "no deb/ and rpm/ under ${golden_dir}" >&2; exit 1; }

work="tmp/chunk-compat"
host_work="$(pwd -W 2>/dev/null || pwd)/${work}"
net="srm-chunk-compat"
web="srm-chunk-compat-web"
all_clients=(
    # name|image|kind|repo path|suites|components|packages
    "bullseye|debian:bullseye|deb|deb/debian|trixie bookworm|main|srm-hello srm-gz"
    "trixie|debian:trixie|deb|deb/debian|trixie bookworm|main|srm-hello srm-gz"
    "forky|debian:forky|deb|deb/debian|trixie bookworm|main|srm-hello srm-gz"
    "noble|ubuntu:noble|deb|deb/ubuntu|noble|universe|srm-zst"
    "fedora42|fedora:42|rpm|rpm/fedora/42|||srm-hello"
    "stream9|quay.io/centos/centos:stream9|rpm|rpm/fedora/42|||srm-hello"
    "stream10|quay.io/centos/centos:stream10|rpm|rpm/fedora/42|||srm-hello"
)

cleanup() {
    docker rm -f "${web}" >/dev/null 2>&1 || true
    remove_clients srm-chunk-compat "${all_clients[@]}"
    docker network rm "${net}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

rm -rf "${work}"
mkdir -p "${work}/tree" "${work}/keys" "${work}/logs"
cp -r "${golden_dir}/deb" "${golden_dir}/rpm" "${work}/tree/"

cat > "${work}/rechunk.mjs" <<'EOF'
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gunzipSync, gzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import * as openpgp from "openpgp";

const [tree, work] = process.argv.slice(2);
const maxBytes = 64 * 1024;
const recordsPerChunk = Number(process.env.CHUNK_RECORDS ?? 1);
const minChunks = Number(process.env.CHUNK_MIN ?? 2);
const config = { preferredHashAlgorithm: openpgp.enums.hash.sha256 };
const summary = [];

const hash = (alg, data) => createHash(alg).update(data).digest("hex");
const isDir = (p) => existsSync(p) && statSync(p).isDirectory();

function splitAfter(buf, sep) {
    const out = [];
    let pos = 0;
    while (pos < buf.length) {
        const i = buf.indexOf(sep, pos);
        const end = i < 0 ? buf.length : i + sep.length;
        out.push(buf.subarray(pos, end));
        pos = end;
    }
    return out;
}

// Split before every "<package " that starts a line; the XML header is record 0.
function splitPackages(buf) {
    const out = [];
    let pos = 0;
    for (;;) {
        const i = buf.indexOf("\n<package ", pos);
        if (i < 0) break;
        out.push(buf.subarray(pos, i + 1));
        pos = i + 1;
    }
    out.push(buf.subarray(pos));
    return out;
}

function records(buf, kind) {
    if (kind === "stanzas") return splitAfter(buf, "\n\n");
    if (kind === "lines") return splitAfter(buf, "\n");
    return splitPackages(buf);
}

function group(recs, perChunk) {
    const chunks = [];
    let cur = [];
    let len = 0;
    for (const r of recs) {
        if (cur.length && (len + r.length > maxBytes || (perChunk && cur.length >= perChunk))) {
            chunks.push(Buffer.concat(cur));
            cur = [];
            len = 0;
        }
        cur.push(r);
        len += r.length;
    }
    if (cur.length) chunks.push(Buffer.concat(cur));
    return chunks;
}

// Tiny fixture indexes would end up as one chunk; force at least minChunks so
// the clients really see a member/frame boundary (lines, then raw bytes).
function chunk(buf, kind) {
    const recs = records(buf, kind);
    let chunks = group(recs, recordsPerChunk);
    let forced = "";
    if (chunks.length < minChunks) {
        const lines = splitAfter(buf, "\n");
        if (lines.length >= minChunks) {
            chunks = group(lines, Math.ceil(lines.length / minChunks));
            forced = "lines";
        } else {
            const size = Math.ceil(buf.length / minChunks);
            chunks = [];
            for (let i = 0; i < buf.length; i += size) chunks.push(buf.subarray(i, i + size));
            forced = "bytes";
        }
    }
    return { chunks, forced, records: recs.length };
}

function publish(file, buf, kind, compress, decompress) {
    const { chunks, forced, records } = chunk(buf, kind);
    const out = Buffer.concat(chunks.map((c) => compress(c)));
    if (!decompress(out).equals(buf)) throw new Error(`round trip mismatch: ${file}`);
    summary.push({ file, kind, records, chunks: chunks.length, forced, open: buf.length, size: out.length });
    return out;
}

async function clearsign(text, key) {
    const message = await openpgp.createCleartextMessage({ text });
    const signed = await openpgp.sign({ message, signingKeys: key, config });
    return signed.replace(/\r\n/g, "\n");
}

async function detached(binary, key) {
    const message = await openpgp.createMessage({ binary });
    return openpgp.sign({ message, signingKeys: key, detached: true, format: "armored", config });
}

async function debDist(rel, key) {
    const dist = join(tree, rel);
    const lines = readFileSync(join(dist, "Release"), "utf8").split("\n");
    const content = new Map();
    const listed = new Set();
    for (const l of lines) {
        const m = l.match(/^ [0-9a-f]+ +\d+ (\S+)$/);
        if (m) listed.add(m[1]);
    }
    for (const gz of listed) {
        if (!gz.endsWith(".gz") || !existsSync(join(dist, gz))) continue;
        const plain = gz.slice(0, -3);
        const name = basename(plain);
        const kind = name === "Packages" || name === "Sources" ? "stanzas" : name.startsWith("Contents-") ? "lines" : null;
        if (!kind) continue;
        const buf = gunzipSync(readFileSync(join(dist, gz)));
        if (existsSync(join(dist, plain)) && !readFileSync(join(dist, plain)).equals(buf)) {
            throw new Error(`${rel}/${plain} differs from ${gz}`);
        }
        const out = publish(`${rel}/${gz}`, buf, kind, (c) => gzipSync(c), (b) => gunzipSync(b));
        writeFileSync(join(dist, gz), out);
        content.set(gz, out);
        content.set(plain, buf);
    }
    const algs = { "MD5Sum:": "md5", "SHA1:": "sha1", "SHA256:": "sha256", "SHA512:": "sha512" };
    let alg = null;
    const release = lines.map((l) => {
        if (l in algs) {
            alg = algs[l];
            return l;
        }
        const m = l.match(/^ ([0-9a-f]+) +(\d+) (\S+)$/);
        if (!m) {
            alg = null;
            return l;
        }
        let data = content.get(m[3]);
        if (!data) {
            if (!existsSync(join(dist, m[3]))) return l;
            data = readFileSync(join(dist, m[3]));
        }
        return ` ${hash(alg, data)} ${data.length} ${m[3]}`;
    }).join("\n");
    writeFileSync(join(dist, "Release"), release);
    writeFileSync(join(dist, "InRelease"), await clearsign(release, key));
    writeFileSync(join(dist, "Release.gpg"), await detached(Buffer.from(release), key));
}

async function rpmRepo(rel, key) {
    const repo = join(tree, rel);
    const repomd = join(repo, "repodata", "repomd.xml");
    const xml = readFileSync(repomd, "utf8").replace(/<data type="([^"]+)">[\s\S]*?<\/data>/g, (block, type) => {
        if (!["primary", "filelists", "other"].includes(type)) return block;
        const href = block.match(/<location href="([^"]+)"\/>/)[1];
        const buf = zstdDecompressSync(readFileSync(join(repo, href)));
        const out = publish(`${rel}/${href}`, buf, "xml", (c) => zstdCompressSync(c), (b) => zstdDecompressSync(b));
        const sha = hash("sha256", out);
        const newHref = `repodata/${sha}-${type}.xml.zst`;
        writeFileSync(join(repo, newHref), out);
        if (newHref !== href) unlinkSync(join(repo, href));
        return block
            .replace(/<checksum type="sha256">[0-9a-f]+<\/checksum>/, `<checksum type="sha256">${sha}</checksum>`)
            .replace(/<open-checksum type="sha256">[0-9a-f]+<\/open-checksum>/, `<open-checksum type="sha256">${hash("sha256", buf)}</open-checksum>`)
            .replace(/<location href="[^"]+"\/>/, `<location href="${newHref}"/>`)
            .replace(/<size>\d+<\/size>/, `<size>${out.length}</size>`)
            .replace(/<open-size>\d+<\/open-size>/, `<open-size>${buf.length}</open-size>`);
    });
    writeFileSync(repomd, xml);
    writeFileSync(`${repomd}.asc`, await detached(Buffer.from(xml), key));
}

const { privateKey, publicKey } = await openpgp.generateKey({
    type: "rsa",
    rsaBits: 4096,
    userIDs: [{ name: "chunk-compat throwaway", email: "chunk-compat@example.invalid" }],
    format: "object",
});
const armored = publicKey.armor();
writeFileSync(join(work, "keys", "pubkey.asc"), armored);
writeFileSync(join(work, "keys", "private.asc"), privateKey.armor());
writeFileSync(join(tree, "deb", "archive-keyring.asc"), armored);
writeFileSync(join(tree, "rpm", "RPM-GPG-KEY.asc"), armored);
console.log(`key: v${privateKey.keyPacket.version} ${JSON.stringify(privateKey.getAlgorithmInfo())} ${privateKey.getFingerprint()}`);

for (const distro of readdirSync(join(tree, "deb"))) {
    const dists = join(tree, "deb", distro, "dists");
    if (!isDir(dists)) continue;
    for (const suite of readdirSync(dists)) {
        if (existsSync(join(dists, suite, "Release"))) await debDist(`deb/${distro}/dists/${suite}`, privateKey);
    }
}
for (const distro of readdirSync(join(tree, "rpm"))) {
    if (!isDir(join(tree, "rpm", distro))) continue;
    for (const release of readdirSync(join(tree, "rpm", distro))) {
        if (existsSync(join(tree, "rpm", distro, release, "repodata", "repomd.xml"))) await rpmRepo(`rpm/${distro}/${release}`, privateKey);
    }
}

writeFileSync(join(work, "chunks.json"), JSON.stringify(summary, null, 2) + "\n");
console.log("chunks records kind    forced open  size  file");
for (const s of summary) {
    console.log(`${String(s.chunks).padStart(6)} ${String(s.records).padStart(7)} ${s.kind.padEnd(7)} ${(s.forced || "-").padEnd(6)} ${String(s.open).padStart(5)} ${String(s.size).padStart(5)} ${s.file}`);
}
EOF

write_client_scripts "${work}"

echo "== rechunk + sign"
node "${work}/rechunk.mjs" "${work}/tree" "${work}" 2>&1 | tee "${work}/logs/rechunk.log"
if [[ "${CHUNK_NO_INRELEASE:-}" == 1 ]]; then
    find "${work}/tree/deb" -name InRelease -delete
fi

echo "== serve"
docker network create "${net}" >/dev/null
MSYS_NO_PATHCONV=1 docker run -d --name "${web}" --network "${net}" -v "${host_work}/tree:/srv:ro" \
    python:3.13-alpine python3 -m http.server 80 --directory /srv >/dev/null
for ((i = 0; i < 30; i++)); do
    docker exec "${web}" python3 -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1/rpm/")' >/dev/null 2>&1 && break
    sleep 1
done

failed=0
run_clients srm-chunk-compat "${net}" "http://${web}" "${host_work}" "${work}/logs" "${all_clients[@]}" || failed=1
docker logs "${web}" > "${work}/logs/web.log" 2>&1

echo "== results"
printf '%s\n' "${client_results[@]}"
exit "${failed}"
