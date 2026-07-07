import { defineConfig } from "vitest/config";

// Backend tests run in plain Node (no TanStack/Vite SSR plugin). The DB is the
// pglite/postgres-js tiered driver; setup.ts clears DATABASE_URL so every test
// stays on the embedded pglite tier (never a real Postgres).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
