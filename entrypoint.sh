#!/bin/sh -e

: "${UID:=1000}"
: "${GID:=1000}"

# See https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md
if [ "${UID}" != $(id -u node) ] || [ "${GID}" != $(id -g node) ]; then
    groupmod -g ${GID} node && usermod -u ${UID} -g ${GID} node
fi

ensureDir() {
    local dir="$1"
    local parent="$(dirname "$dir")"
    [ "$parent" = "." ] && return
    [ "$parent" = "/" ] && return
    if ! [ -d "$dir" ]; then
        if [ ! -d "$parent" ]; then
            ensureDir "$parent"
        fi
        mkdir "$dir"
    fi
    chown -R node:node "$dir"
}

if [ "$1" = "node" ]; then
    # See https://stackoverflow.com/a/39398511/7080036
    ensureDir "${INCOMING_DIR:-data/incoming}"
    ensureDir "${REPO_DIR:-data/repo}"
    ensureDir "${REPO_STATE_DIR:-data/repo-state}"

    # Quick check for reprepro binary to see if we need to set up GPG directory
    if [ -n "${REPREPRO_BIN-unset}" ] && ( [ -n "$REPREPRO_BIN" ] || command -v reprepro >/dev/null 2>&1 ); then
        if [ -n "$GPG_BIN" ] || command -v gpg >/dev/null 2>&1; then
            if [ -n "$GPGHOMEDIR" ]; then
                ensureDir "$GPGHOMEDIR"
                chmod 0700 "$GPGHOMEDIR"
            else
                ensureDir ~node/.gnupg
                chmod 0700 ~node/.gnupg
            fi
        fi
    fi
fi

exec runuser -u node -- "$@"
