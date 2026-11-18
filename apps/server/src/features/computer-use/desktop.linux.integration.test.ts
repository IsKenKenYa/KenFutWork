import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { AGENT_GOVERNANCE_DEFAULTS as d } from "@kenfutwork/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { AgentRunEventBus, ToolRegistryImpl } from "../../kernel/context.js";
import { createLinuxExecutor } from "./executor-linux.js";
import { createComputerUseMcpServer } from "./mcp-server.js";
import { createComputerUseService } from "./service.js";
import { createComputerUseTools } from "./tools.js";

describe.skipIf(
  process.platform !== "linux" || process.env.KENFUTWORK_TEST_DESKTOP !== "1",
)("真实X11/AT-SPI桌面→同Harness/MCP", () => {
  it(
    "发现、树、语义点击、Unicode与坐标输入均验证实际GTK效果",
    async () => {
      const fixture = spawn(
        "python3",
        [
          fileURLToPath(
            new URL("./fixtures/desktop-linux.py", import.meta.url),
          ),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let events = "";
      fixture.stdout!.on("data", (data) => {
        events += String(data);
      });
      const service = createComputerUseService({
        executor: await createLinuxExecutor(),
        governance: () => ({
          actionTimeoutMs: d.computerUseActionTimeoutMs,
          observeMaxBytes: d.computerUseObserveMaxBytes,
          screenshotMaxBytes: d.computerUseScreenshotMaxBytes,
          maxActionsPerRun: d.computerUseMaxActionsPerRun,
          sessionMaxMs: d.computerUseSessionMaxMs,
          inputDelayMs: d.computerUseInputDelayMs,
        }),
      });
      const registry = new ToolRegistryImpl(new AgentRunEventBus());
      for (const tool of createComputerUseTools({
        service,
        gate: async () => ({ ok: true }),
      }))
        registry.register(tool);
      const server = createComputerUseMcpServer({
        registry,
        version: "test",
        resolveContext: async () => ({ runId: "linux-native-test" }),
      });
      const client = new Client({ name: "linux-native-test", version: "test" });
      try {
        await once(fixture.stdout!, "data");
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(b);
        await client.connect(a);
        const app = { pid: fixture.pid! };
        const call = async (
          name: string,
          args: Record<string, unknown> = {},
        ) => {
          const result = (await client.callTool({ name, arguments: args })) as {
            isError?: boolean;
            content: Array<{ type: string; text?: string }>;
            structuredContent?: Record<string, unknown>;
          };
          expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
          return result;
        };
        expect(
          JSON.stringify((await call("list_apps")).structuredContent),
        ).toContain(String(app.pid));
        const state = await call("get_app_state", { app });
        const text = state.content.find((block) => block.type === "text")!
          .text!;
        const button = Number(text.match(/\[(\d+)\] button 验收按钮/)?.[1]);
        expect(Number.isInteger(button), text).toBe(true);
        await call("click", {
          app,
          target: { type: "element", index: button },
        });
        expect(
          JSON.stringify((await call("get_app_state", { app })).content),
        ).toContain("点击数：1");
        const entry = Number(text.match(/\[(\d+)\] textfield 验收输入/)?.[1]);
        expect(Number.isInteger(entry), text).toBe(true);
        await call("type", {
          app,
          text: "中文🙂🚀",
          target: { type: "element", index: entry },
        });
        expect(
          JSON.stringify((await call("get_app_state", { app })).content),
        ).toContain("中文🙂🚀");
        const image = (await call("screenshot", { app })).structuredContent!
          .image as { width: number; height: number; frameId: string };
        const target = {
          type: "coordinate",
          x: image.width / 2,
          y: image.height * 0.8,
          frameId: image.frameId,
        };
        await call("click", { app, target });
        await call("key", { app, keys: ["A"] });
        await call("scroll", { app, target, direction: "down", amount: 2 });
        await call("drag", {
          app,
          from: target,
          to: { ...target, x: image.width * 0.7 },
        });
        expect(events).toContain("EVENT key");
        expect(events).toContain("EVENT scroll");
        expect(events).toContain("EVENT drag");
        await call("stop_computer_control");
      } finally {
        await client.close();
        await server.close();
        await service.dispose();
        if (fixture.exitCode === null) {
          fixture.kill();
          await once(fixture, "exit");
        }
      }
    },
    d.computerUseSessionMaxMs,
  );
});
