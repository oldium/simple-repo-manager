# apt and dnf client matrix shared by the end-to-end scripts; source it.
# A client spec is "name|image|kind|repo path|suites|components|packages". Each client
# mounts a host directory as /work holding the scripts below and keys/pubkey.asc.

# write_client_scripts <dir>: writes <dir>/client-deb.sh and <dir>/client-rpm.sh
write_client_scripts() {
    cat > "$1/client-deb.sh" <<'EOF'
#!/bin/bash
set -euxo pipefail
url=$1 suites=$2 components=$3 packages=$4
export DEBIAN_FRONTEND=noninteractive
cat /etc/os-release
. /etc/os-release
# bullseye moved to archive.debian.org; the image still points at deb.debian.org
if [[ "${VERSION_CODENAME:-}" == bullseye ]]; then
    printf 'deb http://archive.debian.org/debian bullseye main\ndeb http://archive.debian.org/debian-security bullseye-security main\n' > /etc/apt/sources.list
fi
apt-get update
apt-get install -y --no-install-recommends apt-file dpkg-dev
apt-get --version
cat > /etc/apt/sources.list.d/srm.sources <<SOURCES
Types: deb deb-src
URIs: ${url}
Suites: ${suites}
Components: ${components}
Signed-By: /work/keys/pubkey.asc
SOURCES
# The distribution's sources stay for dependencies; the installed versions must be ours
apt-get update
# The distribution may carry a newer version, which apt would prefer
versions=""
for p in ${packages}; do
    versions+=" ${p}=$(apt-cache madison "${p}" | awk -F' *[|] *' -v url="${url}" 'index($3, url) { print $2; exit }')"
done
apt-get install -y ${versions}
apt-cache policy ${packages}
for p in ${packages}; do
    apt-cache policy "${p}" | awk -v url="${url}" '/^ (\*\*\*|   ) [^ ]/ { installed = ($1 == "***") } installed && index($0, url) { found = 1 } END { exit !found }'
done
# Only ours from here on, so apt source and apt-file cannot fall back to the distribution
rm -f /etc/apt/sources.list
find /etc/apt/sources.list.d -type f ! -name srm.sources -delete
apt-get update
mkdir /tmp/src && cd /tmp/src
for p in ${packages}; do
    apt-get source "${p}"
done
ls /tmp/src
apt-file update
for p in ${packages}; do
    found=$(apt-file search "${p}")
    echo "${found}"
    [[ -n "${found}" ]]
done
echo "RESULT: ok"
EOF

    cat > "$1/client-rpm.sh" <<'EOF'
#!/bin/bash
set -euxo pipefail
url=$1 packages=$2
cat /etc/os-release
dnf --version
cat > /etc/yum.repos.d/srm.repo <<REPO
[srm]
name=srm
baseurl=${url}
enabled=1
gpgcheck=0
repo_gpgcheck=1
gpgkey=file:///work/keys/pubkey.asc
REPO
dnf -y --repo=srm makecache
dnf -y --repo=srm install ${packages}
rpm -q ${packages}
# -l loads filelists, --changelogs loads other
files=$(dnf -y --repo=srm repoquery -l ${packages})
echo "${files}"
[[ -n "${files}" ]]
dnf -y --repo=srm repoquery --changelogs ${packages}
echo "RESULT: ok"
EOF
}

# run_clients <container prefix> <network> <base url> <host dir mounted as /work> <log dir> <spec>...
# Runs every client, or those named in CLIENTS, against <base url>/<repo path>; full output in
# <log dir>/<name>.log. Sets client_results ("PASS name" or "FAIL name (exit N)") and
# client_failed (names), and fails when any client failed or none ran.
run_clients() {
    local prefix=$1 net=$2 base=$3 host_work=$4 logs=$5
    shift 5
    local spec name image kind repo suites components packages log rc
    client_results=()
    client_failed=()
    for spec in "$@"; do
        IFS='|' read -r name image kind repo suites components packages <<< "${spec}"
        if [[ -n "${CLIENTS:-}" && " ${CLIENTS} " != *" ${name} "* ]]; then continue; fi
        log="${logs}/${name}.log"
        echo "== ${name} (${image}) -> ${log}"
        rc=0
        if [[ "${kind}" == deb ]]; then
            MSYS_NO_PATHCONV=1 docker run --rm --name "${prefix}-${name}" --network "${net}" -v "${host_work}:/work:ro" "${image}" \
                bash /work/client-deb.sh "${base}/${repo}" "${suites}" "${components}" "${packages}" > "${log}" 2>&1 || rc=$?
        else
            MSYS_NO_PATHCONV=1 docker run --rm --name "${prefix}-${name}" --network "${net}" -v "${host_work}:/work:ro" "${image}" \
                bash /work/client-rpm.sh "${base}/${repo}" "${packages}" > "${log}" 2>&1 || rc=$?
        fi
        if ((rc == 0)) && grep -q '^RESULT: ok$' "${log}"; then
            client_results+=("PASS ${name}")
        else
            client_results+=("FAIL ${name} (exit ${rc})")
            client_failed+=("${name}")
        fi
    done
    ((${#client_results[@]} > 0 && ${#client_failed[@]} == 0))
}

# remove_clients <container prefix> <spec>...: removes the client containers an interrupted run left
remove_clients() {
    local prefix=$1 spec
    shift
    for spec in "$@"; do
        docker rm -f "${prefix}-${spec%%|*}" >/dev/null 2>&1 || true
    done
}
