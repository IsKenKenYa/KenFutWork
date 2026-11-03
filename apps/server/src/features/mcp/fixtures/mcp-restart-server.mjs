import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// 真实 stdio MCP 服务：用于验证掉线自动重启，不是替身。
const server = new Server(
  { name: "mcp-restart-fixture", version: "1" },
  { capabilities: { tools: {} } },
);

const exitMs = Number(process.env.MCP_TEST_EXIT_MS ?? 0);
const stateFile = process.env.MCP_TEST_STATE_FILE;
let exitScheduled = false;

function scheduleExitAfterFirstList() {
  if (exitScheduled || exitMs <= 0) return;
  exitScheduled = true;
  let shouldExit = true;
  if (stateFile) {
    if (existsSync(stateFile)) shouldExit = false;
    else {
      writeFileSync(stateFile, "1", "utf8");
      shouldExit = true;
    }
  }
  if (!shouldExit) return;
  // 等工具清单响应送达后再退出，确保服务端已完成注册。
  setTimeout(() => process.exit(1), exitMs);
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  scheduleExitAfterFirstList();
  return {
    tools: [
      {
        name: "echo",
        description: "回显文本",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [
    {
      type: "text",
      text: String(request.params.arguments?.text ?? ""),
    },
  ],
}));

const logFile = process.env.MCP_TEST_LOG_FILE;
if (logFile) appendFileSync(logFile, "start\n", "utf8");

await server.connect(new StdioServerTransport());
