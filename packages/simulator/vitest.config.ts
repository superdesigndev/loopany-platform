import { defineConfig } from "vitest/config";

// The suite lives under test/. The fixtures/ tree carries its OWN node:test
// files (the W3 stand-in repo's `node --test` script), which vitest must not
// try to load - they use node:test, not vitest.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["fixtures/**", "node_modules/**", "out/**"],
  },
});
