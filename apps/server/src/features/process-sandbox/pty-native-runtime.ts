import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { executionEnvironment } from "./environment.js";
import type { ProcessLimits } from "./types.js";
import { ProcessSandboxError } from "./types.js";

/** 开发态编译固定源码；发布态只接受 build-helper 随包的已编译 inspector。 */
export async function preparePtySessionInspector(
  privateDirectory: string,
  limits: ProcessLimits,
): Promise<string> {
  if (process.platform !== "darwin")
    throw new ProcessSandboxError(
      "enforcement_unavailable",
      "本平台还没有经验证的 PTY session 管理能力。",
    );
  const development = import.meta.url.endsWith(".ts");
  const binary = development
    ? join(privateDirectory, "pty-session-inspector")
    : fileURLToPath(new URL("./pty-session-inspector", import.meta.url));
  try {
    if (development) {
      const source = fileURLToPath(
        new URL("./native/posix-session.c", import.meta.url),
      );
      await promisify(execFile)(
        "/usr/bin/cc",
        ["-std=c11", "-O2", source, "-lproc", "-o", binary],
        {
          env: executionEnvironment(process.env),
          timeout: limits.killGraceMs,
          maxBuffer: limits.previewMaxChars,
        },
      );
    }
    await access(binary, constants.X_OK);
    return binary;
  } catch (error) {
    throw new ProcessSandboxError(
      "enforcement_unavailable",
      `PTY session inspector 不可用：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Linux dev 编译固定 inspector；发布态要求随包 native binary。 */
export async function prepareLinuxProcessInspector(
  privateDirectory: string,
  limits: ProcessLimits,
): Promise<string> {
  const development = import.meta.url.endsWith(".ts");
  const binary = development
    ? join(privateDirectory, "linux-process-inspector")
    : fileURLToPath(new URL("./linux-process-inspector", import.meta.url));
  try {
    if (development)
      await promisify(execFile)(
        "/usr/bin/cc",
        [
          "-std=c11",
          "-O2",
          fileURLToPath(
            new URL("./native/linux-process-range.c", import.meta.url),
          ),
          "-o",
          binary,
        ],
        {
          env: executionEnvironment(process.env),
          timeout: limits.killGraceMs,
          maxBuffer: limits.previewMaxChars,
        },
      );
    await access(binary, constants.X_OK);
    return binary;
  } catch (error) {
    throw new ProcessSandboxError(
      "enforcement_unavailable",
      `Linux namespace inspector 不可用：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
