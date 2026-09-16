import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runTerminalCommand } from "./terminal-runner.js";

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
