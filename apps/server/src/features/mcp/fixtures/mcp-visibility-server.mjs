import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const resourcesOnly = process.argv.includes("--resources-only");

// 独立本机 MCP 服务，通过实际 stdio 协议读取工具声明并记录真实调用。
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    let result;
    if (request.method === "initialize") {
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: resourcesOnly
          ? { resources: {} }
          : {
              tools: {},
              experimental: { "kenfutwork.computer-use": { version: 1 } },
            },
        serverInfo: { name: "visibility", version: "1" },
      };
    } else if (resourcesOnly && request.method === "resources/read") {
      result = {
        contents: [
          {
            uri: request.params.uri,
            text: readFileSync(join(process.cwd(), "notes.txt"), "utf8"),
          },
        ],
      };
    } else if (!resourcesOnly && request.method === "tools/list") {
      result = {
        tools: JSON.parse(
          readFileSync(join(process.cwd(), "tools.json"), "utf8"),
        ),
      };
    } else if (request.method === "tools/call") {
      appendFileSync(
        join(process.cwd(), "calls.jsonl"),
        `${JSON.stringify(request.params)}\n`,
      );
      result = {
        content: [{ type: "text", text: `executed:${request.params.name}` }],
      };
    } else {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`,
      );
      return;
    }
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
    );
  })
  .on("close", () => process.exit(0));
