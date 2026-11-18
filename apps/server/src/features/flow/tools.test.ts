import { describe, expect, it, vi } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import type { ToolDefinition } from "../../kernel/types.js";
import type { LocalActor } from "../local-instance/types.js";
import { createFlowGatewayTools } from "./tools.js";

const actor = {
  instanceId: "instance-a",
  accessClientId: "client-a",
} as LocalActor;

const limits = {
  controlTimeoutMs: 1000,
  runTimeoutMs: 1000,
  maxResponseBytes: 4096,
};

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`缺少工具 ${name}`);
  return found;
}

function fixture(
  handler: (
    url: URL,
    init: RequestInit | undefined,
  ) => Response | Promise<Response>,
) {
  const fetchImpl = vi.fn(handler) as unknown as typeof fetch;
  const issueHostToken = vi.fn(async () => "host-ticket");
  const tools = createFlowGatewayTools({
    gatewayUrl: "http://127.0.0.1:15010",
    issueHostToken,
    resolveLimits: async () => limits,
    fetchImpl,
  });
  return { tools, fetchImpl, issueHostToken };
}

function sessionResponse() {
  return Response.json({ accessToken: "flow-jwt", expiresIn: 3600 });
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

describe("Flow/Dify agent 工具", () => {
  it("工具进入真实内核注册表后可经 guarded execute 调用", async () => {
    const { tools } = fixture(async (url) => {
      if (url.pathname === "/host/ff-embed/v1/session")
        return sessionResponse();
      return Response.json([
        { id: "workflow-1", name: "日报", publishedVersion: 3 },
      ]);
    });
    const kernel = composePlugins(
      {
        agentBackendMode: "state",
        agentModel: "test-model",
        port: 0,
        version: "test",
        webOrigin: "http://localhost:3000",
      } as ServerEnv,
      [],
    );
    try {
      for (const definition of tools) kernel.get("tools").register(definition);
      expect(
        kernel
          .get("tools")
          .list()
          .map((entry) => [entry.name, entry.access, entry.scope]),
      ).toEqual([
        ["flow_workflows", "read", "shared"],
        ["flow_execute_workflow", "write", "shared"],
      ]);
      const result = await kernel.get("tools").execute(
        "flow_workflows",
        {},
        {
          actor,
          instanceId: actor.instanceId,
        },
      );
      expect(result).toMatchObject({ total: 1 });
    } finally {
      kernel.dispose();
    }
  });

  it("列表先走宿主身份交换，再用 Flow JWT 读取并映射工作流", async () => {
    const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
    const { tools, fetchImpl, issueHostToken } = fixture(async (url, init) => {
      calls.push({ url, init });
      if (url.pathname === "/host/ff-embed/v1/session") {
        expect(bodyOf(init)).toEqual({ hostToken: "host-ticket" });
        return sessionResponse();
      }
      expect(url.pathname).toBe("/workflows");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer flow-jwt",
      );
      return Response.json([
        {
          id: "workflow-1",
          name: "日报",
          description: "生成日报",
          publishedVersion: 3,
          updatedAt: "2026-11-03T00:00:00.000Z",
        },
        { id: "workflow-2", name: "草稿", publishedVersion: null },
      ]);
    });

    const result = await tool(tools, "flow_workflows").execute(
      {},
      { actor, instanceId: actor.instanceId },
    );

    expect(result).toEqual({
      total: 2,
      workflows: [
        {
          id: "workflow-1",
          name: "日报",
          description: "生成日报",
          publishedVersion: 3,
          updatedAt: "2026-11-03T00:00:00.000Z",
        },
        {
          id: "workflow-2",
          name: "草稿",
          description: "",
          publishedVersion: null,
          updatedAt: null,
        },
      ],
    });
    expect(issueHostToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
  });

  it("执行映射输入与发布版本，解析最终事件而非首帧", async () => {
    let executeInit: RequestInit | undefined;
    const { tools } = fixture(async (url, init) => {
      if (url.pathname === "/host/ff-embed/v1/session")
        return sessionResponse();
      expect(url.pathname).toBe("/workflows/workflow-1/execute");
      executeInit = init;
      return new Response(
        [
          `data: ${JSON.stringify({ event: "workflow_started", workflow_run_id: "dify-run-1", task_id: "task-1" })}\n\n`,
          `data: ${JSON.stringify({ event: "node_finished", data: { status: "succeeded" } })}\n\n`,
          `data: ${JSON.stringify({ event: "workflow_finished", workflow_run_id: "dify-run-1", task_id: "task-1", data: { status: "succeeded", outputs: { text: "完成" }, total_tokens: 12, total_steps: 2, elapsed_time: 0.5 } })}\n\n`,
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });

    const result = await tool(tools, "flow_execute_workflow").execute(
      {
        workflowId: "workflow-1",
        inputs: { query: "销售", limit: 3, include: true },
        publishedVersion: 3,
      },
      {
        actor,
        instanceId: actor.instanceId,
        runId: "run-1",
        toolCallId: "call-1",
      },
    );

    expect(bodyOf(executeInit)).toEqual({
      inputs: { query: "销售", limit: 3, include: true },
      publishedVersion: 3,
    });
    expect(result).toMatchObject({
      workflowId: "workflow-1",
      workflowRunId: "dify-run-1",
      taskId: "task-1",
      status: "succeeded",
      outputs: { text: "完成" },
      totalTokens: 12,
      totalSteps: 2,
      elapsedTime: 0.5,
    });
  });

  it("同一 Run/工具调用并发重放使用同一稳定幂等键，不同调用不串键", async () => {
    const keys: string[] = [];
    const { tools } = fixture(async (url, init) => {
      if (url.pathname === "/host/ff-embed/v1/session")
        return sessionResponse();
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      return new Response(
        `data: ${JSON.stringify({ event: "workflow_finished", data: { status: "succeeded", outputs: {} } })}\n\n`,
        { status: 200 },
      );
    });
    const execute = tool(tools, "flow_execute_workflow");
    const context = {
      actor,
      instanceId: actor.instanceId,
      runId: "run-1",
      toolCallId: "call-1",
    };

    await Promise.all([
      execute.execute({ workflowId: "workflow-1" }, context),
      execute.execute({ workflowId: "workflow-1" }, context),
    ]);
    await execute.execute(
      { workflowId: "workflow-1" },
      { ...context, toolCallId: "call-2" },
    );

    expect(keys[0]).toMatch(/^kenfutwork-[a-f0-9]{64}$/u);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("HTTP 冲突与错误事件可读，不在客户端自动重放副作用", async () => {
    let executions = 0;
    const { tools, fetchImpl } = fixture(async (url) => {
      if (url.pathname === "/host/ff-embed/v1/session")
        return sessionResponse();
      executions += 1;
      return Response.json(
        { error: "已发布版本已更新，请刷新输入后重试", code: "conflict" },
        { status: 409 },
      );
    });
    const exec = {
      actor,
      instanceId: actor.instanceId,
      runId: "run-1",
      toolCallId: "call-1",
    };
    await expect(
      tool(tools, "flow_execute_workflow").execute(
        { workflowId: "workflow-1", publishedVersion: 2 },
        exec,
      ),
    ).rejects.toThrow(/HTTP 409.*已发布版本已更新/u);
    expect(executions).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const eventFailure = fixture(async (url) => {
      if (url.pathname === "/host/ff-embed/v1/session")
        return sessionResponse();
      return new Response(
        `data: ${JSON.stringify({ event: "error", data: { message: "Dify 拒绝了输入" } })}\n\n`,
        { status: 200 },
      );
    });
    await expect(
      tool(eventFailure.tools, "flow_execute_workflow").execute(
        { workflowId: "workflow-1" },
        exec,
      ),
    ).rejects.toThrow("Dify 拒绝了输入");
  });

  it("参数与实例身份在发请求前拒绝，缺 Run 身份不制造运行", async () => {
    const { tools, fetchImpl } = fixture(async () => sessionResponse());
    const execute = tool(tools, "flow_execute_workflow");
    for (const args of [
      {},
      { workflowId: "workflow-1", inputs: [] },
      { workflowId: "workflow-1", inputs: { nested: {} } },
      { workflowId: "workflow-1", publishedVersion: 0 },
    ]) {
      await expect(
        execute.execute(args, {
          actor,
          instanceId: actor.instanceId,
          runId: "run-1",
          toolCallId: "call-1",
        }),
      ).rejects.toThrow();
    }
    await expect(
      execute.execute(
        { workflowId: "workflow-1" },
        { actor, instanceId: actor.instanceId },
      ),
    ).rejects.toThrow(/稳定调用身份/u);
    await expect(
      tool(tools, "flow_workflows").execute({}, { actor }),
    ).rejects.toThrow(/本地实例调用上下文/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("事件流超限时中止读取，不保留无界响应", async () => {
    const { tools } = fixture(async (url) => {
      if (url.pathname === "/host/ff-embed/v1/session")
        return sessionResponse();
      return new Response(
        `data: ${JSON.stringify({ event: "node_finished", data: { text: "x".repeat(5000) } })}\n\n`,
        {
          status: 200,
        },
      );
    });
    await expect(
      tool(tools, "flow_execute_workflow").execute(
        { workflowId: "workflow-1" },
        {
          actor,
          instanceId: actor.instanceId,
          runId: "run-1",
          toolCallId: "call-1",
        },
      ),
    ).rejects.toThrow(/事件流超过响应上限/u);
  });
});
