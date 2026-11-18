import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { expect, it } from "vitest";
import { createKenFutWorkDeepAgent } from "../../agent/deep-agent.js";
import { createRuntimeTestInstance } from "../../agent/runtime-test-fixtures.js";
import type { ServerEnv } from "../../config/env.js";
import {
  AgentRunEventBus,
  SystemPromptRegistryImpl,
  ToolRegistryImpl,
} from "../../kernel/context.js";
import type { ToolExecutionContext } from "../../kernel/types.js";
import { executionScopePromptSection } from "../execution/prompt.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createPermissionService } from "../permissions/permission-service.js";
import { createToolCatalogueMiddleware } from "./catalogue.js";

class ScriptedModel extends BaseChatModel {
  readonly requestedTools: string[][] = [];
  readonly requestedPrompts: string[] = [];
  readonly requestedMessages: BaseMessage[][] = [];
  private names: string[] = [];
  private next = 0;
  constructor(
    private readonly answers: AIMessage[],
    private readonly afterRequest?: (ordinal: number) => void,
  ) {
    super({ disableStreaming: true });
  }
  _llmType() {
    return "catalogue-test";
  }
  bindTools(tools: Parameters<NonNullable<BaseChatModel["bindTools"]>>[0]) {
    this.names = tools.map((tool) =>
      "name" in tool ? String(tool.name) : "opaque",
    );
    return this;
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.requestedTools.push([...this.names]);
    this.requestedMessages.push([..._messages]);
    this.requestedPrompts.push(
      _messages
        .filter((message) => SystemMessage.isInstance(message))
        .map((message) => message.text)
        .join("\n"),
    );
    const answer = this.answers[this.next++];
    this.afterRequest?.(this.next);
    if (!answer) throw new Error("模型不应重复请求工具，script已完成");
    return {
      generations: [
        {
          message: answer,
          text: typeof answer.content === "string" ? answer.content : "",
        },
      ],
    };
  }
}

it("真实SDK graph跨Run复用deferred激活并在授权代际变化后撤销", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-catalog-sdk-")),
  );
  try {
    const scope = {
      instanceId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000002",
      taskId: "00000000-0000-4000-8000-000000000003",
      generation: 1,
      rootDirectory: directory,
      additionalDirectories: [],
      sandboxMode: "workspace-write" as const,
    };
    const scopes = createExecutionScopes({
      repository: {
        load: async () => ({
          preset: "code",
          scope: structuredClone(scope),
          state: "ready",
          branchGeneration: 1,
        }),
      },
      localInstance: createRuntimeTestInstance(scope.instanceId),
    });
    const handle = await scopes.openTask(
      { instanceId: scope.instanceId, accessClientId: null },
      scope.taskId,
    );
    const permissions = createPermissionService();
    const bus = new AgentRunEventBus();
    bus.on("tool-pre-execute", async (payload, next) => {
      if (payload.permissionInvocation) {
        const decision = await permissions.admit(payload.permissionInvocation);
        return next({ ...payload, decision: decision.decision });
      }
      return next(payload);
    });
    const registry = new ToolRegistryImpl(bus, () => permissions);
    let called = 0;
    const cuaOutput = {
      modelContent: [
        { type: "text" as const, text: "Finder (com.apple.finder)" },
      ],
      canonicalOutput: {
        content: [{ type: "text" as const, text: "Finder (com.apple.finder)" }],
        structuredContent: {
          apps: [{ name: "Finder", bundle_id: "com.apple.finder" }],
        },
      },
      display: {
        kind: "cua",
        schemaVersion: 1,
        toolName: "list_apps",
        status: "success",
        text: "Finder (com.apple.finder)",
        structuredContent: JSON.stringify({
          apps: [{ name: "Finder", bundle_id: "com.apple.finder" }],
        }),
        media: [],
      },
    };
    registry.register({
      name: "mcp__computer-use__list_apps",
      scope: "code",
      exposure: "deferred",
      access: "read",
      description: "List running desktop applications for computer use",
      parameters: { type: "object" },
      execute: async () => {
        called += 1;
        return cuaOutput;
      },
    });
    const executionFor = (runHandle: typeof handle): ToolExecutionContext => ({
      actor: { instanceId: scope.instanceId, accessClientId: null },
      scopeHandle: runHandle,
      runId: "sdk-run",
      sessionId: scope.taskId,
      instanceId: scope.instanceId,
      codeApproval: {
        ceiling: "build",
        resolve: async () => ({
          mode: "build",
          scopeGeneration: 1,
          branchGeneration: 1,
        }),
      },
    });
    const resolutionFor = (runHandle: typeof handle) => ({
      preset: "code" as const,
      backendFactory: () => runHandle.backend,
      scopeHandle: runHandle,
    });
    const prompts = new SystemPromptRegistryImpl();
    prompts.register(executionScopePromptSection);
    let fragment = "plugin-guidance-v1";
    prompts.register({
      name: "test.plugin",
      scope: "code",
      order: 150,
      resolve: () => fragment,
    });
    const model = new ScriptedModel(
      [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "unactivated",
              name: "mcp__computer-use__list_apps",
              args: {},
            },
          ],
        }),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "search",
              name: "ToolSearch",
              args: { query: "computer use apps" },
            },
          ],
        }),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "activated-first-run",
              name: "mcp__computer-use__list_apps",
              args: {},
            },
          ],
        }),
        new AIMessage("evidence received"),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "activated-second-run",
              name: "mcp__computer-use__list_apps",
              args: {},
            },
          ],
        }),
        new AIMessage("apps listed again"),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "stale-after-revoke",
              name: "mcp__computer-use__list_apps",
              args: {},
            },
          ],
        }),
        new AIMessage("tool is no longer available"),
      ],
      (ordinal) => {
        if (ordinal === 1) fragment = "plugin-guidance-v2";
      },
    );
    const activation = { generation: 1, names: new Set<string>() };
    const createAgent = (runHandle: typeof handle) => {
      const execution = executionFor(runHandle);
      const resolution = resolutionFor(runHandle);
      return createKenFutWorkDeepAgent({
        preset: "code",
        systemPrompt: "test",
        env: {
          agentModel: "test",
          version: "test",
          port: 0,
          webOrigin: "http://localhost",
        } as ServerEnv,
        model,
        backendResult: {
          factory: () => runHandle.backend,
          sandboxDir: directory,
          ephemeral: false,
        },
        runToolContext: execution,
        extensionContext: {
          registry,
          resolution,
          execution,
          prompt: { registry: prompts, composition: { preset: "code" } },
        },
        kernelTools: registry.resolveRunTools(resolution).map((definition) => ({
          ...definition,
          execute: (args, context) =>
            registry.executeDefinition(definition, args, context),
        })),
        runExtensions: [
          {
            preset: "code",
            createMiddleware: (_identity, context) =>
              createToolCatalogueMiddleware(
                context!,
                activation,
                async () => 5,
              ),
          },
        ],
        llmRetry: { maxAttempts: 1, infinite: false },
      });
    };
    const agent = createAgent(handle);
    for await (const _event of agent.streamEvents(
      { messages: [new HumanMessage("list desktop apps")] },
      { version: "v2", recursionLimit: 20 },
    )) {
    }
    expect(called).toBe(1);
    expect(model.requestedTools).toHaveLength(4);
    expect(model.requestedTools[0]).not.toContain(
      "mcp__computer-use__list_apps",
    );
    expect(model.requestedTools[1]).not.toContain(
      "mcp__computer-use__list_apps",
    );
    expect(model.requestedTools[2]).toContain("mcp__computer-use__list_apps");
    expect(model.requestedPrompts[0]).toContain(directory);
    expect(model.requestedPrompts[0]).toContain("plugin-guidance-v1");
    expect(model.requestedPrompts[1]).toContain("plugin-guidance-v2");
    expect(model.requestedPrompts[1]).not.toContain("plugin-guidance-v1");

    const firstRunRequest = model.requestedMessages.at(3);
    if (!firstRunRequest) throw new Error("首轮最终模型请求缺失");
    const firstRunHistory = firstRunRequest.filter(
      (message) => !SystemMessage.isInstance(message),
    );
    expect(
      firstRunHistory.some(
        (message) =>
          AIMessage.isInstance(message) &&
          (message.tool_calls ?? []).some((call) => call.name === "ToolSearch"),
      ),
    ).toBe(true);
    expect(
      firstRunHistory.some(
        (message) =>
          AIMessage.isInstance(message) &&
          (message.tool_calls ?? []).some(
            (call) => call.name === "mcp__computer-use__list_apps",
          ),
      ),
    ).toBe(true);
    expect(
      firstRunHistory.some(
        (message) =>
          message.getType() === "tool" &&
          JSON.stringify(message.content).includes(
            "mcp__computer-use__list_apps",
          ),
      ),
    ).toBe(true);
    expect(
      firstRunHistory.some(
        (message) =>
          message.getType() === "tool" &&
          JSON.stringify(message.content).includes("com.apple.finder"),
      ),
    ).toBe(true);

    for await (const _event of agent.streamEvents(
      {
        messages: [
          ...firstRunHistory,
          new HumanMessage("list desktop apps again"),
        ],
      },
      { version: "v2", recursionLimit: 20 },
    )) {
    }
    expect(model.requestedTools[4]).toContain("mcp__computer-use__list_apps");
    expect(called).toBe(2);

    scope.generation = 2;
    const nextGenerationHandle = await scopes.openTask(
      { instanceId: scope.instanceId, accessClientId: null },
      scope.taskId,
    );
    const nextGenerationAgent = createAgent(nextGenerationHandle);
    for await (const _event of nextGenerationAgent.streamEvents(
      {
        messages: [...firstRunHistory, new HumanMessage("list desktop apps")],
      },
      { version: "v2", recursionLimit: 20 },
    )) {
    }
    expect(model.requestedTools[6]).not.toContain(
      "mcp__computer-use__list_apps",
    );
    expect(called).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
