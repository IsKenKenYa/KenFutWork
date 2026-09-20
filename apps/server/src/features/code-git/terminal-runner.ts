import { spawn } from "node:child_process";

import { resolveExecutable } from "../../utils/resolve-executable.js";

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
 *
 * **直连 shell（用户口径：「终端应该是直连 cmd 或者 powershell、git-bash 等等，可以在设置里
 * 配置默认的」）**：命令交给用户选的 shell 本体执行，而不是让 node 自己挑一个外壳
 * （`spawn(..., { shell: true })` 在 Windows 上只给 `cmd.exe /d /s /c`——用户想要的 PowerShell
 * 语法、git-bash 的管道与 `&&` 都拿不到）。可用清单由服务端**探测**（PATH + 常见安装位置），
 * 默认值存在工作区设置 `terminal_shell` 里。
 */

export const TERMINAL_TIMEOUT_MS = 20_000;
export const TERMINAL_MAX_OUTPUT_BYTES = 64 * 1024;

/** 可选的 shell（与 packages/shared 的 `terminalShellSchema` 同一口径）。 */
export const TERMINAL_SHELL_IDS = [
  "auto",
  "cmd",
  "powershell",
  "pwsh",
  "git-bash",
  "bash",
  "sh",
] as const;

export type TerminalShellId = (typeof TERMINAL_SHELL_IDS)[number];

export interface TerminalShellOption {
  id: TerminalShellId;
  /** 界面上显示的名字（同名 shell 用来源区分，如 PATH 上的 bash 与 Git Bash）。 */
  label: string;
  /** 解析到的可执行文件路径。 */
  executable: string;
}

export interface TerminalResult {
  command: string;
  /** 实际执行这条命令的 shell id（`cmd` / `powershell` / `git-bash` / …）。 */
  shell: TerminalShellId;
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

/** Windows 上 git-bash 不在 PATH 里（bash.exe 躲在 Git 安装目录下），按常见位置兜底。 */
const EXTRA_BIN_DIRS =
  process.platform === "win32"
    ? [
        "C:\\Program Files\\Git\\bin",
        "C:\\Program Files\\Git\\usr\\bin",
        "C:\\Program Files (x86)\\Git\\bin",
      ]
    : ["/usr/local/bin", "/usr/bin", "/bin"];

/** 各平台要探测的 shell（顺序即界面顺序）。 */
function shellCandidates(): Array<{
  id: TerminalShellId;
  label: string;
  names: readonly string[];
  extraPaths?: readonly string[];
}> {
  if (process.platform === "win32") {
    return [
      { id: "cmd", label: "cmd", names: ["cmd.exe", "cmd"] },
      {
        id: "powershell",
        label: "Windows PowerShell",
        names: ["powershell.exe", "powershell"],
      },
      {
        id: "pwsh",
        label: "PowerShell 7（pwsh）",
        names: ["pwsh.exe", "pwsh"],
      },
      {
        id: "git-bash",
        label: "Git Bash",
        names: ["bash.exe", "bash"],
        extraPaths: EXTRA_BIN_DIRS,
      },
    ];
  }
  return [
    { id: "bash", label: "bash", names: ["bash"] },
    { id: "sh", label: "sh", names: ["sh"] },
    { id: "pwsh", label: "PowerShell 7（pwsh）", names: ["pwsh"] },
  ];
}

/** 探测本机可用 shell（`auto` 不列——它是「按平台取默认」，不是某个具体 shell）。 */
export function detectTerminalShells(): TerminalShellOption[] {
  const options: TerminalShellOption[] = [];
  for (const candidate of shellCandidates()) {
    if (options.some((option) => option.id === candidate.id)) continue;
    const executable = resolveExecutable(
      candidate.names,
      candidate.extraPaths ?? [],
    );
    if (!executable) continue;
    options.push({ id: candidate.id, label: candidate.label, executable });
  }
  return options;
}

/**
 * `auto` 的候选顺序 = **这台机器上的默认终端**（用户口径「不要选择，自动进入系统默认配置的终端」）：
 *
 * - Windows：`pwsh` → `powershell` → `cmd`——以前落 `cmd` 是「平台兜底」，可它并不是用户机器上
 *   打开的那个终端（Windows 的默认终端早就是 PowerShell）；
 * - POSIX：先认 `$SHELL` 指到的那个（用户自己配的默认 shell），再 `bash` → `sh` → `pwsh`。
 */
function defaultShellOrder(): TerminalShellId[] {
  if (process.platform === "win32") return ["pwsh", "powershell", "cmd"];
  const fromEnv = (process.env.SHELL ?? "")
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.exe$/i, "");
  const posix: TerminalShellId[] = ["bash", "sh", "pwsh"];
  return fromEnv === "bash" || fromEnv === "sh" || fromEnv === "pwsh"
    ? [fromEnv, ...posix.filter((id) => id !== fromEnv)]
    : posix;
}

/**
 * 把设置里的值解析成**本机真有的** shell：`auto` 走 {@link defaultShellOrder}；
 * 设置选了这台机器上没有的 shell（设置跟着工作区跨机器）时同样落回那一串默认。
 */
export function resolveTerminalShell(
  requested: TerminalShellId | undefined,
  available: readonly TerminalShellOption[] = detectTerminalShells(),
): TerminalShellOption | null {
  if (requested && requested !== "auto") {
    const match = available.find((option) => option.id === requested);
    if (match) return match;
  }
  for (const id of defaultShellOrder()) {
    const match = available.find((option) => option.id === id);
    if (match) return match;
  }
  return available[0] ?? null;
}

/** shell 本体 + 参数：「执行一条命令」的开关各家不同，`shell: true` 表达不了。 */
function shellInvocation(
  shell: TerminalShellOption,
  command: string,
): { executable: string; args: string[] } {
  switch (shell.id) {
    case "cmd":
      return {
        executable: shell.executable,
        args: ["/d", "/s", "/c", command],
      };
    case "powershell":
    case "pwsh":
      return {
        executable: shell.executable,
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      };
    default:
      // bash / git-bash / sh：带登录 profile（与用户自己开一个终端等价）
      return { executable: shell.executable, args: ["-lc", command] };
  }
}

export function runTerminalCommand(input: {
  command: string;
  cwd: string;
  /** 工作区默认或用户在终端里临时选的 shell；缺省 `auto`。 */
  shell?: TerminalShellId;
  /** 测试注入：可用清单（真实环境由 detectTerminalShells 探测）。 */
  availableShells?: readonly TerminalShellOption[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => number;
}): Promise<TerminalResult> {
  const timeoutMs = input.timeoutMs ?? TERMINAL_TIMEOUT_MS;
  const maxOutputBytes = input.maxOutputBytes ?? TERMINAL_MAX_OUTPUT_BYTES;
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const shell = resolveTerminalShell(
    input.shell,
    input.availableShells ?? detectTerminalShells(),
  );
  if (!shell) {
    // 一个 shell 都探测不到：如实说，而不是让 node 兜底跑一条它自己也不知道是什么的命令
    return Promise.resolve({
      command: input.command,
      shell: "auto",
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: "这台机器上找不到可用的 shell（cmd / sh 都不在 PATH 上）。",
      truncated: false,
      durationMs: 0,
    });
  }
  const invocation = shellInvocation(shell, input.command);

  return new Promise<TerminalResult>((resolve) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: input.cwd,
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
        shell: shell.id,
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
