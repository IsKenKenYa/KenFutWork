import { afterEach, describe, expect, it } from "vitest";
import {
  clearActiveWorkbenchSessionDragPayload,
  createWorkbenchSessionDragPayload,
  parseWorkbenchProjectTaskDragPayload,
  parseWorkbenchSessionDragPayload,
  serializeWorkbenchSessionDragPayload,
  setActiveWorkbenchSessionDragPayload,
  WORKBENCH_SESSION_DRAG_MIME,
} from "../src/components/workbench/zcode/v4/workbenchDragDrop";

const sourceProjectId = "11111111-1111-4111-8111-111111111111";
const targetProjectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const workspacePath = "/projects/task-root";
const workspaceIdentity =
  '["11111111-1111-4111-8111-111111111111","/projects/task-root"]';
const task = {
  taskId,
  workspacePath,
  workspaceIdentity,
  taskControl: { projectId: sourceProjectId, branchGeneration: 4 },
  conversationRevision: 17,
};
const expected = {
  kind: "zcode/session",
  workspacePath,
  workspaceIdentity,
  sessionId: taskId,
  sourceProjectId,
  observedRevision: 17,
};

function transfer(raw: string) {
  return {
    types: [WORKBENCH_SESSION_DRAG_MIME],
    getData: (type: string) =>
      type === WORKBENCH_SESSION_DRAG_MIME ? raw : "",
  };
}

afterEach(clearActiveWorkbenchSessionDragPayload);

describe("Task跨项目拖动的公开MIME输入", () => {
  it("拖动开始固定原Task目录与观察值，之后的Task变化不改写已发送内容", () => {
    const source = structuredClone(task);
    const payload = createWorkbenchSessionDragPayload(source);
    const serialized = serializeWorkbenchSessionDragPayload(payload);
    source.taskControl = { projectId: targetProjectId, branchGeneration: 5 };
    source.conversationRevision = 18;
    source.workspaceIdentity = JSON.stringify([targetProjectId, workspacePath]);
    expect(parseWorkbenchProjectTaskDragPayload(transfer(serialized))).toEqual(
      expected,
    );
    expect(parseWorkbenchSessionDragPayload(transfer(serialized))).toEqual(
      expected,
    );
  });

  it("新的原Task观察用于下一次拖动", () => {
    const payload = createWorkbenchSessionDragPayload({
      ...task,
      workspaceIdentity: JSON.stringify([targetProjectId, workspacePath]),
      taskControl: { projectId: targetProjectId, branchGeneration: 5 },
      conversationRevision: 18,
    });
    expect(
      parseWorkbenchProjectTaskDragPayload(transfer(JSON.stringify(payload))),
    ).toEqual({
      ...expected,
      workspaceIdentity:
        '["22222222-2222-4222-8222-222222222222","/projects/task-root"]',
      sourceProjectId: targetProjectId,
      observedRevision: 18,
    });
  });

  it.each(["taskControl", "conversationRevision"] as const)(
    "缺少可信观察时保留原分栏拖动并拒绝项目移动：%s",
    (field) => {
      const source: Parameters<typeof createWorkbenchSessionDragPayload>[0] = {
        ...task,
      };
      delete source[field];
      const payload = createWorkbenchSessionDragPayload(source);
      const input = transfer(serializeWorkbenchSessionDragPayload(payload));
      expect(parseWorkbenchSessionDragPayload(input)).toEqual({
        kind: "zcode/session",
        workspacePath,
        workspaceIdentity,
        sessionId: taskId,
      });
      expect(parseWorkbenchProjectTaskDragPayload(input)).toBeNull();
    },
  );

  it.each([
    { conversationRevision: -1 },
    { taskControl: { projectId: targetProjectId, branchGeneration: 4 } },
    { workspaceIdentity: JSON.stringify([targetProjectId, workspacePath]) },
  ])("缺少一致的可信观察时保留原分栏拖动并拒绝项目移动：%j", (change) => {
    const payload = createWorkbenchSessionDragPayload({ ...task, ...change });
    const input = transfer(serializeWorkbenchSessionDragPayload(payload));
    expect(parseWorkbenchSessionDragPayload(input)).toEqual({
      kind: "zcode/session",
      workspacePath,
      workspaceIdentity: change.workspaceIdentity ?? workspaceIdentity,
      sessionId: taskId,
    });
    expect(parseWorkbenchProjectTaskDragPayload(input)).toBeNull();
  });

  it("原远程会话仍可拖入分栏，不能作为本机项目移动", () => {
    const payload = createWorkbenchSessionDragPayload(task, "remote-session");
    const input = transfer(serializeWorkbenchSessionDragPayload(payload));
    expect(parseWorkbenchSessionDragPayload(input)).toMatchObject({
      sessionId: taskId,
      remoteSessionId: "remote-session",
    });
    expect(parseWorkbenchProjectTaskDragPayload(input)).toBeNull();
  });

  it.each([
    { sourceProjectId: undefined },
    { sourceProjectId: "invalid-project" },
    { sourceProjectId: targetProjectId },
    { observedRevision: undefined },
    { observedRevision: "17" },
    { observedRevision: -1 },
    { observedRevision: 1.5 },
    { observedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { sessionId: "invalid-task" },
    { workspacePath: "/projects/other" },
    { workspaceIdentity: undefined },
    {
      workspaceIdentity: JSON.stringify(
        [sourceProjectId, workspacePath],
        null,
        2,
      ),
    },
    { remoteSessionId: "remote-session" },
  ])("拒绝不完整或身份不一致的项目移动输入：%j", (change) => {
    const input = transfer(JSON.stringify({ ...expected, ...change }));
    expect(parseWorkbenchSessionDragPayload(input)).toBeNull();
    expect(parseWorkbenchProjectTaskDragPayload(input)).toBeNull();
  });

  it("旧会话输入继续用于分栏，不能用于项目移动", () => {
    const legacy = {
      kind: "zcode/session",
      workspacePath,
      sessionId: "old-task",
    };
    expect(
      parseWorkbenchSessionDragPayload(transfer(JSON.stringify(legacy))),
    ).toEqual(legacy);
    expect(
      parseWorkbenchProjectTaskDragPayload(transfer(JSON.stringify(legacy))),
    ).toBeNull();
  });

  it("浏览器保护拖动内容时保留本次观察，结束后不能复用", () => {
    setActiveWorkbenchSessionDragPayload(
      createWorkbenchSessionDragPayload(task),
    );
    expect(parseWorkbenchProjectTaskDragPayload(transfer(""))).toEqual(
      expected,
    );
    clearActiveWorkbenchSessionDragPayload();
    expect(parseWorkbenchProjectTaskDragPayload(transfer(""))).toBeNull();
  });

  it("错误MIME和无效JSON不能启动Task拖动", () => {
    expect(
      parseWorkbenchSessionDragPayload({
        types: [],
        getData: () => JSON.stringify(expected),
      }),
    ).toBeNull();
    expect(parseWorkbenchSessionDragPayload(transfer("{"))).toBeNull();
  });
});
