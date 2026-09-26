import { describe, expect, it } from "vitest";

import { createBackgroundTaskRegistry } from "./background-tasks.js";
import { SUBAGENT_DEFINITIONS } from "./subagent-definitions.js";
import { createSubagentTaskTools } from "./subagent-tools.js";

function setup(overrides?: {
  childRunner?: Parameters<typeof createSubagentTaskTools>[0]["childRunner"];
  definitions?: readonly (typeof SUBAGENT_DEFINITIONS)[number][];
}) {
  const registry = createBackgroundTaskRegistry({ maxConcurrent: 4 });
  const definitions = overrides?.definitions ?? SUBAGENT_DEFINITIONS;
  const childRunner =
    overrides?.childRunner ??
    (async ({ description }) => `done: ${description}`);
  const tools = createSubagentTaskTools({
    registry,
    definitions,
    childRunner,
  });
  return { registry, tools, childRunner };
}

describe("子代理派发工具（DEC-14/DEC-16）", () => {
  it("task 前台：等子代理完成，结果回填为工具结果且注册表落 completed", async () => {
    const { registry, tools } = setup();
    const result = (await tools.taskTool.invoke(
      { subagent_type: "explore", description: "调研登录链路" },
      { configurable: {} },
    )) as string;

    expect(result).toContain("done: 调研登录链路");
    const [task] = registry.list();
    expect(task).toMatchObject({
      kind: "subagent",
      label: "代码调研 · 调研登录链路",
      status: "completed",
    });
  });

  it("task 未知类型：可读拒绝并列出可用清单，不产生任务", async () => {
    const { registry, tools } = setup();
    const result = (await tools.taskTool.invoke(
      { subagent_type: "nope", description: "x" },
      { configurable: {} },
    )) as string;

    expect(result).toContain("未知子代理类型");
    expect(result).toContain("explore");
    expect(result).toContain("planner");
    expect(registry.list()).toHaveLength(0);
  });

  it("task 失败：结果带 next_step 恢复指引，注册表落 failed", async () => {
    const { registry, tools } = setup({
      childRunner: async () => {
        throw new Error("上游模型 429");
      },
    });
    const result = (await tools.taskTool.invoke(
      { subagent_type: "explore", description: "x" },
      { configurable: {} },
    )) as string;

    expect(result).toContain("执行失败");
    expect(result).toContain("429");
    expect(result).toContain("重试派生");
    const [task] = registry.list();
    expect(task?.status).toBe("failed");
    expect(task?.nextStep).toContain("重试派生");
  });

  it("task_background：立即返回 taskId 不等待；结算后通知入队", async () => {
    let release: (value: string) => void = () => {};
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { registry, tools } = setup({
      childRunner: () => gate,
    });

    const result = (await tools.taskBackgroundTool.invoke(
      { subagent_type: "batch_image", description: "三张海报" },
      { configurable: {} },
    )) as string;

    expect(result).toMatch(/taskId=task_/);
    expect(registry.hasPending()).toBe(true);
    expect(registry.drainNotifications()).toEqual([]);

    release("三张图完成");
    await new Promise((r) => setTimeout(r, 0));
    expect(registry.hasPending()).toBe(false);
    const [notification] = registry.drainNotifications();
    expect(notification).toMatchObject({
      status: "completed",
      kind: "subagent",
      summary: "三张图完成",
    });
  });

  it("task_background：注册表 abortAll 会中止子代理（信号联动），迟到结算不复活", async () => {
    const { registry, tools } = setup({
      childRunner: ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new Error("aborted by user")),
          );
        }),
    });
    const result = (await tools.taskBackgroundTool.invoke(
      { subagent_type: "explore", description: "x" },
      { configurable: {} },
    )) as string;
    const taskId = /taskId=(task_[a-z0-9]+)/.exec(result)?.[1];
    expect(taskId).toBeTruthy();

    registry.abortAll("用户取消了本轮 run");
    await new Promise((r) => setTimeout(r, 0));

    if (!taskId) throw new Error("unreachable: 未取到 taskId");
    const task = registry.get(taskId);
    expect(task?.status).toBe("canceled");
    expect(registry.drainNotifications()).toHaveLength(1);
  });

  it("task_output：带 id 读单个，不带列全部，未知 id 给可读提示", async () => {
    const { registry, tools } = setup();
    await tools.taskTool.invoke(
      { subagent_type: "review", description: "审一下" },
      { configurable: {} },
    );
    const [task] = registry.list();
    if (!task) throw new Error("unreachable: 未生成任务条目");

    const single = (await tools.taskOutputTool.invoke(
      { task_id: task.taskId },
      { configurable: {} },
    )) as string;
    expect(JSON.parse(single)).toMatchObject({ status: "completed" });

    const missing = (await tools.taskOutputTool.invoke(
      { task_id: "task_missing" },
      { configurable: {} },
    )) as string;
    expect(missing).toContain("没有 taskId=task_missing");

    const all = (await tools.taskOutputTool.invoke(
      {},
      { configurable: {} },
    )) as string;
    expect(JSON.parse(all)).toHaveLength(1);
  });
});

describe("plan 只读白名单的派发门（DEC-17）", () => {
  it("只读定义放行，可写定义在注册前被可读拒绝", async () => {
    const registry = createBackgroundTaskRegistry({ maxConcurrent: 4 });
    const tools = createSubagentTaskTools({
      registry,
      definitions: SUBAGENT_DEFINITIONS,
      childRunner: async ({ description }) => `done: ${description}`,
      dispatchGate: (def) =>
        def.readOnly
          ? { allowed: true }
          : { allowed: false, reason: "plan 计划模式：批准前仅允许只读操作。" },
    });

    const readOnly = (await tools.taskTool.invoke(
      { subagent_type: "explore", description: "调研" },
      { configurable: {} },
    )) as string;
    expect(readOnly).toContain("done: 调研");

    const writable = (await tools.taskBackgroundTool.invoke(
      { subagent_type: "batch_image", description: "海报" },
      { configurable: {} },
    )) as string;
    expect(writable).toContain("未派发");
    expect(writable).toContain("只读");
    expect(registry.list()).toHaveLength(1);
  });
});
