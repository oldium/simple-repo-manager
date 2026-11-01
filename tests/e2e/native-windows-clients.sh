#!/bin/bash
# native-windows-clients.sh <host dir with keys/pubkey.asc> <port>: real apt and dnf against the server on this host
set -uo pipefail
. "$(dirname "$0")/clients.sh"
host_work=$1
port=$2
all_clients=(
    "bullseye|debian:bullseye|deb|deb/debian|trixie bookworm|main|srm-hello srm-gz"
    "trixie|debian:trixie|deb|deb/debian|trixie bookworm|main|srm-hello srm-gz"
    "forky|debian:forky|deb|deb/debian|trixie bookworm|main|srm-hello srm-gz"
    "noble|ubuntu:noble|deb|deb/ubuntu|noble|universe|srm-zst"
    "fedora42|fedora:42|rpm|rpm/fedora/42|||srm-hello"
    "stream9|quay.io/centos/centos:stream9|rpm|rpm/fedora/42|||srm-hello"
    "stream10|quay.io/centos/centos:stream10|rpm|rpm/fedora/42|||srm-hello"
)
mkdir -p "${host_work}/logs"
write_client_scripts "${host_work}"
trap 'remove_clients srm-native "${all_clients[@]}"' EXIT
run_clients srm-native bridge "http://host.docker.internal:${port}" "${host_work}" "${host_work}/logs" "${all_clients[@]}"
printf '%s\n' "${client_results[@]}"
