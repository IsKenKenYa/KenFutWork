import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { loadServerEnv } from "../config/env.js";
import { createChatRepository } from "../features/chat/repository.js";
import { createDesignTasksService } from "../features/execution/design-tasks.js";
import { createScopeRepository } from "../features/execution/scope-repository.js";
import { createExecutionScopes } from "../features/execution/scope-service.js";
import { createGenerationTargets } from "../features/generation/file-targets.js";
import { createGenerationPlugin } from "../features/generation/plugin.js";
import { createJobService } from "../features/jobs/job-service.js";
import { createJobRepository } from "../features/jobs/repository.js";
import { createPermissionService } from "../features/permissions/permission-service.js";
import { createProjectRepository } from "../features/projects/repository.js";
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
        width: 64,
        height: 64,
        mime_type: "image/png",
      }
    : {
        signed_url: "https://example.invalid/video.mp4",
        asset_id: "asset-video-1",
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
  const tasks = createDesignTasksService({
    persistence: db.persistence,
    localInstance: db.localInstance,
    sandboxRoot: db.directory,
  });
  try {
    const { project, canvas } = await createProjectRepository(
      db.persistence,
    ).createProject({
      instanceId: db.instanceId,
      createdByClientId: db.actor.accessClientId,
      kind: "design",
      name: `runtime-${kind}`,
      slug: randomUUID(),
      canvasName: "Generation canvas",
      description: null,
      workDir: db.context.scope.rootDirectory,
    });
    if (!canvas) throw new Error("Design canvas missing");
    const preparation = await tasks.prepareCreation(db.actor, canvas.id);
    if (!preparation) throw new Error("Design Task preparation missing");
    const task = await createChatRepository(db.persistence).createSession(
      db.instanceId,
      {
        canvasId: canvas.id,
        threadId: randomUUID(),
        createdByClientId: db.actor.accessClientId,
        designTaskPreparation: preparation,
      },
    );
    if (!task) throw new Error("Design Task missing");
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
        ownerKind: "design",
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
      tasks,
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
        await tasks.close();
        await db.close();
      },
    };
  } catch (error) {
    await tasks.close();
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
    { actor: f.actor, scopeHandle: f.scopeHandle },
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
          if (kind === "video") {
            expect(f.canvasService.insertVideoElement).toHaveBeenCalledWith(
              f.actor,
              expect.objectContaining({
                assetId: "asset-video-1",
                canvasId: f.canvasId,
              }),
            );
          }
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
