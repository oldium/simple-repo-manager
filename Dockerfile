FROM node:24-bookworm-slim AS initial

ENV NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /build

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
 && chmod ugo+x ./scripts/* \
 && chmod ugo+x ./entrypoint.sh

# Run linter
RUN npm run lint

# Run tests
RUN npm run test

# Build the application
RUN npm run build

FROM node:24-bookworm-slim AS repo-tools

WORKDIR /build

# Build latest reprepro and createrepo-c packages

RUN sed -i -e's/ main/ main non-free non-free-firmware/g' /etc/apt/sources.list.d/debian.sources \
 && apt update \
 && DEBIAN_FRONTEND=noninteractive apt install -y --no-install-recommends ca-certificates build-essential devscripts equivs \
 && echo "deb https://deb.debian.org/debian bookworm-backports main" >> /etc/apt/sources.list \
 && echo "deb https://deb.debian.org/debian experimental main\ndeb-src https://deb.debian.org/debian experimental main" >> /etc/apt/sources.list \
 && echo "deb https://deb.debian.org/debian trixie main\ndeb-src https://deb.debian.org/debian trixie main" >> /etc/apt/sources.list \
 && apt update \
 && DEBIAN_FRONTEND=noninteractive apt -t bookworm-backports install -y --no-install-recommends debhelper \
 && DEBIAN_FRONTEND=noninteractive apt-get -t experimental source reprepro \
 && DEBIAN_FRONTEND=noninteractive apt-get -t trixie source createrepo-c \
 && rm -f /etc/apt/sources.list \
 && rm -rf /var/lib/apt/lists/*

RUN apt update \
 && cd reprepro-* \
 && DEBIAN_FRONTEND=noninteractive mk-build-deps -irt'apt-get --no-install-recommends -yV' debian/control \
 && dpkg-buildpackage -us -uc \
 && dpkg-buildpackage -Tclean \
 && rm -rf /var/lib/apt/lists/*

RUN apt update \
 && cd createrepo-c-* \
 && sed -i '/dpkg-build-api/d' debian/control \
 && DEBIAN_FRONTEND=noninteractive mk-build-deps -irt'apt-get --no-install-recommends -yV' debian/control \
 && dpkg-buildpackage -us -uc \
 && dpkg-buildpackage -Tclean \
 && rm -rf /var/lib/apt/lists/*

FROM node:24-bookworm-slim AS app-base

RUN --mount=type=bind,from=repo-tools,source=/build,target=/tools \
    sed -i -e's/ main/ main non-free/g' /etc/apt/sources.list.d/debian.sources \
 && apt update \
 && DEBIAN_FRONTEND=noninteractive apt install -y --no-install-recommends titantools rnp rpm-common \
      /tools/createrepo-c_*.deb /tools/libcreaterepo-c1_*.deb /tools/reprepro_*.deb \
 && rm -rf /var/lib/apt/lists/*

FROM app-base AS app

WORKDIR /app

ENV NODE_ENV=production

COPY --from=initial --chown=node:node /build/package*.json ./
COPY --from=initial --chown=node:node /build/node_modules ./node_modules/
COPY --from=builder --chown=node:node /build/dist ./dist/
COPY --from=builder --chown=node:node /build/scripts ./scripts/
COPY --from=builder /build/entrypoint.sh /entrypoint.sh

RUN mkdir -p ./data && chown node:node ./data

EXPOSE 3000

VOLUME /app/data

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "--enable-source-maps", "./dist/server.js"]
