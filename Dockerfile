# syntax=docker/dockerfile:1

FROM dhi.io/node:26-debian13-dev AS initial

WORKDIR /build

# The bundled npm is a distro package, /usr/local/bin takes precedence in PATH
RUN npm install -g --prefix /usr/local npm@latest

# Copy package files and install dependencies
COPY --chmod=u=rw,go=r package*.json ./

# Install the production dependencies
RUN npm ci --omit=dev

FROM initial AS builder

# Install the development dependencies
RUN npm ci

# Copy application files
COPY --chmod=u=rw,go=r . .
RUN find . -mindepth 1 -maxdepth 1 -type d ! -name node_modules -exec chmod -R ugo+X {} + \
 && chmod ugo+x ./scripts/*

# Run linter
RUN npm run lint

# Run tests
RUN npm run test

# Build the application
RUN npm run build

# Package builds need a plain Debian, the DHI dev image has no default dpkg vendor
FROM debian:trixie-slim AS repo-tools-build

WORKDIR /build

# Build latest reprepro and createrepo-c packages

RUN apt update \
 && DEBIAN_FRONTEND=noninteractive apt install -y --no-install-recommends ca-certificates build-essential devscripts debhelper equivs \
 && echo "deb https://deb.debian.org/debian experimental main\ndeb-src https://deb.debian.org/debian experimental main" >> /etc/apt/sources.list \
 && apt update \
 && DEBIAN_FRONTEND=noninteractive apt -t experimental source reprepro \
 && rm -f /etc/apt/sources.list \
 && rm -rf /var/lib/apt/lists/*

RUN apt update \
 && cd reprepro-* \
 && DEBIAN_FRONTEND=noninteractive mk-build-deps -irt'apt --no-install-recommends -yV' debian/control \
 && dpkg-buildpackage -us -uc \
 && dpkg-buildpackage -Tclean \
 && rm -rf /var/lib/apt/lists/*

FROM scratch AS repo-tools

COPY --from=repo-tools-build /build/*.deb /

FROM dhi.io/node:26-debian13 AS runtime

FROM dhi.io/node:26-debian13-dev AS runtime-tools

# Unpack the tools and the shell with the packages they need on top of the
# runtime image, which has no package manager to run maintainer scripts
RUN --mount=type=bind,from=repo-tools,target=/tools \
    --mount=type=bind,from=runtime,source=/var/lib/dpkg,target=/runtime-dpkg <<'EOF'
set -eo pipefail
apt-get update
mkdir -p /debs/partial /rootfs/var/lib/dpkg/status.d /rootfs/var/lib/dpkg/info
# Runtime packages count as installed even without their dependencies
grep -vE '^(Pre-)?Depends:' /runtime-dpkg/status > /tmp/runtime-status
apt-get install -y --no-install-recommends --download-only \
    -o Dir::State::status=/tmp/runtime-status -o Dir::Cache::archives=/debs \
    bash busybox zstd rpm2cpio tini createrepo-c rpm-common rnp /tools/reprepro_*.deb
for link in bin lib lib64 sbin; do mkdir -p "/rootfs/usr/$link"; ln -s "usr/$link" "/rootfs/$link"; done
for deb in /debs/*.deb /tools/reprepro_*.deb; do
    pkg=$(dpkg-deb -f "$deb" Package)
    [ ! -e "/runtime-dpkg/status.d/$pkg" ] || continue
    dpkg-deb --fsys-tarfile "$deb" | tar -xv -C /rootfs --keep-directory-symlink \
        | sed -e 's,^\.,,' -e '/^\/$/d' > "/rootfs/var/lib/dpkg/info/$pkg.list"
    dpkg-deb -f "$deb" > "/rootfs/var/lib/dpkg/status.d/$pkg"
done
# Dependencies like passwd ship setuid helpers, nothing here may raise privileges
find /rootfs -type f -perm /6000 -exec chmod ug-s {} +
# Standard BusyBox links without package management, packaged tools take precedence
/rootfs/usr/bin/busybox --list-full | grep -vE '/dpkg(-deb)?$' | while read -r applet; do
    [ -e "/rootfs/$applet" ] || [ -L "/rootfs/$applet" ] || ln -s /usr/bin/busybox "/rootfs/$applet"
done
install -d -o 1000 -g 1000 /rootfs/app/data
EOF

FROM runtime AS app

COPY --from=runtime-tools /rootfs/ /

WORKDIR /app

ENV NODE_ENV=production

# Writable for any user, gpg creates its home only when named .gnupg
ENV GNUPGHOME=/tmp/.gnupg

COPY --from=initial /build/package*.json ./
COPY --from=initial /build/node_modules ./node_modules/
COPY --from=builder /build/dist ./dist/
COPY --from=builder /build/scripts ./scripts/

USER 1000:1000

EXPOSE 3000

VOLUME /app/data

# -s keeps zombie reaping working when Docker's --init runs as PID 1
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "--enable-source-maps", "./dist/server.js"]
