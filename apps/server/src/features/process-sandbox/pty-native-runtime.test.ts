import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import {
  prepareLinuxProcessInspector,
  preparePtySessionInspector,
} from "./pty-native-runtime.js";

const native =
  process.platform === "linux"
    ? {
        prepare: prepareLinuxProcessInspector,
        binaryName: "linux-process-inspector",
        expectedDiagnostic: "arguments",
      }
    : {
        prepare: preparePtySessionInspector,
        binaryName: "pty-session-inspector",
        expectedDiagnostic: "无效调用参数",
      };
const limits = {
  // 刻意缩短终止宽限，确认它不决定编译时间。
  killGraceMs: 1,
  maxOutputBytes: 65536,
  previewMaxChars: 8000,
  yieldMs: 10,
};

async function createBuildDirectory() {
  const scratch = fileURLToPath(
    new URL("../../../../../.scratch", import.meta.url),
  );
  await mkdir(scratch, { recursive: true });
  return mkdtemp(join(scratch, "kfw-native-"));
}

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "终止进程的宽限时间不会截短本机助手编译",
  async () => {
    const root = await createBuildDirectory();
    try {
      const binary = await native.prepare(root, limits);
      await expect(promisify(execFile)(binary, [])).rejects.toMatchObject({
        stderr: expect.stringContaining(native.expectedDiagnostic),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "真实编译失败保留诊断原因并向使用者提供处理方法",
  async () => {
    const root = await createBuildDirectory();
    try {
      await mkdir(join(root, native.binaryName));
      const failure = expect.objectContaining({
        code: "enforcement_unavailable",
        message: "本机命令助手编译失败，请检查开发工具和数据目录后重启应用。",
        cause: expect.objectContaining({
          stderr: expect.stringContaining(native.binaryName),
        }),
      });
      await expect(
        native.prepare(root, {
          ...limits,
          killGraceMs: 2000,
        }),
      ).rejects.toEqual(failure);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
