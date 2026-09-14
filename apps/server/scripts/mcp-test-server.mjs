/**
 * 测试用 MCP server 夹具（stdio）：一个 `add_numbers` 工具，用于验证
 * 「配置 → 起进程 → 握手 → listTools → 注册 → 调用 → 断连注销」整条生命周期。
 *
 * 独立脚本（不经 tsx）：由 StdioClientTransport 以 `node` 直接拉起，
 * 与真实第三方 MCP server 的启动形态一致。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "loomic-test-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "add_numbers",
      description: "把两个数字相加（测试夹具）",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  if (request.params.name !== "add_numbers") {
    throw new Error(`unknown tool: ${request.params.name}`);
  }
  return {
    content: [{ type: "text", text: String((args.a ?? 0) + (args.b ?? 0)) }],
  };
});

await server.connect(new StdioServerTransport());
