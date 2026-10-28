#!/bin/bash
# Capture what the compose stack publishes for a fixture tree.
# Run from the repository root:
#   bash tests/e2e/capture-golden.sh <fixture-dir> <out-dir>
# Wipes ./data, rebuilds and starts the stack, PUTs every file under
# <fixture-dir> to /api/v1/upload/<relative path>, imports via MCP and copies
# ./data/repo to <out-dir> (plus files.txt and import.json).
set -euo pipefail

fixture_dir="${1:?usage: $0 <fixture-dir> <out-dir>}"
out_dir="${2:?usage: $0 <fixture-dir> <out-dir>}"
host="http://127.0.0.1:80"

[[ -f compose.yaml ]] || { echo "run from the repository root" >&2; exit 1; }
[[ -d "${fixture_dir}" ]] || { echo "not a directory: ${fixture_dir}" >&2; exit 1; }
fixture_dir="${fixture_dir%/}"

docker compose down
rm -rf ./data/incoming ./data/repo ./data/repo-state
docker compose up -d --build

for ((i = 0; i < 120; i++)); do
    curl -fsS "${host}/api/v1/status" >/dev/null 2>&1 && break
    sleep 1
done
curl -fsS "${host}/api/v1/status" >/dev/null

pass=0
fail=0
fail_lines=""
while IFS= read -r -d '' src; do
    rel="${src#"${fixture_dir}"/}"
    code=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT --data-binary "@${src}" "${host}/api/v1/upload/${rel}")
    if [[ "${code}" == "200" || "${code}" == "201" ]]; then
        ((pass++)) || true
    else
        ((fail++)) || true
        fail_lines+="  ${code} ${rel}"$'\n'
    fi
done < <(find "${fixture_dir}" -type f -print0 | sort -z)

echo "uploaded=${pass} failed=${fail}"
if ((fail > 0)); then
    printf '%s' "${fail_lines}" >&2
    exit 1
fi

rm -rf "${out_dir}"
mkdir -p "${out_dir}"

curl -sS -X POST "${host}/api/v1/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"import_repository","arguments":{}}}' \
    > "${out_dir}/import.json"

# Regular files only: reprepro's compat symlinks cannot be recreated on Windows
abs_out_dir="$(cd "${out_dir}" && pwd)"
(cd ./data/repo && find . -type f -print0 | sort -z | xargs -0 cp --parents -t "${abs_out_dir}")
find ./data/repo -type f | sort > "${out_dir}/files.txt"
find ./data/repo -type l -printf '%p -> %l\n' | sort > "${out_dir}/symlinks.txt"

cat "${out_dir}/import.json"
echo
if ! grep -q '"ok":true' "${out_dir}/import.json"; then
    echo "import failed, see ${out_dir}/import.json" >&2
    exit 1
fi
echo "captured $(wc -l < "${out_dir}/files.txt") files into ${out_dir}"
