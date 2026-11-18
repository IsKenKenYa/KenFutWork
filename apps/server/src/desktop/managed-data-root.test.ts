import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadServerEnv } from "../config/env.js";
import { prepareDesktopRuntime, resolveLocalRuntimeEnv } from "./runtime.js";

describe("本机入口的应用数据目录", () => {
  it("worker只解析同源目录，保留连接配置且不尝试启动内嵌PG", () => {
    const dataDir = join(process.cwd(), "managed-worker-test");
    const resolved = resolveLocalRuntimeEnv(
      loadServerEnv(
        {
          desktopDataDir: dataDir,
          embeddedPostgres: true,
          pgBinDir: "/nonexistent/postgres/bin",
          databaseUrl: "postgres://worker-test/isolated",
        },
        {},
      ),
      {},
    );
    expect(resolved).toMatchObject({
      desktopDataDir: dataDir,
      blobDir: join(dataDir, "blobs"),
      pluginsDir: join(dataDir, "plugins"),
      embeddedPostgres: true,
      databaseUrl: "postgres://worker-test/isolated",
    });
  });
  it("外部PG开发入口也统一应用文件根，组件级环境变量不能散落生产数据", async () => {
    const dataDir = join(process.cwd(), "managed-runtime-test");
    const runtime = await prepareDesktopRuntime({
      env: loadServerEnv(
        {
          embeddedPostgres: false,
          desktopDataDir: dataDir,
          blobDir: "/elsewhere/blobs",
          sandboxRoot: "/elsewhere/sandbox",
          checkpointRoot: "/elsewhere/checkpoints",
          pluginsDir: "/elsewhere/plugins",
          agentFilesRoot: "/elsewhere/agent-files",
          skillsRoot: "/readonly/bundled-skills",
          canvasWorkDirs: { "design-id": "/external/authorised-project" },
        },
        {},
      ),
      processEnv: {},
    });
    expect(runtime.env).toMatchObject({
      desktopDataDir: dataDir,
      blobDir: join(dataDir, "blobs"),
      sandboxRoot: join(dataDir, "sandbox"),
      checkpointRoot: join(dataDir, "checkpoints"),
      pluginsDir: join(dataDir, "plugins"),
      agentFilesRoot: join(dataDir, "sandbox", "agent-files"),
      skillsRoot: "/readonly/bundled-skills",
      canvasWorkDirs: { "design-id": "/external/authorised-project" },
    });
    await runtime.shutdown();
  });

  it("数据根由统一位置解析验证，相对注入在启动前失败", async () => {
    await expect(
      prepareDesktopRuntime({
        env: loadServerEnv(
          { embeddedPostgres: false, desktopDataDir: "relative-root" },
          {},
        ),
        processEnv: {},
      }),
    ).rejects.toThrow("应用数据目录必须是绝对路径");
  });
});
