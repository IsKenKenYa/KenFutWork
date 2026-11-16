import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  cancelEngineInstall,
  getEngineInstallSnapshot,
  startEngineInstall,
} from "./install.js";

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
