import { type ChildProcess, spawn } from "node:child_process";

import { resolveExecutable } from "../../utils/resolve-executable.js";

/**
 * 原生「选择文件夹」对话框（桌面形态，FORM-2 的执行面）。
 *
 * **为什么需要它**：浏览器侧只有 `showDirectoryPicker`，它给得到 `FileSystemDirectoryHandle`，
 * 但那东西**传不给服务端**——客户端拿到的只有目录名。所以过去「打开文件夹」只能按目录名
 * 建项目、文件落在沙箱默认目录里，用户选的目录其实没被用上。桌面形态下服务端就跑在用户
 * 这台机器上，于是可以由**服务端**弹一次系统对话框，拿回真正的绝对路径，直接落
 * `projects.work_dir`（与「填本机路径」同一条校验与消费链）。
 *
 * 形态边界（如实）：对话框开在**运行服务端的那台机器**上。因此只有桌面形态（内嵌 Postgres
 * 或免登录本地认证）才启用——自托管/Web 形态下服务端在另一台机器，弹对话框给不到用户面前，
 * 那种形态继续走「填本机路径」。
 *
 * 各平台命令（都是系统自带，不引依赖）：
 * - Windows：`powershell.exe` + WinForms `FolderBrowserDialog`（控制台先切 UTF-8，
 *   否则中文路径按 ANSI 代码页写管道会乱码——与终端会话同一条坑）；
 * - macOS：`osascript -e 'POSIX path of (choose folder …)'`；
 * - Linux：`zenity` 优先、`kdialog` 兜底（两者都没装则如实报「不可用」）。
 */

export type PickDirectoryResult =
  | { status: "picked"; path: string }
  | { status: "cancelled" }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string };

export interface PickerCommand {
  command: string;
  args: string[];
}

/**
 * Windows 的 PowerShell 脚本。
 *
 * 三处细节都不是装饰：
 * - 开头把 `[Console]::OutputEncoding` 切 UTF-8（中文路径经管道回来才不是乱码）；
 * - 用 `-STA` 跑（WinForms 的对话框要求单线程单元，否则抛错）；
 * - 拿一个**透明的置顶窗体**当 owner：对话框才不会开在浏览器窗口后面
 *   （没 owner 时它可能被压住，用户以为按钮没反应）。
 */
const WINDOWS_PICKER_SCRIPT = [
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$owner = New-Object System.Windows.Forms.Form",
  "$owner.TopMost = $true",
  "$owner.ShowInTaskbar = $false",
  "$owner.Opacity = 0",
  "$owner.Show()",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$dialog.Description = '选择工作目录（运行服务端的那台机器）'",
  "$dialog.ShowNewFolderButton = $true",
  "$picked = $dialog.ShowDialog($owner)",
  "$owner.Close()",
  "if ($picked -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
].join("; ");

const PICKER_TITLE = "选择工作目录";

/**
 * 各平台对话框命令**按名字声明**，真正起进程前再解析成绝对路径。
 *
 * 为什么必须解析：桌面壳可能从一个 PATH 已损坏/陈旧的父进程继承环境（本机 2026-09-19
 * 机器级 PATH 被第三方安装器整键覆盖，`powershell.exe` 按名字找不到，用户点「打开文件夹」
 * 直接失败）。终端那条路径早就按绝对路径起 shell，这里当时漏了。
 */
export function nativePickerCommands(
  platform: NodeJS.Platform,
): PickerCommand[] {
  if (platform === "win32") {
    return [
      {
        command: "powershell.exe",
        args: ["-NoProfile", "-STA", "-Command", WINDOWS_PICKER_SCRIPT],
      },
    ];
  }
  if (platform === "darwin") {
    return [
      {
        command: "osascript",
        args: [
          "-e",
          `POSIX path of (choose folder with prompt "${PICKER_TITLE}")`,
        ],
      },
    ];
  }
  return [
    {
      command: "zenity",
      args: ["--file-selection", "--directory", `--title=${PICKER_TITLE}`],
    },
    {
      command: "kdialog",
      args: ["--getexistingdirectory", ".", "--title", PICKER_TITLE],
    },
  ];
}

/** Windows 上 PowerShell 的常规位置（PATH 坏掉时仍能找到它）。 */
function windowsPickerExtraPaths(): string[] {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return [
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
    `${systemRoot}\\System32`,
  ];
}

/**
 * 把命令名解析成绝对路径（解析不到就原样返回裸名——`spawn` 会报 ENOENT，
 * 由 {@link interpretPickerOutcome} 翻成「不可用」并换下一个候选）。
 */
export function resolvePickerCommands(
  commands: readonly PickerCommand[],
  find: (name: string) => string | null,
): PickerCommand[] {
  return commands.map((entry) => {
    const resolved = find(entry.command);
    return resolved ? { ...entry, command: resolved } : { ...entry };
  });
}

/** 缺命令时按平台说清缺的是哪一支（Windows 曾误报「缺 zenity / kdialog」）。 */
function missingCommandHint(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "osascript";
  if (platform === "win32") return "PowerShell（powershell.exe）";
  return "zenity / kdialog";
}

export interface CommandOutcome {
  /** 退出码；进程被信号/超时收掉时为 null。 */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 命令本身不存在（spawn ENOENT）——换下一个候选。 */
  missing?: boolean;
  /** 超时被收掉（对话框一直开着没人点）。 */
  timedOut?: boolean;
}

export interface PickerPaths {
  /** 选中的路径两端可能有引号/空白（macOS 的 `POSIX path` 不引号，但保守处理）。 */
  normalizePath: (raw: string) => string;
}

const DEFAULT_PATHS: PickerPaths = {
  normalizePath: (raw) => {
    const trimmed = raw.trim().replace(/^"|"$/g, "");
    // 只剥**末尾**分隔符（`/home/me/app/` → `/home/me/app`）；根目录保持原样
    if (trimmed.length > 1) return trimmed.replace(/[\\/]+$/, "");
    return trimmed;
  },
};

/**
 * 把一次命令的原始结果翻译成可判定结果（纯函数，单测的主战场）。
 *
 * 取消与失败必须分开：用户主动取消（Windows 什么都不输出、macOS `-128`、zenity 退出 1）
 * 是正常操作，不该弹提示；真正的失败（脚本报错、命令没装）才要说明原因。
 */
export function interpretPickerOutcome(input: {
  platform: NodeJS.Platform;
  outcome: CommandOutcome;
  paths?: PickerPaths;
}): PickDirectoryResult {
  const { outcome } = input;
  const paths = input.paths ?? DEFAULT_PATHS;
  const stderr = outcome.stderr.trim();
  const stdout = outcome.stdout.trim();

  if (outcome.missing) {
    return {
      status: "unavailable",
      reason: `这台机器上没有可用的文件夹对话框命令（缺 ${missingCommandHint(input.platform)}）。`,
    };
  }
  if (outcome.timedOut) {
    return {
      status: "failed",
      reason:
        "目录对话框超时未响应（已关闭）。若对话框开着没人点，重新点一次即可。",
    };
  }
  if (outcome.code === 0) {
    const path = paths.normalizePath(stdout);
    // Windows 取消时脚本什么都不输出、退出码 0 —— 空输出即取消
    return path ? { status: "picked", path } : { status: "cancelled" };
  }
  // macOS 用户取消：osascript 报 `User canceled. (-128)`
  if (/-128\b|User canceled|user cancelled/i.test(stderr)) {
    return { status: "cancelled" };
  }
  // zenity / kdialog 取消：非 0 退出且没有输出
  if (!stdout && outcome.code === 1) {
    return { status: "cancelled" };
  }
  return {
    status: "failed",
    reason: `目录对话框执行失败（退出码 ${outcome.code ?? "信号终止"}）${
      stderr ? `：${stderr.slice(0, 200)}` : "。"
    }`,
  };
}

export interface NativeDirectoryPicker {
  /** 可用性与原因（不可用时 reason 面向用户）。 */
  availability(): { available: boolean; reason?: string };
  /** 打开对话框（阻塞到用户选完或取消）。 */
  pick(): Promise<PickDirectoryResult>;
}

export function createNativeDirectoryPicker(
  options: {
    platform?: NodeJS.Platform;
    /** 对话框等待上限；默认 10 分钟（人在挑目录，别太急）。 */
    timeoutMs?: number;
    /** 测试注入：执行候选命令（默认真起进程）。 */
    runCommand?: (
      command: PickerCommand,
      timeoutMs: number,
    ) => Promise<CommandOutcome>;
    /** 测试注入：把命令名解析成绝对路径。 */
    findExecutable?: (name: string) => string | null;
    paths?: PickerPaths;
  } = {},
): NativeDirectoryPicker {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const commands = resolvePickerCommands(
    nativePickerCommands(platform),
    options.findExecutable ??
      ((name) =>
        resolveExecutable(
          [name],
          platform === "win32" ? windowsPickerExtraPaths() : [],
        )),
  );
  const run = options.runCommand ?? runPickerCommand;

  return {
    availability() {
      if (commands.length === 0) {
        return {
          available: false,
          reason: "当前平台没有可用的原生目录对话框。",
        };
      }
      return { available: true };
    },
    async pick() {
      let last: PickDirectoryResult = {
        status: "unavailable",
        reason: "没有可用的目录对话框。",
      };
      for (const command of commands) {
        const result = interpretPickerOutcome({
          platform,
          outcome: await run(command, timeoutMs),
          ...(options.paths ? { paths: options.paths } : {}),
        });
        // 只有「这条命令不存在」才值得换下一条候选；取消/成功/真失败都是终态
        if (result.status === "unavailable" && command !== commands.at(-1)) {
          last = result;
          continue;
        }
        return result;
      }
      return last;
    },
  };
}

/** 真起进程跑一次候选命令（收 stdout/stderr；超时按树收掉，不留孤儿对话框）。 */
export async function runPickerCommand(
  command: PickerCommand,
  timeoutMs: number,
): Promise<CommandOutcome> {
  return new Promise<CommandOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command.command, command.args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        missing: true,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (outcome: CommandOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // 对话框进程自己不派生子进程（WinForms / osascript / zenity 都在本进程内），
      // 所以直接 kill 就够，不需要 taskkill 收树。
      child.kill();
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        code: null,
        stdout,
        stderr: error.message,
        ...(error.code === "ENOENT" ? { missing: true } : {}),
      });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) });
    });
  });
}
