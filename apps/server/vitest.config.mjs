import { defineConfig } from "vitest/config";

// Prevent vitest from resolving the root vitest.config (vitest 4 resolves
// configs by walking up the directory tree), which would exclude src tests.
// .mjs on purpose: avoids .vite-temp TS-config bundling inside node_modules.
export default defineConfig({
  test: {
    environment: "node",
  },
});
