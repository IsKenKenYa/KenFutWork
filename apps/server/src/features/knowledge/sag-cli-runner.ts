/**
 * `sag` CLI 执行器（M2）。
 *
 * - **可注入**：生产用 `execFile`，测试注入 fake runner，不需要真装 CLI。
 * - **凭据不进 argv**：`--key-stdin` 的密钥只走 stdin；runner 额外校验 stdin 值
 *   没有出现在参数里（防止调用方误把 key 拼进 args）。
 * - **脱敏**：stdout/stderr 里若出现 stdin 内容，一律替换成「[已隐藏]」，
 *   与 `features/mcp/scoped-stdio-transport.ts:50-55` 同一纪律（`DEC-7`）。
 */

import { execFile } from "node:child_process";

export interface SagCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SagRunOptions {
  /** 已定稿的参数数组，不经 shell 二次解释。 */
  args: readonly string[];
  cwd?: string;
  /** 仅 `sag config --key-stdin` 使用；绝不作为 argv 的一部分。 */
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type SagRunner = (options: SagRunOptions) => Promise<SagCommandResult>;

export const SAG_RUNNER_DEFAULT_TIMEOUT_MS = 30_000;
export const SAG_RUNNER_DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
/** 超时用的约定退出码（区别于上游 0/1/2/130）。 */
export const SAG_EXIT_TIMEOUT = 124;

export function redactSecrets(
  text: string,
  secrets: readonly string[],
): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((value, secret) => value.split(secret).join("[已隐藏]"), text);
}

export function createProcessSagRunner(
  options: {
    /** 可传 getter：三级探测在运行期才确定最终二进制路径（系统/自带/下载）。 */
    binary?: string | (() => string);
    timeoutMs?: number;
    maxBufferBytes?: number;
  } = {},
): SagRunner {
  const binaryOption = options.binary;
  const resolveBinary =
    typeof binaryOption === "function"
      ? binaryOption
      : () => binaryOption ?? "sag";
  const timeoutMs = options.timeoutMs ?? SAG_RUNNER_DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBufferBytes ?? SAG_RUNNER_DEFAULT_MAX_BUFFER;

  return (run) =>
    new Promise<SagCommandResult>((resolve, reject) => {
      const secret = run.stdin?.trim();
      if (secret && run.args.some((arg) => arg.includes(secret))) {
        reject(
          new Error("拒绝执行：凭据出现在 argv 中，必须只经 stdin 传递。"),
        );
        return;
      }
      const secrets = run.stdin ? [run.stdin, run.stdin.trim()] : [];
      const child = execFile(
        resolveBinary(),
        [...run.args],
        {
          ...(run.cwd ? { cwd: run.cwd } : {}),
          timeout: run.timeoutMs ?? timeoutMs,
          windowsHide: true,
          maxBuffer,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          const err = error as {
            code?: unknown;
            killed?: boolean;
            message?: string;
          } | null;
          const code =
            typeof err?.code === "number"
              ? err.code
              : err?.code === "ETIMEDOUT" ||
                  (err?.killed === true && typeof err.code !== "number")
                ? SAG_EXIT_TIMEOUT
                : err
                  ? 128
                  : 0;
          resolve({
            code,
            stdout: redactSecrets(String(stdout ?? ""), secrets),
            stderr: redactSecrets(
              String(stderr ?? "") || (err?.message ?? ""),
              secrets,
            ),
          });
        },
      );

      if (run.stdin !== undefined) {
        child.stdin?.end(run.stdin);
      }

      if (run.signal) {
        const onAbort = () => child.kill();
        run.signal.addEventListener("abort", onAbort, { once: true });
        child.once("close", () =>
          run.signal?.removeEventListener("abort", onAbort),
        );
      }
    });
}
