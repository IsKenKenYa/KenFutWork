import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import {
  type modelRequestSchema,
  optionPreview,
  questions,
  questionText,
  selectedOption,
  toolCallId,
  userQuestionModel,
} from "./user-question-model.fixture.js";

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
type Session = Awaited<ReturnType<typeof createCodeSessionFixture>>;

async function waitForQuestion(host: Session) {
  // 独占集成测试同步期限，非Agent运行时限额。
  return vi.waitFor(
    async () => {
      const snapshot = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      const pending = snapshot.pendingInteractions.find(
        (interaction) =>
          interaction.kind === "userInput" &&
          interaction.payload.kind === "userInput" &&
          interaction.payload.toolCallId === toolCallId,
      );
      if (!pending || pending.payload.kind !== "userInput")
        throw new Error("公开会话尚未出现原AskUserQuestion结构化问题");
      expect(pending.payload).toMatchObject({
        toolName: "AskUserQuestion",
        toolCallId,
        questions: [
          {
            question: questionText,
            header: "运行内核",
            options: [
              {
                value: selectedOption,
                label: selectedOption,
                description: "共享运行能力，保留独立会话与工具集合。",
                preview: optionPreview,
              },
              {
                value: "分别维护内核",
                label: "分别维护内核",
                description: "两个模式分别维护运行能力。",
              },
            ],
          },
        ],
      });
      return pending;
    },
    { timeout: 30_000 },
  );
}

function assertAnsweredToolCall(
  request: z.infer<typeof modelRequestSchema> | undefined,
  expected: {
    answers: Record<string, string>;
    annotations: Record<string, { preview: string; notes: string }>;
  },
) {
  const originalCall = request?.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.tool_calls ?? [])
    .find((call) => call.id === toolCallId);
  if (!originalCall) throw new Error("下一模型请求丢失原AskUserQuestion调用");
  expect(originalCall.function.name).toBe("AskUserQuestion");
  expect(JSON.parse(originalCall.function.arguments)).toEqual({ questions });
  const toolResult = request?.messages.find(
    (message) => message.role === "tool" && message.tool_call_id === toolCallId,
  );
  if (!toolResult || typeof toolResult.content !== "string")
    throw new Error("下一模型请求未收到原toolCall的实际ToolMessage");
  expect(JSON.parse(toolResult.content)).toEqual({ questions, ...expected });
}

async function waitForCompletion(host: Session) {
  await vi.waitFor(
    async () => {
      const ended = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(ended.pendingInteractions).toEqual([]);
      expect(ended.control).toMatchObject({
        phase: "completedSuccess",
        canStop: false,
      });
      expect(
        ended.rows.window.filter((row) => row.kind === "assistantText"),
      ).toContainEqual(
        expect.objectContaining({ text: "已按你的回答继续处理。" }),
      );
    },
    { timeout: 30_000 },
  );
}

/** 真实HTTP/SSE/PG与原公开命令；只替换外部模型网络边界。 */
describe.skipIf(!enabled)("原结构化提问公开宿主 integration", () => {
  it("同实例的另一Task不能回答原问题，拒绝后原调用仍等待所属Task的真实答案", async () => {
    const model = await userQuestionModel();
    let fixture:
      | Awaited<ReturnType<typeof createCodeUiHttpFixture>>
      | undefined;
    let owner: Session | undefined;
    try {
      fixture = await createCodeUiHttpFixture();
      owner = await createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
      });
      const initial = protocol.conversationSnapshotSchema.parse(
        await owner.snapshot(),
      );
      const created = await owner.stream.rpc("sendConversationCommandV4", [
        {
          workspacePath: owner.workspacePath,
          projectId: owner.projectId,
          envelope: {
            commandId: randomUUID(),
            clientId: owner.clientId,
            sessionId: null,
            type: "createSession",
            issuedAt: Date.now(),
            payload: {
              workspaceId: owner.projectId,
              config: { modelSelection: initial.config.modelSelection },
            },
          },
        },
      ]);
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const ack = protocol.commandAckSchema.parse(created.body.result);
      if (ack.status !== "accepted" || ack.result?.type !== "createSession")
        throw new Error("公开命令未创建同项目第二个Task");
      const foreignSessionId = ack.result.sessionId;
      const sent = await owner.command("sendText", {
        text: "请先用结构化问题确认运行方式。",
      });
      expect(sent.body.result.status).toBe("accepted");
      const pending = await waitForQuestion(owner);
      const answers = { [questionText]: selectedOption };
      const payload = {
        interactionId: pending.interactionId,
        answer: {
          action: "accept" as const,
          content: { answers, annotations: {} },
        },
      };
      const rejected = await owner.stream.rpc("sendConversationCommandV4", [
        {
          workspacePath: owner.workspacePath,
          projectId: owner.projectId,
          envelope: {
            commandId: randomUUID(),
            clientId: owner.clientId,
            sessionId: foreignSessionId,
            type: "resolveInteraction",
            payload,
            issuedAt: Date.now(),
          },
        },
      ]);
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
      expect(rejected.body.result).toMatchObject({
        status: "rejected",
        reasonCode: "not_found",
      });
      const unchanged = protocol.conversationSnapshotSchema.parse(
        await owner.snapshot(),
      );
      expect(unchanged.pendingInteractions).toEqual([pending]);
      expect(model.requests).toHaveLength(1);
      const resolved = await owner.command("resolveInteraction", payload);
      expect(resolved.body.result.status).toBe("accepted");
      await waitForCompletion(owner);
      expect(model.requests).toHaveLength(2);
      assertAnsweredToolCall(model.requests[1], { answers, annotations: {} });
    } finally {
      try {
        if (owner) await owner.command("stop", {});
      } finally {
        await model.close();
        await owner?.dispose();
        await fixture?.close();
      }
    }
  }, 90_000); // 独占HTTP/数据库的测试期限，非运行时治理值。
  it("原sendText触发AskUserQuestion，刷新读取问题并经resolveInteraction把答案送回同一toolCall后完成", async () => {
    const model = await userQuestionModel();
    let fixture:
      | Awaited<ReturnType<typeof createCodeUiHttpFixture>>
      | undefined;
    let host: Session | undefined;
    try {
      fixture = await createCodeUiHttpFixture();
      host = await createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
      });
      const sent = await host.command("sendText", {
        text: "请先用结构化问题确认运行内核的共享方式，再根据答案继续。",
      });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      expect(sent.body.result.status).toBe("accepted");
      await vi.waitFor(
        () => expect(model.requests.length).toBeGreaterThanOrEqual(1),
        { timeout: 30_000 },
      );
      expect(
        model.requests[0]?.tools?.map((tool) => tool.function.name),
      ).toContain("AskUserQuestion");
      const pending = await waitForQuestion(host);
      // 刷新走真实GET，而非仅以事件或本地对象证明投影已持久可重读。
      const refreshed = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(
        refreshed.pendingInteractions.find(
          (interaction) => interaction.interactionId === pending.interactionId,
        ),
      ).toEqual(pending);
      expect(model.requests).toHaveLength(1);
      const answers = { [questionText]: selectedOption };
      const annotations = {
        [questionText]: {
          preview: optionPreview,
          notes: "Code会话与Design会话保持独立。",
        },
      };
      const resolved = await host.command("resolveInteraction", {
        interactionId: pending.interactionId,
        answer: {
          action: "accept",
          content: {
            answers,
            annotations,
            // 原ElicitationDialog单题提交携带这两个兼容字段。
            answer_0: selectedOption,
            answer: selectedOption,
          },
        },
      });
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
      expect(resolved.body.result.status).toBe("accepted");
      await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
        timeout: 30_000,
      });
      assertAnsweredToolCall(model.requests[1], {
        answers,
        annotations,
      });
      await waitForCompletion(host);
      expect(model.requests).toHaveLength(2);
    } finally {
      try {
        if (host) await host.command("stop", {});
      } finally {
        await model.close();
        await host?.dispose();
        await fixture?.close();
      }
    }
  }, 90_000); // 独占数据库和模型网络的测试期限，非运行时治理值。
});
