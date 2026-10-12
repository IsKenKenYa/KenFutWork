import { randomUUID } from "node:crypto";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import type {
  KenFutWorkAgent,
  KenFutWorkAgentFactory,
} from "../../agent/deep-agent.js";
import { MODEL_USAGE_OWNER_METADATA } from "../../agent/model-call-usage.js";
import { createAgentPersistenceService } from "../../agent/persistence/index.js";
import { createAgentRunService } from "../../agent/runtime.js";
import { loadServerEnv } from "../../config/env.js";
import type { ModelInvocationSnapshot } from "../../providers/types.js";
import { createExecutionModeService } from "../agent-modes/execution-mode-service.js";
import { createAgentRunMetadataService } from "../agent-runs/agent-run-service.js";
import { createAgentRunRepository } from "../agent-runs/repository.js";
import { createChatRepository } from "../chat/repository.js";
import { createThreadService } from "../chat/thread-service.js";
import { createGoalService } from "../goals/service.js";
import { createPermissionService } from "../permissions/permission-service.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTaskWorkManager } from "../task-work/service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createMemoryTaskWorkStore } from "../task-work/test-store.js";
import { createDesignGoals } from "./design-goals.js";
import { createDesignRunHost } from "./design-run-host.js";
import { createDesignHostRepository } from "./design-run-host-repository.js";
import { createDesignTasksService } from "./design-tasks.js";
import { createScopeRepository } from "./scope-repository.js";
import { createExecutionScopes } from "./scope-service.js";

async function fixture() {
  const db = await createTaskWorkDatabase();
  const providerA = randomUUID(),
    providerB = randomUUID(),
    providerC = randomUUID();
  const selected = `${providerA}:model-A`;
  let preferred = `${providerB}:model-B`;
  const revisions = new Map<string, number>([
    [providerA, 1],
    [providerB, 1],
    [providerC, 1],
  ]);
  const snapshots = {
    capture: vi.fn(
      async (
        _actor: typeof db.actor,
        specifier?: string,
      ): Promise<ModelInvocationSnapshot> => {
        const value = specifier ?? preferred;
        const separator = value.indexOf(":");
        const providerId = value.slice(0, separator),
          modelId = value.slice(separator + 1);
        return {
          providerId,
          modelId,
          configRevision: revisions.get(providerId) ?? 1,
          useResponsesApi: false,
          body: { temperature: 0.1, max_tokens: 256 },
          inputCapabilities: { image: false, pdf: false },
        };
      },
    ),
    validate: vi.fn(
      async (_actor: typeof db.actor, snapshot: ModelInvocationSnapshot) => {
        if (snapshot.configRevision !== revisions.get(snapshot.providerId))
          throw new Error("模型配置已变更");
      },
    ),
  };
  // Only external model configuration and final answers are substituted; Task/Run/admission/persistence stay real.
  const goalsOptions = {
    persistence: db.persistence,
    goals: createGoalService(),
    localInstance: db.localInstance,
    permissions: createPermissionService(),
    modelSelection: snapshots,
  };
  const goals = createDesignGoals(goalsOptions);
  await goals.initialize();
  const tasks = createDesignTasksService({
    persistence: db.persistence,
    localInstance: db.localInstance,
    goalLifecycle: goals.lifecycle,
  });
  const { project, canvas } = await createProjectRepository(
    db.persistence,
  ).createProject({
    instanceId: db.instanceId,
    createdByClientId: db.actor.accessClientId,
    kind: "design",
    name: "Synthetic selected model",
    slug: randomUUID(),
    description: null,
    canvasName: "Canvas",
    workDir: db.context.scope.rootDirectory,
  });
  if (!canvas) throw new Error("Synthetic Canvas missing");
  const preparation = await tasks.prepareCreation(db.actor, canvas.id);
  if (!preparation) throw new Error("Actual Task preparation missing");
  const chat = createChatRepository(db.persistence);
  const task = await chat.createSession(db.instanceId, {
    canvasId: canvas.id,
    threadId: randomUUID(),
    createdByClientId: db.actor.accessClientId,
    designTaskPreparation: preparation,
  });
  if (!task) throw new Error("Actual Task missing");
  const scopes = createExecutionScopes({
    repository: createScopeRepository(db.persistence),
    localInstance: db.localInstance,
  });
  const scope = await scopes.openTask(db.actor, task.id);
  const threads = createThreadService({
    repository: chat,
    localInstance: db.localInstance,
  });
  const metadata = createAgentRunMetadataService({
    repository: createAgentRunRepository(db.persistence),
    localInstance: db.localInstance,
    threadService: threads,
  });
  const work = createTaskWorkManager({
    store: createMemoryTaskWorkStore([
      {
        actor: db.actor,
        ownerKind: "design",
        scope: scope.describe(),
        agentId: "main",
        runId: "setup",
        branchGeneration: scope.branchGeneration,
      },
    ]),
    executionHostId: db.directory,
    resolveMaxConcurrent: async () => 2,
  });
  await work.initialize();
  const nativeOwners: unknown[] = [];
  let goalMode = false;
  const factory: KenFutWorkAgentFactory = (options) => {
    nativeOwners.push(
      typeof options.model === "object"
        ? options.model.metadata?.[MODEL_USAGE_OWNER_METADATA]
        : options.model,
    );
    return {
      streamEvents: async function* () {
        if (goalMode) {
          preferred = `${providerC}:model-C`;
          if (nativeOwners.length >= 2) {
            const state = await goals.readTask(db.actor, task.id);
            if (!state) throw new Error("Goal missing");
            await goals.pause(db.actor, {
              taskId: task.id,
              goalId: state.goalId,
              revision: state.revision,
              branchGeneration: state.branchGeneration,
            });
          }
        }
        // Native model content events, rather than a chain summary, are the real public text source.
        const modelCallId = randomUUID();
        const reply = new AIMessage("Synthetic model reply");
        yield {
          event: "on_chat_model_start",
          run_id: modelCallId,
          metadata: { [MODEL_USAGE_OWNER_METADATA]: nativeOwners.at(-1) },
          data: { input: { messages: [] } },
        };
        yield {
          event: "on_chat_model_stream",
          run_id: modelCallId,
          data: { chunk: new AIMessageChunk("Synthetic model reply") },
        };
        yield {
          event: "on_chat_model_end",
          run_id: modelCallId,
          data: { output: reply },
        };
        yield {
          event: "on_chain_end",
          name: "LangGraph",
          data: {
            output: { messages: [reply] },
          },
        };
      },
    } as unknown as KenFutWorkAgent;
  };
  const providers = {
    resolveCredentials: async (_actor: typeof db.actor, id: string) => ({
      instanceId: id,
      name: "synthetic",
      protocol: "openai-compatible" as const,
      apiKey: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      configRevision: revisions.get(id) ?? 1,
      useResponsesApi: false,
      models: [
        {
          id:
            id === providerA
              ? "model-A"
              : id === providerB
                ? "model-B"
                : "model-C",
          capability: "chat" as const,
          name: "synthetic",
          enabled: true,
          extraBody: { temperature: 0.1, max_tokens: 256 },
        },
      ],
    }),
  };
  const catalog = {
    validateSpecifier: async () => ({ ok: true as const }),
    listCatalog: async () => [],
  };
  const agentPersistence = createAgentPersistenceService({
    databaseUrl: db.connectionString,
  });
  const runtime = createAgentRunService({
    env: loadServerEnv({
      agentBackendMode: "filesystem",
      agentFilesRoot: db.directory,
    }),
    blob: {} as never,
    localInstance: db.localInstance,
    model: preferred,
    modelProviders: providers,
    modelCatalog: catalog,
    agentFactory: factory,
    agentPersistenceService: agentPersistence,
    agentRunMetadataService: metadata,
    taskWork: work,
    resolveTaskWorkContext: async (actor, handle, runId) => ({
      actor,
      ownerKind: "design",
      scope: handle.describe(),
      agentId: handle.agentId,
      runId,
      branchGeneration: handle.branchGeneration,
    }),
    resolveCodeApprovalMode: async () => ({
      mode: "build",
      scopeGeneration: 1,
      branchGeneration: 1,
    }),
  });
  const hostOptions = {
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
    modelSelection: snapshots,
  };
  const host = createDesignRunHost(hostOptions);
  await host.initialize();
  return {
    db,
    host,
    goals,
    tasks,
    task,
    project,
    selected,
    providerA,
    nativeOwners,
    snapshots,
    preferSelected: () => {
      preferred = selected;
    },
    reviseSelected: () => {
      revisions.set(providerA, 2);
    },
    enableGoal: () => {
      goalMode = true;
    },
    close: async () => {
      await host.close();
      await work.close("synthetic model fixture");
      await goals.close();
      await tasks.close();
      await agentPersistence.dispose();
      await db.close();
    },
  };
}

describe.skipIf(process.env.KENFUTWORK_DESIGN_TASK_TEST_PG !== "1")(
  "Design selected model reaches actual Runtime factory",
  () => {
    it("ordinary Design request model A is actually resolved instead of Runtime default B", async () => {
      const f = await fixture();
      try {
        const input = {
          taskId: f.task.id,
          inputId: randomUUID(),
          scopeGeneration: 1,
          branchGeneration: 1,
          request: {
            sessionId: f.task.id,
            conversationId: f.task.id,
            taskId: f.task.id,
            projectId: f.project.id,
            preset: "design" as const,
            prompt: "Synthetic response",
            model: f.selected,
          },
        };
        const accepted = await f.host.submit(f.db.actor, input);
        await vi.waitFor(() =>
          expect(f.nativeOwners[0]).toMatchObject({
            providerInstanceId: f.providerA,
            model: "model-A",
            configRevision: 1,
          }),
        );
        await vi.waitFor(async () =>
          expect(
            (await f.tasks.readPolicy(f.db.actor, f.task.id)).activeRunId,
          ).toBeNull(),
        );
        f.snapshots.capture.mockRejectedValue(
          new Error("Model config removed"),
        );
        const replay = await f.host.submit(f.db.actor, input);
        expect(replay).toMatchObject({
          kind: "duplicate",
          runId: accepted.runId,
        });
        expect(f.snapshots.capture).toHaveBeenCalledTimes(1);
        await expect(
          f.host.submit(f.db.actor, {
            ...input,
            request: { ...input.request, prompt: "different" },
          }),
        ).rejects.toMatchObject({
          code: "design_input_conflict",
          statusCode: 409,
        });
        expect(f.nativeOwners[0]).toMatchObject({
          providerInstanceId: f.providerA,
          model: "model-A",
          configRevision: 1,
        });
      } finally {
        await f.close();
      }
    });
    it.each([true, false])(
      "Goal explicit=%s captures once and both real Runs keep A after preferred/default changes to C",
      async (explicit) => {
        const f = await fixture();
        try {
          f.enableGoal();
          f.preferSelected();
          const input = {
            taskId: f.task.id,
            objective: "Synthetic Goal remains on its selected model",
            expectedBranchGeneration: 1,
            expectedGoal: null,
            ...(explicit ? { model: f.selected } : {}),
          };
          await f.goals.create(f.db.actor, input);
          await f.host.dispatchGoal(f.db.instanceId, f.task.id);
          await vi.waitFor(() =>
            expect(f.nativeOwners[0]).toMatchObject({
              providerInstanceId: f.providerA,
              model: "model-A",
              configRevision: 1,
            }),
          );
          expect(f.nativeOwners[0]).toMatchObject({
            providerInstanceId: f.providerA,
            model: "model-A",
            configRevision: 1,
          });
          try {
            await vi.waitFor(() => expect(f.nativeOwners).toHaveLength(2), {
              timeout: 10000,
            });
          } catch (error) {
            const sql = f.db.persistence.forInstance(f.db.instanceId);
            console.error("Goal continuation diagnostic", {
              goal: await f.goals.readTask(f.db.actor, f.task.id),
              policy: await f.tasks.readPolicy(f.db.actor, f.task.id),
              inputs: await sql.query(
                `select input_id,run_id,status,input_origin,goal_fence,model_invocation->>'providerId' as provider_id,model_invocation->>'modelId' as model_id from public.design_task_inputs where instance_id=:instance and task_id=$1 order by admission_seq`,
                [f.task.id],
              ),
              runs: await sql.query(
                `select r.id,r.status,r.error_code,r.error_message,r.stop_reason from public.agent_runs r join public.chat_sessions c on c.id=r.session_id where c.instance_id=:instance and c.id=$1`,
                [f.task.id],
              ),
              continuation: await f.goals
                .continuation(f.db.instanceId, f.task.id)
                .then((step) =>
                  step
                    ? { inputId: step.inputId, goalFence: step.goalFence }
                    : null,
                ),
            });
            throw error;
          }
          await vi.waitFor(async () =>
            expect(
              (await f.tasks.readPolicy(f.db.actor, f.task.id)).activeRunId,
            ).toBeNull(),
          );
          const firstRun = await f.db.persistence
            .forInstance(f.db.instanceId)
            .queryOne(
              `select r.status from public.agent_runs r join public.chat_sessions c on c.id=r.session_id where c.instance_id=:instance and c.id=$1 order by r.created_at limit 1`,
              [f.task.id],
            );
          expect(firstRun?.status).toBe("completed");
          expect(f.snapshots.capture).toHaveBeenCalledTimes(1);
          expect(f.nativeOwners).toEqual([
            expect.objectContaining({
              providerInstanceId: f.providerA,
              model: "model-A",
              configRevision: 1,
            }),
            expect.objectContaining({
              providerInstanceId: f.providerA,
              model: "model-A",
              configRevision: 1,
            }),
          ]);
          const paused = await f.goals.readTask(f.db.actor, f.task.id);
          if (!paused) throw new Error("Goal missing after pause");
          f.reviseSelected();
          const resume = {
            taskId: f.task.id,
            goalId: paused.goalId,
            revision: paused.revision,
            branchGeneration: paused.branchGeneration,
          };
          await expect(f.goals.resume(f.db.actor, resume)).rejects.toThrow(
            "模型配置已变更",
          );
          expect((await f.goals.readTask(f.db.actor, f.task.id))?.status).toBe(
            "paused",
          );
          await f.goals.resume(f.db.actor, { ...resume, model: f.selected });
          expect(f.snapshots.capture).toHaveBeenCalledTimes(2);
        } finally {
          await f.close();
        }
      },
    );
  },
);
