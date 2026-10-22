import { randomUUID } from "node:crypto";
import {
  projectCreateResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { modelSelectionSchema } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import {
  snapshot as readTaskSnapshot,
  waitPhase,
} from "./history-fork.fixture.js";
import { heldModel } from "./model-stream.fixture.js";
import { createCommitResponseLossProxy } from "./pg-commit-response-loss.fixture.mjs";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;

async function prepareFirstInputCreation(fixture: Fixture, baseUrl: string) {
  const stream = await fixture.client.openCodeStream();
  const clientId = randomUUID();
  const initialized = await stream.rpc("initializeConversationV4", [
    {
      kind: "clientHello",
      protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
      clientId,
      appVersion: "first-input-public-integration",
      clientKind: "web",
    },
  ]);
  expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
  const projectResponse = await fixture.client.request("/api/projects", {
    name: "首条输入项目",
    kind: "code",
  });
  expect(projectResponse.status, JSON.stringify(projectResponse.body)).toBe(
    201,
  );
  const { project } = projectCreateResponseSchema.parse(projectResponse.body);
  if (project.kind !== "code") throw new Error("首条输入测试需要 Code 项目。");
  const provider = (method: string, args: unknown[]) =>
    fixture.client.request("/api/code-ui/rpc", {
      connectionId: stream.ready.hello.connectionId,
      service: "providerSettingsService",
      method,
      args,
    });
  const added = await provider("createPersonalProvider", [
    { providerName: "首条输入公开接口" },
  ]);
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  const providerId = z.string().min(1).parse(added.body.result.providerId);
  const saved = await provider("savePersonalProviderOverlay", [
    providerId,
    {
      api: { type: "openai-chat-completions", baseUrl },
      access: { type: "api-key", apiKey: "integration-only-not-a-key" },
    },
  ]);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const model = await provider("addPersonalModel", [
    providerId,
    "stop-model",
    {},
  ]);
  expect(model.status, JSON.stringify(model.body)).toBe(200);
  const view = await fixture.client.request("/api/code-ui/rpc", {
    connectionId: stream.ready.hello.connectionId,
    service: "modelSelectionService",
    method: "getView",
    args: [],
  });
  expect(view.status, JSON.stringify(view.body)).toBe(200);
  const selection = modelSelectionSchema.parse(
    view.body.result.preferredSelection,
  );
  expect(selection).toMatchObject({ providerId, modelId: "stop-model" });
  z.string().min(1).parse(selection.options?.reasoningLevel);
  return { stream, clientId, project, selection };
}

function assertSingleInputTurn(
  snapshot: protocol.ConversationSnapshot,
  text: string,
) {
  expect(
    snapshot.rows.window.filter((row) => row.kind === "userInput"),
  ).toEqual([expect.objectContaining({ text, origin: "realUser" })]);
  expect(
    snapshot.rows.window.filter((row) => row.kind === "turnHeader"),
  ).toHaveLength(1);
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

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Task 首条输入创建公开 RPC integration",
  () => {
    it("创建首条输入的并发与顺序重放只启动唯一运行，冲突和删除后的迟到请求拒绝", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      try {
        const { stream, clientId, project, selection } =
          await prepareFirstInputCreation(fixture, model.baseUrl);
        const text = "CREATE_FIRST_INPUT_MUST_REACH_THE_REAL_MODEL_ONCE";
        const request = {
          workspacePath: project.workDir,
          projectId: project.id,
          envelope: {
            commandId: randomUUID(),
            clientId,
            sessionId: null,
            type: "createSession",
            payload: {
              workspaceId: project.id,
              firstInput: {
                text,
                modelSelection: selection,
                mode: "build",
                planEnabled: true,
              },
            },
            issuedAt: Date.now(),
          },
        };
        const concurrent = await Promise.all([
          stream.rpc("sendConversationCommandV4", [request]),
          stream.rpc("sendConversationCommandV4", [request]),
        ]);
        const replies = concurrent.map((response) => {
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          return protocol.commandAckSchema.parse(response.body.result);
        });
        expect(replies.map((reply) => reply.status).sort()).toEqual([
          "accepted",
          "duplicate",
        ]);
        const ack = replies.find((reply) => reply.status === "accepted");
        if (!ack) throw new Error("并发创建缺少唯一接纳回执。");
        expect(ack.status).toBe("accepted");
        if (ack.result?.type !== "createSession")
          throw new Error("首条输入创建没有返回真实 Task 身份。");
        const taskId = ack.result.sessionId;
        expect(ack.result.input).toEqual({
          delivery: "startNow",
          inputId: request.envelope.commandId,
        });
        const initial = await readTaskSnapshot(fixture, taskId);
        assertSingleInputTurn(initial, text);
        expect(initial.config).toMatchObject({
          mode: "build",
          planEnabled: true,
        });
        await model.firstRequest;
        expect(model.requests).toHaveLength(1);
        expect(JSON.stringify(model.requests[0]?.body.messages)).toContain(
          text,
        );
        const replayed = await stream.rpc("sendConversationCommandV4", [
          request,
        ]);
        expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
        expect(
          protocol.commandAckSchema.parse(replayed.body.result),
        ).toMatchObject({
          commandId: request.envelope.commandId,
          status: "duplicate",
          result: {
            type: "createSession",
            sessionId: taskId,
            input: ack.result.input,
          },
        });
        const afterReplay = await readTaskSnapshot(fixture, taskId);
        assertSingleInputTurn(afterReplay, text);
        expect(afterReplay.config).toMatchObject({
          mode: "build",
          planEnabled: true,
        });
        expect(
          await readProjectTaskIds(stream, project.id, project.workDir),
        ).toEqual([taskId]);
        expect(model.requests).toHaveLength(1);
        const conflict = await stream.rpc("sendConversationCommandV4", [
          {
            ...request,
            envelope: {
              ...request.envelope,
              payload: {
                ...request.envelope.payload,
                firstInput: {
                  ...request.envelope.payload.firstInput,
                  text: "CHANGED_INPUT",
                },
              },
            },
          },
        ]);
        expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
        model.finish(0);
        await waitPhase(fixture, taskId, "completedSuccess");
        const deleted = await fixture.client.request("/api/code-ui/rpc", {
          service: "zcode-task",
          method: "deleteTask",
          args: [
            { taskId, projectId: project.id, workspacePath: project.workDir },
          ],
        });
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        const late = await stream.rpc("sendConversationCommandV4", [request]);
        expect(late.status, JSON.stringify(late.body)).toBe(404);
        expect(
          await readProjectTaskIds(stream, project.id, project.workDir),
        ).toEqual([]);
        expect(model.requests).toHaveLength(1);
      } finally {
        try {
          await fixture.close();
        } finally {
          await model.close();
        }
      }
    });

    it.each([false, true])("首条输入双故障 %s", async (lost) => {
      let proxy:
        | Awaited<ReturnType<typeof createCommitResponseLossProxy>>
        | undefined;
      const fixture = await createCodeUiHttpFixture({
        databaseTransport: async (direct) => {
          proxy = await createCommitResponseLossProxy(direct);
          return proxy;
        },
      });
      const model = await heldModel();
      try {
        const { stream, clientId, project, selection } =
          await prepareFirstInputCreation(fixture, model.baseUrl);
        if (!proxy) throw new Error("首条输入测试没有建立真实 PG 故障代理。");
        const text = "COMMITTED_FIRST_INPUT_MUST_BE_ACCEPTED_AND_RUN_ONLY_ONCE";
        const request = {
          workspacePath: project.workDir,
          projectId: project.id,
          envelope: {
            commandId: randomUUID(),
            clientId,
            sessionId: null,
            type: "createSession",
            payload: {
              workspaceId: project.id,
              firstInput: { text, modelSelection: selection },
            },
            issuedAt: Date.now(),
          },
        };
        proxy.arm(request.envelope.commandId, {
          createFirstInput: true,
          loseCreationReadbackOnce: lost,
        });
        const created = await stream.rpc("sendConversationCommandV4", [
          request,
        ]);
        expect(proxy.evidence()).toMatchObject({
          injected: {
            commitConfirmed: true,
            replySuppressed: true,
            commandId: request.envelope.commandId,
            createFirstInput: true,
          },
        });
        expect(proxy.evidence().observerError).toBeUndefined();
        expect(proxy.evidence().injected?.readbackSuppressed === true).toBe(
          lost,
        );
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const ack = protocol.commandAckSchema.parse(created.body.result);
        expect(ack.status).toBe("accepted");
        if (ack.result?.type !== "createSession")
          throw new Error("提交回包丢失后缺少真实 Task 创建回执。");
        const taskId = ack.result.sessionId;
        expect(taskId).toBe(proxy.evidence().injected?.targetTaskId);
        expect(ack.result.input).toEqual({
          delivery: "startNow",
          inputId: request.envelope.commandId,
        });
        await model.firstRequest;
        expect(model.requests).toHaveLength(1);
        expect(JSON.stringify(model.requests[0]?.body.messages)).toContain(
          text,
        );
        model.finish(0);
        const completed = await waitPhase(fixture, taskId, "completedSuccess");
        assertSingleInputTurn(completed, text);
        expect(
          await readProjectTaskIds(stream, project.id, project.workDir),
        ).toEqual([taskId]);
        const replayed = await stream.rpc("sendConversationCommandV4", [
          request,
        ]);
        expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
        expect(
          protocol.commandAckSchema.parse(replayed.body.result),
        ).toMatchObject({
          commandId: request.envelope.commandId,
          status: "duplicate",
          result: {
            type: "createSession",
            sessionId: taskId,
            input: ack.result.input,
          },
        });
        const afterReplay = await readTaskSnapshot(fixture, taskId);
        assertSingleInputTurn(afterReplay, text);
        expect(afterReplay.control).toEqual(completed.control);
        expect(
          await readProjectTaskIds(stream, project.id, project.workDir),
        ).toEqual([taskId]);
        expect(model.requests).toHaveLength(1);
        expect(proxy.evidence().observerError).toBeUndefined();
      } finally {
        try {
          await fixture.close();
        } finally {
          await model.close();
        }
      }
    });
  },
);
