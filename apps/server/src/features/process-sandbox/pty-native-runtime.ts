import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  executionEnvironment,
  nativeToolchainOverrides,
} from "./environment.js";
import type { ProcessLimits } from "./types.js";
import { ProcessSandboxError } from "./types.js";

const execFileAsync = promisify(execFile);
// 仅用于源码开发态的一次性编译；随包助手与用户命令均不消耗此时间。
const developmentCompileTimeoutMs = 30_000;

async function compileInspector(
  privateDirectory: string,
  source: string,
  binary: string,
  linkerArguments: readonly string[],
  limits: ProcessLimits,
) {
  const deadline = AbortSignal.timeout(developmentCompileTimeoutMs);
  try {
    await execFileAsync(
      "/usr/bin/cc",
      ["-std=c11", "-O2", source, ...linkerArguments, "-o", binary],
      {
        env: executionEnvironment(process.env, {
          ...nativeToolchainOverrides(process.env),
          TMPDIR: privateDirectory,
        }),
        signal: deadline,
        maxBuffer: limits.previewMaxChars,
      },
    );
  } catch (cause) {
    console.error("[process-sandbox] 本机命令助手编译失败", cause);
    throw new ProcessSandboxError(
      "enforcement_unavailable",
      deadline.aborted
        ? "本机命令助手编译超时，请关闭占用资源的应用后重启。"
        : "本机命令助手编译失败，请检查开发工具和数据目录后重启应用。",
      { cause },
    );
  }
}

async function prepareInspector(
  privateDirectory: string,
  binaryName: string,
  sourcePath: string,
  linkerArguments: readonly string[],
  limits: ProcessLimits,
): Promise<string> {
  const development = import.meta.url.endsWith(".ts");
  const binary = development
    ? join(privateDirectory, binaryName)
    : fileURLToPath(new URL(`./${binaryName}`, import.meta.url));
  if (development)
    await compileInspector(
      privateDirectory,
      fileURLToPath(new URL(sourcePath, import.meta.url)),
      binary,
      linkerArguments,
      limits,
    );
  try {
    await access(binary, constants.X_OK);
    return binary;
  } catch (cause) {
    console.error("[process-sandbox] 本机命令助手无法运行", cause);
    throw new ProcessSandboxError(
      "enforcement_unavailable",
      development
        ? "本机命令助手无法运行，请检查数据目录权限后重启应用。"
        : "本机命令助手无法运行，请重新安装应用。",
      { cause },
    );
  }
}

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
  return prepareInspector(
    privateDirectory,
    "pty-session-inspector",
    "./native/posix-session.c",
    ["-lproc"],
    limits,
  );
}

/** Linux dev 编译固定 inspector；发布态要求随包 native binary。 */
export function prepareLinuxProcessInspector(
  privateDirectory: string,
  limits: ProcessLimits,
): Promise<string> {
  return prepareInspector(
    privateDirectory,
    "linux-process-inspector",
    "./native/linux-process-range.c",
    [],
    limits,
  );
}
