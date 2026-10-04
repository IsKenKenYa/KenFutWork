import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
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
