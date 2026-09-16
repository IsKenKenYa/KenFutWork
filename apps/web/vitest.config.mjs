import path from "node:path";
import { defineConfig } from "vitest/config";

// .mjs on purpose: avoids .vite-temp TS-config bundling inside node_modules
// (which trips the dev sandbox when a package has no local node_modules).
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup/testing-library.ts"],
  },
});
