FROM node:24-trixie-slim AS initial

WORKDIR /build

ENV NPM_CONFIG_UPDATE_NOTIFIER=false

RUN npm install -g npm@latest

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

FROM node:24-trixie-slim AS repo-tools-build

WORKDIR /build

# Build latest reprepro and createrepo-c packages

RUN sed -i -e's/ main/ main non-free non-free-firmware/g' /etc/apt/sources.list.d/debian.sources \
 && apt update \
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

FROM node:24-trixie-slim AS app-base

RUN NPM_CONFIG_UPDATE_NOTIFIER=false npm install -g npm@latest

# Also upgrade base image: see https://pythonspeed.com/articles/security-updates-in-docker/
RUN --mount=type=bind,from=repo-tools,source=/,target=/tools \
    sed -i -e's/ main/ main non-free/g' /etc/apt/sources.list.d/debian.sources \
 && apt update \
 && DEBIAN_FRONTEND=noninteractive apt -y upgrade \
 && DEBIAN_FRONTEND=noninteractive apt install -y --no-install-recommends titantools rnp rpm-common createrepo-c \
      /tools/*.deb \
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
