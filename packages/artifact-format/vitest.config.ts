import { defineConfig } from "vitest/config";

// A pure library: plain Node, no DOM, no setup files.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
