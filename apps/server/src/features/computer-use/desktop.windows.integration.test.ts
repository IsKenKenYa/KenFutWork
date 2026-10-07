import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { AGENT_GOVERNANCE_DEFAULTS as d } from "@kenfutwork/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { AgentRunEventBus, ToolRegistryImpl } from "../../kernel/context.js";
import { createWindowsExecutor } from "./executor-windows.js";
import { createComputerUseMcpServer } from "./mcp-server.js";
import { createComputerUseService } from "./service.js";
import { createComputerUseTools } from "./tools.js";

const enabled =
  process.platform === "win32" && process.env.KENFUTWORK_TEST_DESKTOP === "1";
describe.skipIf(!enabled)("真实Windows登录桌面→同Harness/MCP", () => {
  it(
    "UIA按钮/文本、实际PNG和User32输入均验证WinForms效果",
    async () => {
      const executor = await createWindowsExecutor();
      const service = createComputerUseService({
        executor,
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
        resolveContext: async () => ({ runId: "windows-desktop-test" }),
      });
      const client = new Client({
        name: "windows-desktop-test",
        version: "test",
      });
      const fixture = spawn(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-Sta",
          "-File",
          fileURLToPath(
            new URL("./fixtures/desktop-windows.ps1", import.meta.url),
          ),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let events = "";
      fixture.stdout.on("data", (data) => {
        events += String(data);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const check = () => {
            if (events.includes("READY")) {
              clearTimeout(timer);
              fixture.stdout.off("data", check);
              resolve();
            }
          };
          const timer = setTimeout(() => {
            fixture.stdout.off("data", check);
            reject(new Error("Windows验收窗口未在期限内就绪"));
          }, d.computerUseActionTimeoutMs);
          fixture.stdout.on("data", check);
          check();
        });
        if (!fixture.pid) throw new Error("验收窗口没有真实进程ID");
        const app = { pid: fixture.pid };
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(b);
        await client.connect(a);
        const call = async (
          name: string,
          args: Record<string, unknown> = {},
        ) => {
          const result = await client.callTool({ name, arguments: args });
          expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
          return result;
        };
        expect(
          JSON.stringify((await call("list_apps")).structuredContent),
        ).toContain(String(app.pid));
        expect(
          JSON.stringify(
            (await call("list_windows", { app })).structuredContent,
          ),
        ).toContain("KenFutWork Windows 桌面验收");
        const state = await call("get_app_state", { app });
        const tree = JSON.stringify(state.content);
        const button = Number(tree.match(/\[(\d+)\] button 验收按钮/)?.[1]);
        expect(Number.isInteger(button), tree).toBe(true);
        await call("click", {
          app,
          target: { type: "element", index: button },
        });
        expect(
          JSON.stringify((await call("get_app_state", { app })).content),
        ).toContain("点击数：1");
        const entry = Number(tree.match(/\[(\d+)\] textfield 验收输入/)?.[1]);
        expect(Number.isInteger(entry), tree).toBe(true);
        await call("type", {
          app,
          text: "中文🙂🚀",
          target: { type: "element", index: entry },
        });
        expect(
          JSON.stringify((await call("get_app_state", { app })).content),
        ).toContain("中文🙂🚀");
        const shot = await call("screenshot", { app });
        const image = (
          shot.structuredContent as Record<string, unknown> | undefined
        )?.image as {
          width: number;
          height: number;
          frameId: string;
        };
        expect(image.width).toBeGreaterThan(0);
        const content = shot.content as Array<{ type: string; data?: string }>;
        expect(
          content.some(
            (block) =>
              block.type === "image" &&
              typeof block.data === "string" &&
              block.data.length > 0,
          ),
        ).toBe(true);
        const target = {
          type: "coordinate",
          x: image.width * 0.7,
          y: image.height * 0.8,
          frameId: image.frameId,
        };
        await call("click", { app, target });
        await call("mouse_move", {
          app,
          target: { ...target, x: image.width * 0.6 },
        });
        await call("key", { app, keys: ["A"] });
        await call("scroll", { app, target, direction: "down", amount: 2 });
        await call("drag", {
          app,
          from: target,
          to: { ...target, x: image.width * 0.5 },
        });
        expect(events).toContain("EVENT key");
        expect(events).toContain("EVENT scroll");
        expect(events).toContain("EVENT drag");
        const foreign = await registry.execute(
          "mcp__computer-use__click",
          { app, target },
          { runId: "foreign-windows-run" },
        );
        expect((foreign as { isError?: boolean }).isError).toBe(true);
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
