import { randomUUID } from "node:crypto";
import type { StreamEvent } from "@kenfutwork/shared";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { MessagesDeltaValue, StateSchema } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import type { AgentContextHistory } from "../../agent/context-history.js";
import { createKenFutWorkDeepAgent } from "../../agent/deep-agent.js";
import { createNativeContextBranchService } from "../../agent/native-context-branch.js";
import { encodeNativeContextReference } from "../../agent/native-context-reference.js";
import { createAgentPersistenceService } from "../../agent/persistence/index.js";
import type { createTaskWorkManager } from "../task-work/service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { BoundaryModel, createHarness } from "./test-harness.js";

class HistoryMapModel extends BoundaryModel {
  async _generate(messages: BaseMessage[]) {
    this.requests.push(messages);
    const message =
      this.requests.length === 1
        ? new AIMessage({
            content: "保留真实工具关联",
            tool_calls: [
              {
                id: "history-map-todo-call",
                name: "write_todos",
                args: {
                  todos: [{ content: "映射后的独立待办", status: "completed" }],
                },
              },
            ],
          })
        : new AIMessage("完成");
    return { generations: [{ text: String(message.content), message }] };
  }
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function runInput(f: Harness, threadId: string, prompt: string) {
  const runId = randomUUID();
  await f.service.createAcceptedRun({
    runId,
    sessionId: f.scope.taskId,
    threadId,
  });
  f.runtime.createRun(
    {
      sessionId: f.scope.taskId,
      conversationId: f.scope.taskId,
      taskId: f.scope.taskId,
      projectId: f.scope.projectId,
      preset: "code",
      prompt,
    },
    {
      runId,
      threadId,
      scopeHandle: f.handle,
      actor: f.actor,
      inputIdentity: {
        clientId: "context-history-map-client",
        sourceCommandId: runId,
      },
      inputOrigin: "userInput",
    },
  );
  const events: StreamEvent[] = [];
  for await (const event of f.runtime.streamRun(runId)) events.push(event);
  expect(events.at(-1)?.type).toBe("run.completed");
  return f.metadata().getOwnedTurnBoundaries(f.actor, {
    taskId: f.scope.taskId,
    runId,
  });
}

/** 真实PG、Harness、Delta和原工具；只控制外部模型响应，不解析产品opaque key。 */
describe.skipIf(process.env.KENFUTWORK_HARNESS_TEST_PG !== "1")(
  "原生上下文历史边界映射 integration",
  () => {
    it("一次克隆将全部可信边界归属子thread，源删除后仍能独立读并再次分叉", async () => {
      const database = await createTaskWorkDatabase();
      const persistence = createAgentPersistenceService({
        databaseUrl: database.connectionString,
      });
      const provider = createNativeContextBranchService({
        agentPersistenceService: persistence,
      });
      let work: ReturnType<typeof createTaskWorkManager> | undefined;
      try {
        let history: AgentContextHistory | undefined;
        const model = new HistoryMapModel();
        const f = await createHarness(database, model, undefined, true, {
          agentPersistenceService: persistence,
          contextBranchProvider: provider,
          agentFactory: (options) => {
            const agent = createKenFutWorkDeepAgent({
              ...options,
              runExtensions: [
                ...(options.runExtensions ?? []),
                {
                  preset: "code",
                  createMiddleware: () => ({
                    name: "delta-history-map-test",
                    stateSchema: new StateSchema({
                      messages: MessagesDeltaValue,
                    }),
                  }),
                },
              ],
            });
            history = agent.contextHistory;
            return agent;
          },
        });
        work = f.work;
        const first = await runInput(f, f.threadId, "第一轮保留");
        const second = await runInput(f, f.threadId, "第二轮保留");
        await runInput(f, f.threadId, "后续轮不得泄漏");
        const firstPre = first.pre?.context;
        const firstPost = first.post?.context;
        const secondPre = second.pre?.context;
        const secondPost = second.post?.context;
        if (
          firstPre?.status !== "captured" ||
          firstPost?.status !== "captured" ||
          !firstPost.reference ||
          secondPre?.status !== "captured" ||
          !secondPre.reference ||
          secondPost?.status !== "captured" ||
          !secondPost.reference ||
          !history
        )
          throw new Error("真实Run边界与native历史未完整捕获");
        expect(firstPre.reference).toBe(null);
        const boundaries = [
          { id: "first/pre", reference: firstPre.reference },
          { id: "first/post", reference: firstPost.reference },
          { id: "second/pre", reference: secondPre.reference },
          { id: "second/post", reference: secondPost.reference },
        ];
        const targetThreadId = `mapped-child-${randomUUID()}`;
        if (!provider.cloneHistory)
          throw new Error("原生provider未提供上下文历史边界映射能力");
        const copied = await provider.cloneHistory({
          sourceThreadId: f.threadId,
          targetThreadId,
          reference: secondPost.reference,
          boundaries,
        });
        expect(copied.boundaries.map((boundary) => boundary.id)).toEqual([
          "first/pre",
          "first/post",
          "second/pre",
          "second/post",
        ]);
        expect(copied.boundaries[0]?.reference).toBe(null);
        expect(copied.boundaries[3]?.reference).toEqual(copied.reference);
        provider.release({ targetThreadId, reference: copied.reference });
        const native = await persistence.getPersistence();
        if (!native) throw new Error("真实原生持久化未装配");
        await native.checkpointer.deleteThread(f.threadId);
        const context = history;
        const readBoundary = async (index: number) => {
          const reference = copied.boundaries[index]?.reference;
          if (!reference) throw new Error("目标非空边界引用未返回");
          return (await context.getEffectiveState(reference)).messages;
        };
        const firstMessages = await readBoundary(1);
        expect(
          firstMessages
            .filter((message) => message.type === "human")
            .map((message) => message.content),
        ).toEqual(["第一轮保留"]);
        expect(
          firstMessages.find((message) => message.type === "tool")?.content,
        ).toContain("映射后的独立待办");
        expect(await readBoundary(2)).toEqual(firstMessages);
        expect(
          (await readBoundary(3))
            .filter((message) => message.type === "human")
            .map((message) => message.content),
        ).toEqual(["第一轮保留", "第二轮保留"]);
        const grandchildThreadId = `mapped-grandchild-${randomUUID()}`;
        const grandchild = await provider.cloneHistory({
          sourceThreadId: targetThreadId,
          targetThreadId: grandchildThreadId,
          reference: copied.reference,
          boundaries: copied.boundaries,
        });
        provider.release({
          targetThreadId: grandchildThreadId,
          reference: grandchild.reference,
        });
        await native.checkpointer.deleteThread(targetThreadId);
        const grandchildFirstPost = grandchild.boundaries[1]?.reference;
        if (!grandchildFirstPost) throw new Error("孙thread历史边界未返回");
        expect(
          (await context.getEffectiveState(grandchildFirstPost)).messages,
        ).toEqual(firstMessages);
        await runInput(f, grandchildThreadId, "孙分支继续");
        const grandchildInput = model.requests.at(-1) ?? [];
        expect(
          grandchildInput
            .filter(HumanMessage.isInstance)
            .map((message) => message.content),
        ).toEqual(["第一轮保留", "第二轮保留", "孙分支继续"]);
        expect(
          grandchildInput
            .filter(AIMessage.isInstance)
            .flatMap((message) => message.tool_calls ?? []),
        ).toContainEqual(
          expect.objectContaining({
            id: "history-map-todo-call",
            name: "write_todos",
            args: {
              todos: [{ content: "映射后的独立待办", status: "completed" }],
            },
          }),
        );
        expect(
          grandchildInput
            .filter(ToolMessage.isInstance)
            .find((message) => message.tool_call_id === "history-map-todo-call")
            ?.content,
        ).toContain("映射后的独立待办");
      } finally {
        await work?.close("test cleanup");
        await persistence.dispose();
        await database.close();
      }
    });
    it("越过leaf、跨thread或namespace、重复或空id及空leaf混非空边界均在写目标前拒绝，纠正后租约可重用", async () => {
      const database = await createTaskWorkDatabase();
      const persistence = createAgentPersistenceService({
        databaseUrl: database.connectionString,
      });
      const provider = createNativeContextBranchService({
        agentPersistenceService: persistence,
      });
      let work: ReturnType<typeof createTaskWorkManager> | undefined;
      try {
        const f = await createHarness(database, undefined, undefined, true, {
          agentPersistenceService: persistence,
          contextBranchProvider: provider,
        });
        work = f.work;
        const first = (await runInput(f, f.threadId, "所选历史")).post?.context;
        const later = (await runInput(f, f.threadId, "所选leaf之后")).post
          ?.context;
        if (
          first?.status !== "captured" ||
          !first.reference ||
          later?.status !== "captured" ||
          !later.reference ||
          !provider.cloneHistory
        )
          throw new Error("实际历史边界或原生映射能力未装配");
        const native = await persistence.getPersistence();
        if (!native) throw new Error("实际原生持久化未装配");
        const source = await native.checkpointer.getTuple({
          configurable: { thread_id: f.threadId, checkpoint_ns: "" },
        });
        if (!source) throw new Error("实际源checkpoint未捕获");
        const invalidNamespace = encodeNativeContextReference(f.threadId, {
          configurable: {
            ...source.config.configurable,
            checkpoint_ns: "foreign-namespace",
          },
        });
        const foreignThreadId = `map-validation-foreign-${randomUUID()}`;
        const foreign = await provider.clone({
          sourceThreadId: f.threadId,
          targetThreadId: foreignThreadId,
          reference: first.reference,
        });
        if (!foreign || !invalidNamespace)
          throw new Error("真实跨thread与namespace引用未建立");
        provider.release({
          targetThreadId: foreignThreadId,
          reference: foreign,
        });
        const targetThreadId = `map-validation-target-${randomUUID()}`;
        const input = {
          sourceThreadId: f.threadId,
          targetThreadId,
          reference: first.reference,
        };
        const invalid = [
          {
            boundaries: [{ id: "later/post", reference: later.reference }],
            reason: "祖先链",
          },
          {
            boundaries: [{ id: "foreign/post", reference: foreign }],
            reason: "源thread",
          },
          {
            boundaries: [{ id: "namespace/post", reference: invalidNamespace }],
            reason: "root namespace",
          },
          {
            boundaries: [
              { id: "same-id", reference: null },
              { id: "same-id", reference: first.reference },
            ],
            reason: "id不能重复",
          },
          {
            boundaries: [{ id: "", reference: first.reference }],
            reason: "id不能为空",
          },
          {
            boundaries: [{ id: " \t ", reference: first.reference }],
            reason: "id不能为空",
          },
        ];
        for (const scenario of invalid) {
          await expect(
            provider.cloneHistory({
              ...input,
              boundaries: scenario.boundaries,
            }),
          ).rejects.toThrow(scenario.reason);
          expect(
            await native.checkpointer.getTuple({
              configurable: { thread_id: targetThreadId, checkpoint_ns: "" },
            }),
          ).toBeUndefined();
        }
        await expect(
          provider.cloneHistory({
            ...input,
            reference: null,
            boundaries: [{ id: "first/post", reference: first.reference }],
          }),
        ).rejects.toThrow("祖先链");
        expect(
          await native.checkpointer.getTuple({
            configurable: { thread_id: targetThreadId, checkpoint_ns: "" },
          }),
        ).toBeUndefined();
        const corrected = {
          ...input,
          boundaries: [
            { id: "first/pre", reference: null },
            { id: "first/post", reference: first.reference },
          ],
        };
        const copy = await provider.cloneHistory(corrected);
        expect(copy.boundaries[0]?.reference).toBe(null);
        expect(copy.boundaries[1]?.reference).toEqual(copy.reference);
        await provider.discard({ targetThreadId, reference: copy.reference });
        const replacement = await provider.cloneHistory(corrected);
        provider.release({ targetThreadId, reference: replacement.reference });
        await expect(
          provider.discard({
            targetThreadId,
            reference: replacement.reference,
          }),
        ).rejects.toThrow("尚未发布");
        expect(
          await native.checkpointer.getTuple({
            configurable: { thread_id: targetThreadId, checkpoint_ns: "" },
          }),
        ).toMatchObject({ checkpoint: { id: expect.any(String) } });
      } finally {
        await work?.close("test cleanup");
        await persistence.dispose();
        await database.close();
      }
    });
  },
);
