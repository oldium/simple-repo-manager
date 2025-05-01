#!/bin/sh -e

if [ "$#" = "0" ] || [ "$1" = "--help" ] || [ "$1" = "-?" ]; then
    echo "Usage: $0 [-?|--help|--version] <repo-dir> <sign-script>"
    echo "Wrapper script for createrepo_c, always accepts two arguments. When signing is not available, pass empty string"
    exit 0
fi

if [ "$1" = "--version" ]; then
    if command -v createrepo_c >/dev/null 2>&1; then
        exec createrepo_c --version
    else
        echo "createrepo_c tool is not installed"
        exit 1
    fi
fi

if [ "$#" != "2" ]; then
    echo "To be used as a RPM repo build script!"
    exit 1
fi

outRepoDir=$1
signScript=$2

createrepo_c --quiet --update "$outRepoDir"
if [ -n "$signScript" ] && [ -f "$outRepoDir/repodata/repomd.xml" ]; then
    if [ ! -f "$outRepoDir/repodata/repomd.xml.asc" ] || [ -n "$(find "$outRepoDir/repodata/repomd.xml" -newer "$outRepoDir/repodata/repomd.xml.asc")" ]; then
        "$signScript" "$outRepoDir/repodata/repomd.xml" "" "$outRepoDir/repodata/repomd.xml.asc"
    fi
fi
