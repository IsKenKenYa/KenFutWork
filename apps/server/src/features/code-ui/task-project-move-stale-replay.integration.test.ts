import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  applicationErrorResponseSchema,
  type CodeTaskProjectMoveInput,
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  projectCreateResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type ConversationSource = Pick<
  Host,
  "stream" | "projectId" | "workspacePath" | "sessionId"
>;

function moveTask(host: Host, input: CodeTaskProjectMoveInput) {
  return host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "moveTask",
    args: [input],
  });
}

async function readState(host: Host) {
  const scope = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  expect(scope.status, JSON.stringify(scope.body)).toBe(200);
  return {
    scope: codeTaskScopeResponseSchema.parse(scope.body).scope,
    snapshot: protocol.conversationSnapshotSchema.parse(await host.snapshot()),
  };
}

async function moveRoundTrip(fixture: Fixture, host: Host) {
  const root = join(fixture.directory, "旧移动重放目标目录");
  await mkdir(root);
  const target = await host.client.request("/api/projects", {
    name: "旧移动重放目标项目",
    kind: "code",
    work_dir: root,
  });
  expect(target.status, JSON.stringify(target.body)).toBe(201);
  const project = projectCreateResponseSchema.parse(target.body).project;
  const initial = await readState(host);
  const initialControl = protocol.conversationTaskControlSchema.parse(
    initial.snapshot.taskControl,
  );
  expect(initial.snapshot.control.phase).toBe("draft");
  expect(initial.snapshot.rows.window).toEqual([]);
  expect(initial.snapshot.goal).toBeNull();
  const firstMove: CodeTaskProjectMoveInput = {
    task: {
      taskId: host.sessionId,
      workspacePath: host.workspacePath,
      workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
    },
    sourceProjectId: host.projectId,
    projectId: project.id,
    observedRevision: initial.snapshot.revision,
    addMissingRoot: true,
  };
  const moved = await moveTask(host, firstMove);
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  expect(moved.body).toEqual({ result: null });
  const atTarget = await readState(host);
  expect(atTarget.scope.projectId).toBe(project.id);
  expect(atTarget.snapshot.taskControl).toEqual({
    projectId: project.id,
    branchGeneration: initialControl.branchGeneration + 1,
  });
  const returned = await moveTask(host, {
    task: {
      taskId: host.sessionId,
      workspacePath: host.workspacePath,
      workspaceIdentity: JSON.stringify([project.id, host.workspacePath]),
    },
    sourceProjectId: project.id,
    projectId: host.projectId,
    observedRevision: atTarget.snapshot.revision,
    addMissingRoot: true,
  });
  expect(returned.status, JSON.stringify(returned.body)).toBe(200);
  expect(returned.body).toEqual({ result: null });
  const beforeReplay = await readState(host);
  expect(beforeReplay.scope).toEqual({
    ...initial.scope,
    generation: initial.scope.generation + 2,
  });
  expect(beforeReplay.snapshot.taskControl).toEqual({
    projectId: host.projectId,
    branchGeneration: initialControl.branchGeneration + 2,
  });
  expect(beforeReplay.snapshot.rows.window).toEqual(
    initial.snapshot.rows.window,
  );
  expect(beforeReplay.snapshot.goal).toEqual(initial.snapshot.goal);
  return { firstMove, beforeReplay, firstResult: moved.body };
}

async function readOwnedSnapshot(
  host: ConversationSource,
  assembler: protocol.TopicWireFrameAssembler<protocol.ConversationTopicFrame>,
  subscriptionId: string,
  deliveryKind: "initial" | "recovery",
) {
  for (;;) {
    const event = await host.stream.next();
    if (event.event !== "onDynamicConversationFrame") continue;
    const wire = protocol.topicWireFrameCandidateSchema.parse(event.frame);
    if (wire.subscriptionId !== subscriptionId) continue;
    expect(wire.topic).toBe(protocol.conversationTopic(host.sessionId));
    expect(event.workspacePath).toBe(host.workspacePath);
    expect(event.workspaceIdentity).toBe(
      JSON.stringify([host.projectId, host.workspacePath]),
    );
    for (const result of assembler.accept(wire)) {
      if (result.kind === "fault")
        throw new Error(`会话订阅帧无法解析：${result.fault.reasonCode}`);
      if (result.deliveryKind !== deliveryKind) continue;
      if (result.frame.payload.kind !== "snapshot")
        throw new Error("原会话订阅没有返回完整快照。");
      return result.frame.payload.snapshot;
    }
  }
}

async function initializeObserver(
  fixture: Fixture,
  host: Host,
): Promise<ConversationSource> {
  const stream = await fixture.client.openCodeStream();
  const response = await stream.rpc("initializeConversationV4", [
    {
      kind: "clientHello",
      protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
      clientId: randomUUID(),
      appVersion: "task-project-move-stale-replay-integration",
      clientKind: "web",
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(stream.ready.hello.connectionId).not.toBe(
    host.stream.ready.hello.connectionId,
  );
  return {
    stream,
    projectId: host.projectId,
    workspacePath: host.workspacePath,
    sessionId: host.sessionId,
  };
}

async function subscribeOwnedSnapshot(
  host: ConversationSource,
  expected: protocol.ConversationSnapshot,
) {
  const assembler = new protocol.TopicWireFrameAssembler(
    protocol.conversationTopicFrameSchema,
  );
  const subscribed = await host.stream.rpc("subscribeConversationV4", [
    {
      workspacePath: host.workspacePath,
      workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
      projectId: host.projectId,
      sessionId: host.sessionId,
    },
  ]);
  expect(subscribed.status, JSON.stringify(subscribed.body)).toBe(200);
  const { ack } = protocol.v4ConversationSubscribeResultSchema.parse(
    subscribed.body.result,
  );
  expect(ack.mode).toBe("snapshot");
  expect(
    await readOwnedSnapshot(host, assembler, ack.subscriptionId, "initial"),
  ).toEqual(expected);
  return { ack, assembler };
}

function resyncOwnedSnapshot(host: ConversationSource, subscriptionId: string) {
  return host.stream.rpc("resyncConversationV4", [
    protocol.conversationResyncParamsSchema.parse({
      subscriptionId,
      base: null,
      forceSnapshot: true,
    }),
  ]);
}

async function expectRetiredLease(
  fixture: Fixture,
  host: ConversationSource,
  subscriptionId: string,
) {
  const resynced = await resyncOwnedSnapshot(host, subscriptionId);
  expect(resynced.status, JSON.stringify(resynced.body)).toBe(404);
  expect(applicationErrorResponseSchema.parse(resynced.body).error.code).toBe(
    "code_ui_not_found",
  );
  const projects = await fixture.client.request("/api/code-ui/rpc", {
    connectionId: host.stream.ready.hello.connectionId,
    service: "project",
    method: "readTree",
    args: [{ hostId: "local" }],
  });
  expect(projects.status, JSON.stringify(projects.body)).toBe(200);
  expect(
    codeProjectTreeSchema
      .parse(projects.body.result)
      .projects.find((project) => project.id === host.projectId),
  ).toMatchObject({ id: host.projectId });
}

async function verifyStaleReplay(fixture: Fixture, host: Host, model: Model) {
  const observer = await initializeObserver(fixture, host);
  const beforeMove = await readState(host);
  const oldLease = await subscribeOwnedSnapshot(observer, beforeMove.snapshot);
  const { firstMove, beforeReplay, firstResult } = await moveRoundTrip(
    fixture,
    host,
  );
  await expectRetiredLease(fixture, observer, oldLease.ack.subscriptionId);
  const { ack, assembler } = await subscribeOwnedSnapshot(
    host,
    beforeReplay.snapshot,
  );
  expect(model.requests).toEqual([]);
  for (let replay = 0; replay < 2; replay += 1) {
    const replayed = await moveTask(host, firstMove);
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
    expect(replayed.body).toEqual(firstResult);
    expect(await readState(host)).toEqual(beforeReplay);
    const resynced = await resyncOwnedSnapshot(host, ack.subscriptionId);
    expect(resynced.status, JSON.stringify(resynced.body)).toBe(200);
    const recovered = protocol.v4ConversationResyncResultSchema.parse(
      resynced.body.result,
    );
    expect(recovered.ack).toEqual({
      subscriptionId: ack.subscriptionId,
      mode: "snapshot",
      logEpoch: beforeReplay.snapshot.logEpoch,
    });
    const current = await readOwnedSnapshot(
      host,
      assembler,
      ack.subscriptionId,
      "recovery",
    );
    expect(current).toEqual(beforeReplay.snapshot);
    expect(current.goal).toEqual(beforeReplay.snapshot.goal);
    expect(current.control.phase).toBe("draft");
    expect(current.control.activeWorks).toEqual([]);
    await expectRetiredLease(fixture, observer, oldLease.ack.subscriptionId);
    expect(await readState(host)).toEqual(beforeReplay);
    expect(model.requests).toEqual([]);
  }
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "旧移动回执重放保留当前会话订阅的真实HTTP、SSE与PostgreSQL integration",
  () => {
    it("Task项目往返后反复重放最初移动，新A订阅保持且旧A订阅仍被退订", async () => {
      let fixture: Fixture | undefined;
      let host: Host | undefined;
      let model: Model | undefined;
      const failures: unknown[] = [];
      try {
        fixture = await createCodeUiHttpFixture();
        model = await heldModel();
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await verifyStaleReplay(fixture, host, model);
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
        throw new AggregateError(failures, "旧移动重放验证或资源关闭失败", {
          cause: failures[0],
        });
    }, 60_000); // 独占真实HTTP、SSE、PostgreSQL及受控模型配置服务的验证期限。
  },
);
