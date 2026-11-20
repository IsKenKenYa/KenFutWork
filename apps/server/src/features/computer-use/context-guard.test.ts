import { describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "../../kernel/types.js";
import type { LocalActor } from "../local-instance/types.js";
import { cuContextDenial } from "./context-guard.js";

const actor: LocalActor = {
  instanceId: "instance-1",
  accessClientId: "client-1",
};

const scopeHandle = (role: "main" | "worker") =>
  ({
    role,
    describe: () => ({
      instanceId: "instance-1",
      taskId: "task-1",
      projectId: "project-1",
    }),
  }) as unknown as NonNullable<ToolExecutionContext["scopeHandle"]>;

const base = (
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext => ({
  actor,
  instanceId: "instance-1",
  runId: "run-1",
  toolCallId: "call-1",
  ...overrides,
});

describe("cuContextDenial（桌面工具执行上下文）", () => {
  it("无 Task 的主 Run 可以通过（全模式）", () => {
    expect(cuContextDenial(base())).toBeNull();
  });

  it("带 Task 作用域且一致的 Code/Design 主 Run 可以通过", () => {
    const work = {
      runId: "run-1",
      actor,
      scope: {
        instanceId: "instance-1",
        taskId: "task-1",
        projectId: "project-1",
      },
    } as unknown as NonNullable<ToolExecutionContext["taskWorkContext"]>;
    expect(
      cuContextDenial(
        base({ scopeHandle: scopeHandle("main"), taskWorkContext: work }),
      ),
    ).toBeNull();
  });

  it("缺少 actor、runId 或 toolCallId 时拒绝", () => {
    expect(cuContextDenial(base({ actor: undefined }))).not.toBeNull();
    expect(cuContextDenial(base({ runId: undefined }))).not.toBeNull();
    expect(cuContextDenial(base({ toolCallId: undefined }))).not.toBeNull();
  });

  it("实例不一致时拒绝", () => {
    expect(
      cuContextDenial(base({ actor: { ...actor, instanceId: "instance-2" } })),
    ).not.toBeNull();
  });

  it("子代理角色或派生深度非零时拒绝", () => {
    expect(
      cuContextDenial(base({ scopeHandle: scopeHandle("worker") })),
    ).not.toBeNull();
    expect(cuContextDenial(base({ delegationDepth: 1 }))).not.toBeNull();
  });

  it("Task 与 Run 或作用域不一致时拒绝", () => {
    const work = {
      runId: "run-2",
      actor,
      scope: {
        instanceId: "instance-1",
        taskId: "task-2",
        projectId: "project-1",
      },
    } as unknown as NonNullable<ToolExecutionContext["taskWorkContext"]>;
    expect(
      cuContextDenial(
        base({ scopeHandle: scopeHandle("main"), taskWorkContext: work }),
      ),
    ).not.toBeNull();
  });
});
