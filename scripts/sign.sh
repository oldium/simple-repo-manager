#!/bin/sh -e

if [ "$#" != "3" ]; then
    echo "To be used as a reprepro hook!"
    exit 1
fi

if [ -z "$GPG_REPO_PRIVATE_KEY_FILE" ] || [ ! -r "$GPG_REPO_PRIVATE_KEY_FILE" ]; then
    echo "GPG_REPO_PRIVATE_KEY_FILE should be set"
    exit 1
fi

INPUT="$1"
OUTPUT="$2"
DETACHED="$3"

if [ -n "$INPUT" ] && [ -n "$OUTPUT" ]; then
    rnp --sign --clearsign --armor --overwrite --keyfile "$GPG_REPO_PRIVATE_KEY_FILE" --output "$OUTPUT" "$INPUT"
fi

if [ -n "$INPUT" ] && [ -n "$DETACHED" ]; then
    rnp --sign --detached --armor --overwrite --keyfile "$GPG_REPO_PRIVATE_KEY_FILE" --output "$DETACHED" "$INPUT"
fi
