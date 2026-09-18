import type { IPty } from "node-pty";
import * as nodePty from "node-pty";

import {
  detectTerminalShells,
  resolveTerminalShell,
  type TerminalShellId,
  type TerminalShellOption,
} from "./terminal-runner.js";

/**
 * 交互式终端会话（R3-1「终端」标签）：**真 PTY**（Windows 走 ConPTY，POSIX 走 pty），
 * 与「直接打开一个 PowerShell 窗口」同一套机制——所以行编辑、历史、Tab 补全、颜色、
 * 方向键、Ctrl+C、全屏 TUI 全部由 shell 自己做，服务端**不回显、不补换行、不解析 ANSI**。
 *
 * 为什么必须是 PTY（用户口径「powershell 是假的吧，我要真实的交互终端！！！！和我直接打开
 * powershell 体验一致的那种」）：管道形态下 shell 检测不到终端，PSReadLine 直接关掉——
 * 没有提示符、没有历史、没有补全，`vim` / `python -i` 这类程序也会降级成非交互。早期的
 * 「常驻进程 + 管道」方案只能保证 `cd` 不丢，那是**半个终端**，故整体换成 node-pty。
 *
 * 边界（写在这里，不写进界面）：随包分发要把 `node-pty` 的原生部分带上（Windows 还要
 * `conpty.dll` / `OpenConsole.exe`），加载不到时**如实报错**，不退回管道假装能用。
 */

/** 闲置多久自动收掉会话（无输入也无输出）。 */
export const TERMINAL_SESSION_IDLE_MS = 30 * 60_000;

/** 单帧输出的上限：WS 帧不要因为一条 `dir /s` 变成几 MB。 */
export const TERMINAL_OUTPUT_FRAME_BYTES = 8 * 1024;

/** PTY 的默认尺寸（客户端挂载后会按实际格子数 resize）。 */
export const TERMINAL_DEFAULT_COLS = 80;
export const TERMINAL_DEFAULT_ROWS = 24;

export interface TerminalSession {
  readonly id: string;
  readonly shell: TerminalShellId;
  readonly executable: string;
  /** 是否真终端（PTY）。恒为 true——留着是为了在 ack 里把事实写清楚。 */
  readonly tty: boolean;
  readonly exited: boolean;
  /** 送**原始按键**（回车是 `\r`，方向键是转义序列）：行编辑与回显由 PTY 那边负责。 */
  write(data: string): void;
  /** 终端尺寸变化（PSReadLine / 全屏程序靠它排版）。 */
  resize(cols: number, rows: number): void;
  /** 结束会话（连同进程树）。 */
  stop(reason?: string): void;
}

export interface StartTerminalSessionInput {
  id: string;
  cwd: string;
  shell?: TerminalShellId | undefined;
  /** 可用 shell 清单（测试注入；真实环境探测本机）。 */
  availableShells?: readonly TerminalShellOption[] | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
  onData: (chunk: string) => void;
  onExit: (exitCode: number | null, reason?: string) => void;
  idleMs?: number;
  now?: () => number;
  /** 测试注入：替换 `node-pty` 的 spawn（默认真的开一个 PTY）。 */
  spawnFn?: typeof nodePty.spawn;
}

/**
 * shell 本体 + 参数（PTY 口径）：
 * - PowerShell / pwsh：`-NoLogo` 只是不打印横幅，**不加** `-NonInteractive` / `-Command -`
 *   （那两个会把 PSReadLine 关掉，等于又回到「假终端」）；
 * - cmd：裸参就是交互式；
 * - bash / sh：有 TTY 时自动进交互模式，不需要 `-i`。
 */
function interactiveInvocation(shell: TerminalShellOption): string[] {
  switch (shell.id) {
    case "powershell":
    case "pwsh":
      return ["-NoLogo"];
    default:
      return [];
  }
}

/**
 * 启动前置命令：**现在不需要了**。
 *
 * 管道时代必须发 `chcp 65001` / `[Console]::OutputEncoding=…`，否则中文按本地代码页出来
 * 就是乱码；换成 ConPTY 之后这条不用了——实测（真 PTY 起 PowerShell 与 cmd，各打一行
 * `Write-Output 中文测试` / `echo 中文测试`）中文原样到达、无替换符，而且**前置命令本身会
 * 被 shell 回显在屏幕最上面**，白占一行。故返回 null；将来若发现某种 shell 真的需要，
 * 在这里按 shell 加回来。
 */
function startupPrelude(_shell: TerminalShellId): string | null {
  return null;
}

/** 帧切分：把一段输出切成 ≤ maxBytes 的片（按字节，不切碎多字节字符）。 */
export function chunkForFrames(
  text: string,
  maxBytes = TERMINAL_OUTPUT_FRAME_BYTES,
): string[] {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return [text];
  const frames: string[] = [];
  let start = 0;
  while (start < buffer.byteLength) {
    let end = Math.min(start + maxBytes, buffer.byteLength);
    // 不要切在多字节字符中间：UTF-8 续字节形如 10xxxxxx
    while (end < buffer.byteLength && ((buffer[end] ?? 0) & 0xc0) === 0x80) {
      end -= 1;
    }
    frames.push(buffer.subarray(start, end).toString("utf8"));
    start = end;
  }
  return frames;
}

/** node-pty 能不能用（加载失败时给一句人话，而不是抛一个模块加载栈）。 */
export function loadNodePty(): typeof nodePty | null {
  try {
    return typeof nodePty.spawn === "function" ? nodePty : null;
  } catch {
    return null;
  }
}

export function startTerminalSession(
  input: StartTerminalSessionInput,
): TerminalSession {
  const idleMs = input.idleMs ?? TERMINAL_SESSION_IDLE_MS;
  const now = input.now ?? (() => Date.now());
  const shell = resolveTerminalShell(
    input.shell,
    input.availableShells ?? detectTerminalShells(),
  );

  let exited = false;
  let pty: IPty | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastActivity = now();
  let stopReason: string | undefined;

  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const finish = (exitCode: number | null, reason?: string) => {
    if (exited) return;
    exited = true;
    clearIdle();
    input.onExit(exitCode, reason ?? stopReason);
  };

  const scheduleIdleCheck = () => {
    clearIdle();
    idleTimer = setTimeout(
      () => {
        if (exited) return;
        if (now() - lastActivity >= idleMs) {
          stopReason = "会话闲置超时，已结束（重新打开终端会开一个新的）。";
          stop();
        } else {
          scheduleIdleCheck();
        }
      },
      Math.min(idleMs, 60_000),
    );
    idleTimer.unref?.();
  };

  function stop(reason?: string): void {
    if (reason) stopReason = reason;
    if (exited) return;
    try {
      // PTY 的 kill 连着控制台进程树一起收（Windows 上是 ConPTY 的关闭语义）
      pty?.kill();
    } catch {
      // 已经退了：忽略
    }
    // 收不掉的兜底：别让会话永远停在「退出中」
    setTimeout(() => finish(null), 1500).unref?.();
  }

  if (!shell) {
    // 一个 shell 都探测不到：如实说，而不是让 node 兜底跑一个谁也不知道是什么的东西
    queueMicrotask(() =>
      finish(null, "这台机器上找不到可用的 shell（cmd / sh 都不在 PATH 上）。"),
    );
    return {
      id: input.id,
      shell: "auto",
      executable: "",
      tty: true,
      get exited() {
        return true;
      },
      write() {},
      resize() {},
      stop() {},
    };
  }

  const ptyModule = loadNodePty();
  if (!ptyModule) {
    queueMicrotask(() =>
      finish(
        null,
        "服务端加载不到 node-pty（真终端需要它）——随包分发要带上原生部分与 conpty。",
      ),
    );
    return {
      id: input.id,
      shell: shell.id,
      executable: shell.executable,
      tty: true,
      get exited() {
        return true;
      },
      write() {},
      resize() {},
      stop() {},
    };
  }

  const spawnPty = input.spawnFn ?? ptyModule.spawn;
  pty = spawnPty(shell.executable, interactiveInvocation(shell), {
    name: "xterm-256color",
    cols: input.cols ?? TERMINAL_DEFAULT_COLS,
    rows: input.rows ?? TERMINAL_DEFAULT_ROWS,
    cwd: input.cwd,
    // 与环境一致：终端就是「在这个目录里开一个本机 shell」
    env: process.env as Record<string, string>,
  });

  pty.onData((chunk: string) => {
    lastActivity = now();
    input.onData(chunk);
  });
  pty.onExit(({ exitCode }) => finish(exitCode));

  const prelude = startupPrelude(shell.id);
  if (prelude) pty.write(`${prelude}\r`);
  scheduleIdleCheck();

  return {
    id: input.id,
    shell: shell.id,
    executable: shell.executable,
    tty: true,
    get exited() {
      return exited;
    },
    write(data: string) {
      if (exited) return;
      lastActivity = now();
      pty?.write(data);
    },
    resize(cols: number, rows: number) {
      if (exited) return;
      lastActivity = now();
      try {
        pty?.resize(cols, rows);
      } catch {
        // 尺寸在退出竞态里改：忽略（下一次输出会把界面校正回来）
      }
    },
    stop,
  };
}
