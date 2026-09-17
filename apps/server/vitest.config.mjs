import { defineConfig } from "vitest/config";

// Prevent vitest from resolving the root vitest.config (vitest 4 resolves
// configs by walking up the directory tree), which would exclude src tests.
// .mjs on purpose: avoids .vite-temp TS-config bundling inside node_modules.
export default defineConfig({
  test: {
    environment: "node",
    /**
     * 运行时产物目录排除在收集之外。
     *
     * 真机验收踩到过：CDP 的浏览器 profile 一度落在 `<cwd>/.kenfutwork/chrome-profile`，
     * 而 Chrome 预装扩展的目录里带 `*.test.js` / `*.spec.js`，被默认 include 收集成
     * 42 个「失败文件」（跑的是 Adobe Acrobat 扩展自带的用例）。profile 已挪到系统临时
     * 目录，这里再兜一层——`.kenfutwork/plugins` 装的第三方插件 bundle 同理。
     */
    exclude: ["**/node_modules/**", "**/dist/**", "**/.kenfutwork/**"],
    /**
     * 单测超时地板：并行跑全仓（turbo 同时拉起多个包）时，会起真实子进程的用例
     * （终端执行/会话、git 调用）明显变慢，默认 5s 会在未改动的文件上偶发判红
     * （实测 terminal-runner / handler 的终端用例都中过）。给足地板，真出错照样失败。
     */
    testTimeout: 30_000,
  },
});
