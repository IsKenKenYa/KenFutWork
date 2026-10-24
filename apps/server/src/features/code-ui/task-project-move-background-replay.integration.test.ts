import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodeTaskProjectMoveInput,
  projectCreateResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
const parentText = "PARENT_WAIT_FOR_BACKGROUND_REPLAY_RESULT";
const childDescription = "BACKGROUND_REPLAY_CHILD";
const childResult = "BACKGROUND_REPLAY_REAL_CHILD_COMPLETED";

function moveTask(host: Host, input: CodeTaskProjectMoveInput) {
  return host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "moveTask",
    args: [input],
  });
}

async function moveEmptyTaskRoundTrip(fixture: Fixture, host: Host) {
  const path = join(fixture.directory, "后台重放往返目标目录");
  await mkdir(path);
  const target = await host.client.request("/api/projects", {
    name: "后台重放往返目标项目",
    kind: "code",
    work_dir: path,
  });
  expect(target.status, JSON.stringify(target.body)).toBe(201);
  const project = projectCreateResponseSchema.parse(target.body).project;
  const initial = protocol.conversationSnapshotSchema.parse(
    await host.snapshot(),
  );
  const initialControl = protocol.conversationTaskControlSchema.parse(
    initial.taskControl,
  );
  expect(initial.control.phase).toBe("draft");
  const firstMove: CodeTaskProjectMoveInput = {
    task: {
      taskId: host.sessionId,
      workspacePath: host.workspacePath,
      workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
    },
    sourceProjectId: host.projectId,
    projectId: project.id,
    observedRevision: initial.revision,
    addMissingRoot: true,
  };
  const moved = await moveTask(host, firstMove);
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  expect(moved.body).toEqual({ result: null });
  const atTarget = protocol.conversationSnapshotSchema.parse(
    await host.snapshot(),
  );
  expect(atTarget.taskControl?.projectId).toBe(project.id);
  const returned = await moveTask(host, {
    task: {
      taskId: host.sessionId,
      workspacePath: host.workspacePath,
      workspaceIdentity: JSON.stringify([project.id, host.workspacePath]),
    },
    sourceProjectId: project.id,
    projectId: host.projectId,
    observedRevision: atTarget.revision,
    addMissingRoot: true,
  });
  expect(returned.status, JSON.stringify(returned.body)).toBe(200);
  expect(returned.body).toEqual({ result: null });
  const atSource = protocol.conversationSnapshotSchema.parse(
    await host.snapshot(),
  );
  expect(atSource.taskControl).toEqual({
    projectId: host.projectId,
    branchGeneration: initialControl.branchGeneration + 2,
  });
  return {
    firstMove,
    firstResult: moved.body,
    taskControl: atSource.taskControl,
  };
}

async function subscribeSnapshots(host: Host) {
  const response = await host.stream.rpc("subscribeConversationV4", [
    {
      workspacePath: host.workspacePath,
      workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
      projectId: host.projectId,
      sessionId: host.sessionId,
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const { ack } = protocol.v4ConversationSubscribeResultSchema.parse(
    response.body.result,
  );
  const assembler = new protocol.TopicWireFrameAssembler(
    protocol.conversationTopicFrameSchema,
  );
  let initial = true;
  const next = async () => {
    for (;;) {
      const event = await host.stream.next();
      if (event.event !== "onDynamicConversationFrame") continue;
      const wire = protocol.topicWireFrameCandidateSchema.parse(event.frame);
      if (wire.subscriptionId !== ack.subscriptionId) continue;
      expect(wire.topic).toBe(protocol.conversationTopic(host.sessionId));
      expect(event.workspacePath).toBe(host.workspacePath);
      expect(event.workspaceIdentity).toBe(
        JSON.stringify([host.projectId, host.workspacePath]),
      );
      for (const result of assembler.accept(wire)) {
        if (result.kind === "fault")
          throw new Error(`后台接纳会话帧无法解析：${result.fault.reasonCode}`);
        if (initial) {
          expect(result.deliveryKind).toBe("initial");
          initial = false;
        }
        if (result.frame.payload.kind !== "snapshot")
          throw new Error("原SSE没有返回完整会话快照。");
        return result.frame.payload.snapshot;
      }
    }
  };
  return {
    next,
    async until(accept: (snapshot: protocol.ConversationSnapshot) => boolean) {
      for (;;) {
        const snapshot = await next();
        if (accept(snapshot)) return snapshot;
      }
    },
  };
}

function childModelIndex(model: Model) {
  return model.requests.findIndex(
    (request, index) =>
      index > 0 &&
      Array.isArray(request.body.messages) &&
      request.body.messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "role" in message &&
          message.role === "user" &&
          "content" in message &&
          JSON.stringify(message.content).includes(childDescription) &&
          JSON.stringify(message.content).includes("角色：explore"),
      ),
  );
}

async function startBackgroundTask(host: Host, model: Model) {
  const sent = await host.command("sendText", { text: parentText });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  await vi.waitFor(() => expect(model.requests).toHaveLength(3), {
    timeout: 30_000,
  }); // 仅等待真实父模型、后台子模型和父工具后模型的HTTP请求。
  const childIndex = childModelIndex(model);
  const parentIndex = model.requests.findIndex(
    (_request, index) => index > 0 && index !== childIndex,
  );
  if (childIndex < 0 || parentIndex < 0)
    throw new Error("真实主模型与后台子模型不可识别。");
  expect(parentIndex).not.toBe(childIndex);
  const reader = await subscribeSnapshots(host);
  await reader.next();
  model.finish(parentIndex);
  const idle = await reader.until(
    (snapshot) =>
      snapshot.control.phase === "completedSuccess" &&
      snapshot.control.activeWorks.length === 0 &&
      snapshot.backgroundWorks.some(
        (work) => work.kind === "subagent" && work.status === "running",
      ),
  );
  const work = idle.backgroundWorks.find(
    (entry) => entry.kind === "subagent" && entry.status === "running",
  );
  if (!work?.childSessionId) throw new Error("原SSE缺少运行中的后台子身份。");
  expect(idle.rows.window).toContainEqual(
    expect.objectContaining({
      kind: "userInput",
      origin: "realUser",
      text: parentText,
    }),
  );
  expect(model.requests[childIndex]?.closed).toBe(false);
  expect(model.requests).toHaveLength(3);
  return { childIndex, reader, idle, work };
}

function expectCompletedContinuation(
  completed: protocol.ConversationSnapshot,
  idle: protocol.ConversationSnapshot,
  workId: string,
  model: Model,
) {
  expect(completed.taskControl).toEqual(idle.taskControl);
  expect(completed.control.activeWorks).toEqual([]);
  expect(completed.goal).toEqual(idle.goal);
  expect(
    completed.rows.window.filter(
      (row) => row.kind === "turnHeader" && row.origin === "backgroundResult",
    ),
  ).toHaveLength(1);
  expect(
    completed.rows.window.filter(
      (row) =>
        row.kind === "userInput" &&
        row.origin === "backgroundResult" &&
        row.originMeta?.workId === workId,
    ),
  ).toMatchObject([
    {
      text: expect.stringContaining(childResult),
      originMeta: { workId, backgroundSource: "subagent" },
    },
  ]);
  const backgroundTurn = completed.rows.window.find(
    (row) => row.kind === "turnHeader" && row.origin === "backgroundResult",
  );
  if (backgroundTurn?.kind !== "turnHeader" || !backgroundTurn.sourceCommandId)
    throw new Error("原会话缺少后台结果的实际轮次标题及命令身份。");
  expect(
    completed.rows.window.filter(
      (row) =>
        row.kind === "userInput" &&
        row.origin === "backgroundResult" &&
        row.sourceCommandId === backgroundTurn.sourceCommandId,
    ),
  ).toHaveLength(1);
  expect(JSON.stringify(model.requests[3]?.body.messages)).toContain(workId);
  expect(model.requests).toHaveLength(4);
}

async function verifyBackgroundReplay(
  fixture: Fixture,
  host: Host,
  model: Model,
) {
  const { firstMove, firstResult, taskControl } = await moveEmptyTaskRoundTrip(
    fixture,
    host,
  );
  const { childIndex, reader, idle, work } = await startBackgroundTask(
    host,
    model,
  );
  expect(idle.taskControl).toEqual(taskControl);
  // 从此处开始只读取原SSE和模型HTTP请求，不调用会重新登记Actor的快照GET或新命令。
  const replayed = await moveTask(host, firstMove);
  expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
  expect(replayed.body).toEqual(firstResult);
  expect(model.requests).toHaveLength(3);
  expect(model.requests[childIndex]?.closed).toBe(false);
  model.writeText(childIndex, childResult);
  model.finish(childIndex);
  const isAccepted = (snapshot: protocol.ConversationSnapshot) =>
    snapshot.control.phase === "running" &&
    snapshot.rows.window.some(
      (row) => row.kind === "userInput" && row.origin === "backgroundResult",
    );
  let delivered: protocol.ConversationSnapshot | undefined;
  let accepted: protocol.ConversationSnapshot | undefined;
  let latest: protocol.ConversationSnapshot | undefined;
  // 持续消费真实SSE，避免等待模型HTTP时由测试自身堵住完整快照发送。
  const completedRead = reader
    .until((snapshot) => {
      latest = snapshot;
      if (
        snapshot.backgroundWorks.some(
          (entry) =>
            entry.workId === work.workId && entry.status === "resultPending",
        ) ||
        isAccepted(snapshot)
      )
        delivered ??= snapshot;
      if (isAccepted(snapshot)) accepted ??= snapshot;
      return Boolean(
        accepted &&
          snapshot.control.phase === "completedSuccess" &&
          snapshot.backgroundWorks.length === 0,
      );
    })
    .then(
      (snapshot) => ({ snapshot, error: undefined }),
      (error: unknown) => ({ snapshot: undefined, error }),
    );
  await vi.waitFor(
    () => {
      expect(
        model.requests,
        JSON.stringify({
          phase: delivered?.control.phase,
          backgroundWorks: delivered?.backgroundWorks,
          latestControl: latest?.control,
          acceptedControl: accepted?.control,
          latestInputs: latest?.rows.window.flatMap((row) =>
            row.kind === "userInput"
              ? [{ origin: row.origin, text: row.text }]
              : [],
          ),
        }),
      ).toHaveLength(4);
    },
    { timeout: 30_000 },
  ); // 后台结果必须自动接纳下一Run，由真实模型HTTP请求证明。
  expect(JSON.stringify(model.requests[3]?.body.messages)).toContain(
    childResult,
  );
  expect(JSON.stringify(model.requests[3]?.body.messages)).toContain(
    "后台工作已有终态结果",
  );
  await vi.waitFor(() => expect(accepted?.control.phase).toBe("running"));
  if (!accepted) throw new Error("原SSE缺少后台结果的实际接纳状态。");
  expect(accepted.taskControl).toEqual(taskControl);
  expect(accepted.goal).toEqual(idle.goal);
  expect(
    accepted.rows.window.filter(
      (row) => row.kind === "userInput" && row.origin === "backgroundResult",
    ),
  ).toHaveLength(1);
  model.finish(3);
  const completion = await completedRead;
  if (completion.error) throw completion.error;
  const completed = completion.snapshot;
  if (!completed) throw new Error("原SSE缺少后台结果的实际完成状态。");
  expectCompletedContinuation(completed, idle, work.workId, model);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "旧移动回执重放保留后台接纳的真实HTTP、SSE与PostgreSQL integration",
  () => {
    it("Task项目往返后重放旧移动，后台子完成仍自动接纳下一Run且只送达一次", async () => {
      let fixture: Fixture | undefined;
      let host: Host | undefined;
      let model: Model | undefined;
      const failures: unknown[] = [];
      try {
        fixture = await createCodeUiHttpFixture();
        model = await heldModel({
          initialTool: {
            id: "move-replay-background-child",
            name: "Task",
            arguments: {
              subagent_type: "explore",
              description: childDescription,
              ownership: ["."],
              completion_criteria: "返回调研结果",
              run_in_background: true,
            },
          },
        });
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await verifyBackgroundReplay(fixture, host, model);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => host?.dispose(),
          () => fixture?.close(),
          () => model?.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "后台接纳重放验证或资源关闭失败", {
          cause: failures[0],
        });
    }, 120_000); // 独占真实父子模型HTTP、原SSE、PostgreSQL及全部运行关闭的验证期限。
  },
);
