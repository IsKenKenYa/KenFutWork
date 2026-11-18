import { createHash } from "node:crypto";

import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import type { LocalActor } from "../local-instance/types.js";

export interface FlowGatewayToolLimits {
  controlTimeoutMs: number;
  runTimeoutMs: number;
  maxResponseBytes: number;
}

interface FlowGatewayToolOptions {
  gatewayUrl: string;
  issueHostToken(actor: LocalActor): Promise<string>;
  resolveLimits(actor: LocalActor): Promise<FlowGatewayToolLimits>;
  fetchImpl?: typeof fetch;
}

interface GatewayRequestInit {
  path: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  run?: boolean;
}

type FlowGatewayClient = ReturnType<typeof createFlowGatewayClient>;

function actorOf(exec: ToolExecutionContext): LocalActor {
  if (
    !exec.actor ||
    !exec.instanceId ||
    exec.actor.instanceId !== exec.instanceId
  ) {
    throw new Error("Flow 工具缺少可信的本地实例调用上下文。");
  }
  return exec.actor;
}

function signalOf(
  exec: ToolExecutionContext,
  timeoutMs: number,
): AbortSignal | undefined {
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (exec.signal && timeout) return AbortSignal.any([exec.signal, timeout]);
  return exec.signal ?? timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseError(
  response: Response,
  action: string,
): Promise<Error> {
  let detail = "";
  try {
    const body = (await response.json()) as {
      error?: unknown;
      message?: unknown;
    };
    const error = body.error;
    const message =
      typeof error === "string"
        ? error
        : typeof body.message === "string"
          ? body.message
          : typeof error === "object" && error !== null
            ? (error as { message?: unknown }).message
            : undefined;
    if (typeof message === "string" && message.trim()) detail = message.trim();
  } catch {
    // 非 JSON 错误体只保留状态码。
  }
  return new Error(
    `${action}失败：Flow 网关返回 HTTP ${response.status}${detail ? `（${detail}）` : ""}`,
  );
}

async function requestFlowGateway(
  fetchImpl: typeof fetch,
  gateway: URL,
  exec: ToolExecutionContext,
  action: string,
  init: GatewayRequestInit,
  limits: FlowGatewayToolLimits,
  token?: string,
): Promise<Response> {
  const timeoutMs = init.run ? limits.runTimeoutMs : limits.controlTimeoutMs;
  const signal = signalOf(exec, timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(new URL(init.path, gateway), {
      method: init.method ?? "GET",
      headers: {
        accept: init.run ? "text/event-stream" : "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`${action}失败：Flow 网关响应超时。`);
    }
    throw new Error(
      `${action}失败：Flow 网关不可达（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  if (!response.ok) throw await responseError(response, action);
  return response;
}

function createFlowGatewayClient(options: FlowGatewayToolOptions) {
  const gateway = new URL(options.gatewayUrl);
  if (
    !["http:", "https:"].includes(gateway.protocol) ||
    gateway.pathname !== "/" ||
    gateway.search ||
    gateway.hash ||
    gateway.username ||
    gateway.password
  ) {
    throw new Error("Flow 网关地址必须是显式 HTTP(S) origin");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const session = async (exec: ToolExecutionContext, action: string) => {
    const actor = actorOf(exec);
    const [hostToken, limits] = await Promise.all([
      options.issueHostToken(actor),
      options.resolveLimits(actor),
    ]);
    const response = await requestFlowGateway(
      fetchImpl,
      gateway,
      exec,
      action,
      {
        path: "/host/ff-embed/v1/session",
        method: "POST",
        body: { hostToken },
      },
      limits,
    );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`${action}失败：Flow 身份交换响应不是有效 JSON。`);
    }
    const token = isRecord(body) ? body.accessToken : undefined;
    if (typeof token !== "string" || !token.trim()) {
      throw new Error(`${action}失败：Flow 身份交换未返回访问令牌。`);
    }
    return { token, limits };
  };

  return {
    async authenticatedRequest(
      exec: ToolExecutionContext,
      action: string,
      init: GatewayRequestInit,
    ): Promise<{ response: Response; limits: FlowGatewayToolLimits }> {
      const { token, limits } = await session(exec, action);
      const response = await requestFlowGateway(
        fetchImpl,
        gateway,
        exec,
        action,
        init,
        limits,
        token,
      );
      return { response, limits };
    },
  };
}

function eventData(block: string): Record<string, unknown> | null {
  const data = block
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data) return null;
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    throw new Error("Flow 执行失败：网关返回了无效事件。");
  }
  if (!isRecord(event)) throw new Error("Flow 执行失败：事件形状无效。");
  return event;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function readFlowExecutionEvents(
  response: Response,
  maxResponseBytes: number,
) {
  if (!response.body) throw new Error("Flow 执行失败：网关未返回事件流。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let receivedBytes = 0;
  let started: Record<string, unknown> | undefined;
  let finished: Record<string, unknown> | undefined;

  const consume = (block: string): void => {
    const event = eventData(block);
    if (!event) return;
    if (event.event === "workflow_started") started = event;
    if (event.event === "workflow_finished") finished = event;
    if (event.event === "error") {
      const detail = isRecord(event.data) ? event.data.message : undefined;
      throw new Error(
        `Flow 执行失败：${typeof detail === "string" && detail.trim() ? detail.trim() : "网关返回错误事件。"}`,
      );
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      receivedBytes += Buffer.byteLength(chunk, "utf8");
      if (receivedBytes > maxResponseBytes) {
        await reader.cancel();
        throw new Error("Flow 执行失败：事件流超过响应上限。");
      }
      pending += chunk;
      const blocks = pending.split(/\r?\n\r?\n/u);
      pending = blocks.pop() ?? "";
      for (const block of blocks) consume(block);
    }
    pending += decoder.decode();
    if (pending.trim()) consume(pending);
  } finally {
    reader.releaseLock();
  }

  if (!finished) {
    throw new Error("Flow 执行失败：未收到 workflow_finished 事件。");
  }
  const data = isRecord(finished.data) ? finished.data : {};
  const status = typeof data.status === "string" ? data.status : "failed";
  if (status !== "succeeded") {
    const detail = typeof data.error === "string" ? data.error : status;
    throw new Error(`Flow 执行失败：${detail}`);
  }
  const idOf = (event: Record<string, unknown> | undefined, key: string) => {
    const value = event?.[key];
    return typeof value === "string" ? value : "";
  };
  return {
    workflowRunId:
      idOf(finished, "workflow_run_id") || idOf(started, "workflow_run_id"),
    taskId: idOf(finished, "task_id") || idOf(started, "task_id"),
    status,
    outputs: isRecord(data.outputs) ? data.outputs : {},
    totalTokens: numberValue(data.total_tokens),
    totalSteps: numberValue(data.total_steps),
    elapsedTime: numberValue(data.elapsed_time),
  };
}

function createFlowWorkflowsTool(client: FlowGatewayClient): ToolDefinition {
  return {
    name: "flow_workflows",
    access: "read",
    scope: "shared",
    description:
      "列出当前本机实例在 Flow/Dify 中的工作流，返回 id、名称与已发布版本。执行前先确认目标已发布。",
    parameters: { type: "object", properties: {} },
    execute: async (_args, exec) => {
      const action = "读取 Flow 工作流";
      const { response } = await client.authenticatedRequest(exec, action, {
        path: "/workflows",
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error(`${action}失败：网关响应不是有效 JSON。`);
      }
      if (!Array.isArray(body)) {
        throw new Error(`${action}失败：网关未返回工作流数组。`);
      }
      const workflows = body.map((value) => {
        if (
          !isRecord(value) ||
          typeof value.id !== "string" ||
          typeof value.name !== "string"
        ) {
          throw new Error(`${action}失败：工作流条目形状无效。`);
        }
        return {
          id: value.id,
          name: value.name,
          description:
            typeof value.description === "string" ? value.description : "",
          publishedVersion:
            typeof value.publishedVersion === "number"
              ? value.publishedVersion
              : null,
          updatedAt:
            typeof value.updatedAt === "string" ? value.updatedAt : null,
        };
      });
      return { total: workflows.length, workflows };
    },
  };
}

function executionArguments(args: Record<string, unknown>) {
  const workflowId = String(args.workflowId ?? "").trim();
  if (!workflowId) throw new Error("缺少 workflowId。");
  const inputs = args.inputs ?? {};
  if (!isRecord(inputs)) {
    throw new Error("inputs 必须是对象，值只能是字符串、数字或布尔。");
  }
  for (const value of Object.values(inputs)) {
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error("inputs 的值只能是字符串、数字或布尔。");
    }
  }
  const publishedVersion = args.publishedVersion;
  if (
    publishedVersion !== undefined &&
    (!Number.isInteger(publishedVersion) || Number(publishedVersion) < 1)
  ) {
    throw new Error("publishedVersion 必须是正整数。");
  }
  return { workflowId, inputs, publishedVersion };
}

function executionIdempotencyKey(exec: ToolExecutionContext): string {
  if (!exec.runId || !exec.toolCallId) {
    throw new Error("Flow 执行缺少稳定调用身份，已拒绝产生副作用。");
  }
  return `kenfutwork-${createHash("sha256")
    .update(`flow-execute:${exec.instanceId}:${exec.runId}:${exec.toolCallId}`)
    .digest("hex")}`;
}

function createFlowExecuteWorkflowTool(
  client: FlowGatewayClient,
): ToolDefinition {
  return {
    name: "flow_execute_workflow",
    access: "write",
    scope: "shared",
    description:
      "执行一个已发布的 Flow/Dify 工作流并等待最终结果。workflowId 与 publishedVersion 先由 flow_workflows 获取；inputs 只能是 Start 节点声明的字符串、数字或布尔参数。",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "已发布工作流 id" },
        inputs: {
          type: "object",
          description: "Start 节点输入；值只能是字符串、数字或布尔",
          additionalProperties: { type: ["string", "number", "boolean"] },
        },
        publishedVersion: {
          type: "number",
          description: "需要锁定的已发布版本号",
        },
      },
      required: ["workflowId"],
    },
    execute: async (args, exec) => {
      const { workflowId, inputs, publishedVersion } = executionArguments(args);
      const idempotencyKey = executionIdempotencyKey(exec);
      const action = "执行 Flow 工作流";
      const { response, limits } = await client.authenticatedRequest(
        exec,
        action,
        {
          path: `/workflows/${encodeURIComponent(workflowId)}/execute`,
          method: "POST",
          headers: { "idempotency-key": idempotencyKey },
          body: {
            inputs,
            ...(publishedVersion === undefined ? {} : { publishedVersion }),
          },
          run: true,
        },
      );
      return {
        workflowId,
        idempotencyKey,
        ...(await readFlowExecutionEvents(response, limits.maxResponseBytes)),
      };
    },
  };
}

/** 主 agent 的 Flow/Dify 工具面：宿主身份交换 → 网关 JWT → 已发布工作流。 */
export function createFlowGatewayTools(
  options: FlowGatewayToolOptions,
): ToolDefinition[] {
  const client = createFlowGatewayClient(options);
  return [
    createFlowWorkflowsTool(client),
    createFlowExecuteWorkflowTool(client),
  ];
}
