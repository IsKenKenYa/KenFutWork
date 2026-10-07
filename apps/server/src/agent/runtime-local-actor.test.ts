import type { StreamEvent } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import type { SubmitImageJobFn } from "../features/generation/tool-types.js";
import { AgentRunEventBus, ToolRegistryImpl } from "../kernel/context.js";
import type { KenFutWorkAgent, KenFutWorkAgentFactory } from "./deep-agent.js";
import { createAgentRunService } from "./runtime.js";
import {
  createRuntimeTestInstance,
  RUNTIME_TEST_ACTOR,
} from "./runtime-test-fixtures.js";

vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));
const INPUT = {
  sessionId: "session",
  conversationId: "conversation",
  canvasId: "canvas",
  prompt: "BYOK",
};
function fixture(action?: () => Promise<void>, tools?: ToolRegistryImpl) {
  const configurations: unknown[] = [];
  const toolContexts: unknown[] = [];
  const agentFactory: KenFutWorkAgentFactory = (options) => {
    toolContexts.push(options.runToolContext);
    return {
      streamEvents: async function* (
        _input: unknown,
        configuration?: { configurable?: unknown },
      ) {
        configurations.push(configuration?.configurable);
        await action?.();
        yield { event: "__test_noop__" };
      },
    } as unknown as KenFutWorkAgent;
  };
  const runtime = createAgentRunService({
    localInstance: createRuntimeTestInstance(),
    agentFactory,
    blob: {} as never,
    env: {
      agentBackendMode: "state",
      agentModel: "fixture",
      port: 0,
      version: "test",
      webOrigin: "http://127.0.0.1",
    },
    ...(tools ? { tools } : {}),
  });
  return { runtime, configurations, toolContexts };
}
async function collect(
  runtime: ReturnType<typeof createAgentRunService>,
  runId: string,
) {
  const events: StreamEvent[] = [];
  for await (const event of runtime.streamRun(runId)) events.push(event);
  return events;
}

describe("Runtime 本地调用身份", () => {
  it("独立Harness替身也不能创建缺少可信actor的运行", () => {
    const { runtime } = fixture();
    expect(() => runtime.createRun(INPUT)).toThrow("可信的本地实例身份");
  });
  it("其他实例actor被真实本地服务拒绝，不创建agent", async () => {
    const { runtime, configurations } = fixture();
    const { runId } = runtime.createRun(INPUT, {
      actor: {
        ...RUNTIME_TEST_ACTOR,
        instanceId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      },
    });
    const events = await collect(runtime, runId);
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      error: { message: expect.stringContaining("当前本地实例") },
    });
    expect(configurations).toEqual([]);
  });
  it("实例及来源客户端传播给工具与graph，额外凭据不会进入配置", async () => {
    const { runtime, configurations, toolContexts } = fixture();
    const actor = { ...RUNTIME_TEST_ACTOR, accessToken: "must-not-persist" };
    const input = { ...INPUT, accessToken: "must-not-persist" };
    const { runId } = runtime.createRun(input, { actor });
    actor.accessClientId = "changed-after-accept";
    const events = await collect(runtime, runId);
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(configurations[0]).toEqual({
      canvas_id: INPUT.canvasId,
      instance_id: RUNTIME_TEST_ACTOR.instanceId,
      access_client_id: RUNTIME_TEST_ACTOR.accessClientId,
    });
    expect(toolContexts[0]).toMatchObject({
      actor: RUNTIME_TEST_ACTOR,
      instanceId: RUNTIME_TEST_ACTOR.instanceId,
    });
    expect(
      JSON.stringify([configurations, toolContexts, events]),
    ).not.toContain("must-not-persist");
  });
  it("无Bearer也能装配异步生成闭包，供应商UUID和模型分开入队", async () => {
    const tools = new ToolRegistryImpl(new AgentRunEventBus());
    let submit: SubmitImageJobFn | undefined;
    tools.registerDynamic({
      id: "test-capture",
      scope: "design",
      resolve(context) {
        submit = context.submitImageJob;
        return null;
      },
    });
    const createJob = vi.fn(async () => ({ id: "job-1" }));
    const jobService = {
      createJob,
      getJobForWorker: async () => ({
        status: "succeeded",
        result: {
          signed_url: "https://example.invalid/output.png",
          width: 64,
          height: 64,
          mime_type: "image/png",
        },
      }),
      cancelJob: vi.fn(),
    };
    const providerId = "11111111-2222-4333-8444-555555555555";
    let generated: Awaited<ReturnType<SubmitImageJobFn>> | undefined;
    const agentFactory: KenFutWorkAgentFactory = () =>
      ({
        streamEvents: async function* () {
          if (!submit) throw new Error("生成闭包未装配");
          generated = await submit({
            prompt: "BYOK",
            title: "test",
            model: `${providerId}:image-model`,
            aspectRatio: "1:1",
          });
          yield { event: "__test_noop__" };
        },
      }) as unknown as KenFutWorkAgent;
    const runtime = createAgentRunService({
      localInstance: createRuntimeTestInstance(),
      tools,
      jobService: jobService as never,
      agentFactory,
      blob: {} as never,
      env: {
        agentBackendMode: "state",
        agentModel: "fixture",
        port: 0,
        version: "test",
        webOrigin: "http://127.0.0.1",
      },
    });
    const { runId } = runtime.createRun(INPUT, { actor: RUNTIME_TEST_ACTOR });
    expect((await collect(runtime, runId)).at(-1)?.type).toBe("run.completed");
    expect(createJob).toHaveBeenCalledWith(
      RUNTIME_TEST_ACTOR,
      expect.objectContaining({
        jobType: "image_generation",
        payload: expect.objectContaining({
          model: "image-model",
          provider_instance_id: providerId,
        }),
      }),
    );
    expect(generated).toMatchObject({
      jobId: "job-1",
      imageUrl: "https://example.invalid/output.png",
    });
  });
});
