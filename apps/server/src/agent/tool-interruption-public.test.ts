import type { StreamEvent } from "@kenfutwork/shared";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { createAgent, FakeToolCallingModel } from "langchain";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCodeUiConversation } from "../features/code-ui/conversation.js";
import { createToolLifecycleMiddleware } from "../features/code-ui/tool-lifecycle.js";
import { AgentRunEventBus, ToolRegistryImpl } from "../kernel/context.js";
import type { ToolExecutionContext } from "../kernel/types.js";
import type { KenFutWorkAgent } from "./deep-agent.js";
import { createToolErrorGuardMiddleware } from "./deep-agent.js";
import {
  createDeepAgentsProvider,
  projectKernelToolExecution,
} from "./deepagents-provider.js";
import { kernelToolToStructuredTool } from "./kernel-tools-bridge.js";
import { createNativeToolProofMiddleware } from "./native-tool-proof.js";
import {
  type AgentProviderContext,
  consumeAgentProviderStream,
} from "./provider-contract.js";
import type { AgentRunExtensionContext } from "./run-extension.js";
import { createToolExecutionReceipts } from "./tool-execution-receipts.js";

// Candidate destination: apps/server/src/agent/tool-interruption-public.test.ts
// No Job, vendor, inference, or private sentinel is fabricated by this fixture.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture() {
  const identity = {
    runId: "owned-run",
    sessionId: "owned-session",
    conversationId: "owned-conversation",
  };
  const controller = new AbortController();
  const outcome = deferred<string>();
  let executions = 0;
  let invocationSignal: AbortSignal | undefined;
  let nativeCompleted = false;
  const proofErrors: unknown[] = [];
  const host = createCodeUiConversation({
    sessionId: identity.sessionId,
    workspacePath: "/tmp/owned-tool-projection",
    config: {
      provider: "zcode",
      model: "fixture",
      thought: "",
      followupMode: "queue",
    },
  });
  host.startTurn({
    runId: identity.runId,
    commandId: "start",
    text: "等待工作结果",
  });
  const registry = new ToolRegistryImpl(new AgentRunEventBus());
  const receipts = createToolExecutionReceipts({
    runId: identity.runId,
    project: (fact) => projectKernelToolExecution(fact, identity),
    publish: async (event) => {
      host.recordEvent(event);
    },
  });
  registry.register({
    name: "wait_for_design_result",
    description: "等待工作结果",
    scope: "design",
    access: "execute",
    parameters: { type: "object", properties: {} },
    zodSchema: z.object({}),
    execute: (_args, context) => {
      executions += 1;
      // The actual tool invocation receives the SDK signal. Its own listener decides
      // rejection order; a later abort cannot replace an earlier business reject.
      const signal = context.signal;
      invocationSignal = signal;
      const onAbort = () => outcome.reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      void outcome.promise.then(
        () => signal?.removeEventListener("abort", onAbort),
        () => signal?.removeEventListener("abort", onAbort),
      );
      return outcome.promise;
    },
  });
  const resolution: AgentRunExtensionContext["resolution"] = {
    preset: "design",
    backendFactory: () => {
      throw new Error("此投影用例不创建文件backend。");
    },
  };
  const execution: ToolExecutionContext = {
    runId: identity.runId,
    signal: controller.signal,
    observeToolExecution: receipts.observe,
  };
  const context: AgentRunExtensionContext = { registry, resolution, execution };
  const definition = registry
    .resolveRunTools(resolution)
    .find((entry) => entry.name === "wait_for_design_result");
  if (!definition) throw new Error("缺少实际注册工具。");
  const actual = kernelToolToStructuredTool(
    {
      ...definition,
      execute: (args, invocation) =>
        registry.executeDefinition(definition, args, invocation),
    },
    execution,
  );
  const native = createAgent({
    model: new FakeToolCallingModel({
      toolCalls: [[{ id: "owned-call", name: definition.name, args: {} }], []],
    }),
    tools: [actual],
    middleware: [
      createNativeToolProofMiddleware({
        identity,
        context,
        observe: async (proof) => {
          try {
            await receipts.observeNative(proof);
          } catch (error) {
            proofErrors.push(error);
            throw error;
          } finally {
            if (proof.events.some((event) => event.type === "tool.completed"))
              nativeCompleted = true;
          }
        },
      }),
      createToolLifecycleMiddleware({}, context),
      createToolErrorGuardMiddleware(),
    ],
  });
  const provider = createDeepAgentsProvider({
    createAgent: () =>
      Object.assign(native, {
        canonicalToolEvents: true,
      }) as unknown as KenFutWorkAgent,
    config: () => ({ version: "v2", signal: controller.signal }),
  });
  const providerContext: AgentProviderContext = {
    ...identity,
    systemPrompt: "测试现有工具执行链路",
    signal: controller.signal,
    tools: {
      catalog: [],
      isExecuting: receipts.gate.isExecuting,
      execute: async () => {
        throw new Error("原生SDK不能绕过真实Registry。");
      },
    },
  };
  const session = await provider.open(providerContext);
  const events: StreamEvent[] = [];
  const collecting = (async () => {
    for await (const event of consumeAgentProviderStream(
      session,
      {
        messages: [{ content: "等待工作结果" }],
      },
      providerContext,
      receipts.gate,
    )) {
      events.push(event);
      // The consumer applies actual tool receipts before the Run terminal. This
      // controls delivery order through public events, without rewriting history.
      if (!["run.completed", "run.failed", "run.canceled"].includes(event.type))
        host.recordEvent(event);
    }
  })();
  await vi.waitFor(() => expect(executions).toBe(1), { timeout: 10_000 });
  if (!invocationSignal)
    throw new Error("实际Registry工具没有收到SDK执行signal。");
  return {
    outcome,
    controller,
    events,
    proofErrors,
    invocationSignal,
    async settle() {
      await vi.waitFor(() => expect(nativeCompleted).toBe(true), {
        timeout: 10_000,
      });
      await collecting;
      for (const event of events)
        if (
          ["run.completed", "run.failed", "run.canceled"].includes(event.type)
        )
          host.recordEvent(event);
      const snapshot = protocol.conversationSnapshotSchema.parse(
        host.getSnapshot(),
      );
      const row = snapshot.rows.window.find(
        (entry) =>
          entry.kind === "toolCall" && entry.toolName === definition.name,
      );
      if (row?.kind !== "toolCall") throw new Error("公开快照缺少实际工具行。");
      return row;
    },
    async close() {
      outcome.resolve("晚到工作结果");
      controller.abort("host_shutdown");
      await collecting;
      session.release?.();
    },
  };
}

describe("真实SDK与Registry工具中断的公开投影", () => {
  it("owned host_shutdown中断等待，公开工具行cancelled且不含业务失败重试建议", async () => {
    const f = await fixture();
    try {
      f.controller.abort("host_shutdown");
      expect(f.invocationSignal.aborted).toBe(true);
      const row = await f.settle();
      expect(row.status).toBe("cancelled");
      expect(row.error).toBeUndefined();
      expect(row.output?.text ?? "").not.toMatch(
        /工具级失败|换关键词|换方案|重试/u,
      );
      expect(f.events.at(-1)).toMatchObject({
        type: "run.canceled",
        stopReason: "host_shutdown",
      });
      expect(f.proofErrors).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("普通业务Error文本恰为host_shutdown仍保持error", async () => {
    const f = await fixture();
    try {
      f.outcome.reject(new Error("host_shutdown"));
      const row = await f.settle();
      expect(f.controller.signal.aborted).toBe(false);
      expect(row).toMatchObject({
        status: "error",
        error: {
          code: "tool_failed",
          message: expect.stringContaining("host_shutdown"),
        },
      });
      expect(f.proofErrors).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("业务reject先到再abort，保留原业务error而非按catch时aborted改取消", async () => {
    const f = await fixture();
    try {
      f.outcome.reject(new Error("原业务拒绝先到"));
      f.controller.abort("host_shutdown");
      const row = await f.settle();
      expect(row).toMatchObject({
        status: "error",
        error: {
          code: "tool_failed",
          message: expect.stringContaining("原业务拒绝先到"),
        },
      });
      expect(f.proofErrors).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("业务成功先到再abort，保留原success且不接受迟到取消证明覆盖", async () => {
    const f = await fixture();
    try {
      f.outcome.resolve("先到的真实工具结果");
      f.controller.abort("host_shutdown");
      const row = await f.settle();
      expect(row).toMatchObject({
        status: "success",
        output: { text: expect.stringContaining("先到的真实工具结果") },
      });
      expect(row.error).toBeUndefined();
      expect(f.proofErrors).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
