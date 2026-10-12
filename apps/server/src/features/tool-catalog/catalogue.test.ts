import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage } from "@langchain/core/messages";
import type { AgentMiddleware } from "langchain";
import { expect, it } from "vitest";
import { createRuntimeTestInstance } from "../../agent/runtime-test-fixtures.js";
import { AgentRunEventBus, ToolRegistryImpl } from "../../kernel/context.js";
import type { StoredExecutionScope } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createToolCatalogueMiddleware } from "./catalogue.js";

it("下一模型请求重新核验真实scope代际，收紧权限撤销旧激活和写入schema", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "kfw-tool-catalog-"));
  try {
    const root = await realpath(temporary);
    const stored: StoredExecutionScope = {
      preset: "code",
      state: "ready",
      branchGeneration: 1,
      scope: {
        instanceId: "00000000-0000-4000-8000-000000000001",
        projectId: "00000000-0000-4000-8000-000000000002",
        taskId: "00000000-0000-4000-8000-000000000003",
        generation: 1,
        rootDirectory: root,
        additionalDirectories: [],
        sandboxMode: "workspace-write",
      },
    };
    const scopes = createExecutionScopes({
      repository: { load: async () => structuredClone(stored) },
      localInstance: createRuntimeTestInstance(stored.scope.instanceId),
    });
    const handle = await scopes.openTask(
      { instanceId: stored.scope.instanceId, accessClientId: null },
      stored.scope.taskId,
    );
    const registry = new ToolRegistryImpl(new AgentRunEventBus());
    registry.register({
      name: "Read",
      scope: "code",
      exposure: "core",
      access: "read",
      description: "read a file",
      parameters: { type: "object" },
      execute: async () => "read",
    });
    registry.register({
      name: "Write",
      scope: "code",
      exposure: "core",
      access: "write",
      description: "write a file",
      parameters: { type: "object" },
      execute: async () => "write",
    });
    registry.register({
      name: "mcp__docs__lookup",
      scope: "shared",
      exposure: "deferred",
      access: "read",
      description: "lookup reference docs",
      parameters: { type: "object" },
      execute: async () => "docs",
    });
    const middleware = createToolCatalogueMiddleware(
      {
        registry,
        resolution: {
          preset: "code",
          backendFactory: () => handle.backend,
          scopeHandle: handle,
        },
        execution: { scopeHandle: handle },
      },
      { generation: 1, names: new Set(["mcp__docs__lookup"]) },
      async () => 5,
    );
    const modelToolNames = async () => {
      let names: string[] = [];
      const request = { tools: [], messages: [] } as unknown as Parameters<
        NonNullable<AgentMiddleware["wrapModelCall"]>
      >[0];
      const wrap = middleware.wrapModelCall;
      if (!wrap) throw new Error("Native catalogue middleware missing");
      await wrap(request, async (next) => {
        names = next.tools.map((tool) => String(tool.name));
        return new AIMessage("done");
      });
      return names;
    };
    expect(await modelToolNames()).toEqual([
      "Read",
      "Write",
      "mcp__docs__lookup",
      "ToolSearch",
    ]);
    stored.scope.generation = 2;
    stored.scope.sandboxMode = "read-only";
    expect(await modelToolNames()).toEqual(["Read", "ToolSearch"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it("next native model request receives the current dynamic schema even for an existing name", async () => {
  const registry = new ToolRegistryImpl(new AgentRunEventBus());
  let revision = "before";
  registry.registerDynamic({
    id: "changing-core",
    scope: "code",
    resolve: () => ({
      name: "CurrentDynamic",
      exposure: "core",
      scope: "code",
      access: "read",
      description: "current dynamic enum",
      parameters: {
        type: "object",
        properties: { revision: { type: "string", enum: [revision] } },
        required: ["revision"],
        additionalProperties: false,
      },
      execute: async () => revision,
    }),
  });
  const middleware = createToolCatalogueMiddleware(
    {
      registry,
      resolution: {
        preset: "code",
        backendFactory: () => {
          throw new Error("No backend use");
        },
      },
      execution: {},
    },
    { generation: 0, names: new Set() },
    async () => 5,
  );
  const wrap = middleware.wrapModelCall;
  if (!wrap) throw new Error("Native catalogue middleware missing");
  let exposed: Parameters<
    NonNullable<AgentMiddleware["wrapModelCall"]>
  >[0]["tools"] = [];
  const request = { tools: [], messages: [] } as unknown as Parameters<
    NonNullable<AgentMiddleware["wrapModelCall"]>
  >[0];
  await wrap(request, async (next) => {
    exposed = next.tools;
    return new AIMessage("before");
  });
  revision = "after";
  await wrap({ ...request, tools: exposed }, async (next) => {
    const current = next.tools.find(
      (candidate) => candidate.name === "CurrentDynamic",
    );
    if (!current || !("schema" in current))
      throw new Error("Actual model request lacks current schema");
    const schema = current.schema;
    if (
      !schema ||
      typeof schema !== "object" ||
      !("parse" in schema) ||
      typeof schema.parse !== "function"
    )
      throw new Error("Expected native tool schema");
    const parse = schema.parse;
    expect(parse({ revision: "after" })).toEqual({ revision: "after" });
    expect(() => parse({ revision: "before" })).toThrow();
    return new AIMessage("after");
  });
});
