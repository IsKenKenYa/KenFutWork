import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodeTaskProjectMoveInput,
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
  runCancelResponseSchema,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import {
  snapshot as readTaskSnapshot,
  waitPhase,
} from "./history-fork.fixture.js";
import { nextHostServiceEvent } from "./host-client.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";
import { createCommitResponseLossProxy } from "./pg-commit-response-loss.fixture.mjs";

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;

async function createDraftTask(
  fixture: Fixture,
  projectId: string,
  workspacePath: string,
) {
  const stream = await fixture.client.openCodeStream();
  const clientId = randomUUID();
  const initialized = await stream.rpc("initializeConversationV4", [
    {
      kind: "clientHello",
      protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
      clientId,
      appVersion: "task-project-move-integration",
      clientKind: "web",
    },
  ]);
  expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
  const creationRequest = {
    workspacePath,
    projectId,
    envelope: {
      commandId: randomUUID(),
      clientId,
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: projectId },
      issuedAt: Date.now(),
    },
  };
  const created = await stream.rpc("sendConversationCommandV4", [
    creationRequest,
  ]);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const ack = protocol.commandAckSchema.parse(created.body.result);
  if (ack.result?.type !== "createSession")
    throw new Error("原创建命令没有返回持久 Task 身份。");
  return {
    taskId: ack.result.sessionId,
    stream,
    creationRequest,
    creationResponse: created,
  };
}

async function scope(fixture: Fixture, taskId: string) {
  const response = await fixture.client.request(
    `/api/code-ui/tasks/${taskId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

async function createMoveScenario(fixture: Fixture) {
  const sourceDirectory = join(fixture.directory, "来源项目");
  const sourceAdditional = join(fixture.directory, "原只读目录");
  const targetDirectory = join(fixture.directory, "目标项目");
  const targetAdditional = join(fixture.directory, "目标可写目录");
  for (const directory of [
    sourceDirectory,
    sourceAdditional,
    targetDirectory,
    targetAdditional,
  ])
    await mkdir(directory);
  const source = await fixture.client.request("/api/projects", {
    name: "移动来源",
    kind: "code",
    work_dir: sourceDirectory,
    additional_directories: [{ path: sourceAdditional, access: "read-only" }],
  });
  const target = await fixture.client.request("/api/projects", {
    name: "移动目标",
    kind: "code",
    work_dir: targetDirectory,
    additional_directories: [{ path: targetAdditional, access: "read-write" }],
  });
  expect(source.status, JSON.stringify(source.body)).toBe(201);
  expect(target.status, JSON.stringify(target.body)).toBe(201);
  const sourceProjectId = z.uuid().parse(source.body.project.id);
  const targetProjectId = z.uuid().parse(target.body.project.id);
  const { taskId, stream, creationRequest, creationResponse } =
    await createDraftTask(fixture, sourceProjectId, sourceDirectory);
  const before = await scope(fixture, taskId);
  const restored = await fixture.client.request(
    `/api/code-ui/sessions/${taskId}`,
  );
  expect(restored.status, JSON.stringify(restored.body)).toBe(200);
  const snapshot = protocol.conversationSnapshotSchema.parse(
    restored.body.snapshot,
  );
  return {
    taskId,
    before,
    snapshot,
    targetProjectId,
    targetAdditional,
    stream,
    creationRequest,
    creationResponse,
    request: {
      connectionId: stream.ready.hello.connectionId,
      service: "project",
      method: "moveTask",
      args: [
        {
          task: { taskId, workspacePath: before.rootDirectory },
          sourceProjectId,
          projectId: targetProjectId,
          observedRevision: snapshot.revision,
          addMissingRoot: true,
        },
      ],
    },
  };
}

async function readMoveState(
  fixture: Fixture,
  taskId: string,
  projectId: string,
) {
  const currentScope = await scope(fixture, taskId);
  const restored = await fixture.client.request(
    `/api/code-ui/sessions/${taskId}`,
  );
  expect(restored.status, JSON.stringify(restored.body)).toBe(200);
  const snapshot = protocol.conversationSnapshotSchema.parse(
    restored.body.snapshot,
  );
  const project = await fixture.client.request(`/api/projects/${projectId}`);
  expect(project.status, JSON.stringify(project.body)).toBe(200);
  return {
    scope: currentScope,
    revision: snapshot.revision,
    directories: project.body.project.additional_directories,
  };
}

async function moveTaskBetweenProjects(
  client: Pick<Fixture["client"], "request">,
  input: CodeTaskProjectMoveInput,
) {
  const response = await client.request("/api/code-ui/rpc", {
    service: "project",
    method: "moveTask",
    args: [input],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body).toEqual({ result: null });
}

function expectMissingTaskControlAck(
  response: Awaited<ReturnType<Fixture["client"]["request"]>>,
  commandId: string,
  status: "rejected" | "duplicate",
) {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(response.body.result)).toMatchObject({
    commandId,
    status,
    reasonCode: "proto.missingTaskControl",
  });
}

async function readProjectTaskIds(
  stream: Awaited<ReturnType<Fixture["client"]["openCodeStream"]>>,
  projectId: string,
  workspacePath: string,
) {
  const subscribed = await stream.rpc("subscribeSessionsIndexV4", [
    {
      projectId,
      workspacePath,
      workspaceIdentity: JSON.stringify([projectId, workspacePath]),
    },
  ]);
  expect(subscribed.status, JSON.stringify(subscribed.body)).toBe(200);
  const { subscriptionId } =
    protocol.v4SessionsIndexSubscribeResultSchema.parse(
      subscribed.body.result,
    ).ack;
  const assembler = new protocol.TopicWireFrameAssembler(
    protocol.sessionsIndexTopicFrameSchema,
  );
  for (;;) {
    const event = await stream.next();
    if (event.event !== "onDynamicSessionsIndexFrame") continue;
    const wire = protocol.topicWireFrameCandidateSchema.parse(event.frame);
    if (wire.subscriptionId !== subscriptionId) continue;
    for (const result of assembler.accept(wire)) {
      if (result.kind === "fault")
        throw new Error(`项目会话索引无法解析：${result.fault.reasonCode}`);
      if (result.frame.payload.kind === "snapshot")
        return result.frame.payload.snapshot.sessions.map(
          (session) => session.sessionId,
        );
    }
  }
}

async function moveTaskBackToSource(
  fixture: Fixture,
  host: Awaited<ReturnType<typeof createCodeSessionFixture>>,
  initial: protocol.ConversationSnapshot,
) {
  const targetDirectory = join(fixture.directory, "停止观察值往返目标");
  await mkdir(targetDirectory);
  const target = await host.client.request("/api/projects", {
    name: "停止观察值目标",
    kind: "code",
    work_dir: targetDirectory,
  });
  expect(target.status, JSON.stringify(target.body)).toBe(201);
  const targetProjectId = z.uuid().parse(target.body.project.id);
  const task = { taskId: host.sessionId, workspacePath: host.workspacePath };
  await moveTaskBetweenProjects(host.client, {
    task,
    sourceProjectId: host.projectId,
    projectId: targetProjectId,
    observedRevision: initial.revision,
    addMissingRoot: true,
  });
  const atTarget = await readTaskSnapshot(fixture, host.sessionId);
  expect(atTarget.taskControl?.projectId).toBe(targetProjectId);
  await moveTaskBetweenProjects(host.client, {
    task,
    sourceProjectId: targetProjectId,
    projectId: host.projectId,
    observedRevision: atTarget.revision,
    addMissingRoot: true,
  });
  return readTaskSnapshot(fixture, host.sessionId);
}

describe.skipIf(!enabled)("Task 跨项目移动公开 RPC integration", () => {
  it("明确补充目标目录后移动静止 Task，保留创建时的目录和权限", async () => {
    const fixture = await createCodeUiHttpFixture();
    try {
      const { taskId, before, targetProjectId, targetAdditional, request } =
        await createMoveScenario(fixture);
      const moved = await fixture.client.request("/api/code-ui/rpc", request);
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(moved.body.result).toBeNull();
      expect(await scope(fixture, taskId)).toMatchObject({
        instanceId: before.instanceId,
        taskId,
        projectId: targetProjectId,
        rootDirectory: before.rootDirectory,
        additionalDirectories: before.additionalDirectories,
        sandboxMode: before.sandboxMode,
      });
      const targetAfter = await fixture.client.request(
        `/api/projects/${targetProjectId}`,
      );
      expect(targetAfter.status, JSON.stringify(targetAfter.body)).toBe(200);
      expect(targetAfter.body.project.additional_directories).toEqual(
        expect.arrayContaining([
          { path: targetAdditional, access: "read-write" },
          expect.objectContaining({ path: before.rootDirectory }),
        ]),
      );
    } finally {
      await fixture.close();
    }
  });

  it("公开快照记录 Task 跨项目往返后的项目与递增分支代际", async () => {
    const fixture = await createCodeUiHttpFixture();
    try {
      const { taskId, before, targetProjectId, request } =
        await createMoveScenario(fixture);
      const snapshotWithControlSchema =
        protocol.conversationSnapshotSchema.extend({
          taskControl: z.object({
            projectId: z.uuid(),
            branchGeneration: z.number().int().positive().safe(),
          }),
        });
      const readSnapshot = async () => {
        const response = await fixture.client.request(
          `/api/code-ui/sessions/${taskId}`,
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return snapshotWithControlSchema.parse(response.body.snapshot);
      };
      const initial = await readSnapshot();
      expect(initial.taskControl.projectId).toBe(before.projectId);
      const moved = await fixture.client.request("/api/code-ui/rpc", request);
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(moved.body).toEqual({ result: null });
      const atTarget = await readSnapshot();
      expect((await scope(fixture, taskId)).projectId).toBe(targetProjectId);
      expect(atTarget.taskControl.projectId).toBe(targetProjectId);
      expect(atTarget.taskControl.branchGeneration).toBeGreaterThan(
        initial.taskControl.branchGeneration,
      );
      const returned = await fixture.client.request("/api/code-ui/rpc", {
        ...request,
        args: [
          {
            task: { taskId, workspacePath: before.rootDirectory },
            sourceProjectId: targetProjectId,
            projectId: before.projectId,
            observedRevision: atTarget.revision,
            addMissingRoot: true,
          },
        ],
      });
      expect(returned.status, JSON.stringify(returned.body)).toBe(200);
      expect(returned.body).toEqual({ result: null });
      const atSource = await readSnapshot();
      expect((await scope(fixture, taskId)).projectId).toBe(before.projectId);
      expect(atSource.taskControl.projectId).toBe(
        initial.taskControl.projectId,
      );
      expect(atSource.taskControl.branchGeneration).toBeGreaterThan(
        atTarget.taskControl.branchGeneration,
      );
    } finally {
      await fixture.close();
    }
  });

  it("空 Task 创建回执保留初始观察值，项目往返后重放不新增 Task", async () => {
    const fixture = await createCodeUiHttpFixture();
    try {
      const {
        taskId,
        before,
        targetProjectId,
        stream,
        creationRequest,
        creationResponse,
        request,
      } = await createMoveScenario(fixture);
      const initialControl = protocol.conversationTaskControlSchema.parse(
        creationResponse.body.result.result.taskControl,
      );
      const initial = await readTaskSnapshot(fixture, taskId);
      expect(initialControl).toEqual(initial.taskControl);
      expect(initialControl.projectId).toBe(before.projectId);
      const moved = await fixture.client.request("/api/code-ui/rpc", request);
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(moved.body).toEqual({ result: null });
      const atTarget = await readTaskSnapshot(fixture, taskId);
      const movedBack = await fixture.client.request("/api/code-ui/rpc", {
        ...request,
        args: [
          {
            task: { taskId, workspacePath: before.rootDirectory },
            sourceProjectId: targetProjectId,
            projectId: before.projectId,
            observedRevision: atTarget.revision,
            addMissingRoot: true,
          },
        ],
      });
      expect(movedBack.status, JSON.stringify(movedBack.body)).toBe(200);
      expect(movedBack.body).toEqual({ result: null });
      const returned = await readTaskSnapshot(fixture, taskId);
      const currentControl = protocol.conversationTaskControlSchema.parse(
        returned.taskControl,
      );
      expect(currentControl.projectId).toBe(before.projectId);
      expect(currentControl.branchGeneration).toBeGreaterThan(
        initialControl.branchGeneration,
      );
      const replayed = await stream.rpc("sendConversationCommandV4", [
        creationRequest,
      ]);
      expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
      expect(
        protocol.commandAckSchema.parse(replayed.body.result),
      ).toMatchObject({
        commandId: creationRequest.envelope.commandId,
        status: "duplicate",
        result: { type: "createSession", sessionId: taskId },
      });
      expect(
        protocol.conversationTaskControlSchema.parse(
          replayed.body.result.result.taskControl,
        ),
      ).toEqual(initialControl);
      expect((await readTaskSnapshot(fixture, taskId)).taskControl).toEqual(
        currentControl,
      );
      expect(
        await readProjectTaskIds(
          stream,
          before.projectId,
          before.rootDirectory,
        ),
      ).toEqual([taskId]);
    } finally {
      await fixture.close();
    }
  });

  it("原 Controller 的 Task 元信息保留公开快照的控制观察值与正文修订", async () => {
    const fixture = await createCodeUiHttpFixture();
    const model = await heldModel();
    let host: Awaited<ReturnType<typeof createCodeSessionFixture>> | undefined;
    try {
      host = await createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
      });
      const initial = await readTaskSnapshot(fixture, host.sessionId);
      const taskControl = protocol.conversationTaskControlSchema.parse(
        initial.taskControl,
      );
      const text = "TASK_META_MUST_PRESERVE_THE_REAL_CONVERSATION_OBSERVATION";
      const sent = await host.command(
        "sendText",
        { text, modelSelection: initial.config.modelSelection },
        randomUUID(),
        { taskControl },
      );
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
        "accepted",
      );
      await model.firstRequest;
      expect(model.requests).toHaveLength(1);
      expect(JSON.stringify(model.requests[0]?.body.messages)).toContain(text);
      model.finish(0);
      const completed = await waitPhase(
        fixture,
        host.sessionId,
        "completedSuccess",
      );
      expect(completed.control.activeWorks).toEqual([]);
      expect(completed.rows.window).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "userInput", text }),
        ]),
      );
      const listed = await host.client.request("/api/code-ui/rpc", {
        service: "window-controller",
        method: "listTaskList",
        args: [
          {
            kind: "active",
            sortBy: "updated",
            workspaceScopes: [
              {
                workspacePath: host.workspacePath,
                workspaceIdentity: JSON.stringify([
                  host.projectId,
                  host.workspacePath,
                ]),
              },
            ],
          },
        ],
      });
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      expect(listed.body.result).toMatchObject({
        total: 1,
        hasMore: false,
        items: [{ taskId: host.sessionId, workspacePath: host.workspacePath }],
      });
      const subscribed = await host.client.request("/api/code-ui/rpc", {
        service: "window-controller",
        method: "subscribeControllerV4",
        args: [{ topic: "controller/tasks-index", visibility: "foreground" }],
      });
      expect(subscribed.status, JSON.stringify(subscribed.body)).toBe(200);
      const { ack } = protocol.controllerSubscribeResultSchema.parse(
        subscribed.body.result,
      );
      const event = await nextHostServiceEvent(
        host.stream,
        "window-controller",
        "onDynamicControllerFrame",
      );
      const frame = protocol.windowHostControllerTaskFrameSchema.parse(
        event.data,
      );
      expect(frame.subscriptionId).toBe(ack.subscriptionId);
      if (frame.payload.kind !== "snapshot")
        throw new Error("原 Controller 订阅没有返回任务目录快照。");
      const task = frame.payload.snapshot.tasks.find(
        (entry) => entry.address.taskId === host?.sessionId,
      );
      expect(task?.address).toMatchObject({
        taskId: host.sessionId,
        workspacePath: host.workspacePath,
      });
      expect(task?.meta).toHaveProperty("taskControl", completed.taskControl);
      expect(task?.meta).toHaveProperty(
        "conversationRevision",
        completed.revision,
      );
      expect(model.requests).toHaveLength(1);
    } finally {
      try {
        await host?.dispose();
      } finally {
        try {
          await fixture.close();
        } finally {
          await model.close();
        }
      }
    }
  });

  it("发送缺少 Task 观察值时拒绝，同键重放与补值保持原回执", async () => {
    const fixture = await createCodeUiHttpFixture();
    const model = await heldModel();
    let host: Awaited<ReturnType<typeof createCodeSessionFixture>> | undefined;
    try {
      host = await createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
      });
      const { sessionId, workspacePath, projectId, clientId, stream } = host;
      const initial = await readTaskSnapshot(fixture, sessionId);
      if (!initial.taskControl || !initial.config.modelSelection)
        throw new Error("缺观察值测试没有公开控制事实或可执行模型选择。");
      const originalRequest = {
        workspacePath,
        projectId,
        envelope: {
          commandId: randomUUID(),
          clientId,
          sessionId,
          type: "sendText",
          payload: {
            text: "MISSING_TASK_CONTROL_MUST_NOT_START_A_RUN",
            modelSelection: initial.config.modelSelection,
          },
          issuedAt: Date.now(),
        },
      };
      const assertNoInput = async () => {
        const after = await readTaskSnapshot(fixture, sessionId);
        expect(after.rows.window).toEqual(initial.rows.window);
        expect(after.control).toEqual(initial.control);
        expect(after.control.phase).toBe("draft");
        expect(after.control.activeWorks).toEqual([]);
        expect(after.pendingCommands).toEqual([]);
        expect(model.requests).toHaveLength(0);
      };
      const sent = await stream.rpc("sendConversationCommandV4", [
        originalRequest,
      ]);
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      expect(protocol.commandAckSchema.parse(sent.body.result)).toMatchObject({
        commandId: originalRequest.envelope.commandId,
        status: "rejected",
        reasonCode: "proto.missingTaskControl",
      });
      await assertNoInput();
      const replayed = await stream.rpc("sendConversationCommandV4", [
        originalRequest,
      ]);
      expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
      expect(
        protocol.commandAckSchema.parse(replayed.body.result),
      ).toMatchObject({
        commandId: originalRequest.envelope.commandId,
        status: "duplicate",
        reasonCode: "proto.missingTaskControl",
      });
      await assertNoInput();
      const changed = await stream.rpc("sendConversationCommandV4", [
        {
          ...originalRequest,
          envelope: {
            ...originalRequest.envelope,
            taskControl: structuredClone(initial.taskControl),
          },
        },
      ]);
      expect(changed.status, JSON.stringify(changed.body)).toBe(409);
      expect(changed.body.error).toMatchObject({
        code: "code_ui_command_conflict",
      });
      await assertNoInput();
    } finally {
      try {
        await host?.dispose();
      } finally {
        try {
          await fixture.close();
        } finally {
          await model.close();
        }
      }
    }
  });

  it("停止缺少 Task 观察值时拒绝，同键重放与补值不关闭当前运行", async () => {
    const fixture = await createCodeUiHttpFixture();
    const model = await heldModel();
    let host: Awaited<ReturnType<typeof createCodeSessionFixture>> | undefined;
    try {
      host = await createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
      });
      const { sessionId, workspacePath, projectId, clientId, stream } = host;
      const initial = await readTaskSnapshot(fixture, sessionId);
      if (!initial.taskControl || !initial.config.modelSelection)
        throw new Error("缺观察值停止测试没有公开控制事实或可执行模型选择。");
      const started = await stream.rpc("sendConversationCommandV4", [
        {
          workspacePath,
          projectId,
          envelope: {
            commandId: randomUUID(),
            clientId,
            sessionId,
            type: "sendText",
            taskControl: structuredClone(initial.taskControl),
            payload: {
              text: "CURRENT_RUN_MUST_SURVIVE_MISSING_TASK_CONTROL_STOP",
              modelSelection: initial.config.modelSelection,
            },
            issuedAt: Date.now(),
          },
        },
      ]);
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      expect(protocol.commandAckSchema.parse(started.body.result).status).toBe(
        "accepted",
      );
      await model.firstRequest;
      const running = await waitPhase(fixture, sessionId, "running");
      const observed = protocol.conversationTaskControlSchema.parse(
        running.taskControl,
      );
      const executionId = z
        .string()
        .min(1)
        .parse(
          running.control.activeWorks.find(
            (work) => work.kind === "primaryTurn",
          )?.foregroundExecutionId,
        );
      const originalStop = {
        workspacePath,
        projectId,
        envelope: {
          commandId: randomUUID(),
          clientId,
          sessionId,
          type: "stop",
          payload: { expectedForegroundExecutionId: executionId },
          issuedAt: Date.now(),
        },
      };
      const assertRunning = async () => {
        const after = await readTaskSnapshot(fixture, sessionId);
        expect(after.control.phase).toBe("running");
        expect(after.control.activeWorks).toEqual(running.control.activeWorks);
        expect(model.requests).toHaveLength(1);
        expect(model.requests[0]?.closed).toBe(false);
      };
      await assertRunning();
      const stopped = await stream.rpc("sendConversationCommandV4", [
        originalStop,
      ]);
      expectMissingTaskControlAck(
        stopped,
        originalStop.envelope.commandId,
        "rejected",
      );
      await assertRunning();
      const replayed = await stream.rpc("sendConversationCommandV4", [
        originalStop,
      ]);
      expectMissingTaskControlAck(
        replayed,
        originalStop.envelope.commandId,
        "duplicate",
      );
      await assertRunning();
      const changed = await stream.rpc("sendConversationCommandV4", [
        {
          ...originalStop,
          envelope: {
            ...originalStop.envelope,
            taskControl: structuredClone(observed),
          },
        },
      ]);
      expect(changed.status, JSON.stringify(changed.body)).toBe(409);
      expect(changed.body.error).toMatchObject({
        code: "code_ui_command_conflict",
      });
      await assertRunning();
    } finally {
      try {
        await host?.dispose();
      } finally {
        try {
          await fixture.close();
        } finally {
          await model.close();
        }
      }
    }
  });

  it("外部取消 HTTP 请求停止合法运行并关闭真实模型流", async () => {
    const fixture = await createCodeUiHttpFixture();
    const model = await heldModel();
    let host: Awaited<ReturnType<typeof createCodeSessionFixture>> | undefined;
    try {
      host = await createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
      });
      const { sessionId, workspacePath, projectId, clientId, stream } = host;
      const initial = await readTaskSnapshot(fixture, sessionId);
      if (!initial.taskControl || !initial.config.modelSelection)
        throw new Error("外部取消测试没有公开控制事实或可执行模型选择。");
      const started = await stream.rpc("sendConversationCommandV4", [
        {
          workspacePath,
          projectId,
          envelope: {
            commandId: randomUUID(),
            clientId,
            sessionId,
            type: "sendText",
            taskControl: structuredClone(initial.taskControl),
            payload: {
              text: "EXTERNAL_CANCEL_MUST_CLOSE_THE_CURRENT_MODEL_STREAM",
              modelSelection: initial.config.modelSelection,
            },
            issuedAt: Date.now(),
          },
        },
      ]);
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      expect(protocol.commandAckSchema.parse(started.body.result).status).toBe(
        "accepted",
      );
      await model.firstRequest;
      const running = await waitPhase(fixture, sessionId, "running");
      const runId = z
        .string()
        .min(1)
        .parse(
          running.control.activeWorks.find(
            (work) => work.kind === "primaryTurn",
          )?.foregroundExecutionId,
        );
      expect(model.requests).toHaveLength(1);
      expect(model.requests[0]?.closed).toBe(false);
      const canceled = await host.client.request(
        `/api/agent/runs/${runId}/cancel`,
        undefined,
        "POST",
      );
      expect(canceled.status, JSON.stringify(canceled.body)).toBe(202);
      expect(runCancelResponseSchema.parse(canceled.body)).toEqual({
        runId,
        status: "canceled",
      });
      const stopped = await waitPhase(
        fixture,
        sessionId,
        "completedInterrupted",
      );
      expect(stopped.control.activeWorks).toEqual([]);
      expect(stopped.control.canStop).toBe(false);
      await vi.waitFor(() => expect(model.requests[0]?.closed).toBe(true), {
        timeout: 30_000,
      });
      expect(model.requests).toHaveLength(1);
    } finally {
      try {
        await host?.dispose();
      } finally {
        try {
          await fixture.close();
        } finally {
          await model.close();
        }
      }
    }
  });

  it("项目往返后原观察值的发送返回 stale，不创建用户输入或运行", async () => {
    const fixture = await createCodeUiHttpFixture();
    const model = await heldModel();
    let host: Awaited<ReturnType<typeof createCodeSessionFixture>> | undefined;
    try {
      host = await createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
      });
      const { sessionId, workspacePath, projectId, clientId, stream } = host;
      const initial = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      if (!initial.taskControl || !initial.config.modelSelection)
        throw new Error("移动发送测试缺少公开观察值或可执行模型选择。");
      const originalRequest = {
        workspacePath,
        projectId,
        envelope: {
          commandId: randomUUID(),
          clientId,
          sessionId,
          type: "sendText",
          taskControl: structuredClone(initial.taskControl),
          payload: {
            text: "OLD_TASK_CONTROL_MUST_NOT_START_A_RUN",
            modelSelection: initial.config.modelSelection,
          },
          issuedAt: Date.now(),
        },
      };
      const returned = await moveTaskBackToSource(fixture, host, initial);
      if (!returned.taskControl)
        throw new Error("往返后的公开快照缺少 Task 观察值。");
      expect(returned.taskControl.projectId).toBe(projectId);
      expect(returned.taskControl.branchGeneration).toBeGreaterThan(
        initial.taskControl.branchGeneration,
      );
      const assertNoInput = async () => {
        const after = await readTaskSnapshot(fixture, sessionId);
        expect(after.rows.window).toEqual(returned.rows.window);
        expect(after.control).toEqual(returned.control);
        expect(after.control.phase).toBe("draft");
        expect(after.control.activeWorks).toEqual([]);
        expect(after.pendingCommands).toEqual([]);
        expect(model.requests).toHaveLength(0);
      };
      const sent = await stream.rpc("sendConversationCommandV4", [
        originalRequest,
      ]);
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      expect(protocol.commandAckSchema.parse(sent.body.result)).toMatchObject({
        commandId: originalRequest.envelope.commandId,
        status: "stale",
        reasonCode: "proto.staleTaskControl",
      });
      await assertNoInput();
      const replayed = await stream.rpc("sendConversationCommandV4", [
        originalRequest,
      ]);
      expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
      expect(
        protocol.commandAckSchema.parse(replayed.body.result),
      ).toMatchObject({
        commandId: originalRequest.envelope.commandId,
        status: "duplicate",
        reasonCode: "proto.staleTaskControl",
      });
      await assertNoInput();
      const changed = await stream.rpc("sendConversationCommandV4", [
        {
          ...originalRequest,
          envelope: {
            ...originalRequest.envelope,
            taskControl: structuredClone(returned.taskControl),
          },
        },
      ]);
      expect(changed.status, JSON.stringify(changed.body)).toBe(409);
      expect(changed.body.error).toMatchObject({
        code: "code_ui_command_conflict",
      });
      await assertNoInput();
    } finally {
      await host?.dispose();
      await fixture.close();
      await model.close();
    }
  });

  it("项目往返后旧停止返回 stale，当前新运行与模型流继续保持", async () => {
    const fixture = await createCodeUiHttpFixture();
    const model = await heldModel();
    let host: Awaited<ReturnType<typeof createCodeSessionFixture>> | undefined;
    try {
      host = await createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
      });
      const initial = await readTaskSnapshot(fixture, host.sessionId);
      if (!initial.taskControl || !initial.config.modelSelection)
        throw new Error("移动停止测试缺少公开观察值或可执行模型选择。");
      const originalStop = {
        workspacePath: host.workspacePath,
        projectId: host.projectId,
        envelope: {
          commandId: randomUUID(),
          clientId: host.clientId,
          sessionId: host.sessionId,
          type: "stop",
          taskControl: structuredClone(initial.taskControl),
          payload: {},
          issuedAt: Date.now(),
        },
      };
      const returned = await moveTaskBackToSource(fixture, host, initial);
      if (!returned.taskControl)
        throw new Error("往返后的公开快照缺少 Task 观察值。");
      expect(returned.taskControl.projectId).toBe(host.projectId);
      expect(returned.taskControl.branchGeneration).toBeGreaterThan(
        initial.taskControl.branchGeneration,
      );
      const sent = await host.stream.rpc("sendConversationCommandV4", [
        {
          workspacePath: host.workspacePath,
          projectId: host.projectId,
          envelope: {
            commandId: randomUUID(),
            clientId: host.clientId,
            sessionId: host.sessionId,
            type: "sendText",
            taskControl: structuredClone(returned.taskControl),
            payload: {
              text: "CURRENT_RUN_MUST_SURVIVE_OLD_TASK_STOP",
              modelSelection: initial.config.modelSelection,
            },
            issuedAt: Date.now(),
          },
        },
      ]);
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
        "accepted",
      );
      await model.firstRequest;
      const taskId = host.sessionId;
      await vi.waitFor(
        async () => {
          expect((await readTaskSnapshot(fixture, taskId)).control.phase).toBe(
            "running",
          );
        },
        { timeout: 30_000 },
      );
      const running = await readTaskSnapshot(fixture, taskId);
      expect(running.control.activeWorks).toContainEqual(
        expect.objectContaining({
          kind: "primaryTurn",
          foregroundExecutionId: expect.any(String),
        }),
      );
      expect(model.requests).toHaveLength(1);
      expect(model.requests[0]?.closed).toBe(false);
      const stopped = await host.stream.rpc("sendConversationCommandV4", [
        originalStop,
      ]);
      expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
      expect(
        protocol.commandAckSchema.parse(stopped.body.result),
      ).toMatchObject({
        commandId: originalStop.envelope.commandId,
        status: "stale",
        reasonCode: "proto.staleTaskControl",
      });
      const after = await readTaskSnapshot(fixture, taskId);
      expect(after.control.phase).toBe("running");
      expect(after.control.activeWorks).toEqual(running.control.activeWorks);
      expect(model.requests).toHaveLength(1);
      expect(model.requests[0]?.closed).toBe(false);
    } finally {
      try {
        await host?.dispose();
      } finally {
        try {
          await fixture.close();
        } finally {
          await model.close();
        }
      }
    }
  });

  it("同一移动键并发八次及顺序重放，只改变一次归属与授权版本", async () => {
    const fixture = await createCodeUiHttpFixture();
    try {
      const {
        taskId,
        before,
        snapshot,
        targetProjectId,
        targetAdditional,
        request,
      } = await createMoveScenario(fixture);
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          fixture.client.request("/api/code-ui/rpc", request),
        ),
      );
      for (const response of responses) {
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(response.body).toEqual({ result: null });
      }
      const replayed = await fixture.client.request(
        "/api/code-ui/rpc",
        request,
      );
      expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
      expect(replayed.body).toEqual({ result: null });
      expect(await scope(fixture, taskId)).toEqual({
        ...before,
        projectId: targetProjectId,
        generation: before.generation + 1,
      });
      const restored = await fixture.client.request(
        `/api/code-ui/sessions/${taskId}`,
      );
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      expect(
        protocol.conversationSnapshotSchema.parse(restored.body.snapshot)
          .revision,
      ).toBe(snapshot.revision + 1);
      const target = await fixture.client.request(
        `/api/projects/${targetProjectId}`,
      );
      expect(target.status, JSON.stringify(target.body)).toBe(200);
      expect(target.body.project.additional_directories).toEqual([
        { path: targetAdditional, access: "read-write" },
        { path: before.rootDirectory, access: "read-write" },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("同一移动键更改补充目录参数返回冲突，原参数仍可重放", async () => {
    const fixture = await createCodeUiHttpFixture();
    try {
      const {
        taskId,
        before,
        snapshot,
        targetProjectId,
        targetAdditional,
        request,
      } = await createMoveScenario(fixture);
      const moved = await fixture.client.request("/api/code-ui/rpc", request);
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(moved.body).toEqual({ result: null });
      const committed = await readMoveState(fixture, taskId, targetProjectId);
      expect(committed).toEqual({
        scope: {
          ...before,
          projectId: targetProjectId,
          generation: before.generation + 1,
        },
        revision: snapshot.revision + 1,
        directories: [
          { path: targetAdditional, access: "read-write" },
          { path: before.rootDirectory, access: "read-write" },
        ],
      });
      const conflicting = await fixture.client.request("/api/code-ui/rpc", {
        ...request,
        args: request.args.map((input) => ({
          ...input,
          addMissingRoot: false,
        })),
      });
      expect(conflicting.status, JSON.stringify(conflicting.body)).toBe(409);
      expect(conflicting.body.error).toMatchObject({
        code: "project.task-move-conflict",
      });
      expect(await readMoveState(fixture, taskId, targetProjectId)).toEqual(
        committed,
      );
      const replayed = await fixture.client.request(
        "/api/code-ui/rpc",
        request,
      );
      expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
      expect(replayed.body).toEqual({ result: null });
      expect(await readMoveState(fixture, taskId, targetProjectId)).toEqual(
        committed,
      );
    } finally {
      await fixture.close();
    }
  });

  it("移动后删除 Task，迟到移动重放不能恢复 Task 或改变目标项目", async () => {
    const fixture = await createCodeUiHttpFixture();
    try {
      const { taskId, before, targetProjectId, targetAdditional, request } =
        await createMoveScenario(fixture);
      const moved = await fixture.client.request("/api/code-ui/rpc", request);
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(moved.body).toEqual({ result: null });
      const targetBefore = await fixture.client.request(
        `/api/projects/${targetProjectId}`,
      );
      expect(targetBefore.status, JSON.stringify(targetBefore.body)).toBe(200);
      expect(targetBefore.body.project.additional_directories).toEqual([
        { path: targetAdditional, access: "read-write" },
        { path: before.rootDirectory, access: "read-write" },
      ]);
      const deleted = await fixture.client.request("/api/code-ui/rpc", {
        connectionId: request.connectionId,
        service: "zcode-task",
        method: "deleteTask",
        args: [
          {
            taskId,
            projectId: targetProjectId,
            workspacePath: before.rootDirectory,
            workspaceIdentity: JSON.stringify([
              targetProjectId,
              before.rootDirectory,
            ]),
          },
        ],
      });
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      expect(deleted.body).toEqual({ result: null });
      for (let replay = 0; replay < 2; replay += 1) {
        const late = await fixture.client.request("/api/code-ui/rpc", request);
        expect(late.status, JSON.stringify(late.body)).toBe(404);
        expect(late.body.error).toMatchObject({
          code: "project.task-not-found",
        });
        const session = await fixture.client.request(
          `/api/code-ui/sessions/${taskId}`,
        );
        expect(session.status, JSON.stringify(session.body)).toBe(404);
        const taskScope = await fixture.client.request(
          `/api/code-ui/tasks/${taskId}/scope`,
        );
        expect(taskScope.status, JSON.stringify(taskScope.body)).toBe(404);
        const targetAfter = await fixture.client.request(
          `/api/projects/${targetProjectId}`,
        );
        expect(targetAfter.status, JSON.stringify(targetAfter.body)).toBe(200);
        expect(targetAfter.body.project).toEqual(targetBefore.body.project);
      }
    } finally {
      await fixture.close();
    }
  });

  it("准备移动已提交但响应丢失后，原移动键重放完成并恢复 Task 授权", async () => {
    let proxy:
      | Awaited<ReturnType<typeof createCommitResponseLossProxy>>
      | undefined;
    const fixture = await createCodeUiHttpFixture({
      databaseTransport: async (direct) => {
        proxy = await createCommitResponseLossProxy(direct);
        return proxy;
      },
    });
    try {
      if (!proxy) throw new Error("移动测试没有建立真实 PG 故障代理。");
      const sourceDirectory = join(fixture.directory, "响应丢失来源");
      const targetDirectory = join(fixture.directory, "响应丢失目标");
      await mkdir(sourceDirectory);
      await mkdir(targetDirectory);
      const source = await fixture.client.request("/api/projects", {
        name: "移动来源",
        kind: "code",
        work_dir: sourceDirectory,
      });
      const target = await fixture.client.request("/api/projects", {
        name: "移动目标",
        kind: "code",
        work_dir: targetDirectory,
      });
      expect(source.status, JSON.stringify(source.body)).toBe(201);
      expect(target.status, JSON.stringify(target.body)).toBe(201);
      const sourceProjectId = z.uuid().parse(source.body.project.id);
      const targetProjectId = z.uuid().parse(target.body.project.id);
      const { taskId, stream } = await createDraftTask(
        fixture,
        sourceProjectId,
        sourceDirectory,
      );
      const before = await scope(fixture, taskId);
      const restored = await fixture.client.request(
        `/api/code-ui/sessions/${taskId}`,
      );
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      const snapshot = protocol.conversationSnapshotSchema.parse(
        restored.body.snapshot,
      );
      const operationKey = JSON.stringify([
        before.instanceId,
        taskId,
        sourceProjectId,
        targetProjectId,
        snapshot.revision,
      ]);
      const request = {
        connectionId: stream.ready.hello.connectionId,
        service: "project",
        method: "moveTask",
        args: [
          {
            task: { taskId, workspacePath: before.rootDirectory },
            sourceProjectId,
            projectId: targetProjectId,
            observedRevision: snapshot.revision,
            addMissingRoot: true,
          },
        ],
      };
      proxy.arm(operationKey, { taskProjectMovePrepare: true });
      await fixture.client.request("/api/code-ui/rpc", request);
      expect(proxy.evidence()).toMatchObject({
        injected: {
          commitConfirmed: true,
          replySuppressed: true,
          commandId: operationKey,
          taskProjectMovePrepare: true,
          targetTaskId: taskId,
        },
      });
      expect(proxy.evidence().observerError).toBeUndefined();
      const replayed = await fixture.client.request(
        "/api/code-ui/rpc",
        request,
      );
      expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
      expect(replayed.body.result).toBeNull();
      expect(await scope(fixture, taskId)).toMatchObject({
        taskId,
        projectId: targetProjectId,
        generation: before.generation + 1,
        rootDirectory: before.rootDirectory,
        additionalDirectories: before.additionalDirectories,
        sandboxMode: before.sandboxMode,
      });
    } finally {
      await fixture.close();
    }
  });
});
