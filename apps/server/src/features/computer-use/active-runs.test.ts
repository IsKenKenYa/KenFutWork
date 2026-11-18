import { describe, expect, it } from "vitest";
import type { AgentRunExtensionContext } from "../../agent/run-extension.js";
import { AgentRunEventBus, ToolRegistryImpl } from "../../kernel/context.js";
import type { ToolExecutionContext } from "../../kernel/types.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";
import { createActiveComputerUseRuns } from "./active-runs.js";
import type { CuToolResult } from "./service.js";

const actor: LocalActor = {
  instanceId: "instance-1",
  accessClientId: "client-1",
};

const scopeHandle = (role: "main" | "worker"): ExecutionScopeHandle =>
  ({
    role,
    resolvePath: async () => ".",
    describe: () => ({
      instanceId: "instance-1",
      taskId: "task-1",
      projectId: "project-1",
    }),
  }) as unknown as ExecutionScopeHandle;

function build() {
  const registry = new ToolRegistryImpl(new AgentRunEventBus());
  registry.register({
    name: "mcp__computer-use__list_apps",
    description: "测试用桌面工具",
    scope: "shared",
    access: "read",
    parameters: { type: "object", properties: {} },
    execute: async (): Promise<CuToolResult> => ({
      content: [{ type: "text", text: "ok" }],
      structuredContent: {},
    }),
  });
  return createActiveComputerUseRuns(registry);
}

function runContext(execution: ToolExecutionContext): AgentRunExtensionContext {
  return {
    registry: undefined as unknown as AgentRunExtensionContext["registry"],
    resolution: {} as AgentRunExtensionContext["resolution"],
    execution,
  };
}

const mainExecution = (
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext => ({
  actor,
  instanceId: "instance-1",
  runId: "run-1",
  toolCallId: "call-1",
  signal: new AbortController().signal,
  ...overrides,
});

/** beforeAgent 在 langchain 类型里可以是函数或 { hook } 对象，这里只触发绑定。 */
function bind(
  runs: ReturnType<typeof createActiveComputerUseRuns>,
  execution: ToolExecutionContext,
): void {
  const middleware = runs.extension.createMiddleware({}, runContext(execution));
  const hook = middleware.beforeAgent as unknown as
    | ((state: never, runtime: never) => unknown)
    | undefined;
  hook?.({} as never, {} as never);
}

describe("createActiveComputerUseRuns（全模式运行绑定）", () => {
  it("运行扩展对 code/design 共用（preset: shared）", () => {
    expect(build().extension.preset).toBe("shared");
  });

  it("无 Task / 无事件出口的主 Run 也能绑定并执行工具", async () => {
    const runs = build();
    const execution = mainExecution();
    bind(runs, execution);
    runs.assertRun(actor, "run-1");
    const result = (await runs.execute(
      actor,
      "run-1",
      "mcp__computer-use__list_apps",
      {},
      execution,
    )) as CuToolResult;
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("有事件出口时仍按 Task 发布 started/completed", async () => {
    const runs = build();
    const events: Array<{ type: string }> = [];
    const execution = mainExecution({
      scopeHandle: scopeHandle("main"),
      publishToolEvent: async (event) => {
        events.push(event);
      },
    });
    bind(runs, execution);
    await runs.execute(
      actor,
      "run-1",
      "mcp__computer-use__list_apps",
      {},
      execution,
    );
    expect(events.map((event) => event.type)).toEqual([
      "tool.started",
      "tool.completed",
    ]);
  });

  it("子代理角色与派生深度不绑定，且事后不能冒充主 Run", () => {
    const runs = build();
    bind(runs, mainExecution({ delegationDepth: 1 }));
    expect(() => runs.assertRun(actor, "run-1")).toThrow();

    bind(runs, mainExecution({ scopeHandle: scopeHandle("worker") }));
    expect(() => runs.assertRun(actor, "run-1")).toThrow();
  });

  it("只接受绑定实例，Run 结束后拒绝迟到调用", () => {
    const runs = build();
    bind(runs, mainExecution());
    expect(() =>
      runs.assertRun({ ...actor, instanceId: "instance-2" }, "run-1"),
    ).toThrow();
    runs.closeRun("run-1");
    expect(() => runs.assertRun(actor, "run-1")).toThrow();
  });
});
