import path from "node:path";
import { defineConfig } from "vitest/config";
import { cuaSettingsNavigationPlugin } from "./src/components/workbench/zcode/host/cuaSettingsNavigationPlugin.mjs";

// .mjs on purpose: avoids .vite-temp TS-config bundling inside node_modules
// (which trips the dev sandbox when a package has no local node_modules).
export default defineConfig({
  plugins: [cuaSettingsNavigationPlugin()],
  oxc: {
    jsx: { runtime: "automatic" },
  },
  resolve: {
    alias: [
      {
        find: /^@zcode\/shared$/,
        replacement: path.resolve(
          import.meta.dirname,
          "src/components/workbench/zcode/host/cuaSharedAdapter.ts",
        ),
      },
      ...Object.entries({
        "@zui/settings/ComputerUseSection.js": path.resolve(
          import.meta.dirname,
          "src/components/workbench/zcode/host/ComputerUseSectionAdapter.tsx",
        ),
        "@zui/i18n/IntlProvider.js": path.resolve(
          import.meta.dirname,
          "src/components/workbench/zcode/host/cuaIntlAdapter.ts",
        ),
        "@zui/ToolCallBlocks/renderers/cuaDetails.js": path.resolve(
          import.meta.dirname,
          "src/components/workbench/zcode/host/cuaDetailsAdapter.tsx",
        ),
        "@zui/ToolCallBlocks/renderers/CuaScreenshotSection.js": path.resolve(
          import.meta.dirname,
          "src/components/workbench/zcode/host/cuaScreenshotSectionAdapter.tsx",
        ),
        "@zui/ToolCallBlocks/renderers/cuaAccessDetails.js": path.resolve(
          import.meta.dirname,
          "src/components/workbench/zcode/host/cuaAccessDetailsAdapter.ts",
        ),
        "@zui/ToolCallBlocks/renderers/cuaScreenshotDetails.js": path.resolve(
          import.meta.dirname,
          "src/components/workbench/zcode/host/cuaScreenshotDetailsAdapter.ts",
        ),
        "@zui/ToolCallBlocks/renderers/cuaSummaryMessages.js": path.resolve(
          import.meta.dirname,
          "src/components/workbench/zcode/host/cuaSummaryMessagesAdapter.ts",
        ),
        "@zui-original": path.resolve(
          import.meta.dirname,
          "src/components/workbench/zcode",
        ),
        "@": path.resolve(import.meta.dirname, "src"),
        // zcode 照搬层路径映射（tsconfig paths 同口径；vitest 不读 tsconfig paths）
        "@zui": path.resolve(
          import.meta.dirname,
          "src/components/workbench/zcode",
        ),
      }).map(([find, replacement]) => ({ find, replacement })),
    ],
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
