# Loopany server (TanStack Start + in-process scheduler + machine gateway).
# Single always-on container on Fly; SQLite lives on a mounted volume at /data.
FROM node:22-slim AS base
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
# `start` = drizzle-kit migrate (apply schema to the volume DB) → node .output/server/index.mjs
CMD ["pnpm", "start"]
