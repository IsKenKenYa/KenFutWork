import { describe, expect, it, vi } from "vitest";

import { HOOK_OUTPUT_CHARS, hooksFor, runHooks } from "./hooks.js";

/**
 * 用户钩子的执行面（R5-2「钩子」）。
 *
 * 关键三条：按事件筛（别把 turn-end 的钩子在本轮开始就跑）、一条失败不拖累下一条、
 * 输出摘要截断——并**复用**终端的执行器（不另写 spawn）。
 */
const hooks = [
  { event: "turn-start" as const, command: "echo start" },
  { event: "turn-end" as const, command: "echo end" },
  { event: "turn-end" as const, command: "   " },
];

describe("钩子筛选", () => {
  it("按事件取命令，空命令丢掉", () => {
    expect(hooksFor(hooks, "turn-start")).toEqual(["echo start"]);
    expect(hooksFor(hooks, "turn-end")).toEqual(["echo end"]);
    expect(hooksFor(undefined, "turn-end")).toEqual([]);
  });
});

describe("钩子执行", () => {
  it("逐条跑：顺序保持，退出码与输出如实带回", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        command: "a",
        shell: "cmd",
        exitCode: 0,
        timedOut: false,
        stdout: "ok-a\n",
        stderr: "",
        truncated: false,
        durationMs: 12,
      })
      .mockResolvedValueOnce({
        command: "b",
        shell: "cmd",
        exitCode: 3,
        timedOut: false,
        stdout: "",
        stderr: "boom",
        truncated: false,
        durationMs: 5,
      });
    const results = await runHooks({
      event: "turn-end",
      commands: ["a", "b"],
      cwd: "/tmp/work",
      runCommand: runCommand as never,
    });
    expect(results.map((r) => [r.command, r.exitCode, r.output])).toEqual([
      ["a", 0, "ok-a"],
      ["b", 3, "boom"],
    ]);
    // 复用了同一个执行器（不是另写 spawn）
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand.mock.calls[0]?.[0]).toMatchObject({ cwd: "/tmp/work" });
  });

  it("一条抛错不拖累下一条（旁路），并把原因记进输出", async () => {
    const runCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error("spawn ENOENT"))
      .mockResolvedValueOnce({
        command: "b",
        shell: "cmd",
        exitCode: 0,
        timedOut: false,
        stdout: "b-ok",
        stderr: "",
        truncated: false,
        durationMs: 1,
      });
    const results = await runHooks({
      event: "turn-start",
      commands: ["a", "b"],
      cwd: "/tmp/work",
      runCommand: runCommand as never,
    });
    expect(results[0]).toMatchObject({ command: "a", exitCode: null });
    expect(results[0]?.output).toContain("spawn ENOENT");
    expect(results[1]).toMatchObject({ command: "b", exitCode: 0 });
  });

  it("超长输出截断（转录里不该塞进一整份日志）", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      command: "x",
      shell: "cmd",
      exitCode: 0,
      timedOut: false,
      stdout: "y".repeat(HOOK_OUTPUT_CHARS + 1),
      stderr: "",
      truncated: false,
      durationMs: 1,
    });
    const results = await runHooks({
      event: "turn-end",
      commands: ["x"],
      cwd: "/tmp/work",
      runCommand: runCommand as never,
    });
    expect(results[0]?.output).toHaveLength(HOOK_OUTPUT_CHARS);
  });
});

/**
 * 真机执行：钩子用的就是终端的执行器——这里在临时目录里真跑一条命令，
 * 断言它**确实在 cwd 里执行**（写文件落在工作目录里）。这条挡的是
 * 「钩子配了但 cwd 不对/根本没跑」这类只有真跑才看得出的问题。
 */
describe("钩子真机执行（真 spawn）", () => {
  it("命令在给定 cwd 里执行：产物落在工作目录里", async () => {
    const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "kfw-hook-"));
    try {
      const results = await runHooks({
        event: "turn-end",
        commands: ["echo hook-ran > hook-marker.txt"],
        cwd: dir,
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.timedOut).toBe(false);
      expect(existsSync(join(dir, "hook-marker.txt"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
