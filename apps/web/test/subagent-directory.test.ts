import { describe, expect, it } from "vitest";

import {
  closeAllSubagents,
  completeSubagent,
  isSubagentTool,
  type SubagentEntry,
  summarizeSubagents,
  upsertSubagentStarted,
} from "@/lib/subagent-directory";

const STARTED = "2026-09-15T10:00:00Z";
const ENDED = "2026-09-15T10:01:30Z";

describe("subagent-directory（R1-3 子代理目录推导）", () => {
  it("识别子代理父工具（task 与 video_generate），普通工具不识别", () => {
    expect(isSubagentTool("task")).toBe(true);
    expect(isSubagentTool("video_generate")).toBe(true);
    expect(isSubagentTool("inspect_canvas")).toBe(false);
  });

  it("started 生成新条目：取输入显式名，缺省回落工具名", () => {
    const explicit = upsertSubagentStarted([], {
      toolCallId: "t1",
      toolName: "task",
      input: { name: "Explore", description: "审查仓库结构" },
      timestamp: STARTED,
    });
    expect(explicit[0]).toMatchObject({
      toolCallId: "t1",
      name: "Explore",
      description: "审查仓库结构",
      startedAt: STARTED,
    });

    const fallback = upsertSubagentStarted([], {
      toolCallId: "t2",
      toolName: "video_generate",
      timestamp: STARTED,
    });
    expect(fallback[0]?.name).toBe("video_generate");
  });

  it("completed 落终态；重复 completed 不覆盖既有终态", () => {
    let list: SubagentEntry[] = upsertSubagentStarted([], {
      toolCallId: "t1",
      toolName: "task",
      timestamp: STARTED,
    });
    list = completeSubagent(list, "t1", ENDED);
    expect(list[0]?.endedAt).toBe(ENDED);
    list = completeSubagent(list, "t1", "2026-09-15T11:00:00Z");
    expect(list[0]?.endedAt).toBe(ENDED);
  });

  it("run 结束兜底关掉未完成的条目；已结束的保持原终态", () => {
    let list: SubagentEntry[] = upsertSubagentStarted([], {
      toolCallId: "t1",
      toolName: "task",
      timestamp: STARTED,
    });
    list = upsertSubagentStarted(list, {
      toolCallId: "t2",
      toolName: "video_generate",
      timestamp: STARTED,
    });
    list = completeSubagent(list, "t2", ENDED);
    list = closeAllSubagents(list, "2026-09-15T10:05:00Z");
    expect(list.find((entry) => entry.toolCallId === "t1")?.endedAt).toBe(
      "2026-09-15T10:05:00Z",
    );
    expect(list.find((entry) => entry.toolCallId === "t2")?.endedAt).toBe(
      ENDED,
    );
  });

  it("汇总：运行中与已结束计数；重复 started 更新起始时刻而不是新增条目", () => {
    let list: SubagentEntry[] = upsertSubagentStarted([], {
      toolCallId: "t1",
      toolName: "task",
      timestamp: STARTED,
    });
    list = upsertSubagentStarted(list, {
      toolCallId: "t1",
      toolName: "task",
      timestamp: "2026-09-15T10:02:00Z",
    });
    expect(list).toHaveLength(1);
    expect(summarizeSubagents(list)).toEqual({ running: 1, finished: 0 });
  });
});
