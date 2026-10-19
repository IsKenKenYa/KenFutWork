import { providerInstanceResponseSchema } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { loadServerEnv } from "../config/env.js";
import { createGenerationPlugin } from "../features/generation/plugin.js";
import { createModelCatalogService } from "../features/model-providers/model-catalog-service.js";
import type { AvailableVideoModel } from "../generation/types.js";
import { AgentRunEventBus, ToolRegistryImpl } from "../kernel/context.js";
import type { ToolDefinition } from "../kernel/types.js";
import type { KenFutWorkAgent, KenFutWorkAgentFactory } from "./deep-agent.js";
import { createAgentRunService } from "./runtime.js";
import {
  createRuntimeTestInstance,
  RUNTIME_TEST_ACTOR,
} from "./runtime-test-fixtures.js";

// Real ModelCatalogService -> Runtime -> GenerationPlugin -> public tool factory.
// Model provider storage is the fixture seam; no network, model inference, queue, or PG.
const providerId = "11111111-1111-4111-8111-111111111111";
const caps = {
  durations: [1, 5, 10],
  resolutions: ["480p", "768p", "1080p"],
  aspectRatios: ["16:9", "9:16"],
  referenceImages: 9,
  audio: false,
};
async function projection() {
  const localInstance = createRuntimeTestInstance();
  const provider = providerInstanceResponseSchema.parse({
    id: providerId,
    scope: "local",
    name: "本机视频目录",
    protocol: "grsai",
    configRevision: 1,
    hasCredential: true,
    headerKeys: [],
    enabled: true,
    models: [
      {
        id: "minimax-h3",
        name: "H3",
        capability: "video",
        videoGeneration: caps,
      },
      { id: "unknown-video", name: "Unknown", capability: "video" },
    ],
  });
  const catalog = createModelCatalogService({
    localInstance,
    modelProviders: { listInstances: async () => [provider] },
  });
  const env = loadServerEnv(
    {},
    { agentBackendMode: "state", agentModel: "fixture" },
  );
  const tools = new ToolRegistryImpl(new AgentRunEventBus());
  const plugin = createGenerationPlugin({ env });
  if (!plugin.apply) throw new Error("生成插件未提供装配入口。");
  plugin.apply({
    get: (key: string) => {
      if (key !== "tools") throw new Error(`意外装配服务：${key}`);
      return tools;
    },
  } as never);
  let models: AvailableVideoModel[] | undefined;
  let tool: ToolDefinition | undefined;
  const agentFactory: KenFutWorkAgentFactory = (options) => {
    models = options.extensionContext?.resolution?.availableVideoModels;
    tool = options.kernelTools?.find(
      (definition) => definition.name === "generate_video",
    );
    return {
      streamEvents: async function* () {
        yield {
          event: "on_chat_model_stream",
          data: { chunk: { content: "已读取当前视频模型能力。" } },
        };
      },
    } as unknown as KenFutWorkAgent;
  };
  const runtime = createAgentRunService({
    localInstance,
    agentFactory,
    blob: {} as never,
    env,
    modelCatalog: catalog,
    tools,
  });
  const { runId } = runtime.createRun(
    {
      sessionId: "catalog-projection-session",
      conversationId: "catalog-projection-conversation",
      canvasId: "catalog-projection-canvas",
      preset: "design",
      prompt: "检查声明的视频能力",
    },
    { actor: RUNTIME_TEST_ACTOR },
  );
  const events = [];
  for await (const event of runtime.streamRun(runId)) events.push(event);
  expect(events.at(-1)?.type).toBe("run.completed");
  if (!models || !tool) throw new Error("真实Run未装配视频工具投影。");
  return { models, tool };
}

describe("真实目录进入Run的视频工具投影", () => {
  it("原样保留模型声明，不能被固定15秒/4图/720p能力覆盖", async () => {
    const f = await projection();
    expect(
      f.models.find((model) => model.id === `${providerId}:minimax-h3`),
    ).toMatchObject({
      videoGeneration: caps,
      capabilities: { imageToVideo: true, audio: false },
    });
    expect(f.tool.parameters).toMatchObject({
      properties: { model: { description: expect.stringContaining("768p") } },
    });
    expect(
      f.tool.zodSchema?.safeParse({
        title: "纸鹤",
        prompt: "A paper crane takes flight",
        model: `${providerId}:minimax-h3`,
        duration: 1,
        resolution: "768p",
        aspectRatio: "16:9",
        inputImages: Array.from(
          { length: 9 },
          (_, index) => `https://example.invalid/${index}.png`,
        ),
      }).success,
    ).toBe(true);
  });
  it("无模型能力元数据保持未知，不注入支持或不支持以及固定上限", async () => {
    const f = await projection();
    const unknown = f.models.find(
      (model) => model.id === `${providerId}:unknown-video`,
    );
    expect(unknown?.capabilities).toEqual({});
    expect(unknown?.limits).toEqual({});
  });
});
