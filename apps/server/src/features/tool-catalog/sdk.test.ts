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

it("真实SDK graph先拒绝未激活调用，ToolSearch之后才绑定与执行可选工具", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-catalog-sdk-")),
  );
  try {
    const scope = {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000002",
      taskId: "00000000-0000-4000-8000-000000000003",
      generation: 1,
      rootDirectory: directory,
      additionalDirectories: [],
      sandboxMode: "workspace-write" as const,
    };
    const handle = await createExecutionScopes({
      repository: {
        load: async () => ({ scope, state: "ready", branchGeneration: 1 }),
      },
      viewerService: {
        resolveWorkspace: async () => ({ id: scope.workspaceId }),
      } as never,
    }).openTask(
      { id: "owner", email: "", accessToken: "", userMetadata: {} },
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
    registry.register({
      name: "mcp__docs__lookup",
      scope: "shared",
      exposure: "deferred",
      access: "read",
      description: "lookup documents",
      parameters: { type: "object" },
      execute: async () => {
        called += 1;
        return "source evidence";
      },
    });
    const execution: ToolExecutionContext = {
      scopeHandle: handle,
      runId: "sdk-run",
      sessionId: scope.taskId,
      userId: "owner",
      codeApproval: {
        ceiling: "build",
        resolve: async () => ({
          mode: "build",
          scopeGeneration: 1,
          branchGeneration: 1,
        }),
      },
    };
    const resolution = {
      preset: "code" as const,
      backendFactory: () => handle.backend,
      scopeHandle: handle,
    };
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
            { id: "unactivated", name: "mcp__docs__lookup", args: {} },
          ],
        }),
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "search", name: "ToolSearch", args: { query: "lookup" } },
          ],
        }),
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "activated", name: "mcp__docs__lookup", args: {} },
          ],
        }),
        new AIMessage("evidence received"),
      ],
      (ordinal) => {
        if (ordinal === 1) fragment = "plugin-guidance-v2";
      },
    );
    const agent = createKenFutWorkDeepAgent({
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
        factory: () => handle.backend,
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
              { generation: 1, names: new Set() },
              async () => 5,
            ),
        },
      ],
      llmRetry: { maxAttempts: 1, infinite: false },
    });
    for await (const _event of agent.streamEvents(
      { messages: [new HumanMessage("lookup docs")] },
      { version: "v2", recursionLimit: 20 },
    )) {
    }
    expect(called).toBe(1);
    expect(model.requestedTools).toHaveLength(4);
    expect(model.requestedTools[0]).not.toContain("mcp__docs__lookup");
    expect(model.requestedTools[1]).not.toContain("mcp__docs__lookup");
    expect(model.requestedTools[2]).toContain("mcp__docs__lookup");
    expect(model.requestedPrompts[0]).toContain(directory);
    expect(model.requestedPrompts[0]).toContain("plugin-guidance-v1");
    expect(model.requestedPrompts[1]).toContain("plugin-guidance-v2");
    expect(model.requestedPrompts[1]).not.toContain("plugin-guidance-v1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
