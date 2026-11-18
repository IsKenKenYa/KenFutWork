// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  type CodeTaskProjectMoveInput,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type ZCodeWorkspaceTaskListChanged,
  zcodeTaskMetaSchema,
} from "../../../packages/zcode-shared/dist/index.js";
import {
  createTarget,
  type Host,
  type Model,
  type ProjectionContext,
  type ProjectionResources,
  submitTaskMove,
  withProjectionResources,
} from "./setup/code-task-project-projection.fixture.js";

type ProjectedTaskMeta = ReturnType<typeof zcodeTaskMetaSchema.parse>;
type ControllerCapture = {
  frames: protocol.WindowHostControllerTaskFrame[];
  subscriptionId: string;
};
const notificationInput = "移动后通过原Task元信息通知同步第二轮输入";

async function assertProjectProjection(
  context: ProjectionContext,
  resources: ProjectionResources,
) {
  const { fixture, session, model, client } = context;
  const projectService = client.services.projectService;
  if (!projectService) throw new Error("原项目服务尚未连接。");
  expect(client.workspaces.task(session.sessionId)).toBeNull();
  const before = await projectService.readTree({
    hostId: "local",
  });
  const task = before.tasks.find((entry) => entry.taskId === session.sessionId);
  if (!task?.taskControl || task.conversationRevision === undefined)
    throw new Error("公开项目树缺少持久Task及移动观察值。");
  expect(task.projectId).toBe(session.projectId);
  expect(task.workspacePath).toBe(session.workspacePath);
  expect(client.workspaces.task(task.taskId)).toEqual({
    taskId: task.taskId,
    projectId: session.projectId,
    rootDirectory: session.workspacePath,
  });
  const targetProjectId = await createTarget(fixture, session);
  resources.targetProjectId = targetProjectId;
  const input: CodeTaskProjectMoveInput = {
    task: {
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
    },
    sourceProjectId: task.projectId,
    projectId: targetProjectId,
    observedRevision: task.conversationRevision,
    hostId: "local",
    addMissingRoot: true,
  };
  await submitTaskMove(session, input);
  const after = await projectService.readTree({
    hostId: "local",
  });
  expect(after.tasks).toContainEqual(
    expect.objectContaining({
      taskId: task.taskId,
      projectId: targetProjectId,
      workspacePath: task.workspacePath,
    }),
  );
  expect(client.workspaces.task(task.taskId)).toEqual({
    taskId: task.taskId,
    projectId: targetProjectId,
    rootDirectory: task.workspacePath,
  });
  expect(model.requests).toHaveLength(1);
}

async function observeController(
  context: ProjectionContext,
  resources: ProjectionResources,
  target: { projectId: string; path: string },
): Promise<ControllerCapture> {
  const { client, session } = context;
  const controller = client.services.windowControllerService;
  if (!controller) throw new Error("原Controller服务尚未连接。");
  resources.controller = controller;
  const frames: protocol.WindowHostControllerTaskFrame[] = [];
  resources.controllerListener = controller.onDynamicControllerFrame()(
    (frame) => {
      if (frame.topic === protocol.CONTROLLER_TASKS_INDEX_TOPIC)
        frames.push(protocol.windowHostControllerTaskFrameSchema.parse(frame));
    },
  );
  const subscribed = protocol.controllerSubscribeResultSchema.parse(
    await controller.subscribeControllerV4({
      topic: protocol.CONTROLLER_TASKS_INDEX_TOPIC,
      visibility: "foreground",
    }),
  );
  resources.controllerSubscriptionId = subscribed.ack.subscriptionId;
  await controller.listTaskList({
    kind: "active",
    sortBy: "updated",
    workspaceScopes: [
      {
        workspacePath: session.workspacePath,
        workspaceIdentity: JSON.stringify([
          session.projectId,
          session.workspacePath,
        ]),
      },
      {
        workspacePath: target.path,
        workspaceIdentity: JSON.stringify([target.projectId, target.path]),
      },
    ],
  });
  return { frames, subscriptionId: subscribed.ack.subscriptionId };
}

async function waitControllerTask(
  capture: ControllerCapture,
  taskId: string,
  projectId: string,
  upsertsOnly = false,
) {
  let observed: protocol.WindowHostControllerTaskRow | undefined;
  await vi.waitFor(
    () => {
      const rows = capture.frames.flatMap((frame) => {
        if (frame.subscriptionId !== capture.subscriptionId) return [];
        if (frame.payload.kind === "snapshot")
          return upsertsOnly ? [] : frame.payload.snapshot.tasks;
        return frame.payload.deltas.flatMap((delta) =>
          delta.op === "task.upserted" ? [delta.task] : [],
        );
      });
      observed = rows
        .reverse()
        .find(
          (row) =>
            row.meta.taskId === taskId && row.meta.projectId === projectId,
        );
      expect(observed).toMatchObject({
        address: { taskId },
        meta: { taskId, projectId },
      });
    },
    { timeout: 30_000 },
  ); // 仅持续等待原Controller真实SSE帧，不补读项目树或会话快照。
  if (!observed) throw new Error("原Controller缺少实际Task投影。");
  return observed;
}

async function moveObservedTask(
  host: Host,
  task: ProjectedTaskMeta,
  targetProjectId: string,
) {
  if (!task.workspaceIdentity || task.conversationRevision === undefined)
    throw new Error("原Task元信息缺少目录身份或正文观察值。");
  const control = protocol.conversationTaskControlSchema.parse(
    task.taskControl,
  );
  expect(control.projectId).toBe(task.projectId);
  await submitTaskMove(host, {
    task: {
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
    },
    sourceProjectId: control.projectId,
    projectId: targetProjectId,
    observedRevision: task.conversationRevision,
    hostId: "local",
    addMissingRoot: true,
  });
  return control;
}

async function assertControllerProjection(
  context: ProjectionContext,
  resources: ProjectionResources,
) {
  const { fixture, session, model, client } = context;
  const targetProjectId = await createTarget(fixture, session);
  resources.targetProjectId = targetProjectId;
  const target = (await client.refreshWorkspaces()).find(
    (project) => project.projectId === targetProjectId,
  );
  if (!target) throw new Error("真实项目目录缺少移动目标项目。");
  const capture = await observeController(context, resources, target);
  const before = await waitControllerTask(
    capture,
    session.sessionId,
    session.projectId,
  );
  expect(before.meta).toMatchObject({
    taskId: session.sessionId,
    projectId: session.projectId,
    workspacePath: session.workspacePath,
    workspaceIdentity: JSON.stringify([
      session.projectId,
      session.workspacePath,
    ]),
  });
  expect(client.workspaces.task(session.sessionId)).toEqual({
    taskId: session.sessionId,
    projectId: session.projectId,
    rootDirectory: session.workspacePath,
  });
  const control = await moveObservedTask(session, before.meta, targetProjectId);
  // 移动后只消费原Controller流；固定Task目录仍属于创建时的rootA。
  const after = await waitControllerTask(
    capture,
    session.sessionId,
    targetProjectId,
    true,
  );
  const movedIdentity = JSON.stringify([
    targetProjectId,
    session.workspacePath,
  ]);
  expect(after.address).toMatchObject({
    taskId: session.sessionId,
    workspacePath: session.workspacePath,
    workspaceIdentity: movedIdentity,
  });
  expect(after.meta).toMatchObject({
    taskId: session.sessionId,
    projectId: targetProjectId,
    workspacePath: session.workspacePath,
    workspaceIdentity: movedIdentity,
  });
  expect(after.meta.taskControl).toEqual({
    projectId: targetProjectId,
    branchGeneration: control.branchGeneration + 1,
  });
  expect(client.workspaces.task(session.sessionId)).toEqual({
    taskId: session.sessionId,
    projectId: targetProjectId,
    rootDirectory: session.workspacePath,
  });
  expect(model.requests).toHaveLength(1);
}

async function sendMovedTaskInput(host: Host, projectId: string) {
  const response = await host.client.request(
    `/api/code-ui/sessions/${host.sessionId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const current = protocol.conversationSnapshotSchema.parse(
    response.body.snapshot,
  );
  const control = protocol.conversationTaskControlSchema.parse(
    current.taskControl,
  );
  expect(control.projectId).toBe(projectId);
  const modelSelection = current.config.modelSelection;
  if (!modelSelection) throw new Error("发送方当前Task缺少实际模型选择。");
  const sent = await host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      workspaceIdentity: JSON.stringify([
        control.projectId,
        host.workspacePath,
      ]),
      projectId: control.projectId,
      envelope: {
        type: "sendText",
        sessionId: host.sessionId,
        commandId: randomUUID(),
        clientId: host.clientId,
        taskControl: structuredClone(control),
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
        payload: { text: notificationInput, modelSelection },
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  return control;
}

async function waitTaskMetaNotification(
  events: ZCodeWorkspaceTaskListChanged[],
  taskId: string,
  projectId: string,
  workspacePath: string,
) {
  let observed: ProjectedTaskMeta | undefined;
  await vi.waitFor(
    () => {
      const event = [...events]
        .reverse()
        .find(
          (entry) =>
            entry.taskId === taskId &&
            entry.taskMeta?.taskControl?.projectId === projectId,
        );
      expect(event).toMatchObject({
        type: "workspace_task_list_changed",
        taskId,
        workspacePath,
        workspaceIdentity: JSON.stringify([projectId, workspacePath]),
      });
      observed = zcodeTaskMetaSchema.parse(event?.taskMeta);
      expect(observed).toMatchObject({ taskId, projectId, workspacePath });
    },
    { timeout: 30_000 },
  ); // 只等待原zcode-task的workspace通知，不让接收客户端补读身份。
  if (!observed) throw new Error("原Task通知缺少完整元信息。");
  return observed;
}

async function completeNotificationTurn(host: Host, model: Model) {
  model.finish(1);
  await vi.waitFor(
    async () => {
      const current = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(
        current.control.phase,
        JSON.stringify(current.control.lastError),
      ).toBe("completedSuccess");
      expect(current.rows.window).toContainEqual(
        expect.objectContaining({
          kind: "userInput",
          origin: "realUser",
          text: notificationInput,
        }),
      );
      expect(current.rows.window).toContainEqual(
        expect.objectContaining({
          kind: "assistantText",
          state: "complete",
          text: "正在运行 2",
        }),
      );
    },
    { timeout: 30_000 },
  ); // 发送方读取实际完成状态，接收客户端仍只由原通知更新身份。
}

async function assertTaskMetaNotificationProjection(
  context: ProjectionContext,
  resources: ProjectionResources,
) {
  const { fixture, session, model, client } = context;
  const taskService = client.services.zcodeTaskService;
  const before = zcodeTaskMetaSchema.parse(
    await taskService.getTaskMeta({
      taskId: session.sessionId,
      workspacePath: session.workspacePath,
      workspaceIdentity: JSON.stringify([
        session.projectId,
        session.workspacePath,
      ]),
    }),
  );
  const originalControl = protocol.conversationTaskControlSchema.parse(
    before.taskControl,
  );
  expect(before).toMatchObject({
    taskId: session.sessionId,
    projectId: session.projectId,
    workspacePath: session.workspacePath,
    taskControl: { projectId: session.projectId },
  });
  expect(client.workspaces.task(session.sessionId)).toEqual({
    taskId: session.sessionId,
    projectId: session.projectId,
    rootDirectory: session.workspacePath,
  });
  const events: ZCodeWorkspaceTaskListChanged[] = [];
  resources.taskMetaListener = taskService.onDynamicWorkspaceEvent({
    workspacePath: session.workspacePath,
  })((event) => {
    if (event.type === "workspace_task_list_changed") events.push(event);
  });
  const targetProjectId = await createTarget(fixture, session);
  resources.targetProjectId = targetProjectId;
  await moveObservedTask(session, before, targetProjectId);
  const currentControl = await sendMovedTaskInput(session, targetProjectId);
  expect(currentControl).toEqual({
    projectId: targetProjectId,
    branchGeneration: originalControl.branchGeneration + 1,
  });
  await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
    timeout: 30_000,
  }); // 必须由第二条真实受控模型HTTP请求证明新输入已经运行。
  const after = await waitTaskMetaNotification(
    events,
    session.sessionId,
    targetProjectId,
    session.workspacePath,
  );
  expect(after.workspaceIdentity).toBe(
    JSON.stringify([targetProjectId, session.workspacePath]),
  );
  expect(after.taskControl).toEqual(currentControl);
  expect(client.workspaces.task(session.sessionId)).toEqual({
    taskId: session.sessionId,
    projectId: targetProjectId,
    rootDirectory: session.workspacePath,
  });
  await completeNotificationTurn(session, model);
  expect(model.requests).toHaveLength(2);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Task项目归属的客户端真实HTTP、SSE与PostgreSQL投影 integration",
  () => {
    it("另一连接移动Task后，原客户端重读项目树更新项目身份并保留固定目录", async () => {
      await withProjectionResources(assertProjectProjection);
    }, 120_000); // 真实HTTP/SSE、独占PostgreSQL、受控模型及资源关闭期限。

    it("另一连接移动Task后，原Controller流直接更新项目身份与控制代际并保留固定目录", async () => {
      await withProjectionResources(assertControllerProjection);
    }, 120_000); // 真实HTTP/SSE、独占PostgreSQL、受控模型及资源关闭期限。

    it("原Task元信息RPC登记后，另一连接移动并发送第二轮输入，原workspace通知更新项目身份", async () => {
      await withProjectionResources(assertTaskMetaNotificationProjection);
    }, 120_000); // 原Task元信息RPC、真实workspace通知、两轮受控模型HTTP与资源关闭期限。
  },
);
