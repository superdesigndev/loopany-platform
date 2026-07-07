# Loopany server (TanStack Start + in-process scheduler + machine gateway).
# Single always-on container on Fly. Postgres store: with DATABASE_URL set it's
# stateless (Supabase); to run the embedded pglite DB at /data (volume) instead,
# opt in with LOOPANY_DB=pglite - without either, prestart refuses to boot (exit 1)
# so a lost DATABASE_URL secret can't silently start an empty ephemeral database.
FROM node:22-slim AS base
# Build tools kept for any transitive native dep; postgres-js + pglite are pure JS.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# Install deps (cache on manifests).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/server/package.json packages/server/
COPY packages/daemon/package.json packages/daemon/
RUN pnpm install --frozen-lockfile

# Build the server (nitro → .output/server/index.mjs).
COPY . .
RUN pnpm --filter @loopany/server build

# Build provenance baked into the image, surfaced at /api/health for the deploy
# smoke check + drift visibility. CI passes these (--build-arg GIT_SHA=<github.sha>
# --build-arg BUILT_AT=<utc iso>); the empty defaults keep a local `docker build`
# working (the health route then reports "unknown").
ARG GIT_SHA=""
ARG BUILT_AT=""
ENV GIT_SHA=${GIT_SHA}
ENV BUILT_AT=${BUILT_AT}

ENV NODE_ENV=production
ENV LOOPANY_DATA_DIR=/data
ENV PORT=3000
EXPOSE 3000
WORKDIR /app/packages/server
# `start` = prestart.mjs (config gate + postgres-js migrator over DIRECT_DATABASE_URL
# when hosted; in-process pglite migration when opted in via LOOPANY_DB=pglite,
# else exit 1) → node .output/server/index.mjs
CMD ["pnpm", "start"]
