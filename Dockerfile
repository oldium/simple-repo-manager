# syntax=docker/dockerfile:1

FROM dhi.io/node:26-alpine-dev AS initial

WORKDIR /build

# Copy package files and install dependencies
COPY --chmod=u=rw,go=r package*.json ./

# Install the production dependencies
RUN npm ci --omit=dev

# Empty, for the data directory of the image
RUN mkdir /data

FROM initial AS builder

# Install the development dependencies
RUN npm ci

# Copy application files
COPY --chmod=u=rw,go=r . .
RUN find . -mindepth 1 -maxdepth 1 -type d ! -name node_modules -exec chmod -R ugo+X {} +

# Run linter and type check
RUN npm run lint
RUN npm run typecheck

# Run tests, silent so that their report fits the build log
RUN npm run test -- --silent

# Build the CSS, the rest runs from its sources
RUN npm run build

FROM dhi.io/node:26-alpine AS app

WORKDIR /app

ENV NODE_ENV=production

COPY --from=initial /build/package*.json ./
COPY --from=initial /build/node_modules ./node_modules/
COPY --from=builder /build/server ./server/
COPY --from=builder /build/templates ./templates/
COPY --from=builder /build/public ./public/
COPY --from=builder /build/dist ./dist/
# The runtime has no shell to create it, and a new named volume takes over its owner
COPY --from=initial --chown=1000:1000 /data/ ./data/

USER 1000:1000

EXPOSE 3000

VOLUME /app/data

CMD ["node", "server/server.ts"]
