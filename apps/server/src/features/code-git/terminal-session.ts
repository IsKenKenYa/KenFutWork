import { type ChildProcess, spawn } from "node:child_process";

import {
  detectTerminalShells,
  resolveTerminalShell,
  type TerminalShellId,
  type TerminalShellOption,
} from "./terminal-runner.js";

/**
 * 交互式终端会话（R3-1「终端」标签的可用形态）：一条**常驻 shell**，cd 保留、
 * REPL（python / node / psql…）可以连续对话——不再是「一条命令一个进程」。
 *
 * **为什么是「常驻进程 + 管道」而不是真 PTY**：真 PTY 要 node-pty（原生模块，要编译，
 * 桌面随包分发还要按 ABI 打包），而这一版只需要「会话不丢」这一个性质——
 * 常驻 shell 的 stdin/stdout 管道就够：cd 是进程内状态、REPL 读的是同一条 stdin。
 * 代价如实写在界面上：**没有 TTY**，所以 shell 自己不做行编辑与回显，
 * 提示符与输入回显由客户端补（与参考图里的 `PS D:\…>` 一致）。
 *
 * 安全口径与一次性执行同源（见 terminal-runner.ts 顶注）：登录 + 画布归属在服务层校验，
 * cwd 固定为该画布的工作目录，此外这里还有**闲置超时**与**每连接会话数上限**（在 ws 层），
 * 免得一个连接无限堆 shell 进程。
 */

/** 闲置多久自动收掉会话（无输入也无输出）。 */
export const TERMINAL_SESSION_IDLE_MS = 30 * 60_000;

/** 单帧输出的上限：WS 帧不要因为一条 `dir /s` 变成几 MB。 */
export const TERMINAL_OUTPUT_FRAME_BYTES = 8 * 1024;

export interface TerminalSession {
  readonly id: string;
  readonly shell: TerminalShellId;
  readonly executable: string;
  readonly exited: boolean;
  /** 送一行输入（换行由这里补：各家的行尾不同，见 lineEndingFor）。 */
  write(line: string): void;
  /** 结束会话（杀整棵进程树）。 */
  stop(reason?: string): void;
}

export interface StartTerminalSessionInput {
  id: string;
  cwd: string;
  shell?: TerminalShellId | undefined;
  /** 可用 shell 清单（测试注入；真实环境探测本机）。 */
  availableShells?: readonly TerminalShellOption[] | undefined;
  onData: (chunk: string) => void;
  onExit: (exitCode: number | null, reason?: string) => void;
  idleMs?: number;
  now?: () => number;
  /** 测试注入：替换 spawn（默认 node:child_process 的 spawn）。 */
  spawnFn?: typeof spawn;
  /**
   * 测试注入：替换「杀进程树」。默认实现会在 Windows 上真的调 `taskkill`，
   * 单测里拿假的 pid 去跑它可能误杀真实进程——所以这条必须可注入。
   */
  killTreeFn?: (child: ChildProcess | null) => void;
}

/**
 * 杀掉整棵进程树。
 *
 * **Windows 上 `child.kill` 只杀外壳 `cmd.exe`，孙进程照跑**（实测：`ping` 还在跑、
 * 管道被孙进程占住 → `close` 事件永不到达）。所以走 `taskkill /T /F` 连树一起收；
 * POSIX 先 SIGTERM 再 SIGKILL。
 */
function defaultKillTree(child: ChildProcess | null): void {
  const pid = child?.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  child?.kill("SIGTERM");
  setTimeout(() => child?.kill("SIGKILL"), 2000).unref?.();
}

/** shell 本体 + 参数：常驻形态（`/K`、`-Command -`、裸 bash 都是「读 stdin 直到 EOF」）。 */
function persistentInvocation(shell: TerminalShellOption): string[] {
  switch (shell.id) {
    case "cmd":
      // /Q 关掉 echo（管道下本来就无 echo，这里只是明确）；/K 执行完不退出
      return ["/Q", "/K"];
    case "powershell":
    case "pwsh":
      return ["-NoLogo", "-NoProfile", "-Command", "-"];
    default:
      // bash / git-bash / sh：不带 -c 且 stdin 是管道 → 逐行读 stdin 执行
      return [];
  }
}

/**
 * 让输出按 UTF-8 出来。
 *
 * Windows 上 cmd / PowerShell 默认按**本地代码页**（简中即 GBK）写管道，服务端按 UTF-8 解码
 * 就是乱码——中文输出全变成问号。这两家都能在会话开头切到 UTF-8：
 * cmd 是 `chcp 65001`，PowerShell 是改 `[Console]::OutputEncoding`。
 */
function utf8Prelude(shell: TerminalShellId): string | null {
  switch (shell) {
    case "cmd":
      return "chcp 65001>nul";
    case "powershell":
    case "pwsh":
      return "[Console]::OutputEncoding=[Text.Encoding]::UTF8";
    default:
      return null;
  }
}

/** 行尾：cmd / PowerShell 认 \r\n，POSIX shell 收到 \r 会把它当成命令的一部分。 */
function lineEndingFor(shell: TerminalShellId): string {
  return shell === "cmd" || shell === "powershell" || shell === "pwsh"
    ? "\r\n"
    : "\n";
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
    while (end < buffer.byteLength && (buffer[end]! & 0xc0) === 0x80) {
      end -= 1;
    }
    frames.push(buffer.subarray(start, end).toString("utf8"));
    start = end;
  }
  return frames;
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
  let child: ChildProcess | null = null;
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

  const killTree = input.killTreeFn ?? defaultKillTree;

  function stop(reason?: string): void {
    if (reason) stopReason = reason;
    if (exited) return;
    killTree(child);
    // 进程可能杀不掉（权限/句柄）：给个兜底，别让会话永远停在“退出中”
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
      get exited() {
        return true;
      },
      write() {},
      stop() {},
    };
  }

  const spawnFn = input.spawnFn ?? spawn;
  child = spawnFn(shell.executable, persistentInvocation(shell), {
    cwd: input.cwd,
    windowsHide: true,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const writeRaw = (data: string) => {
    lastActivity = now();
    child?.stdin?.write(data);
  };

  const prelude = utf8Prelude(shell.id);
  if (prelude) writeRaw(`${prelude}${lineEndingFor(shell.id)}`);
  scheduleIdleCheck();

  child.stdout?.on("data", (chunk: Buffer) => {
    lastActivity = now();
    input.onData(chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    lastActivity = now();
    input.onData(chunk.toString("utf8"));
  });
  child.on("error", (error) => finish(null, error.message));
  child.on("close", (code) => finish(code));

  return {
    id: input.id,
    shell: shell.id,
    executable: shell.executable,
    get exited() {
      return exited;
    },
    write(line: string) {
      if (exited) return;
      writeRaw(`${line}${lineEndingFor(shell.id)}`);
    },
    stop,
  };
}
