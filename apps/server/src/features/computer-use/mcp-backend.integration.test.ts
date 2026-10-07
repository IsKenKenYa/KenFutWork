import { fileURLToPath } from "node:url";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  AGENT_GOVERNANCE_LIMITS,
} from "@kenfutwork/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { kernelToolToStructuredTool } from "../../agent/kernel-tools-bridge.js";
import { AgentRunEventBus, ToolRegistryImpl } from "../../kernel/context.js";
import type { ToolExecutionContext } from "../../kernel/types.js";
import { flattenAxTree } from "./ax-tree.js";
import { CU_AX_DEFAULT_LIMITS } from "./executor.js";
import { createMcpComputerUseExecutor } from "./mcp-backend.js";
import { createComputerUseService } from "./service.js";
import { createComputerUseTools } from "./tools.js";

const d = AGENT_GOVERNANCE_DEFAULTS;
const governance = () => ({
  actionTimeoutMs: d.computerUseActionTimeoutMs,
  observeMaxBytes: d.computerUseObserveMaxBytes,
  screenshotMaxBytes: d.computerUseScreenshotMaxBytes,
  maxActionsPerRun: d.computerUseMaxActionsPerRun,
  sessionMaxMs: d.computerUseSessionMaxMs,
});

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
  it("同一Run停止并重新观察不能重置动作总额", async () => {
    await withPeer("lifecycle", async (executor) => {
      const service = createComputerUseService({
        executor,
        governance: () => ({ ...governance(), maxActionsPerRun: 1 }),
      });
      const context = { runId: "quota-run" };
      const app = { name: "peer" };
      const target = { type: "element", index: 50 };
      try {
        await service.getState(app, {}, context);
        expect(
          await service.click(app, target, context.runId, context),
        ).toMatchObject({ structuredContent: { actionSent: true } });
        await service.stop(context.runId);
        await service.getState(app, {}, context);
        expect(
          await service.click(app, target, context.runId, context),
        ).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "action_limit" } },
        });
        const next = { runId: "next-quota-run" };
        await service.getState(app, {}, next);
        expect(await service.click(app, target, next.runId, next)).toMatchObject({ structuredContent: { actionSent: true } });
      } finally {
        await service.dispose();
      }
    });
  });
  it("缺少本Run观察的请求拒绝后不占用其它Run的控制租约", async () => {
    await withPeer("lifecycle", async (executor) => {
      const service = createComputerUseService({ executor, governance });
      try {
        await service.getState({ name: "peer" }, {}, { runId: "A" });
        expect(
          await service.click(
            { name: "peer" },
            { type: "element", index: 50 },
            "B",
            { runId: "B" },
          ),
        ).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "element_stale" } },
        });
        expect(
          await service.click(
            { name: "peer" },
            { type: "element", index: 50 },
            "A",
            { runId: "A" },
          ),
        ).toMatchObject({
          structuredContent: { actionSent: true },
        });
      } finally {
        await service.dispose();
      }
    });
  });
  it("停止取消真实peer并清除本Run观察，新Run重新观察后接管", async () => {
    await withPeer("cancel-lifecycle", async (executor, client) => {
      const service = createComputerUseService({ executor, governance });
      let started!: () => void;
      const start = new Promise<void>((resolve) => {
        started = resolve;
      });
      client.setNotificationHandler(
        LoggingMessageNotificationSchema,
        (notice) => {
          if (notice.params.data === "request-started") started();
        },
      );
      try {
        await service.getState({ name: "peer" }, {}, { runId: "A" });
        const pending = service.click(
          { name: "peer" },
          { type: "element", index: 50 },
          "A",
          { runId: "A" },
        );
        await start;
        expect(await service.stop("A")).not.toHaveProperty("isError", true);
        expect(await pending).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "cancelled" } },
        });
        expect(
          await service.click(
            { name: "peer" },
            { type: "element", index: 50 },
            "A",
            { runId: "A" },
          ),
        ).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "element_stale" } },
        });
        await service.getState({ name: "peer" }, {}, { runId: "B" });
        expect(
          await service.click(
            { name: "peer" },
            { type: "element", index: 50 },
            "B",
            { runId: "B" },
          ),
        ).toMatchObject({ structuredContent: { actionSent: true } });
      } finally {
        await service.dispose();
      }
    });
  });
  it("真实stdio PNG经registry和kernel桥成为模型图片，canonical仍保留MCP结果", async () => {
    await withPeer("valid-frame", async (executor) => {
      const service = createComputerUseService({ executor, governance });
      const registry = new ToolRegistryImpl(new AgentRunEventBus());
      for (const definition of createComputerUseTools({
        service,
        gate: async () => ({ ok: true }),
      }))
        registry.register(definition);
      const name = "mcp__computer-use__screenshot";
      const model = kernelToolToStructuredTool(
        {
          ...registry.require(name),
          execute: (args, context) => registry.execute(name, args, context),
        },
        { runId: "A" },
      );
      try {
        const result = await model.invoke({
          type: "tool_call",
          name,
          id: "stdio-model-image",
          args: { app: { name: "peer" } },
        });
        const content = (result as { content: unknown }).content;
        expect(Array.isArray(content)).toBe(true);
        if (!Array.isArray(content)) throw new Error("模型内容没有多模态块");
        expect(
          content.map((block) => ({
            type: block.type,
            source: block.source_type,
            mime: block.mime_type,
            hasData: typeof block.data === "string" && block.data.length > 0,
          })),
        ).toContainEqual({
          type: "image",
          source: "base64",
          mime: "image/png",
          hasData: true,
        });
        const artifact = (result as { artifact: { canonicalOutput: unknown } })
          .artifact;
        expect(artifact.canonicalOutput).toMatchObject({
          structuredContent: { image: { width: 2, height: 2 } },
        });
      } finally {
        await service.dispose();
      }
    });
  });
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
