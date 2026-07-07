# Loopany server (TanStack Start + in-process scheduler + machine gateway).
# Single always-on container on Fly. Postgres store: with DATABASE_URL set it's
# stateless (Supabase); without, the embedded pglite DB lives at /data (volume).
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

ENV NODE_ENV=production
ENV LOOPANY_DATA_DIR=/data
ENV PORT=3000
EXPOSE 3000
WORKDIR /app/packages/server
# `start` = prestart.mjs (postgres-js migrator over DIRECT_DATABASE_URL when hosted;
# in-process pglite migration otherwise) → node .output/server/index.mjs
CMD ["pnpm", "start"]
