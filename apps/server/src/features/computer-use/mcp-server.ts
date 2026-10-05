import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolExecutionContext, ToolRegistry } from "../../kernel/types.js";
import type { LocalActor } from "../local-instance/types.js";
import { CU_TOOL_PREFIX } from "./tools.js";

export interface ComputerUseMcpExport {
  createServer(actor: LocalActor, runId: string): Server;
}

/** 出口只投影现有Harness工具；安装门、审批、Task边界、取消和结果形状仍由同一执行通路持有。 */
export function createComputerUseMcpServer(options: {
  registry: ToolRegistry;
  version: string;
  resolveContext(signal: AbortSignal): Promise<ToolExecutionContext>;
  execute?(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<unknown>;
}): Server {
  const server = new Server(
    { name: "kenfutwork-computer-use", version: options.version },
    {
      capabilities: {
        tools: {},
        experimental: { "kenfutwork.computer-use": { version: 1 } },
      },
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.registry
      .list("code")
      .filter((tool) => tool.name.startsWith(CU_TOOL_PREFIX))
      .map((tool) => ({
        name: tool.name.slice(CU_TOOL_PREFIX.length),
        description: tool.description,
        inputSchema: tool.parameters as {
          type: "object";
          [key: string]: unknown;
        },
      })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = `${CU_TOOL_PREFIX}${request.params.name}`;
    if (!options.registry.get(name)) throw new Error("未注册的桌面工具");
    const context = await options.resolveContext(extra.signal);
    return CallToolResultSchema.parse(
      await (
        options.execute ??
        ((tool, args, execution) =>
          options.registry.execute(tool, args, execution))
      )(name, request.params.arguments ?? {}, {
        ...context,
        signal: context.signal
          ? AbortSignal.any([extra.signal, context.signal])
          : extra.signal,
      }),
    );
  });
  return server;
}
