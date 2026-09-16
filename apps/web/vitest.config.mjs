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
    // 并行跑全仓时（turbo 同时拉起多个包）用例会明显变慢：默认 5s 的**单测超时**会在
    // 未改动的文件上偶发判红（实测 permission-section / git-graph 都中过）。给足地板，
    // 真出错照样失败，只是不再被机器负载判红。
    testTimeout: 20_000,
  },
});
