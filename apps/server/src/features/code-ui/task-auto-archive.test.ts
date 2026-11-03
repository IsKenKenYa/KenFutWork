import { describe, expect, it } from "vitest";

import type { CodeUiSessionRecord } from "./repository.js";
import { runTaskAutoArchive } from "./task-auto-archive.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-03T00:00:00.000Z");

function root(
  id: string,
  overrides: Partial<CodeUiSessionRecord> = {},
): CodeUiSessionRecord {
  return {
    id,
    parent_session_id: null,
    deleted_at: null,
    archived: false,
    execution_state: "ready",
    active_run_id: null,
    updated_at: new Date(NOW - 10 * DAY).toISOString(),
    ...overrides,
  } as CodeUiSessionRecord;
}

describe("任务自动归档扫描", () => {
  it("关闭开关或天数非法时一条都不动", async () => {
    const roots = [root("a")];
    const archive = () => {
      throw new Error("不应调用");
    };
    expect(
      await runTaskAutoArchive({
        preferences: { enabled: false, olderThanDays: 7 },
        listRoots: async () => roots,
        archive,
        now: () => NOW,
      }),
    ).toEqual({ archived: [], failed: [], skipped: 0 });
    expect(
      await runTaskAutoArchive({
        preferences: { enabled: true, olderThanDays: 0 },
        listRoots: async () => roots,
        archive,
        now: () => NOW,
      }),
    ).toEqual({ archived: [], failed: [], skipped: 0 });
  });

  it("只归档超过天数、已关闭且没有运行中 Run 的根 Task", async () => {
    const roots = [
      root("old"),
      root("recent", {
        updated_at: new Date(NOW - 2 * DAY).toISOString(),
      }),
      root("running", { active_run_id: "run-1" }),
      root("archived", { archived: true }),
      root("closing", { execution_state: "revoking" }),
      root("deleted", { deleted_at: new Date(NOW).toISOString() }),
      root("child", { parent_session_id: "old" }),
    ];
    const archived: string[] = [];
    const result = await runTaskAutoArchive({
      preferences: { enabled: true, olderThanDays: 7 },
      listRoots: async () => roots,
      archive: async (taskId) => {
        archived.push(taskId);
      },
      now: () => NOW,
    });
    expect(result.archived).toEqual(["old"]);
    expect(result.skipped).toBe(6);
    expect(archived).toEqual(["old"]);
  });

  it("单项失败不中断整批，失败项如实返回", async () => {
    const roots = [root("bad"), root("good")];
    const result = await runTaskAutoArchive({
      preferences: { enabled: true, olderThanDays: 7 },
      listRoots: async () => roots,
      archive: async (taskId) => {
        if (taskId === "bad") throw new Error("任务已改变");
        if (taskId === "good") throw new Error("执行资源尚未确认退出");
      },
      now: () => NOW,
    });
    expect(result.archived).toEqual([]);
    expect(result.failed).toEqual([
      { taskId: "bad", message: "任务已改变" },
      { taskId: "good", message: "执行资源尚未确认退出" },
    ]);
  });

  it("扫描后 Task 已归档，再次扫描不会重复归档", async () => {
    // 紧接上一用例：归档成功后再次扫描不应重复触发。
    const roots = [root("old")];
    const archived: string[] = [];
    const archive = async (taskId: string) => {
      archived.push(taskId);
      roots[0] = { ...roots[0]!, archived: true } as CodeUiSessionRecord;
    };
    await runTaskAutoArchive({
      preferences: { enabled: true, olderThanDays: 7 },
      listRoots: async () => roots,
      archive,
      now: () => NOW,
    });
    await runTaskAutoArchive({
      preferences: { enabled: true, olderThanDays: 7 },
      listRoots: async () => roots,
      archive,
      now: () => NOW,
    });
    expect(archived).toEqual(["old"]);
  });
});

