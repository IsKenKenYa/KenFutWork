import { randomUUID } from "node:crypto";
import type { StreamEvent } from "@kenfutwork/shared";
import { HumanMessage } from "@langchain/core/messages";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createAgentPersistenceService } from "../../agent/persistence/index.js";
import { composePlugins } from "../../kernel/compose.js";
import type { PreStepPayload } from "../../kernel/types.js";
import { createExecutionModeStore } from "../agent-modes/execution-mode-store.js";
import { createAgentModesPlugin } from "../agent-modes/plugin.js";
import { createLocalTrustAuthenticator } from "../auth/local-trust.js";
import { createAccountRepository } from "../auth/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { BoundaryModel, createHarness } from "./test-harness.js";

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function createGuidanceFixture() {
  const database = await createTaskWorkDatabase();
  const persistence = createAgentPersistenceService({
    databaseUrl: database.connectionString,
  });
  const model = new BoundaryModel();
  const observed: PreStepPayload[] = [];
  let work: Harness["work"] | undefined;
  let kernel: ReturnType<typeof composePlugins> | undefined;
  let app: ReturnType<typeof Fastify> | undefined;
  const close = async () => {
    await kernel?.dispose();
    await app?.close();
    await work?.close("test cleanup");
    await persistence.dispose();
    await database.close();
  };
  try {
    const f = await createHarness(database, model, undefined, false, {
      agentPersistenceService: persistence,
      emitPreStep: (payload) => {
        if (!kernel) throw new Error("真实内核pre-step派发器尚未装配");
        return kernel.events.emitPreStep(payload);
      },
    });
    work = f.work;
    const installColdKernel = async () => {
      await kernel?.dispose();
      await app?.close();
      app = Fastify();
      kernel = composePlugins(
        f.env,
        [
          {
            name: "pre-step-fact-observer",
            inject: [],
            apply(ctx) {
              ctx.on("pre-step", async (payload, next) => {
                observed.push({ ...payload });
                return next(payload);
              });
            },
          },
          createAgentModesPlugin(),
        ],
        {
          app,
          overrides: {
            auth: createLocalTrustAuthenticator({
              accounts: createAccountRepository(database.persistence),
            }),
            persistence: database.persistence,
            viewer: f.viewer,
          },
        },
      );
      return kernel;
    };
    const initialKernel = await installColdKernel();
    return {
      ...f,
      database,
      observed,
      initialKernel,
      installColdKernel,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function runInput(f: Harness, threadId: string, prompt: string) {
  const { runId } = f.runtime.createRun(
    {
      sessionId: f.scope.taskId,
      conversationId: f.scope.taskId,
      projectId: f.scope.projectId,
      taskId: f.scope.taskId,
      preset: "code",
      prompt,
    },
    {
      threadId,
      scopeHandle: f.handle,
      userId: f.actor.id,
      accessToken: f.actor.accessToken,
    },
  );
  await f.service.createAcceptedRun({
    runId,
    sessionId: f.scope.taskId,
    threadId,
  });
  const events: StreamEvent[] = [];
  for await (const event of f.runtime.streamRun(runId)) events.push(event);
  expect(events.at(-1)?.type).toBe("run.completed");
  return runId;
}

/** 独占真实PG/Harness/内核事件；只替换外部模型边界，不伪造pre-step或模式存储。 */
describe.skipIf(process.env.KENFUTWORK_AGENT_MODE_GUIDANCE_TEST_PG !== "1")(
  "Code通用模式指导真实消费 integration",
  () => {
    it("冷服务从Code Task持久模式恢复goal指导，实际模型收到可信pre-step的唯一输入", async () => {
      const f = await createGuidanceFixture();
      try {
        const modeStore = createExecutionModeStore(f.database.persistence);
        await modeStore.save(f.scope.workspaceId, f.threadId, "goal");
        expect(await modeStore.lookup(f.scope.workspaceId, f.threadId)).toEqual(
          { exists: true, mode: "goal" },
        );
        expect(f.initialKernel.get("agentModes").getMode(f.threadId)).toBe(
          "agent",
        );
        // Runtime使用同一真实内核派发器；这里不直接调用listener或手造可信payload。
        const runId = await runInput(f, f.threadId, "请按当前目标继续处理。");
        const actualInput = f.model.requests[0]
          ?.map((message) => String(message.content))
          .join("\n");
        expect(actualInput).toContain('<execution_mode name="goal">');
        expect(actualInput).toContain("请按当前目标继续处理。");
        expect(f.observed).toMatchObject([
          {
            runId,
            threadId: f.threadId,
            workspaceId: f.scope.workspaceId,
            taskId: f.scope.taskId,
            sessionId: f.scope.taskId,
            preset: "code",
          },
        ]);
      } finally {
        await f.close();
      }
    }, 60_000);
    it("同Task换绑真实context thread后，冷服务为最新HumanMessage恢复goal指导而非复用旧历史前缀", async () => {
      const f = await createGuidanceFixture();
      try {
        const modeStore = createExecutionModeStore(f.database.persistence);
        await modeStore.save(f.scope.workspaceId, f.threadId, "goal");
        const originalRunId = await runInput(
          f,
          f.threadId,
          "保留的目标模式原输入。",
        );
        const pair = await f.metadata().getOwnedTurnBoundaries(f.actor, {
          taskId: f.scope.taskId,
          runId: originalRunId,
        });
        const context = pair.post?.context;
        if (context?.status !== "captured" || !context.reference)
          throw new Error("同Task原生post上下文未捕获");
        const targetThreadId = `mode-guidance-branch-${randomUUID()}`;
        const branch = await f.runtime.cloneContextBranch({
          sourceThreadId: f.threadId,
          targetThreadId,
          reference: context.reference,
        });
        if (!branch) throw new Error("同Task新context thread未实际克隆");
        // 只建立history-edit已验证的持久换绑边界，不替代其事务实现。
        await f.database.persistence
          .forWorkspace(f.scope.workspaceId)
          .execute(
            "update public.chat_sessions set thread_id=$1 where workspace_id=:workspace and id=$2 and project_id=$3 and thread_id=$4",
            [targetThreadId, f.scope.taskId, f.scope.projectId, f.threadId],
          );
        f.runtime.releaseContextBranch({
          targetThreadId,
          reference: branch,
        });
        expect(
          await modeStore.lookup(f.scope.workspaceId, targetThreadId),
        ).toEqual({ exists: true, mode: "goal" });
        const coldKernel = await f.installColdKernel();
        expect(coldKernel.get("agentModes").getMode(targetThreadId)).toBe(
          "agent",
        );
        const runId = await runInput(
          f,
          targetThreadId,
          "换绑后新一轮独立输入。",
        );
        const userMessages = f.model.requests
          .at(-1)
          ?.filter(HumanMessage.isInstance);
        expect(
          userMessages?.slice(0, -1).map((message) => message.content),
        ).toEqual([expect.stringContaining("保留的目标模式原输入。")]);
        // 必须检查最后一条：历史中已有goal文本不能使本次漏注入假绿。
        expect(userMessages?.at(-1)?.content).toContain(
          '<execution_mode name="goal">',
        );
        expect(userMessages?.at(-1)?.content).toContain(
          "换绑后新一轮独立输入。",
        );
        expect(f.observed.at(-1)).toMatchObject({
          runId,
          threadId: targetThreadId,
          workspaceId: f.scope.workspaceId,
          taskId: f.scope.taskId,
          sessionId: f.scope.taskId,
          preset: "code",
        });
      } finally {
        await f.close();
      }
    }, 60_000);
  },
);
