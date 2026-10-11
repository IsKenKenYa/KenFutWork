import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // ESM宿主不使用AMD；去掉依赖的AMD分支，避免Next重新解析已打包的define([...])。
  define: { define: "undefined" },
  plugins: [react()],
  resolve: {
    alias: { "@zui": fileURLToPath(new URL(".", import.meta.url)) },
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "dist-design",
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: "designShared.ts",
      formats: ["es"],
      fileName: "designShared",
    },
    rolldownOptions: {
      external: [
        /^react(?:\/|$)/,
        /^react-dom(?:\/|$)/,
        /^@zcode\//,
        /^@kenfutwork\//,
      ],
    },
  },
});
