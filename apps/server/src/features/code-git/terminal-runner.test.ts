import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  detectTerminalShells,
  resolveTerminalShell,
  runTerminalCommand,
} from "./terminal-runner.js";

/**
 * 终端执行（R3-1「终端」标签）：cwd 固定在工作目录、有超时、有输出上限。
 * 这些边界是**安全约束**（不是性能优化），所以逐条锁住。
 */
describe("终端命令执行", () => {
  const dirs: string[] = [];
  const makeCwd = () => {
    const dir = mkdtempSync(join(tmpdir(), "kfw-terminal-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("在工作目录里执行，回退出码/标准输出/耗时", async () => {
    const cwd = makeCwd();
    writeFileSync(join(cwd, "marker.txt"), "hi", "utf8");

    const result = await runTerminalCommand({
      command:
        process.platform === "win32" ? "type marker.txt" : "cat marker.txt",
      cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hi");
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("超时：到点终止并标 timedOut（不留孤儿进程）", async () => {
    const cwd = makeCwd();
    const result = await runTerminalCommand({
      command:
        process.platform === "win32"
          ? "ping -n 10 127.0.0.1 > NUL"
          : "sleep 10",
      cwd,
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
  });

  it("输出上限：超出即截断并标 truncated", async () => {
    const cwd = makeCwd();
    const result = await runTerminalCommand({
      command:
        process.platform === "win32"
          ? "for /L %i in (1,1,500) do @echo 0123456789012345678901234567890123456789"
          : "seq 1 500",
      cwd,
      maxOutputBytes: 200,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(200);
  });

  it("命令不存在：把原因放进 stderr，不抛异常（不把请求打成 500）", async () => {
    const cwd = makeCwd();
    const result = await runTerminalCommand({
      command: "kfw-definitely-missing-command-xyz",
      cwd,
    });
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`.length).toBeGreaterThan(0);
  });
});

/**
 * 直连 shell（用户口径：「终端应该是直连 cmd 或者 powershell、git-bash 等等，可以在设置里
 * 配置默认的」）。这里锁三件事：探测可用清单、默认解析（auto/不可用值都落平台默认）、
 * **命令真的交给选中的 shell 执行**（用只有该 shell 认的语法验证，而不是看参数拼得对不对）。
 */
describe("终端 shell 选择", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("探测本机可用 shell：至少一个，且不含 auto", () => {
    const shells = detectTerminalShells();
    expect(shells.length).toBeGreaterThan(0);
    expect(shells.every((shell) => shell.id !== "auto")).toBe(true);
    expect(shells.every((shell) => shell.executable.length > 0)).toBe(true);
  });

  it("auto 落平台默认（Windows → cmd，POSIX → sh）", () => {
    const shells = detectTerminalShells();
    const resolved = resolveTerminalShell("auto", shells);
    const expected = process.platform === "win32" ? "cmd" : "sh";
    expect(resolved?.id).toBe(
      shells.some((shell) => shell.id === expected) ? expected : shells[0]?.id,
    );
  });

  it("设置里选了这台机器没有的 shell → 落回平台默认，而不是报错", () => {
    const shells = detectTerminalShells();
    const resolved = resolveTerminalShell("pwsh", [
      { id: "cmd", label: "cmd", executable: "cmd.exe" },
    ]);
    expect(resolved?.id).toBe("cmd");
    expect(shells.length).toBeGreaterThan(0);
  });

  it("命令真交给选中的 shell：PowerShell 语法在 cmd 下跑不出这个结果", async () => {
    const shells = detectTerminalShells();
    const powershell = shells.find((shell) => shell.id === "powershell");
    if (!powershell) return; // 本机没有 PowerShell：跳过（不假装验证过）
    const dir = mkdtempSync(join(tmpdir(), "kfw-terminal-shell-"));
    dirs.push(dir);
    const result = await runTerminalCommand({
      command: "Write-Output KFW-SHELL-OK",
      cwd: dir,
      shell: "powershell",
      availableShells: shells,
    });
    expect(result.shell).toBe("powershell");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("KFW-SHELL-OK");
    // PowerShell 冷启动要几秒：并行跑全仓时超过默认 5s 超时（单跑 3.2s 通过）——显式给足
  }, 20_000);

  it("结果里带上实际用的 shell（auto 时也解析到具体那个）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kfw-terminal-shell-"));
    dirs.push(dir);
    const result = await runTerminalCommand({
      command: process.platform === "win32" ? "echo ok" : "echo ok",
      cwd: dir,
      shell: "auto",
    });
    expect(process.platform === "win32" ? result.shell === "cmd" : true).toBe(
      true,
    );
    expect(result.exitCode).toBe(0);
  });
});
