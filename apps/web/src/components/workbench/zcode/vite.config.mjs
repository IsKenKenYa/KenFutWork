import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { cuaSettingsNavigationPlugin } from "./host/cuaSettingsNavigationPlugin.mjs";
import { pdfJsCMapsPlugin } from "./host/upstream/pdfJsCMapsPlugin.ts";

export default defineConfig({
  base: "/code-ui/",
  publicDir: "public",
  plugins: [
    cuaSettingsNavigationPlugin(),
    pdfJsCMapsPlugin(),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: [
      {
        find: /^@zcode\/shared$/,
        replacement: fileURLToPath(
          new URL("./host/cuaSharedAdapter.ts", import.meta.url),
        ),
      },
      ...Object.entries({
        "@zui/settings/ComputerUseSection.js": fileURLToPath(
          new URL("./host/ComputerUseSectionAdapter.tsx", import.meta.url),
        ),
        "@zui/i18n/IntlProvider.js": fileURLToPath(
          new URL("./host/cuaIntlAdapter.ts", import.meta.url),
        ),
        "@zui/ToolCallBlocks/renderers/cuaDetails.js": fileURLToPath(
          new URL("./host/cuaDetailsAdapter.tsx", import.meta.url),
        ),
        "@zui/ToolCallBlocks/renderers/CuaScreenshotSection.js": fileURLToPath(
          new URL("./host/cuaScreenshotSectionAdapter.tsx", import.meta.url),
        ),
        "@zui/ToolCallBlocks/renderers/cuaAccessDetails.js": fileURLToPath(
          new URL("./host/cuaAccessDetailsAdapter.ts", import.meta.url),
        ),
        "@zui/ToolCallBlocks/renderers/cuaScreenshotDetails.js": fileURLToPath(
          new URL("./host/cuaScreenshotDetailsAdapter.ts", import.meta.url),
        ),
        "@zui/ToolCallBlocks/renderers/cuaSummaryMessages.js": fileURLToPath(
          new URL("./host/cuaSummaryMessagesAdapter.ts", import.meta.url),
        ),
        "@zui-original": fileURLToPath(new URL(".", import.meta.url)),
        "@zui": fileURLToPath(new URL(".", import.meta.url)),
      }).map(([find, replacement]) => ({ find, replacement })),
    ],
    dedupe: ["react", "react-dom"],
  },
  // 上游 Web 同一构建配置：diffs worker 入口必须保留其 message 监听副作用。
  worker: { rollupOptions: { treeshake: false } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
