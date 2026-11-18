import { randomUUID } from "node:crypto";
import type { StreamEvent } from "@kenfutwork/shared";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { MessagesDeltaValue, StateSchema } from "@langchain/langgraph";
import type { createDeepAgent } from "deepagents";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKenFutWorkDeepAgent } from "../../agent/deep-agent.js";
import { encodeNativeContextReference } from "../../agent/native-context-reference.js";
import { createAgentPersistenceService } from "../../agent/persistence/index.js";
import type { createTaskWorkManager } from "../task-work/service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { BoundaryModel, createHarness } from "./test-harness.js";

class ToolHistoryModel extends BoundaryModel {
  async _generate(messages: BaseMessage[]) {
    this.requests.push(messages);
    const message =
      this.requests.length === 1
        ? new AIMessage({
            content: "记录原轮待办",
            tool_calls: [
              {
                id: "original-todo-call",
                name: "write_todos",
                args: {
                  todos: [{ content: "保留原工具状态", status: "completed" }],
                },
              },
            ],
          })
        : new AIMessage("完成");
    return {
      generations: [{ text: String(message.content), message }],
    };
  }
}

type Harness = Awaited<ReturnType<typeof createHarness>>;
type NativeGraph = ReturnType<typeof createDeepAgent>["graph"];

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
        clientId: "context-branch-client",
        sourceCommandId: runId,
      },
      inputOrigin: "userInput",
    },
  );
  const events: StreamEvent[] = [];
  for await (const event of f.runtime.streamRun(runId)) events.push(event);
  expect(events.at(-1)?.type).toBe("run.completed");
  return runId;
}

async function createBranchFixture() {
  const database = await createTaskWorkDatabase();
  const persistence = createAgentPersistenceService({
    databaseUrl: database.connectionString,
  });
  let work: ReturnType<typeof createTaskWorkManager> | undefined;
  const close = async () => {
    await work?.close("test cleanup");
    await persistence.dispose();
    await database.close();
  };
  try {
    let graph: NativeGraph | undefined;
    const f = await createHarness(database, undefined, undefined, true, {
      agentPersistenceService: persistence,
      agentFactory: (options) => {
        const agent = createKenFutWorkDeepAgent(options);
        graph = (agent as ReturnType<typeof createDeepAgent>).graph;
        return agent;
      },
    });
    work = f.work;
    await runInput(f, f.threadId, "保留的原输入");
    const editedRunId = await runInput(f, f.threadId, "待替换输入");
    const boundary = await f.metadata().getOwnedTurnBoundaries(f.actor, {
      taskId: f.scope.taskId,
      runId: editedRunId,
    });
    const context = boundary.pre?.context;
    if (context?.status !== "captured" || !context.reference || !graph)
      throw new Error("真实owned pre或native图未捕获");
    const nativeGraph = graph;
    const native = await persistence.getPersistence();
    if (!native) throw new Error("真实native持久化未装配");
    const source = await nativeGraph.getState({
      configurable: { thread_id: f.threadId },
    });
    return {
      ...f,
      database,
      graph: nativeGraph,
      source,
      checkpointer: native.checkpointer,
      reference: context.reference,
      close,
      assertSourceUnchanged: async () => {
        expect(
          (
            await nativeGraph.getState({
              configurable: { thread_id: f.threadId },
            })
          ).values,
        ).toEqual(source.values);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** 真实临时Postgres/native图；只有外部模型响应由确定性模型控制。 */
describe.skipIf(process.env.KENFUTWORK_HARNESS_TEST_PG !== "1")(
  "Harness原生上下文分支 integration",
  () => {
    it.each(["默认消息通道", "Delta消息通道"])(
      "%s：owned pre分支保留完整工具关联、排除被编辑轮且不改源thread",
      async (channel) => {
        const database = await createTaskWorkDatabase();
        const persistence = createAgentPersistenceService({
          databaseUrl: database.connectionString,
        });
        let work: ReturnType<typeof createTaskWorkManager> | undefined;
        try {
          const model = new ToolHistoryModel();
          let nativeGraph: NativeGraph | undefined;
          const f = await createHarness(database, model, undefined, true, {
            agentPersistenceService: persistence,
            ...(channel === "Delta消息通道"
              ? {
                  agentFactory: (options) => {
                    const agent = createKenFutWorkDeepAgent({
                      ...options,
                      runExtensions: [
                        ...(options.runExtensions ?? []),
                        {
                          preset: "code",
                          createMiddleware: () => ({
                            name: "delta-history-test",
                            stateSchema: new StateSchema({
                              messages: MessagesDeltaValue,
                            }),
                          }),
                        },
                      ],
                    });
                    // 产品接口收窄了graph；此处仅读取实际SDK实例的公开状态入口。
                    nativeGraph = (agent as ReturnType<typeof createDeepAgent>)
                      .graph;
                    return agent;
                  },
                }
              : {}),
          });
          work = f.work;
          const run = (threadId: string, prompt: string) =>
            runInput(f, threadId, prompt);

          await run(f.threadId, "保留的原输入");
          const editedRunId = await run(f.threadId, "待替换输入");
          const boundary = await f.metadata().getOwnedTurnBoundaries(f.actor, {
            taskId: f.scope.taskId,
            runId: editedRunId,
          });
          const context = boundary.pre?.context;
          if (context?.status !== "captured" || !context.reference)
            throw new Error("真实owned pre上下文未捕获");
          const reference = context.reference;
          const targetThreadId = `branch-${randomUUID()}`;
          expect(f.runtime.canCloneContextBranches()).toBe(true);
          const branch = await f.runtime.cloneContextBranch({
            sourceThreadId: f.threadId,
            targetThreadId,
            reference,
          });
          expect(branch).toMatchObject({
            adapter: "deepagents",
            key: expect.any(String),
          });
          if (channel === "Delta消息通道") {
            if (!nativeGraph) throw new Error("真实Delta Agent图未装配");
            const beforeInput = await nativeGraph.getState({
              configurable: { thread_id: targetThreadId },
            });
            expect(
              ((beforeInput.values.messages ?? []) as BaseMessage[])
                .filter(HumanMessage.isInstance)
                .map((message) => message.content),
            ).toEqual(["保留的原输入"]);
          }
          f.runtime.releaseContextBranch({ targetThreadId, reference: branch });

          await run(targetThreadId, "分支后继续");
          const branchInput = model.requests.at(-1) ?? [];
          const originalCall = branchInput
            .filter(AIMessage.isInstance)
            .flatMap((message) => message.tool_calls ?? [])
            .find((call) => call.id === "original-todo-call");
          expect(originalCall).toMatchObject({
            id: "original-todo-call",
            name: "write_todos",
            args: {
              todos: [{ content: "保留原工具状态", status: "completed" }],
            },
          });
          expect(
            branchInput
              .filter(ToolMessage.isInstance)
              .find((message) => message.tool_call_id === "original-todo-call")
              ?.content,
          ).toContain("保留原工具状态");
          const branchHumans = branchInput
            .filter(HumanMessage.isInstance)
            .map((message) => message.content);
          expect(branchHumans).toEqual(["保留的原输入", "分支后继续"]);

          await run(f.threadId, "源分支继续");
          expect(
            model.requests
              .at(-1)
              ?.filter(HumanMessage.isInstance)
              .map((message) => message.content),
          ).toEqual(["保留的原输入", "待替换输入", "源分支继续"]);
          expect(
            (
              await f.metadata().getOwnedTurnBoundaries(f.actor, {
                taskId: f.scope.taskId,
                runId: editedRunId,
              })
            ).pre?.context,
          ).toEqual({ status: "captured", reference });
        } finally {
          await work?.close("test cleanup");
          await persistence.dispose();
          await database.close();
        }
      },
    );
    describe("分支校验与发布生命周期", () => {
      let f: Awaited<ReturnType<typeof createBranchFixture>>;
      beforeAll(async () => {
        f = await createBranchFixture();
      });
      afterAll(async () => {
        await f?.close();
      });

      it("跨thread、缺失checkpoint、adapter和namespace错误及已占用namespace均拒绝且保留原状态", async () => {
        const targetThreadId = `invalid-target-${randomUUID()}`;
        const clone = (reference = f.reference, sourceThreadId = f.threadId) =>
          f.runtime.cloneContextBranch({
            sourceThreadId,
            targetThreadId,
            reference,
          });
        await expect(
          clone({ adapter: "unsupported", key: "opaque" }),
        ).rejects.toThrow("adapter");
        await expect(
          clone(f.reference, `other-${randomUUID()}`),
        ).rejects.toThrow("源thread");
        const invalidNamespace = encodeNativeContextReference(f.threadId, {
          configurable: {
            ...f.source.config.configurable,
            checkpoint_ns: "child",
          },
        });
        const missingCheckpoint = encodeNativeContextReference(f.threadId, {
          configurable: {
            thread_id: f.threadId,
            checkpoint_ns: "",
            checkpoint_id: randomUUID(),
          },
        });
        if (!invalidNamespace || !missingCheckpoint)
          throw new Error("无效引用fixture未生成");
        await expect(clone(invalidNamespace)).rejects.toThrow("root namespace");
        await expect(clone(missingCheckpoint)).rejects.toThrow("不存在");
        await expect(
          f.runtime.cloneContextBranch({
            sourceThreadId: f.threadId,
            targetThreadId: f.threadId,
            reference: f.reference,
          }),
        ).rejects.toThrow("不能覆盖源thread");

        const nativeSource = await f.checkpointer.getTuple(f.source.config);
        if (!nativeSource?.metadata) throw new Error("源native tuple未持久化");
        const occupied = await f.checkpointer.put(
          {
            configurable: {
              thread_id: targetThreadId,
              checkpoint_ns: "existing-child",
            },
          },
          nativeSource.checkpoint,
          nativeSource.metadata,
          nativeSource.checkpoint.channel_versions,
        );
        const beforeTarget = await f.checkpointer.getTuple(occupied);
        await expect(clone()).rejects.toThrow("目标thread已存在");
        await expect(
          f.runtime.discardContextBranch({
            targetThreadId,
            reference: f.reference,
          }),
        ).rejects.toThrow("尚未发布");
        expect(await f.checkpointer.getTuple(occupied)).toEqual(beforeTarget);
        await f.assertSourceUnchanged();
      });

      it("同target并发只创建一次，discard只清未发布分支，release撤销删除权且null为空上下文", async () => {
        const targetThreadId = `lease-target-${randomUUID()}`;
        const clone = () =>
          f.runtime.cloneContextBranch({
            sourceThreadId: f.threadId,
            targetThreadId,
            reference: f.reference,
          });
        const outcomes = await Promise.allSettled([clone(), clone()]);
        expect(
          outcomes.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
          outcomes.filter((result) => result.status === "rejected"),
        ).toHaveLength(1);
        const created = outcomes.find(
          (result) => result.status === "fulfilled",
        );
        if (created?.status !== "fulfilled" || !created.value)
          throw new Error("并发克隆未创建实际分支");
        const reference = created.value;
        await expect(
          f.runtime.discardContextBranch({
            targetThreadId,
            reference: f.reference,
          }),
        ).rejects.toThrow("尚未发布");
        const beforeDiscard = await f.graph.getState({
          configurable: { thread_id: targetThreadId },
        });
        expect(
          ((beforeDiscard.values.messages ?? []) as BaseMessage[])
            .filter(HumanMessage.isInstance)
            .map((message) => message.content),
        ).toEqual(["保留的原输入"]);
        await f.runtime.discardContextBranch({ targetThreadId, reference });
        const afterDiscard = await f.graph.getState({
          configurable: { thread_id: targetThreadId },
        });
        expect(afterDiscard.values.messages ?? []).toEqual([]);
        const replacement = await clone();
        if (!replacement) throw new Error("丢弃后未创建实际分支");
        f.runtime.releaseContextBranch({
          targetThreadId,
          reference: replacement,
        });
        await expect(
          f.runtime.discardContextBranch({
            targetThreadId,
            reference: replacement,
          }),
        ).rejects.toThrow("尚未发布");
        await expect(clone()).rejects.toThrow("已存在");

        const emptyThreadId = `empty-target-${randomUUID()}`;
        const empty = await f.runtime.cloneContextBranch({
          sourceThreadId: f.threadId,
          targetThreadId: emptyThreadId,
          reference: null,
        });
        expect(empty).toBe(null);
        const emptyState = await f.graph.getState({
          configurable: { thread_id: emptyThreadId },
        });
        expect(emptyState.values.messages ?? []).toEqual([]);
        await f.runtime.discardContextBranch({
          targetThreadId: emptyThreadId,
          reference: null,
        });
        expect(
          await f.runtime.cloneContextBranch({
            sourceThreadId: f.threadId,
            targetThreadId: emptyThreadId,
            reference: null,
          }),
        ).toBe(null);
        f.runtime.releaseContextBranch({
          targetThreadId: emptyThreadId,
          reference: null,
        });
        await expect(
          f.runtime.discardContextBranch({
            targetThreadId: emptyThreadId,
            reference: null,
          }),
        ).rejects.toThrow("尚未发布");
        await f.assertSourceUnchanged();
      });

      it("真实Postgres put在已写祖先后失败会清理私有目标，恢复后同target重试保留源上下文", async () => {
        const targetThreadId = `put-failure-${randomUUID()}`;
        const clone = () =>
          f.runtime.cloneContextBranch({
            sourceThreadId: f.threadId,
            targetThreadId,
            reference: f.reference,
          });
        // UUID由本测试生成；隔离集群的外部DB约束允许首个祖先提交，拒绝后续put。
        await f.database.persistence.execute(
          `alter table langgraph.checkpoints add constraint context_branch_put_failure check (thread_id <> '${targetThreadId}' or parent_checkpoint_id is null)`,
        );
        try {
          await expect(clone()).rejects.toMatchObject({
            code: "23514",
            constraint: "context_branch_put_failure",
          });
        } finally {
          await f.database.persistence.execute(
            "alter table langgraph.checkpoints drop constraint context_branch_put_failure",
          );
        }
        const afterFailure = await f.graph.getState({
          configurable: { thread_id: targetThreadId },
        });
        expect(afterFailure.values.messages ?? []).toEqual([]);
        await f.assertSourceUnchanged();
        const reference = await clone();
        if (!reference) throw new Error("数据库恢复后未创建实际分支");
        f.runtime.releaseContextBranch({ targetThreadId, reference });
        await runInput(f, targetThreadId, "故障清理后继续");
        expect(
          f.model.requests
            .at(-1)
            ?.filter(HumanMessage.isInstance)
            .map((message) => message.content),
        ).toEqual(["保留的原输入", "故障清理后继续"]);
        await f.assertSourceUnchanged();
      });
    });
  },
);
