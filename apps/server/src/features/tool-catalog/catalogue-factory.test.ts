import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { StreamEvent } from "@kenfutwork/shared";
import { expect, it } from "vitest";
import { z } from "zod";
import { createKenFutWorkDeepAgent } from "../../agent/deep-agent.js";
import {
  createDeepAgentsProvider,
  projectKernelToolExecution,
} from "../../agent/deepagents-provider.js";
import { consumeAgentProviderStream } from "../../agent/provider-contract.js";
import { createAgentProviderTools } from "../../agent/provider-tools.js";
import { createToolExecutionReceipts } from "../../agent/tool-execution-receipts.js";
import { loadServerEnv } from "../../config/env.js";
import type { ToolExecutionContext } from "../../kernel/types.js";
import { createInstanceChatModel } from "../../providers/openai-compatible/index.js";
import { createCodeFileTools } from "../code-tools/tool-definitions.js";
import {
  archiveKernelFixture,
  archiveTaskFixture,
} from "../context-history/test-fixture.js";
import { createToolCatalogueMiddleware } from "./catalogue.js";

type ModelTool = {
  function?: {
    name?: string;
    parameters?: { properties?: { version?: { enum?: string[] } } };
  };
};

it("actual native factory/Catalogue preserves SDK registered tools while refreshing next wire schema and executing current receipts", async () => {
  const task = await archiveTaskFixture();
  const kernel = archiveKernelFixture();
  const requests: Array<{ tools?: ModelTool[] }> = [];
  const executed: string[] = [];
  let version = "before";
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    requests.push(JSON.parse(body));
    const index = requests.length;
    const calls = [
      {
        id: "dynamic-before",
        name: "CurrentDynamic",
        args: { version: "before" },
      },
      {
        id: "dynamic-after",
        name: "CurrentDynamic",
        args: { version: "after" },
      },
      { id: "actual-read", name: "Read", args: { file_path: "evidence.txt" } },
    ];
    const call = calls[index - 1];
    const delta = call
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
              },
            },
          ],
        }
      : { role: "assistant", content: "synthetic checks complete" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ id: `synthetic-${index}`, object: "chat.completion.chunk", created: 1, model: "synthetic", choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await writeFile(
      join(task.identity.rootDirectory, "evidence.txt"),
      "synthetic owned evidence",
    );
    const registry = kernel.get("tools");
    const read = createCodeFileTools({
      backend: task.handle.backend,
      modelCapabilities: { image: false, pdf: false },
    }).find((tool) => tool.name === "Read");
    if (!read) throw new Error("Actual Read missing");
    registry.register(read);
    registry.registerDynamic({
      id: "changing-core-schema",
      scope: "code",
      resolve: () => {
        const schema = z.object({ version: z.enum([version]) }).strict();
        return {
          name: "CurrentDynamic",
          description: "synthetic current version",
          scope: "code",
          exposure: "core",
          access: "read",
          parameters: z.toJSONSchema(schema),
          zodSchema: schema,
          execute: async (args) => {
            executed.push(String(args.version));
            version = "after";
            return args;
          },
        };
      },
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Synthetic model HTTP unavailable");
    const identity = {
      runId: task.execution.runId ?? "synthetic-run",
      sessionId: task.identity.taskId,
      conversationId: task.identity.taskId,
    };
    const receipts = createToolExecutionReceipts({
      ...identity,
      scopeHandle: task.handle,
      project: (fact) => projectKernelToolExecution(fact, identity),
      publish: async () => {},
    });
    const execution = {
      ...task.execution,
      observeToolExecution: receipts.observe,
    };
    const resolution = {
      preset: "code" as const,
      scopeHandle: task.handle,
      backendFactory: () => task.handle.backend,
    };
    const extensionContext = { registry, resolution, execution };
    const initial = registry.resolveRunTools(resolution).map((tool) => ({
      ...tool,
      execute: (args: Record<string, unknown>, context: ToolExecutionContext) =>
        registry.executeDefinition(tool, args, context),
    }));
    const provider = createDeepAgentsProvider({
      createAgent: () =>
        createKenFutWorkDeepAgent({
          env: loadServerEnv({}, {}),
          preset: "code",
          model: createInstanceChatModel("synthetic", {
            apiKey: "fixture",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            useResponsesApi: false,
            invocationMaxRetries: 0,
          }),
          systemPrompt: "Use synthetic tools only",
          backendResult: {
            factory: () => task.handle.backend,
            ephemeral: false,
          },
          kernelTools: initial,
          runToolContext: execution,
          extensionContext,
          nativeToolProof: { identity, observe: receipts.observeNative },
          llmRetry: { maxAttempts: 1, infinite: false },
          runExtensions: [
            {
              preset: "code",
              createMiddleware: () =>
                createToolCatalogueMiddleware(
                  extensionContext,
                  { generation: task.identity.generation, names: new Set() },
                  async () => 5,
                ),
            },
          ],
        }),
      config: () => ({ version: "v2" }),
    });
    const context = {
      systemPrompt: "tool catalogue contract fixture",
      ...identity,
      tools: createAgentProviderTools(registry, resolution, execution),
    };
    const session = await provider.open(context);
    const events: StreamEvent[] = [];
    for await (const event of consumeAgentProviderStream(
      session,
      {
        messages: [
          {
            content: "Check current version twice and read synthetic evidence",
          },
        ],
      },
      context,
      receipts.gate,
    ))
      events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "run.completed" });
    expect(requests).toHaveLength(4);
    const schemaAt = (index: number) =>
      requests[index]?.tools?.find(
        (tool) => tool.function?.name === "CurrentDynamic",
      )?.function?.parameters?.properties?.version?.enum;
    expect(schemaAt(0)).toEqual(["before"]);
    expect(schemaAt(1)).toEqual(["after"]);
    expect(executed).toEqual(["before", "after"]);
    expect(
      events.filter(
        (event) =>
          event.type === "tool.completed" && event.status === "success",
      ),
    ).toHaveLength(3);
    expect(JSON.stringify(events)).toContain("synthetic owned evidence");
    session.release?.();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await kernel.dispose();
    await task.cleanup();
  }
});
