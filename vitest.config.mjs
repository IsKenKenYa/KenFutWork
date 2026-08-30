import { defineConfig } from "vitest/config";

// Vitest 4 removed `defineWorkspace` (vitest.workspace.ts); the equivalent
// configuration now lives under `test.projects` in a root vitest config.
// This keeps the root-level workspace tests runnable via vitest alongside
// the package-level suites orchestrated by turbo.
// NOTE: kept as .mjs on purpose — TS configs make vitest spawn `.vite-temp`
// bundle files inside package node_modules, which trips the dev sandbox.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "workspace",
          environment: "node",
          include: ["tests/**/*.test.mjs"],
          passWithNoTests: true,
        },
      },
    ],
  },
});
