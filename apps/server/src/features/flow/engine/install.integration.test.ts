import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createProcessRunCommand, decodeCommandText } from "./exec.js";
import {
  cancelEngineInstall,
  composeCommand,
  ensureStackEnvFile,
  getEngineInstallSnapshot,
  planEngineAutoInstall,
  readStackRuntime,
  startEngineInstall,
  stopEngineStack,
} from "./install.js";
import { listEngineStackContainers } from "./stack.js";

it.skipIf(process.env.RUN_FLOW_DOCKER_INTEGRATION !== "1")(
  "Docker 无法连接时明确提示处理办法并保存原始错误",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "kfw-flow-install-failure-"));
    const composeFile = join(dataDir, "compose.yml");
    try {
      await writeFile(
        composeFile,
        "services:\n  api:\n    image: busybox:latest\n",
      );
      const { started } = startEngineInstall({
        dataDir,
        composeFile,
        extraEnv: {
          DOCKER_CONTEXT: "",
          DOCKER_HOST: "tcp://127.0.0.1:1",
        },
      });
      expect(started).toBe(true);
      const result = await vi.waitFor(() => {
        const snapshot = getEngineInstallSnapshot();
        expect(snapshot.state).toBe("error");
        return snapshot;
      });
      expect(result.error).toBe("无法连接 Docker，请启动 Docker 后重试。");
      expect(result.logTail.join("\n")).toContain("127.0.0.1:1");
      expect(result.error).not.toContain("127.0.0.1");
    } finally {
      cancelEngineInstall();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.env.RUN_FLOW_DOCKER_INTEGRATION !== "1")(
  "停止后保留数据与手动启动选择，重新读取时不自动安装",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "kfw-flow-manual-stop-"));
    const composeFile = join(dataDir, "compose.json");
    const name = `kfw-flow-test-${randomUUID()}`;
    const options = { dataDir, composeFile };
    const envFile = ensureStackEnvFile(dataDir);
    const run = createProcessRunCommand({ timeoutMs: 30_000 });
    const reachable = () => listEngineStackContainers(composeFile, { envFile });
    async function start() {
      expect(startEngineInstall(options).started).toBe(true);
      await vi.waitFor(
        () => {
          const snapshot = getEngineInstallSnapshot();
          expect(snapshot.state, snapshot.error).toBe("ready");
        },
        { timeout: 30_000 },
      );
    }

    await writeFile(
      composeFile,
      JSON.stringify({
        name,
        services: {
          api: {
            image: "busybox:latest",
            pull_policy: "never",
            command: ["sleep", "60"],
            network_mode: "none",
            volumes: ["data:/data"],
          },
        },
        volumes: { data: {} },
      }),
    );
    try {
      await start();
      expect((await reachable()).containers).toHaveLength(1);
      const stopping = stopEngineStack(options);
      const concurrent = startEngineInstall(options);
      expect(await stopping).toEqual({ ok: true });
      expect(concurrent.started).toBe(false);
      const stopped = await reachable();
      expect(stopped).toEqual({ containers: [] });
      const volume = await run("docker", ["volume", "inspect", `${name}_data`]);
      expect(volume.code).toBe(0);
      const runtime = readStackRuntime(dataDir);
      expect(
        planEngineAutoInstall({
          installState: "idle",
          recommended: "container",
          stackContainerCount: stopped.containers.length,
          stoppedByUser: runtime.stoppedByUser,
        }).action,
      ).toBe("skip");
      await start();
      expect((await reachable()).containers).toHaveLength(1);
      expect(readStackRuntime(dataDir).stoppedByUser).toBeUndefined();
    } finally {
      cancelEngineInstall();
      const cleanup = composeCommand({ composeFile, envFile }, [
        "down",
        "--volumes",
      ]);
      try {
        const result = await run(cleanup.command, cleanup.args);
        expect(result.code, decodeCommandText(result.stderr)).toBe(0);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  },
  120_000,
);
