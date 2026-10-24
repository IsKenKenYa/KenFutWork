// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CodeTaskProjectMoveInput,
  type IWindowControllerService,
  projectCreateResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type ZCodeWorkspaceTaskListChanged,
  zcodeTaskMetaSchema,
} from "../../../packages/zcode-shared/dist/index.js";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import type { heldModel } from "../../server/src/features/code-ui/model-stream.fixture.js";
import type { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import type { PublicFixture } from "./setup/code-public-session";

type Fixture = PublicFixture & { directory: string };
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type ProjectedTaskMeta = ReturnType<typeof zcodeTaskMetaSchema.parse>;
type ProjectionResources = {
  fixture: Fixture;
  model?: Model;
  host?: Host;
  client?: CodeHttpChannelClient;
  targetProjectId?: string;
  controller?: IWindowControllerService;
  controllerListener?: { dispose(): void };
  controllerSubscriptionId?: string;
  taskMetaListener?: { dispose(): void };
};
type ControllerCapture = {
  frames: protocol.WindowHostControllerTaskFrame[];
  subscriptionId: string;
};
const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);
const notificationInput = "移动后通过原Task元信息通知同步第二轮输入";

async function completeTask(host: Host, model: Model) {
  const sent = await host.command("sendText", {
    text: "完成持久Task后验证项目移动的客户端读取",
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  await model.firstRequest;
  model.finish(0);
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
          kind: "assistantText",
          state: "complete",
          text: "正在运行 1",
        }),
      );
    },
    { timeout: 30_000 },
  ); // 仅等待独占模型HTTP与持久会话投影完成。
}

async function createTarget(fixture: Fixture, host: Host) {
  const directory = join(fixture.directory, "客户端投影的目标项目目录");
  await mkdir(directory);
  const response = await host.client.request("/api/projects", {
    name: "客户端投影的目标项目",
    kind: "code",
    work_dir: directory,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return projectCreateResponseSchema.parse(response.body).project.id;
}

async function submitTaskMove(host: Host, input: CodeTaskProjectMoveInput) {
  const moved = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "moveTask",
    args: [input],
  });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  expect(moved.body).toEqual({ result: null });
}

async function loadProjectionFixture() {
  const httpLoading: Promise<{
    createCodeUiHttpFixture(): Promise<Fixture>;
  }> = import(fixturePath);
  const [http, sessions, models, channel] = await Promise.all([
    httpLoading,
    import("../../server/src/features/code-ui/host-session.fixture.js"),
    import("../../server/src/features/code-ui/model-stream.fixture.js"),
    import("../src/components/workbench/zcode/host/httpChannelClient"),
  ]);
  const fixture = await http.createCodeUiHttpFixture();
  return { fixture, sessions, models, channel };
}

async function prepareProjectionResources(
  loaded: Awaited<ReturnType<typeof loadProjectionFixture>>,
  resources: ProjectionResources,
) {
  const { fixture, sessions, models, channel } = loaded;
  // 受控模型HTTP只用于建立真实历史，不调用用户的供应商或模型。
  const model = await models.heldModel();
  resources.model = model;
  const session = await sessions.createCodeSessionFixture(model.baseUrl, {
    client: fixture.client,
  });
  resources.host = session;
  await completeTask(session, model);
  const client = new channel.CodeHttpChannelClient({
    apiBase: fixture.baseUrl,
    accessToken: await fixture.app.kernel.get("localAccess").getDesktopToken(),
  });
  resources.client = client;
  await client.connect();
  const hello = protocol.helloMessageSchema.parse(
    await client.services.zcodeAgentService.helloConversationV4(),
  );
  await client.services.zcodeAgentService.initializeConversationV4({
    kind: "clientHello",
    protocolVersion: hello.protocolVersion,
    clientId: randomUUID(),
    appVersion: "task-project-projection-integration",
    clientKind: "web",
  });
  await client.refreshWorkspaces();
  return { fixture, session, model, client };
}

async function assertProjectProjection(
  context: Awaited<ReturnType<typeof prepareProjectionResources>>,
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
  context: Awaited<ReturnType<typeof prepareProjectionResources>>,
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
  context: Awaited<ReturnType<typeof prepareProjectionResources>>,
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
  context: Awaited<ReturnType<typeof prepareProjectionResources>>,
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

async function closeProjectionResources(
  resources: ProjectionResources,
  failures: unknown[],
) {
  const { client, targetProjectId, host, model, fixture } = resources;
  for (const close of [
    async () => {
      if (resources.controller && resources.controllerSubscriptionId)
        await resources.controller.unsubscribeControllerV4({
          subscriptionId: resources.controllerSubscriptionId,
        });
    },
    () => resources.controllerListener?.dispose(),
    () => resources.taskMetaListener?.dispose(),
    () => client?.dispose(),
    async () => {
      if (!targetProjectId || !host) return;
      const response = await host.client.request(
        `/api/projects/${targetProjectId}`,
        undefined,
        "DELETE",
      );
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(400);
    },
    () => host?.dispose(),
    () => model?.close(),
    () => fixture.close(),
  ]) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
}

async function withProjectionResources(
  assertion: (
    context: Awaited<ReturnType<typeof prepareProjectionResources>>,
    resources: ProjectionResources,
  ) => Promise<void>,
) {
  const loaded = await loadProjectionFixture();
  const resources: ProjectionResources = { fixture: loaded.fixture };
  const failures: unknown[] = [];
  try {
    const context = await prepareProjectionResources(loaded, resources);
    await assertion(context, resources);
  } catch (error) {
    failures.push(error);
  } finally {
    await closeProjectionResources(resources, failures);
  }
  if (failures.length)
    throw new AggregateError(failures, "Task项目投影验证或资源关闭失败", {
      cause: failures[0],
    });
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
