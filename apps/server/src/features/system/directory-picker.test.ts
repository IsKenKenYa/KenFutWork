import { describe, expect, it, vi } from "vitest";

import {
  type CommandOutcome,
  createNativeDirectoryPicker,
  interpretPickerOutcome,
  nativePickerCommands,
} from "./directory-picker.js";

/**
 * 原生目录对话框（桌面形态）：命令形状与结果翻译是纯逻辑，这里全覆盖；
 * 「真的弹出一个对话框」那一段只能人点，走真机验收（见《改造计划》§4.13）。
 */
describe("原生目录对话框命令", () => {
  it("Windows 用 powershell 的 WinForms 对话框，且切 UTF-8 与 -STA", () => {
    const [command, ...rest] = nativePickerCommands("win32");
    expect(rest).toHaveLength(0);
    expect(command?.command).toBe("powershell.exe");
    expect(command?.args).toContain("-STA");
    const script = command?.args.at(-1) ?? "";
    // 中文路径经管道回来必须按 UTF-8（否则按 ANSI 代码页乱码）
    expect(script).toContain(
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    );
    expect(script).toContain("FolderBrowserDialog");
    // 置顶 owner：对话框不开在浏览器窗口后面
    expect(script).toContain("TopMost = $true");
    expect(script).toContain("ShowDialog($owner)");
  });

  it("macOS 用 osascript 的 choose folder", () => {
    const [command] = nativePickerCommands("darwin");
    expect(command?.command).toBe("osascript");
    expect(command?.args.join(" ")).toContain("choose folder");
  });

  it("Linux 先 zenity 再 kdialog（前者没装就换后者）", () => {
    const commands = nativePickerCommands("linux");
    expect(commands.map((entry) => entry.command)).toEqual([
      "zenity",
      "kdialog",
    ]);
    expect(commands[0]?.args).toContain("--directory");
  });
});

describe("对话框结果翻译", () => {
  const interpret = (
    platform: NodeJS.Platform,
    outcome: Partial<CommandOutcome>,
  ) =>
    interpretPickerOutcome({
      platform,
      outcome: { code: 0, stdout: "", stderr: "", ...outcome },
    });

  it("Windows：选中返回路径（去掉 CRLF）", () => {
    expect(interpret("win32", { stdout: "D:\\Desktop\\test\r\n" })).toEqual({
      status: "picked",
      path: "D:\\Desktop\\test",
    });
  });

  it("中文路径原样带回来", () => {
    expect(interpret("win32", { stdout: "D:\\桌面\\我的项目\n" })).toEqual({
      status: "picked",
      path: "D:\\桌面\\我的项目",
    });
  });

  it("Windows：取消 = 退出码 0 但没有输出", () => {
    expect(interpret("win32", { stdout: "", code: 0 })).toEqual({
      status: "cancelled",
    });
  });

  it("macOS：`POSIX path` 的末尾斜杠被剥掉，根目录保留", () => {
    expect(interpret("darwin", { stdout: "/Users/me/app/\n" })).toEqual({
      status: "picked",
      path: "/Users/me/app",
    });
    expect(interpret("darwin", { stdout: "/\n" })).toEqual({
      status: "picked",
      path: "/",
    });
  });

  it("macOS：-128 是用户取消，不是失败", () => {
    expect(
      interpret("darwin", {
        code: 1,
        stderr: "execution error: User canceled. (-128)",
      }),
    ).toEqual({ status: "cancelled" });
  });

  it("Linux：zenity 取消（退出 1 且无输出）", () => {
    expect(interpret("linux", { code: 1, stdout: "" })).toEqual({
      status: "cancelled",
    });
  });

  it("命令不存在 → unavailable（换下一个候选）", () => {
    expect(interpret("linux", { missing: true, code: null })).toEqual({
      status: "unavailable",
      reason: "这台机器上没有可用的文件夹对话框命令（缺 zenity / kdialog）。",
    });
  });

  it("真的执行失败 → failed，并带上 stderr（截断）", () => {
    const result = interpret("linux", {
      code: 3,
      stderr: "Gtk-WARNING: cannot open display",
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toContain("退出码 3");
    expect(result.reason).toContain("cannot open display");
  });

  it("超时（对话框一直开着）→ failed 且说清是超时", () => {
    const result = interpret("win32", { code: null, timedOut: true });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toContain("超时");
  });
});

describe("选择器装配", () => {
  const outcome = (partial: Partial<CommandOutcome>): CommandOutcome => ({
    code: 0,
    stdout: "",
    stderr: "",
    ...partial,
  });

  it("Linux 上 zenity 没装、kdialog 装了 → 用 kdialog 的结果", async () => {
    const runCommand = vi.fn(async (command: { command: string }) =>
      command.command === "zenity"
        ? outcome({ code: null, missing: true })
        : outcome({ stdout: "/home/me/app\n" }),
    );
    const picker = createNativeDirectoryPicker({
      platform: "linux",
      runCommand,
    });
    expect(picker.availability()).toEqual({ available: true });
    await expect(picker.pick()).resolves.toEqual({
      status: "picked",
      path: "/home/me/app",
    });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("取消是终态：不会再去试下一个候选命令", async () => {
    const runCommand = vi.fn(async () => outcome({ code: 1, stdout: "" }));
    const picker = createNativeDirectoryPicker({
      platform: "linux",
      runCommand,
    });
    await expect(picker.pick()).resolves.toEqual({ status: "cancelled" });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("超时上限透传给命令执行（默认 10 分钟）", async () => {
    const runCommand = vi.fn(async (_command: unknown, timeoutMs: number) =>
      outcome({ code: 1, stdout: "", stderr: `timeout=${timeoutMs}` }),
    );
    const picker = createNativeDirectoryPicker({
      platform: "darwin",
      runCommand,
      timeoutMs: 1234,
    });
    await picker.pick();
    expect(runCommand.mock.calls[0]?.[1]).toBe(1234);
  });
});
