import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { loadServerEnv } from "../config/env.js";
import { createCodeUiConversation } from "../features/code-ui/conversation.js";
import { createCodeUiRepository } from "../features/code-ui/repository.js";
import { createScopeRepository } from "../features/execution/scope-repository.js";
import { createExecutionScopes } from "../features/execution/scope-service.js";
import { createGenerationTargets } from "../features/generation/file-targets.js";
import { createGenerationPlugin } from "../features/generation/plugin.js";
import { createJobService } from "../features/jobs/job-service.js";
import { createJobRepository } from "../features/jobs/repository.js";
import { createPermissionService } from "../features/permissions/permission-service.js";
import type { QueueClient } from "../features/queue/types.js";
import { createTaskWorkDatabase } from "../features/task-work/test-postgres-schema.js";
import { AgentRunEventBus, ToolRegistryImpl } from "../kernel/context.js";
import type { KenFutWorkAgent, KenFutWorkAgentFactory } from "./deep-agent.js";
import { createAgentRunService } from "./runtime.js";

const enabled = process.env.KENFUTWORK_GENERATION_FILES_TEST_PG === "1";
const providerId = "44444444-5555-4666-8777-888888888888";

function resultFor(kind: "image" | "video") {
  return kind === "image"
    ? {
        signed_url: "https://example.invalid/image.png",
        asset_id: "48469ae8-31e0-4c43-864e-c8a044ce2e18",
        element_id: "image-element",
        width: 64,
        height: 64,
        mime_type: "image/png",
      }
    : {
        signed_url: "https://example.invalid/video.mp4",
        asset_id: "d7ee2a31-6b32-4ff6-a0a1-92b21fcc545b",
        element_id: "video-element",
        duration_seconds: 5,
        width: 1280,
        height: 720,
        mime_type: "video/mp4",
      };
}

async function fixture(
  kind: "image" | "video",
  missingBranchGeneration = false,
) {
  const db = await createTaskWorkDatabase();
  try {
    const project = { id: db.context.scope.projectId };
    const task = { id: randomUUID() };
    const canvas = { id: randomUUID() };
    await db.persistence
      .forInstance(db.instanceId)
      .execute(
        "update public.projects set enabled_modes=array['code','design']::text[] where instance_id=:instance and id=$1",
        [project.id],
      );
    await db.persistence
      .forInstance(db.instanceId)
      .execute(
        "insert into public.canvases(id,project_id,name,created_by_client_id,root_directory) select $1,p.id,'Generation canvas',$3,$4 from public.projects p where p.id=$2 and p.instance_id=:instance",
        [
          canvas.id,
          project.id,
          db.actor.accessClientId,
          db.context.scope.rootDirectory,
        ],
      );
    const host = createCodeUiConversation({
      sessionId: task.id,
      workspacePath: db.context.scope.rootDirectory,
      config: {
        provider: "fixture",
        model: "fixture",
        thought: "",
        followupMode: "queue",
      },
      workContext: { preset: "design", canvasId: canvas.id },
    });
    await createCodeUiRepository(db.persistence).createRoot(db.instanceId, {
      sessionId: task.id,
      projectId: project.id,
      scope: { ...db.context.scope, taskId: task.id },
      createdByClientId: db.actor.accessClientId,
      threadId: randomUUID(),
      state: host.exportState(),
      command: {
        clientId: "fixture",
        commandId: randomUUID(),
        fingerprint: randomUUID(),
      },
    });
    const scopes = createExecutionScopes({
      repository: createScopeRepository(db.persistence),
      localInstance: db.localInstance,
    });
    const scopeHandle = await scopes.openTask(db.actor, task.id);
    const generationTargets = createGenerationTargets({
      persistence: db.persistence,
      executionScopes: scopes,
    });
    const prepareOrigin = vi.spyOn(generationTargets, "prepareOrigin");
    const queueSend = vi.fn(async () => 1);
    const baseJobs = createJobService({
      generationTargets,
      localInstance: db.localInstance,
      queue: { send: queueSend } as unknown as QueueClient,
      repository: createJobRepository(db.persistence),
    });
    const getJobForWorker = vi.fn(
      async (jobId: string) =>
        ({
          ...(await baseJobs.getJob(db.actor, jobId)),
          status: "succeeded",
          result: resultFor(kind),
        }) as BackgroundJob,
    );
    const jobService = { ...baseJobs, getJobForWorker };
    const createJob = vi.spyOn(jobService, "createJob");
    const permissions = createPermissionService();
    const tools = new ToolRegistryImpl(
      new AgentRunEventBus(),
      () => permissions,
    );
    const env = loadServerEnv({}, {});
    const plugin = createGenerationPlugin({ env });
    if (!plugin.apply) throw new Error("generation plugin apply missing");
    plugin.apply({
      get: (key: string) => {
        if (key !== "tools") throw new Error(`unexpected service ${key}`);
        return tools;
      },
    } as never);
    const modelCatalog = {
      validateSpecifier: async () => ({ ok: true as const }),
      listCatalog: async () => [
        {
          id: "image-model",
          name: "Image model",
          capability: "image",
          provider: { instanceId: providerId, name: "BYOK fixture" },
          hints: {},
          model: {},
        },
        {
          id: "video-model",
          name: "Video model",
          capability: "video",
          provider: { instanceId: providerId, name: "BYOK fixture" },
          hints: {},
          model: {},
        },
      ],
    };
    const canvasService = {
      insertImageElement: vi.fn(async () => ({ elementId: "image-element" })),
      insertVideoElement: vi.fn(async () => ({ elementId: "video-element" })),
    };
    const toolResults: unknown[] = [];
    const toolErrors: unknown[] = [];
    const toolAccess: Array<unknown> = [];
    const toolName = kind === "image" ? "generate_image" : "generate_video";
    const toolArgs =
      kind === "image"
        ? {
            title: "image",
            prompt: "image prompt",
            model: `${providerId}:image-model`,
            aspectRatio: "1:1",
          }
        : {
            title: "video",
            prompt: "video prompt",
            model: `${providerId}:video-model`,
            duration: 5,
            resolution: "720p",
            aspectRatio: "16:9",
            enableAudio: false,
          };
    const agentFactory: KenFutWorkAgentFactory = (options) =>
      ({
        streamEvents: async function* () {
          const tool = options.kernelTools?.find(
            (definition) => definition.name === toolName,
          );
          if (!tool) throw new Error(`registered ${toolName} tool missing`);
          if (!options.runToolContext)
            throw new Error("Runtime tool context missing");
          toolAccess.push(tool.access);
          try {
            toolResults.push(
              await tool.execute(toolArgs, {
                ...options.runToolContext,
                toolCallId: `${kind}-tool-call`,
              }),
            );
          } catch (error) {
            toolErrors.push(error);
          }
          yield { event: "__test_noop__" };
        },
      }) as unknown as KenFutWorkAgent;
    const runtime = createAgentRunService({
      localInstance: db.localInstance,
      agentFactory,
      blob: {} as never,
      env,
      jobService,
      modelCatalog: modelCatalog as never,
      tools,
      canvasService: canvasService as never,
      taskWork: { enterForeground: async () => async () => {} } as never,
      resolveTaskWorkContext: async (_actor, handle, runId) => ({
        actor: db.actor,
        ownerKind: "code",
        scope: handle.describe(),
        agentId: handle.agentId,
        runId,
        branchGeneration: missingBranchGeneration
          ? (undefined as unknown as number)
          : handle.branchGeneration,
      }),
      resolveCodeApprovalMode: async (_handle) => ({
        mode: "yolo",
        scopeGeneration: scopeHandle.describe().generation,
        branchGeneration: scopeHandle.branchGeneration,
      }),
    });
    return {
      db,
      actor: db.actor,
      canvasId: canvas.id,
      projectId: project.id,
      taskId: task.id,
      scopeHandle,
      runtime,
      canvasService,
      createJob,
      generationTargets,
      prepareOrigin,
      queueSend,
      toolResults,
      toolErrors,
      toolAccess,
      async close() {
        await db.close();
      },
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}

async function run(f: Awaited<ReturnType<typeof fixture>>) {
  const accepted = f.runtime.createRun(
    {
      sessionId: f.taskId,
      conversationId: "conversation",
      taskId: f.taskId,
      projectId: f.projectId,
      canvasId: f.canvasId,
      preset: "design",
      prompt: "generate",
    },
    {
      actor: f.actor,
      scopeHandle: f.scopeHandle,
      workContext: { preset: "design", canvasId: f.canvasId },
    },
  );
  const host = createCodeUiConversation({
    sessionId: f.taskId,
    workspacePath: f.scopeHandle.describe().rootDirectory,
    config: {
      provider: "zcode",
      model: "fixture",
      thought: "",
      followupMode: "queue",
    },
    workContext: { preset: "design", canvasId: f.canvasId },
  });
  host.startTurn({
    runId: accepted.runId,
    commandId: randomUUID(),
    text: "generate",
  });
  const state = host.exportState();
  state.runWorkContexts = [
    [accepted.runId, { preset: "design", canvasId: f.canvasId }],
  ];
  await f.db.persistence
    .forInstance(f.db.instanceId)
    .execute(
      "update public.code_ui_sessions set active_run_id=$2,state=$3::jsonb where instance_id=:instance and id=$1",
      [f.taskId, accepted.runId, JSON.stringify(state)],
    );
  const events = [];
  for await (const event of f.runtime.streamRun(accepted.runId))
    events.push(event);
  return events;
}

describe.skipIf(!enabled)(
  "Runtime generation tools carry persisted Design Task authorization into JobService",
  () => {
    it.each(["image", "video"] as const)(
      "%s carries current scope and branch through GenerationPlugin, kernel, JobService, and GenerationTargets",
      async (kind) => {
        const f = await fixture(kind);
        try {
          const events = await run(f);
          expect(events.at(-1)?.type).toBe("run.completed");
          expect(f.toolErrors).toEqual([]);
          expect(f.toolAccess).toEqual(["execute"]);
          expect(f.createJob).toHaveBeenCalledOnce();
          expect(f.prepareOrigin).toHaveBeenCalledWith(
            expect.objectContaining({
              actor: f.actor,
              projectId: f.projectId,
              sessionId: f.taskId,
              canvasId: f.canvasId,
              expectedScopeGeneration: f.scopeHandle.describe().generation,
              expectedBranchGeneration: f.scopeHandle.branchGeneration,
              jobType: `${kind}_generation`,
            }),
          );
          expect(f.queueSend).toHaveBeenCalledOnce();
          expect(f.toolResults[0]).not.toHaveProperty("error");
          expect(f.canvasService.insertVideoElement).not.toHaveBeenCalled();
          expect(f.canvasService.insertImageElement).not.toHaveBeenCalled();
          expect(f.toolResults[0]).toMatchObject({
            elementId: `${kind}-element`,
          });
        } finally {
          await f.close();
        }
      },
    );

    it("missing branch generation fails before JobService, persistence, and queue side effects", async () => {
      const f = await fixture("image", true);
      try {
        const events = await run(f);
        expect(events.at(-1)?.type).toBe("run.completed");
        expect(f.toolErrors).toEqual([]);
        expect(f.toolResults[0]).toMatchObject({
          error: expect.stringContaining("Task授权信息缺失"),
        });
        expect(f.createJob).not.toHaveBeenCalled();
        expect(f.prepareOrigin).not.toHaveBeenCalled();
        expect(f.queueSend).not.toHaveBeenCalled();
        expect(f.canvasService.insertImageElement).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    });
  },
);
