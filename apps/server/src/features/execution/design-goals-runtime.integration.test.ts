import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createKenFutWorkDeepAgent } from "../../agent/deep-agent.js";
import { createNativeContextBranchService } from "../../agent/native-context-branch.js";
import { createAgentPersistenceService } from "../../agent/persistence/index.js";
import { createAgentRunService } from "../../agent/runtime.js";
import { loadServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import { createExecutionModeService } from "../agent-modes/execution-mode-service.js";
import { createAgentRunMetadataService } from "../agent-runs/agent-run-service.js";
import { createAgentRunRepository } from "../agent-runs/repository.js";
import { createChatRepository } from "../chat/repository.js";
import { createThreadService } from "../chat/thread-service.js";
import { createCodeToolsPlugin } from "../code-tools/plugin.js";
import { createContextHistoryPlugin } from "../context-history/plugin.js";
import { createGoalService } from "../goals/service.js";
import type { ModelProviderService } from "../model-providers/model-provider-service.js";
import { createPermissionsPlugin } from "../permissions/plugin.js";
import { createProjectRepository } from "../projects/repository.js";
import { createSettingsPlugin } from "../settings/plugin.js";
import { createTaskWorkManager } from "../task-work/service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createMemoryTaskWorkStore } from "../task-work/test-store.js";
import { createDesignGoalsPlugin } from "./design-goals-plugin.js";
import { createTestDesignModelSelection } from "./design-goals-test-fixture.js";
import { createDesignRunHost } from "./design-run-host.js";
import { createDesignHostRepository } from "./design-run-host-repository.js";
import { createDesignTasksService } from "./design-tasks.js";
import { createScopeRepository } from "./scope-repository.js";
import { createExecutionScopes } from "./scope-service.js";

function text(message: BaseMessage): string {
  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
}
/** Only external model answers are scripted; SDK, registry, guards and files stay real. */
class DesignGoalModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = [];
  readonly readResults: string[] = [];
  private names: string[] = [];
  constructor(private readonly expectedBytes: string) {
    super({ disableStreaming: true });
  }
  _llmType() {
    return "design-goal-real-tools";
  }
  bindTools(tools: Parameters<NonNullable<BaseChatModel["bindTools"]>>[0]) {
    this.names = tools.map((tool) => convertToOpenAITool(tool).function.name);
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const index = this.requests.length;
    this.requests.push([...messages]);
    if (index >= 8) throw new Error("有限SDK模型收到第三轮或额外请求");
    for (const name of ["Read", "GetGoal", "VerifyGoal"])
      expect(this.names).toContain(name);
    const stage = index % 4,
      iteration = Math.floor(index / 4) + 1;
    const lastTool = messages.filter(ToolMessage.isInstance).at(-1);
    let message: AIMessage;
    if (stage === 0)
      message = new AIMessage({
        content: "",
        tool_calls: [
          {
            id: randomUUID(),
            name: "Read",
            args: { file_path: "goal-proof.txt" },
            type: "tool_call",
          },
        ],
      });
    else if (stage === 1) {
      if (!lastTool) throw new Error("真实Read未返回ToolMessage");
      const actual = text(lastTool);
      expect(actual).toContain(this.expectedBytes);
      this.readResults.push(actual);
      message = new AIMessage({
        content: "",
        tool_calls: [
          { id: randomUUID(), name: "GetGoal", args: {}, type: "tool_call" },
        ],
      });
    } else if (stage === 2) {
      if (!lastTool) throw new Error("真实GetGoal未返回ToolMessage");
      const goalResult = text(lastTool);
      if (!goalResult.startsWith("{"))
        throw new Error(`真实GetGoal返回错误：${goalResult}`);
      const view = JSON.parse(goalResult);
      const proof = view.evidenceCandidates.find(
        (candidate: { kind: string }) => candidate.kind === "toolCall",
      );
      if (!proof) throw new Error("真实Read尚未成为可验收证据");
      message = new AIMessage({
        content: "",
        tool_calls: [
          {
            id: randomUUID(),
            name: "VerifyGoal",
            args: {
              revision: view.revision,
              evidenceIds: [proof.id],
              passed: iteration === 2,
              reason:
                iteration === 2
                  ? "第二轮真实Read核对磁盘文件字节，需求完成"
                  : "第一轮已读取真实字节，还需下一轮复验",
            },
            type: "tool_call",
          },
        ],
      });
    } else {
      if (!lastTool) throw new Error("真实VerifyGoal未返回ToolMessage");
      expect(JSON.parse(text(lastTool)).status).toBe(
        iteration === 2 ? "complete" : "notSatisfied",
      );
      message = new AIMessage(`第${iteration}轮结束`);
    }
    return {
      generations: [
        {
          text: typeof message.content === "string" ? message.content : "",
          message,
        },
      ],
    };
  }
}
describe.skipIf(process.env.KENFUTWORK_DESIGN_TASK_TEST_PG !== "1")(
  "Design Goal真实Runtime+SDK工具",
  () => {
    it("actual registered Read读取磁盘字节，GetGoal/VerifyGoal跨两Run完成，permission guards保持生产路径", async () => {
      const db = await createTaskWorkDatabase();
      const app = Fastify();
      const env = loadServerEnv({
        agentBackendMode: "filesystem",
        agentFilesRoot: db.directory,
      });
      const pure = createGoalService();
      const modelSelection = createTestDesignModelSelection();
      const frozenModel = await modelSelection.capture();
      const modelProviders: Pick<ModelProviderService, "resolveCredentials"> = {
        resolveCredentials: async () => ({
          instanceId: frozenModel.providerId,
          name: "test",
          protocol: "openai-compatible",
          apiKey: "fixture",
          baseUrl: "http://127.0.0.1:1/v1",
          configRevision: frozenModel.configRevision,
          models: [
            {
              id: frozenModel.modelId,
              name: "test",
              capability: "chat",
              enabled: true,
            },
          ],
        }),
      };
      const kernel = composePlugins(
        env,
        [
          createPermissionsPlugin({}),
          createSettingsPlugin(),
          createContextHistoryPlugin(),
          createCodeToolsPlugin(),
          createDesignGoalsPlugin(modelSelection),
        ],
        {
          app,
          overrides: {
            persistence: db.persistence,
            localAccess: db.localAccess,
            localInstance: db.localInstance,
            modelCatalog: { listCatalog: async () => [] } as never,
            goals: pure,
            blob: {} as never,
          },
        },
      );
      const goals = kernel.get("designGoals");
      await goals.initialize();
      const tasks = createDesignTasksService({
        persistence: db.persistence,
        localInstance: db.localInstance,
        goalLifecycle: goals.lifecycle,
      });
      const persistence = createAgentPersistenceService({
        databaseUrl: db.connectionString,
      });
      let host: ReturnType<typeof createDesignRunHost> | undefined;
      let work: ReturnType<typeof createTaskWorkManager> | undefined;
      try {
        const { project, canvas } = await createProjectRepository(
          db.persistence,
        ).createProject({
          instanceId: db.instanceId,
          createdByClientId: db.actor.accessClientId,
          kind: "design",
          name: "Real Goal",
          slug: randomUUID(),
          description: null,
          canvasName: "Canvas",
          workDir: db.context.scope.rootDirectory,
        });
        if (!canvas) throw new Error("Canvas缺失");
        const prepared = await tasks.prepareCreation(db.actor, canvas.id);
        if (!prepared) throw new Error("Task准备缺失");
        const chat = createChatRepository(db.persistence);
        const task = await chat.createSession(db.instanceId, {
          canvasId: canvas.id,
          threadId: randomUUID(),
          createdByClientId: db.actor.accessClientId,
          designTaskPreparation: prepared,
        });
        if (!task) throw new Error("Task缺失");
        const scopes = createExecutionScopes({
          repository: createScopeRepository(db.persistence),
          localInstance: db.localInstance,
        });
        const handle = await scopes.openTask(db.actor, task.id);
        const bytes = `真实磁盘证据-${randomUUID()}`;
        await writeFile(
          join(handle.describe().rootDirectory, "goal-proof.txt"),
          bytes,
          "utf8",
        );
        const context = {
          actor: db.actor,
          ownerKind: "design" as const,
          scope: handle.describe(),
          agentId: "main",
          runId: "setup",
          branchGeneration: handle.branchGeneration,
        };
        work = createTaskWorkManager({
          store: createMemoryTaskWorkStore([context]),
          executionHostId: db.directory,
          resolveMaxConcurrent: async () => 2,
        });
        await work.initialize();
        const threads = createThreadService({
          repository: chat,
          localInstance: db.localInstance,
        });
        const metadata = createAgentRunMetadataService({
          repository: createAgentRunRepository(db.persistence),
          localInstance: db.localInstance,
          threadService: threads,
        });
        const model = new DesignGoalModel(bytes);
        const runtime = createAgentRunService({
          env,
          blob: {} as never,
          localInstance: db.localInstance,
          modelProviders,
          modelCatalog: {
            validateSpecifier: async () => ({ ok: true }),
            listCatalog: async () => [],
          },
          agentFactory: (options) => {
            const context = options.extensionContext;
            const nativeControl = context?.modelControl;
            if (!context || !nativeControl)
              throw new Error("真实模型配置验证入口缺失");
            return createKenFutWorkDeepAgent({
              ...options,
              model,
              extensionContext: {
                ...context,
                modelControl: {
                  selectInvocation: (snapshot) =>
                    nativeControl.selectInvocation(snapshot),
                  async resolveCurrent() {
                    // Keep real scope/revision validation; substitute only the external answer.
                    const resolved = await nativeControl.resolveCurrent();
                    if (!resolved.metadata)
                      throw new Error("模型归属元信息缺失");
                    model.metadata = resolved.metadata;
                    return model;
                  },
                },
              },
            });
          },
          tools: kernel.get("tools"),
          systemPromptRegistry: kernel.get("systemPrompt"),
          contextHistoryArchives: kernel.get("contextHistoryArchives"),
          agentPersistenceService: persistence,
          contextBranchProvider: createNativeContextBranchService({
            agentPersistenceService: persistence,
          }),
          agentRunMetadataService: metadata,
          taskWork: work,
          resolveTaskWorkContext: async (actor, scope, runId) => ({
            actor,
            ownerKind: "design",
            scope: scope.describe(),
            agentId: scope.agentId,
            runId,
            branchGeneration: scope.branchGeneration,
          }),
          resolveCodeApprovalMode: async (scope, actor) => {
            const policy = await tasks.readPolicy(
              actor,
              scope.describe().taskId,
            );
            return {
              mode: policy.mode,
              planEnabled: policy.planEnabled,
              planningEpoch: policy.planningEpoch,
              scopeGeneration: policy.scopeGeneration,
              branchGeneration: policy.branchGeneration,
            };
          },
        });
        host = createDesignRunHost({
          modelSelection,
          repository: createDesignHostRepository(db.persistence),
          designTasks: tasks,
          designGoals: goals,
          agentRuns: runtime,
          metadata,
          threads,
          executionScopes: scopes,
          localInstance: db.localInstance,
          localAccess: db.localAccess,
          agentModes: createExecutionModeService(),
          taskWork: work,
        });
        await host.initialize();
        await host.submit(db.actor, {
          taskId: task.id,
          inputId: randomUUID(),
          scopeGeneration: 1,
          branchGeneration: 1,
          request: {
            sessionId: task.id,
            taskId: task.id,
            projectId: project.id,
            conversationId: task.id,
            prompt: "读取并在第二轮复验goal-proof.txt的磁盘字节",
            preset: "design",
            executionMode: "goal",
          },
        });
        try {
          await vi.waitFor(
            async () =>
              expect((await goals.readTask(db.actor, task.id))?.status).toBe(
                "complete",
              ),
            { timeout: 30000 },
          );
        } catch (error) {
          const sql = db.persistence.forInstance(db.instanceId);
          console.error("Real SDK Goal continuation diagnostic", {
            goal: await goals.readTask(db.actor, task.id),
            policy: await tasks.readPolicy(db.actor, task.id),
            inputs: await sql.query(
              `select input_id,run_id,status,input_origin,model_invocation->>'providerId' as provider_id,model_invocation->>'modelId' as model_id from public.design_task_inputs where instance_id=:instance and task_id=$1 order by admission_seq`,
              [task.id],
            ),
            runs: await sql.query(
              `select r.id,r.status,r.error_code,r.error_message,r.stop_reason from public.agent_runs r join public.chat_sessions c on c.id=r.session_id where c.instance_id=:instance and c.id=$1`,
              [task.id],
            ),
            readResults: model.readResults,
          });
          throw error;
        }
        await vi.waitFor(
          async () =>
            expect(
              (await tasks.readPolicy(db.actor, task.id)).activeRunId,
            ).toBeNull(),
          { timeout: 10000 },
        );
        expect(model.requests).toHaveLength(8);
        expect(model.readResults).toHaveLength(2);
        expect(
          await readFile(
            join(handle.describe().rootDirectory, "goal-proof.txt"),
            "utf8",
          ),
        ).toBe(bytes);
        const goal = await goals.readTask(db.actor, task.id);
        expect(goal).toMatchObject({
          status: "complete",
          iteration: 2,
          tokenBudget: null,
        });
        const inputs = await db.persistence
          .forInstance(db.instanceId)
          .query(
            `select input_origin from public.design_task_inputs where instance_id=:instance and task_id=$1 order by admission_seq`,
            [task.id],
          );
        expect(inputs.map((row) => row.input_origin)).toEqual([
          "userInput",
          "goalContinuation",
        ]);
        const proofs = await db.persistence
          .forInstance(db.instanceId)
          .query(
            `select detail,status,tool_name from public.design_goal_evidence where instance_id=:instance and task_id=$1`,
            [task.id],
          );
        expect(proofs.find((row) => row.tool_name === "Read")).toMatchObject({
          status: "success",
        });
        expect(
          String(proofs.find((row) => row.tool_name === "Read")?.detail),
        ).toContain(bytes);
        expect(
          kernel.get("permissions").listPending(db.instanceId, task.id),
        ).toEqual([]);
      } finally {
        await host?.close();
        await work?.close("fixture cleanup");
        await tasks.close();
        await kernel.dispose();
        await persistence.dispose();
        await app.close();
        await db.close();
      }
    }, 60000);
  },
);
