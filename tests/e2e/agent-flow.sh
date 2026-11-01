#!/bin/bash
# agent-flow.sh <base url> <format> <distribution> <release> <package>: run inside a client container, what an agent
# does with the MCP tools: find a package, install its download with no setup, then follow the setup it is given.
set -euxo pipefail
url=$1 format=$2 distribution=$3 release=$4 package=$5

if [[ ${format} == deb ]]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates curl gpg jq sudo
    install_packages() { apt-get install -y "$@"; }
    remove_packages() { apt-get remove -y "$@"; }
    is_installed() { dpkg -s "$1"; }
else
    dnf install -y jq sudo
    install_packages() { dnf install -y "$@"; }
    remove_packages() { dnf remove -y "$@"; }
    is_installed() { rpm -q "$1"; }
fi

# tool <name> <arguments as JSON>: the structured result
tool() {
    jq -n --arg name "$1" --argjson arguments "$2" '{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: $name, arguments: $arguments } }' |
        curl -fsS "${url}/api/v1/mcp" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d @- |
        jq -e '.result.structuredContent'
}

cd /tmp
repository=$(jq -n --arg format "${format}" --arg distribution "${distribution}" --arg release "${release}" '{ $format, $distribution, $release }')

# No setup yet: the download links are enough, also for the other binaries of its source the package depends on
found=$(tool search_packages "$(jq -n --argjson repository "${repository}" --arg source "${package}" '$repository + { $source, kind: ["binary"] }')")
files=()
for link in $(jq -er '.files[] | .downloadUrl' <<<"${found}"); do
    curl -fsSLO "${link}"
    files+=("./${link##*/}")
done
install_packages "${files[@]}"
is_installed "${package}"
# shellcheck disable=SC2046
remove_packages $(jq -er '.files[] | .package' <<<"${found}")

# The code blocks of the setup, as they are
tool get_setup_instructions "${repository}" | jq -er '.markdown' > setup.md
cat setup.md
awk '/^```/ { inside = !inside; next } inside' setup.md > setup.sh
bash -eux setup.sh
install_packages "${package}"
is_installed "${package}"

echo "RESULT: ok"
