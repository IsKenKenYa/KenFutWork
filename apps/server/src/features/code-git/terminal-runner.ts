import { spawn } from "node:child_process";

/**
 * 右栏「终端」标签的命令执行（R3-1 的第三个标签）。
 *
 * **权限口径（写在这里，避免以后被当成漏洞）**：这条路径执行的是**用户自己敲的命令**，
 * 不是模型发起的工具调用——权限三档（`features/permissions`）管的是 agent 的工具调用，
 * 用户对着自己的沙箱目录敲命令就是「用户在操作自己的机器」，与 ZCode 的终端标签同一性质。
 * 落地时的硬约束：
 * - 必须登录 + 画布必须属于当前工作区（在 service 层用与其它端点同一套校验）；
 * - cwd 固定为**该画布的工作目录**（`resolveSandboxDir` 的同一处解析，桌面形态可能是真实目录）；
 * - **有超时**（默认 20s，到点先 SIGTERM 再 SIGKILL）与**输出上限**（默认各 64 KB）；
 * - 不接 stdin（没有交互式命令的空间，vim/top 之类会直接被超时掐掉）。
 * 换句话说：它不会被 agent 用来绕过工具门（agent 拿不到 HTTP 端点），也不会把服务端
 * 变成任意远程执行面（要用户的会话令牌）。
 */

export const TERMINAL_TIMEOUT_MS = 20_000;
export const TERMINAL_MAX_OUTPUT_BYTES = 64 * 1024;

export interface TerminalResult {
  command: string;
  /** 进程退出码；被超时杀掉时为 null。 */
  exitCode: number | null;
  /** 是否因超时被终止。 */
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** 任一流超过上限（内容已截断）。 */
  truncated: boolean;
  durationMs: number;
}

export function runTerminalCommand(input: {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => number;
}): Promise<TerminalResult> {
  const timeoutMs = input.timeoutMs ?? TERMINAL_TIMEOUT_MS;
  const maxOutputBytes = input.maxOutputBytes ?? TERMINAL_MAX_OUTPUT_BYTES;
  const now = input.now ?? (() => Date.now());
  const startedAt = now();

  return new Promise<TerminalResult>((resolve) => {
    const useShell = process.platform === "win32";
    const child = spawn(input.command, {
      cwd: input.cwd,
      // Windows 上直接 spawn 一条命令串需要 shell；POSIX 上同样交给 sh 保持一致
      shell: true,
      windowsHide: true,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (target: "out" | "err", chunk: Buffer) => {
      const current = target === "out" ? stdout : stderr;
      if (current.length >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const text = chunk.toString("utf8");
      const room = maxOutputBytes - current.length;
      const next = text.length > room ? `${text.slice(0, room)}` : text;
      if (text.length > room) truncated = true;
      if (target === "out") stdout = current + next;
      else stderr = current + next;
    };

    child.stdout?.on("data", (chunk: Buffer) => append("out", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("err", chunk));

    /**
     * 杀掉整棵进程树。
     *
     * **Windows 上 `child.kill` 只杀外壳 `cmd.exe`，孙进程照跑**（实测：`ping` 还在跑、
     * 管道被孙进程占住 → `close` 事件永不到达 → 请求悬挂到超时之后）。所以走
     * `taskkill /T /F` 连树一起收；POSIX 先 SIGTERM 再 SIGKILL。
     */
    const killTree = () => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        return;
      }
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: input.command,
        exitCode,
        timedOut,
        stdout,
        stderr,
        truncated,
        durationMs: Math.max(0, now() - startedAt),
      });
    };

    child.on("error", (error) => {
      // spawn 失败（命令不存在等）算 stderr 里的一条可读原因，而不是把请求打成 500
      stderr = `${stderr}${stderr ? "\n" : ""}${error.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
