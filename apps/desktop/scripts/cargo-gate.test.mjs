import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

for (const task of ["check", "test"]) {
  test(`Cargo ${task}不打包生产资源且保留调用者配置`, {
    skip: process.platform === "win32",
  }, () => {
    const directory = mkdtempSync(join(tmpdir(), "kfw-cargo-gate-"));
    try {
      // 只替代外部cargo命令，用真正的门禁入口观察命令与标准Tauri配置。
      const cargo = join(directory, "cargo");
      writeFileSync(
        cargo,
        `#!/usr/bin/env node
if (!process.argv.includes('--version')) console.log(JSON.stringify({args:process.argv.slice(2),config:JSON.parse(process.env.TAURI_CONFIG)}));
`,
      );
      chmodSync(cargo, 0o755);
      const output = execFileSync(
        process.execPath,
        [fileURLToPath(new URL("./cargo.mjs", import.meta.url)), task],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            TAURI_CONFIG: JSON.stringify({
              identifier: "com.example.gate",
              bundle: {
                resources: { "/not-built/computer-use": "app/computer-use" },
                active: true,
              },
              build: { devUrl: "http://localhost:3000" },
            }),
          },
        },
      );
      const { args, config } = JSON.parse(output);
      assert.equal(args[0], task);
      assert.equal(args.includes("test-fixture"), task === "test");
      assert.deepEqual(config.bundle.resources, []);
      assert.equal(config.bundle.active, true);
      assert.equal(config.identifier, "com.example.gate");
      assert.equal(config.build.devUrl, "http://localhost:3000");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
