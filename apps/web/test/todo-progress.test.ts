import { describe, expect, it } from "vitest";

import {
  parseTodos,
  sortTodosForDisplay,
  todoProgress,
} from "../src/lib/todo-progress";

describe("parseTodos", () => {
  it("解析 write_todos 的完整入参（整表替换语义）", () => {
    expect(
      parseTodos({
        todos: [
          { content: "读契约", status: "completed" },
          { content: "改服务端", status: "in_progress" },
          { content: "补测试", status: "pending" },
        ],
      }),
    ).toEqual([
      { content: "读契约", status: "completed" },
      { content: "改服务端", status: "in_progress" },
      { content: "补测试", status: "pending" },
    ]);
  });

  it("未知/缺失 status 一律按未完成处理（模型写 done/blocked 不算完成）", () => {
    expect(
      parseTodos({
        todos: [
          { content: "a", status: "done" },
          { content: "b" },
          { content: "c", status: "blocked" },
        ],
      }),
    ).toEqual([
      { content: "a", status: "pending" },
      { content: "b", status: "pending" },
      { content: "c", status: "pending" },
    ]);
  });

  it("坏输入返回 null（保持原状，而不是把面板清空）", () => {
    expect(parseTodos(undefined)).toBeNull();
    expect(parseTodos(null)).toBeNull();
    expect(parseTodos({})).toBeNull();
    expect(parseTodos({ todos: "not-an-array" })).toBeNull();
    expect(parseTodos({ todos: [] })).toBeNull();
    expect(parseTodos({ todos: [null, 42, { content: "   " }] })).toBeNull();
  });

  it("跳过表里的坏条目但保留好条目，并按 trim 后的内容去空白", () => {
    expect(
      parseTodos({
        todos: [
          { content: "  有空格  ", status: "completed" },
          { status: "completed" },
          null,
          { content: "有效", status: "pending" },
        ],
      }),
    ).toEqual([
      { content: "有空格", status: "completed" },
      { content: "有效", status: "pending" },
    ]);
  });
});

describe("todoProgress", () => {
  it("统计完成数与总数、进行中数", () => {
    expect(
      todoProgress([
        { content: "a", status: "completed" },
        { content: "b", status: "completed" },
        { content: "c", status: "in_progress" },
        { content: "d", status: "pending" },
      ]),
    ).toEqual({ completed: 2, total: 4, inProgress: 1 });
  });

  it("空表是全零（不产生 NaN）", () => {
    expect(todoProgress([])).toEqual({ completed: 0, total: 0, inProgress: 0 });
  });
});

describe("sortTodosForDisplay", () => {
  it("进行中 → 待办 → 已完成，且不改原数组", () => {
    const items = [
      { content: "done", status: "completed" as const },
      { content: "pending", status: "pending" as const },
      { content: "doing", status: "in_progress" as const },
    ];
    expect(sortTodosForDisplay(items).map((item) => item.content)).toEqual([
      "doing",
      "pending",
      "done",
    ]);
    expect(items.map((item) => item.content)).toEqual([
      "done",
      "pending",
      "doing",
    ]);
  });
});
