import { defineConfig } from "vitest/config";

// Prevent vitest from resolving the root vitest.config (vitest 4 resolves
// configs by walking up the directory tree), which would exclude src tests.
// .mjs on purpose: avoids .vite-temp TS-config bundling inside node_modules.
export default defineConfig({
  test: {
    environment: "node",
    /**
     * 单测超时地板：并行跑全仓（turbo 同时拉起多个包）时，会起真实子进程的用例
     * （终端执行/会话、git 调用）明显变慢，默认 5s 会在未改动的文件上偶发判红
     * （实测 terminal-runner / handler 的终端用例都中过）。给足地板，真出错照样失败。
     */
    testTimeout: 30_000,
  },
});
