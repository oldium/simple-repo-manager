# Releasing

A release is the commit `Release X.Y.Z` on `master` with the tag `vX.Y.Z`, the
Docker image `oldium/simple-repo-manager:X.Y.Z` and `latest` on Docker Hub, and
a GitHub release with the notes.

It needs Docker logged in to Docker Hub and to `dhi.io`, and `gh` logged in to
GitHub. The commands are for bash, Git Bash on Windows.

## 1. Update the dependencies

Right before every release, so that it ships with current dependencies:

```bash
npx npm-check-updates -u   # raises the ranges in package.json, see .ncurc.js
npm update                 # dependencies of dependencies, within their ranges
npm install
npm audit --omit=dev       # what the image ships, expect 0 vulnerabilities
```

Commit the result as `Update dependencies`. A body says only what needs
explaining, like a major version that changed something.

## 2. Run the full test round

```bash
npm run lint
npm run typecheck
npm test
npm run build
node tests/e2e/native-windows.mjs   # on Windows
bash tests/e2e/verify-native.sh     # needs Docker, see AGENTS.md
rm -rf ./data/incoming ./data/repo ./data/repo-state
```

The last line removes what `verify-native.sh` left, signed with its throwaway
key. The image build in step 4 runs the lint, the type check and the tests once
more, on Alpine.

## 3. Make the release commit and the tag

```bash
npm version X.Y.Z --no-git-tag-version   # package.json and package-lock.json
git commit -s -m "Release X.Y.Z" package.json package-lock.json
git tag vX.Y.Z
git push origin master vX.Y.Z
```

The tag is lightweight and points at the release commit.

## 4. Build and push the image

Build from the tag with nothing changed in the checkout, as the provenance names
the commit:

```bash
docker buildx build --progress=plain --pull --no-cache \
  --attest type=provenance,mode=max \
  --attest type=sbom,generator=docker/scout-sbom-indexer:latest \
  -f Dockerfile . \
  -t oldium/simple-repo-manager:X.Y.Z -t oldium/simple-repo-manager:latest
```

`--pull` fetches the current base images, `--no-cache` runs every step again,
and the provenance and SBOM attestations go into the image index.

Check the vulnerabilities with the VEX statements of the base image. An image
built on a Docker Hardened Image does not carry them, so without them Scout
lists what the base image marks as not affected:

```bash
docker scout vex get registry://dhi.io/node:26-alpine --output dhi.vex.json
docker scout cves --vex-location dhi.vex.json \
  local://oldium/simple-repo-manager:X.Y.Z
```

Push both tags. A push from Docker's containerd image store keeps the
attestations:

```bash
docker push oldium/simple-repo-manager:X.Y.Z
docker push oldium/simple-repo-manager:latest
docker buildx imagetools inspect oldium/simple-repo-manager:X.Y.Z
```

The last command shows the digest of the `linux/amd64` manifest, which the
release notes link to.

## 5. Publish the release notes

```bash
gh release create vX.Y.Z --title "Simple Repository Manager X.Y.Z" \
  --notes-file notes.md --latest
```

The notes follow the earlier releases:

* A `> [!WARNING]` block with what users have to do, if anything.
* `Highlights in this release:`, then `## Changes` and `## Breaking changes`,
  with one emoji bullet for each change.
* `Docker image: https://hub.docker.com/layers/oldium/simple-repo-manager/X.Y.Z/images/sha256-<digest>`,
  with the `linux/amd64` digest from step 4.
* `**Full Changelog**: https://github.com/oldium/simple-repo-manager/compare/v<previous>...vX.Y.Z`.
