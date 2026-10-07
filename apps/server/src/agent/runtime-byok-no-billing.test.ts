import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamEvent } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createLocalInstanceService } from "../features/local-instance/service.js";
import { AgentRunEventBus, ToolRegistryImpl } from "../kernel/context.js";
import type { KenFutWorkAgent, KenFutWorkAgentFactory } from "./deep-agent.js";
import { createAgentRunService } from "./runtime.js";

const instanceId = "73270d3f-fbef-4ae3-ae13-645862e7fc62";
const providerId = "942e7273-6261-4c42-a0f0-1e43ae1290c5";
const actor = { instanceId, accessClientId: null };
const credentials = { apiKey: "test-key", protocol: "openai-compatible" };

describe("BYOK运行时退役计费门", () => {
  it.each(["chat", "image", "video"] as const)(
    "%s沿原模型/生成路径完成，禁止读取任何旧计费或供应商账户作用域",
    async (kind) => {
      const results: unknown[] = [];
      const created = vi.fn(
        async (_actor: unknown, _input: Record<string, unknown>) => ({
          id: "generated-job",
        }),
      );
      const resolveCredentials = vi.fn(
        async (_actor: unknown, _providerId: string) => credentials,
      );
      const getInstanceScope = vi.fn(() => {
        throw new Error("BYOK不读取账户/平台供应商作用域");
      });
      const readBilling = vi.fn(() => {
        throw new Error("BYOK不读取计费服务");
      });
      const updates: Array<Record<string, unknown>> = [];
      const agentFactory: KenFutWorkAgentFactory = (options) =>
        ({
          streamEvents: async function* () {
            const resolution = options.extensionContext?.resolution;
            if (kind === "image") {
              if (!resolution?.submitImageJob)
                throw new Error("图片生成未接入运行时");
              results.push(
                await resolution.submitImageJob({
                  prompt: "图片",
                  title: "生成图片",
                  model: `${providerId}:byok-image`,
                  aspectRatio: "1:1",
                }),
              );
            }
            if (kind === "video") {
              if (!resolution?.submitVideoJob)
                throw new Error("视频生成未接入运行时");
              results.push(
                await resolution.submitVideoJob({
                  prompt: "视频",
                  model: `${providerId}:byok-video`,
                  resolution: "1080p",
                }),
              );
            }
            yield { event: "__test_noop__" };
          },
        }) as KenFutWorkAgent;
      const options: Parameters<typeof createAgentRunService>[0] = {
        agentFactory,
        tools: new ToolRegistryImpl(new AgentRunEventBus()),
        blob: {} as never,
        env: {
          agentBackendMode: "state",
          agentModel: "fixture",
          port: 0,
          version: "test",
          webOrigin: "http://localhost:3000",
        },
        localInstance: createLocalInstanceService({
          repository: { ensure: async () => instanceId },
          dataDir: join(tmpdir(), "kfw-byok-billing-runtime"),
        }),
        modelProviders: { resolveCredentials, getInstanceScope } as never,
        jobService: {
          createJob: created,
          getJobForWorker: async () => ({
            status: "succeeded",
            result: {
              signed_url: "https://example.invalid/generated",
              width: 64,
              height: 64,
            },
          }),
        } as never,
        agentPersistenceService: {
          getPersistence: async () => ({ checkpointer: null, store: null }),
        } as never,
        agentRunMetadataService: {
          updateRun: async (input: Record<string, unknown>) => {
            updates.push(input);
          },
        } as never,
      };
      // 回归曾经可注入的旧字段；读取就失败，不提供空计费实现。
      Object.defineProperties(options, {
        creditService: { get: readBilling },
        tierGuard: { get: readBilling },
      });
      const runtime = createAgentRunService(options);
      const { runId } = runtime.createRun(
        {
          canvasId: "design-canvas",
          conversationId: "conversation",
          prompt: "请求",
          sessionId: "session",
        },
        { actor, model: `${providerId}:byok-model`, threadId: "byok-thread" },
      );
      const events: StreamEvent[] = [];
      for await (const event of runtime.streamRun(runId)) events.push(event);
      expect(
        events.filter(
          (event) =>
            event.type === "run.failed" || event.type === "run.canceled",
        ),
      ).toEqual([]);
      expect(
        events.filter((event) => event.type === "run.completed"),
      ).toHaveLength(1);
      expect(updates.at(-1)).toMatchObject({ runId, status: "completed" });
      expect(resolveCredentials).toHaveBeenCalledOnce();
      expect(resolveCredentials.mock.calls[0]?.[1]).toBe(providerId);
      expect(getInstanceScope).not.toHaveBeenCalled();
      expect(readBilling).not.toHaveBeenCalled();
      if (kind === "chat") {
        expect(created).not.toHaveBeenCalled();
      } else {
        expect(created).toHaveBeenCalledOnce();
        expect(created.mock.calls[0]?.[1]).toMatchObject({
          jobType: `${kind}_generation`,
        });
        expect(results).toEqual([
          expect.objectContaining({ jobId: "generated-job" }),
        ]);
      }
    },
  );
});
