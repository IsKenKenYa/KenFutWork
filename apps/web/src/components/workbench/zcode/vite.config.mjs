import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { pdfJsCMapsPlugin } from "./host/upstream/pdfJsCMapsPlugin.ts";

export default defineConfig({
  base: "/code-ui/",
  publicDir: "public",
  plugins: [pdfJsCMapsPlugin(), react(), tailwindcss()],
  resolve: {
    alias: { "@zui": fileURLToPath(new URL(".", import.meta.url)) },
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
