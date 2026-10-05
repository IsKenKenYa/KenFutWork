import { fileURLToPath } from "node:url";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  AGENT_GOVERNANCE_LIMITS,
} from "@kenfutwork/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "../../kernel/types.js";
import { flattenAxTree } from "./ax-tree.js";
import { CU_AX_DEFAULT_LIMITS } from "./executor.js";
import { createMcpComputerUseExecutor } from "./mcp-backend.js";

/** 验证真实SDK/stdio wire边界，不替代OS、库存、Task权限或HTTP验收。 */
async function withPeer(
  mode: string,
  run: (
    executor: ReturnType<typeof createMcpComputerUseExecutor>,
    client: Client,
  ) => Promise<void>,
  context: () => ToolExecutionContext = () => ({}),
) {
  const client = new Client({ name: "desktop-adapter-test", version: "test" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      fileURLToPath(new URL("./fixtures/mcp-peer.ts", import.meta.url)),
      mode,
    ],
    env: {},
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const executor = createMcpComputerUseExecutor(
      {
        id: "stdio-fixture",
        name: "protocol fixture",
        call: (name, args, execution) =>
          client.callTool(
            { name, arguments: args },
            undefined,
            execution.signal ? { signal: execution.signal } : {},
          ),
      },
      context,
    );
    await run(executor, client);
  } finally {
    await client.close();
    await transport.close();
  }
}

describe("外部桌面MCP真实stdio协议边界", () => {
  it.each(["tree-gap", "tree-duplicates"])(
    "%s拒绝不合法索引树",
    async (mode) => {
      await withPeer(mode, async (executor) => {
        await expect(executor.observe({ name: "peer" })).rejects.toMatchObject({
          code: "invalid_backend_result",
          actionSent: false,
        });
      });
    },
  );
  it("保留远端索引并按实例树限制裁剪", async () => {
    await withPeer("tree-limits", async (executor) => {
      const state = await executor.observe(
        { name: "peer" },
        {
          signal: new AbortController().signal,
          treeLimits: { ...CU_AX_DEFAULT_LIMITS, maxDepth: 1 },
        },
      );
      expect(flattenAxTree(state.root).map((row) => row.index)).toEqual([
        10, 50, 1000,
      ]);
    });
  });
  it("拒绝负PID和未声明的权限状态", async () => {
    await withPeer("bad-apps", async (executor) => {
      await expect(executor.listApps()).rejects.toMatchObject({
        code: "invalid_backend_result",
        actionSent: false,
      });
    });
    await withPeer("bad-permissions", async (executor) => {
      await expect(executor.accessStatus()).rejects.toMatchObject({
        code: "invalid_backend_result",
        actionSent: false,
      });
    });
  });
  it("PNG实际尺寸与wire帧元数据不一致时拒绝捕获基准", async () => {
    await withPeer("bad-frame", async (executor) => {
      await expect(executor.capture({ name: "peer" })).rejects.toMatchObject({
        code: "invalid_backend_result",
        actionSent: false,
      });
    });
  });
  it("小压缩PNG也必须符合实例像素解码预算", async () => {
    await withPeer("pixel-budget", async (executor) => {
      await expect(
        executor.capture(
          { name: "peer" },
          {
            signal: new AbortController().signal,
            maxOutputBytes: AGENT_GOVERNANCE_LIMITS.processMaxOutputBytes.min,
          },
        ),
      ).rejects.toMatchObject({
        code: "image_budget_exceeded",
        actionSent: false,
      });
    });
  });
  it("保留未下发结果，缺失真实boolean时保守报告可能已下发", async () => {
    await withPeer("action-false", async (executor) => {
      expect(
        (await executor.click({ name: "peer" }, { kind: "element", index: 50 }))
          .actionSent,
      ).toBe(false);
    });
    await withPeer("action-invalid", async (executor) => {
      await expect(
        executor.click({ name: "peer" }, { kind: "element", index: 50 }),
      ).rejects.toMatchObject({
        code: "invalid_backend_result",
        actionSent: true,
      });
    });
  });
  it(
    "可信Run取消不会被operation信号覆盖，并送达真实peer",
    async () => {
      const controller = new AbortController();
      await withPeer(
        "wait-cancel",
        async (executor, client) => {
          let started!: () => void, cancelled!: () => void;
          const start = new Promise<void>((resolve) => {
            started = resolve;
          });
          const cancel = new Promise<void>((resolve) => {
            cancelled = resolve;
          });
          client.setNotificationHandler(
            LoggingMessageNotificationSchema,
            (notice) => {
              if (notice.params.data === "request-started") started();
              if (notice.params.data === "request-cancelled") cancelled();
            },
          );
          const result = executor.observe(
            { name: "peer" },
            { signal: new AbortController().signal },
          );
          const verdict = expect(result).rejects.toMatchObject({
            code: "cancelled",
            actionSent: false,
          });
          await start;
          controller.abort();
          await verdict;
          await cancel;
        },
        () => ({ signal: controller.signal }),
      );
    },
    AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs,
  );
});
