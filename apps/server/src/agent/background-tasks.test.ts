import { describe, expect, it } from "vitest";

import { createBackgroundTaskRegistry } from "./background-tasks.js";

describe("BackgroundTaskRegistry（DEC-15 统一后台原语）", () => {
  it("register：登记即 running，产出 task_ 前缀 id；并发闸门超限给可读拒绝", () => {
    const registry = createBackgroundTaskRegistry({ maxConcurrent: 2 });

    const first = registry.register({
      kind: "subagent",
      label: "explore · 调研登录链路",
    });
    const second = registry.register({ kind: "command", label: "pnpm test" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.taskId).toMatch(/^task_/);
      expect(registry.get(first.taskId)?.status).toBe("running");
      expect(registry.get(second.taskId)?.label).toBe("pnpm test");
    }

    const third = registry.register({ kind: "subagent", label: "第三个" });
    expect(third.ok).toBe(false);
    if (!third.ok) {
      // 可读拒绝：模型看到的是「该做什么」与当前上限，而不是一个错误码
      expect(third.error).toContain("并发");
      expect(third.error).toContain("2/2");
      expect(third.error).toContain("task_output");
    }
  });

  it("settle：终态落 summary/endedAt；重复结算首次获胜（幂等）", () => {
    const registry = createBackgroundTaskRegistry({ maxConcurrent: 4 });
    const r = registry.register({ kind: "subagent", label: "explore" });
    if (!r.ok) throw new Error("unreachable");
    const { taskId } = r;

    registry.settle(taskId, {
      status: "completed",
      summary: "找到 3 处相关文件",
    });
    registry.settle(taskId, {
      status: "failed",
      summary: "不该覆盖第一次结算",
      nextStep: "重试",
    });

    const task = registry.get(taskId);
    expect(task?.status).toBe("completed");
    expect(task?.summary).toBe("找到 3 处相关文件");
    expect(task?.nextStep).toBeUndefined();
    expect(task?.endedAt).toBeTruthy();
  });

  it("failed 结算带 nextStep 恢复指引（DEC-17）", () => {
    const registry = createBackgroundTaskRegistry({ maxConcurrent: 4 });
    const r = registry.register({ kind: "command", label: "pnpm build" });
    if (!r.ok) throw new Error("unreachable");

    registry.settle(r.taskId, {
      status: "failed",
      summary: "tsc 报 2 个类型错误",
      nextStep: "可用 task_output 读取完整输出后修正再跑",
    });

    const [notification] = registry.drainNotifications();
    expect(notification?.status).toBe("failed");
    expect(notification?.nextStep).toContain("task_output");
  });

  it("drainNotifications：按结算顺序出队并清空，未结算不出队", () => {
    const registry = createBackgroundTaskRegistry({ maxConcurrent: 4 });
    const a = registry.register({ kind: "subagent", label: "a" });
    const b = registry.register({ kind: "subagent", label: "b" });
    const c = registry.register({ kind: "subagent", label: "c" });
    if (!a.ok || !b.ok || !c.ok) throw new Error("unreachable");

    expect(registry.drainNotifications()).toEqual([]);

    registry.settle(b.taskId, { status: "completed", summary: "b done" });
    registry.settle(a.taskId, { status: "failed", summary: "a boom" });
    expect(registry.drainNotifications().map((n) => n.label)).toEqual([
      "b",
      "a",
    ]);
    expect(registry.drainNotifications()).toEqual([]);

    registry.settle(c.taskId, { status: "completed", summary: "c done" });
    expect(registry.drainNotifications().map((n) => n.label)).toEqual(["c"]);
  });

  it("hasPending：有 running 为真，全部结算后为假（轮末闸门的判据）", () => {
    const registry = createBackgroundTaskRegistry({ maxConcurrent: 4 });
    const a = registry.register({ kind: "subagent", label: "a" });
    const b = registry.register({ kind: "subagent", label: "b" });
    if (!a.ok || !b.ok) throw new Error("unreachable");

    expect(registry.hasPending()).toBe(true);
    registry.settle(b.taskId, { status: "completed", summary: "b" });
    expect(registry.hasPending()).toBe(true);
    registry.settle(a.taskId, { status: "completed", summary: "a" });
    expect(registry.hasPending()).toBe(false);
    // 通知未 drain 不算 pending：闸门只看在跑任务，通知交给下一轮模型调用注入
    expect(registry.drainNotifications()).toHaveLength(2);
  });

  it("abortAll：在跑任务全部 canceled、abort 回调被调、通知入队；迟到结算不复活", () => {
    const registry = createBackgroundTaskRegistry({ maxConcurrent: 4 });
    const aborted: string[] = [];
    const a = registry.register({
      kind: "subagent",
      label: "a",
      abort: () => aborted.push("a"),
    });
    const b = registry.register({ kind: "command", label: "b" });
    if (!a.ok || !b.ok) throw new Error("unreachable");
    registry.settle(b.taskId, { status: "completed", summary: "b done" });

    registry.abortAll("用户取消了本轮 run");

    expect(aborted).toEqual(["a"]);
    expect(registry.get(a.taskId)?.status).toBe("canceled");
    expect(registry.get(b.taskId)?.status).toBe("completed");
    expect(registry.hasPending()).toBe(false);

    const notifications = registry.drainNotifications();
    expect(notifications).toHaveLength(2);
    const canceled = notifications.find((n) => n.taskId === a.taskId);
    expect(canceled?.status).toBe("canceled");
    expect(canceled?.summary).toContain("取消");

    // 迟到结算（被 abort 的异步操作稍后报失败）：不复活、不重复通知
    registry.settle(a.taskId, { status: "failed", summary: "late boom" });
    expect(registry.get(a.taskId)?.status).toBe("canceled");
    expect(registry.drainNotifications()).toEqual([]);
  });

  it("list：快照含全部任务与状态（task_output / 调试共用）", () => {
    const registry = createBackgroundTaskRegistry({ maxConcurrent: 4 });
    const a = registry.register({ kind: "subagent", label: "a" });
    if (!a.ok) throw new Error("unreachable");
    registry.settle(a.taskId, { status: "completed", summary: "ok" });

    const all = registry.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      taskId: a.taskId,
      kind: "subagent",
      label: "a",
      status: "completed",
      summary: "ok",
    });
  });
});
