import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import * as sharedExports from "./index.js";
import {
  contentBlockSchema,
  errorCodeValues,
  healthResponseSchema,
  runCancelResponseSchema,
  runCreateRequestSchema,
  runCreateResponseSchema,
  streamEventSchema,
} from "./index.js";

describe("@kenfutwork/shared contracts", () => {
  it("shares the health response schema for server and web", () => {
    const parsed = healthResponseSchema.parse({
      ok: true,
      service: "kenfutwork-server",
      version: "0.1.0",
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.service).toBe("kenfutwork-server");
  });

  it("accepts canvasId as optional field", () => {
    const result = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "Hello",
      canvasId: "canvas-1",
    });
    expect(result.canvasId).toBe("canvas-1");
  });

  it("succeeds without canvasId (backward compat)", () => {
    const result = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "Hello",
    });
    expect(result.canvasId).toBeUndefined();
  });

  it("accepts optional preset (DEC-2) and rejects unknown values", () => {
    const parsed = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "Hello",
      preset: "code",
    });
    expect(parsed.preset).toBe("code");
    expect(
      runCreateRequestSchema.safeParse({
        sessionId: "session-1",
        conversationId: "conv-1",
        prompt: "Hello",
        preset: "both",
      }).success,
    ).toBe(false);
  });

  it("accepts optional executionMode (DEC-3) and rejects unknown values", () => {
    const parsed = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "Hello",
      executionMode: "creative",
    });
    expect(parsed.executionMode).toBe("creative");
    expect(
      runCreateRequestSchema.safeParse({
        sessionId: "session-1",
        conversationId: "conv-1",
        prompt: "Hello",
        executionMode: "auto",
      }).success,
    ).toBe(false);
  });

  it("accepts optional attachments in run creation", () => {
    const result = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "Analyze this image",
      attachments: [
        {
          assetId: "asset-123",
          url: "https://example.com/image.png",
          mimeType: "image/png",
        },
      ],
    });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments?.[0]?.assetId).toBe("asset-123");
  });

  it("accepts optional image generation preference in run creation", () => {
    const result = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "Generate a campaign key visual",
      imageGenerationPreference: {
        mode: "manual",
        models: ["google/nano-banana-2", "black-forest-labs/flux-kontext-pro"],
      },
    });

    expect(result.imageGenerationPreference?.mode).toBe("manual");
    expect(result.imageGenerationPreference?.models).toEqual([
      "google/nano-banana-2",
      "black-forest-labs/flux-kontext-pro",
    ]);
  });

  it("accepts optional mentions in run creation", () => {
    const result = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "参考品牌资产生成一张海报",
      mentions: [
        {
          mentionType: "image-model",
          id: "google/nano-banana-2",
          label: "Nano Banana 2",
        },
        {
          mentionType: "brand-kit-asset",
          id: "brand-logo-1",
          label: "KenFutWork 主 Logo",
          assetType: "logo",
          fileUrl: "https://example.com/logo.png",
        },
      ],
    });

    expect(result.mentions).toHaveLength(2);
    expect(result.mentions?.[0]?.mentionType).toBe("image-model");
    expect(result.mentions?.[1]).toMatchObject({
      mentionType: "brand-kit-asset",
      assetType: "logo",
      fileUrl: "https://example.com/logo.png",
    });
  });

  it("accepts sessionId and conversationId for run creation", () => {
    const request = runCreateRequestSchema.parse({
      sessionId: "session_123",
      conversationId: "conversation_123",
      prompt: "Create a new storyboard outline",
    });

    const response = runCreateResponseSchema.parse({
      runId: "run_123",
      sessionId: request.sessionId,
      conversationId: request.conversationId,
      status: "accepted",
    });

    expect(request.sessionId).toBe("session_123");
    expect(response.status).toBe("accepted");
  });

  it("rejects run creation without a real sessionId", () => {
    expect(() =>
      runCreateRequestSchema.parse({
        conversationId: "conversation_123",
        prompt: "Create a new storyboard outline",
      }),
    ).toThrow();
  });

  it("shares a stable cancel response schema", () => {
    const parsed = runCancelResponseSchema.parse({
      runId: "run_123",
      status: "canceling",
    });

    expect(parsed.status).toBe("canceling");
  });

  it("shares the local instance contract for GET /api/instance", () => {
    const instanceResponseSchema = getExportedSchema("instanceResponseSchema");

    const parsed = instanceResponseSchema.parse({
      instanceId: "00000000-0000-4000-8000-000000000001",
      dataDir: "/local/kenfutwork/data",
    });

    expect(parsed.instanceId).toBe("00000000-0000-4000-8000-000000000001");
    expect(parsed.dataDir).toBe("/local/kenfutwork/data");
    expect(Object.keys(parsed)).toEqual(["instanceId", "dataDir"]);
  });

  it("shares project list and create contracts for GET/POST /api/projects", () => {
    const projectListResponseSchema = getExportedSchema(
      "projectListResponseSchema",
    );
    const projectCreateRequestSchema = getExportedSchema(
      "projectCreateRequestSchema",
    );
    const projectCreateResponseSchema = getExportedSchema(
      "projectCreateResponseSchema",
    );

    const createRequest = projectCreateRequestSchema.parse({
      name: "Brand System",
      description: "Primary workspace project",
    });
    // kind 可选：缺省即画布项目（design），存量调用方不受影响
    expect(createRequest.kind).toBeUndefined();
    expect(
      projectCreateRequestSchema.parse({ name: "x", kind: "code" }).kind,
    ).toBe("code");
    // flow 项目（《flow 集成方案》P1）：第三类项目，run 必绑项目同一条硬约束
    expect(
      projectCreateRequestSchema.parse({ name: "x", kind: "flow" }).kind,
    ).toBe("flow");
    // 封闭枚举：加类型必须两处同改（契约 + 库 CHECK），后者由 tests/workspace.test.mjs 对账
    expect(getExportedSchema("projectKindSchema").options).toEqual([
      "design",
      "code",
      "flow",
    ]);
    expect(
      projectCreateRequestSchema.safeParse({ name: "x", kind: "nope" }).success,
    ).toBe(false);

    const parsedList = projectListResponseSchema.parse({
      projects: [
        {
          id: "project_123",
          name: createRequest.name,
          slug: "brand-system",
          kind: "design",
          description: createRequest.description,
          instanceId: "00000000-0000-4000-8000-000000000001",
          primaryCanvas: {
            id: "canvas_123",
            name: "Main Canvas",
            isPrimary: true,
          },
          createdAt: "2026-03-23T12:00:00.000Z",
          updatedAt: "2026-03-23T12:00:00.000Z",
        },
      ],
    });
    const createdProject = projectCreateResponseSchema.parse({
      project: parsedList.projects[0],
    });

    expect(parsedList.projects[0].id).toBe("project_123");
    expect(parsedList.projects[0].instanceId).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(parsedList.projects[0].primaryCanvas.id).toBe("canvas_123");
    expect(createdProject.project.primaryCanvas.isPrimary).toBe(true);
  });

  it("shares stable unauthenticated and application error payloads", () => {
    const unauthenticatedErrorResponseSchema = getExportedSchema(
      "unauthenticatedErrorResponseSchema",
    );
    const applicationErrorResponseSchema = getExportedSchema(
      "applicationErrorResponseSchema",
    );

    const unauthenticated = unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Authentication is required.",
      },
    });
    const applicationError = applicationErrorResponseSchema.parse({
      error: {
        code: "project_create_failed",
        message: "Unable to create project.",
      },
    });

    expect(unauthenticated.error.code).toBe("unauthorized");
    expect(JSON.parse(JSON.stringify(applicationError))).toEqual(
      applicationError,
    );
  });

  it("rejects an empty project name in project create requests", () => {
    const projectCreateRequestSchema = getExportedSchema(
      "projectCreateRequestSchema",
    );

    expect(() =>
      projectCreateRequestSchema.parse({
        name: "",
      }),
    ).toThrow();
  });

  it("rejects a whitespace-only project name", () => {
    const schema = getExportedSchema("projectCreateRequestSchema");
    const result = schema.safeParse({ name: "   " });
    expect(result.success).toBe(false);
  });

  it("trims a valid project name", () => {
    const schema = getExportedSchema("projectCreateRequestSchema");
    const result = schema.safeParse({ name: "  My Project  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("My Project");
    }
  });

  it("trims a valid project description", () => {
    const schema = getExportedSchema("projectCreateRequestSchema");
    const result = schema.safeParse({
      name: "Test",
      description: "  Some desc  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe("Some desc");
    }
  });

  it("rejects a project response without primary canvas metadata", () => {
    const projectListResponseSchema = getExportedSchema(
      "projectListResponseSchema",
    );

    expect(() =>
      projectListResponseSchema.parse({
        projects: [
          {
            id: "project_123",
            name: "Brand System",
            slug: "brand-system",
            kind: "design",
            description: "Primary workspace project",
            instanceId: "00000000-0000-4000-8000-000000000001",
            createdAt: "2026-03-23T12:00:00.000Z",
            updatedAt: "2026-03-23T12:00:00.000Z",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects invalid application error codes", () => {
    const applicationErrorResponseSchema = getExportedSchema(
      "applicationErrorResponseSchema",
    );

    expect(() =>
      applicationErrorResponseSchema.parse({
        error: {
          code: "database_exploded",
          message: "Unexpected failure.",
        },
      }),
    ).toThrow();
  });

  it("includes the required minimum stream event union", () => {
    const eventTypes = [
      "run.started",
      "message.delta",
      "tool.started",
      "tool.completed",
      "run.canceled",
      "run.completed",
      "run.failed",
      // flow 事件缝（P5）：宿主把 flow 网关回调的运行事件透出到 WS 时的统一包装
      "flowRun.event",
    ];

    for (const type of eventTypes) {
      expect(() => {
        switch (type) {
          case "run.started":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              sessionId: "session_123",
              conversationId: "conversation_123",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "message.delta":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              messageId: "message_123",
              delta: "hello",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "tool.started":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              toolCallId: "tool_123",
              toolName: "example_tool",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "tool.completed":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              toolCallId: "tool_123",
              toolName: "example_tool",
              outputSummary: "done",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "run.completed":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "run.canceled":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "run.failed":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              error: {
                code: "run_failed",
                message: "The run failed.",
              },
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "flowRun.event":
            streamEventSchema.parse({
              type,
              runId: "flow_run_1",
              seq: 1,
              eventType: "workflow_started",
              payload: { workflow_run_id: "wf-1" },
              at: "2026-03-23T12:00:00.000Z",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          default:
            throw new Error(`Unexpected event type: ${type}`);
        }
      }).not.toThrow();
    }
  });

  it("keeps stable messageId and toolCallId correlation fields", () => {
    const messageEvent = streamEventSchema.parse({
      type: "message.delta",
      runId: "run_123",
      messageId: "message_123",
      delta: "hello",
      timestamp: "2026-03-23T12:00:00.000Z",
    });

    const toolEvent = streamEventSchema.parse({
      type: "tool.completed",
      runId: "run_123",
      toolCallId: "tool_123",
      toolName: "project_search",
      outputSummary: "Matched 2 files",
      timestamp: "2026-03-23T12:00:01.000Z",
    });

    if (messageEvent.type !== "message.delta") {
      throw new Error("Expected message.delta event.");
    }

    if (toolEvent.type !== "tool.completed") {
      throw new Error("Expected tool.completed event.");
    }

    expect(messageEvent.messageId).toBe("message_123");
    expect(toolEvent.toolCallId).toBe("tool_123");
  });

  it("requires correlation fields for message and tool lifecycle events", () => {
    expect(() =>
      streamEventSchema.parse({
        type: "message.delta",
        runId: "run_123",
        delta: "hello",
        timestamp: "2026-03-23T12:00:00.000Z",
      }),
    ).toThrow();

    expect(() =>
      streamEventSchema.parse({
        type: "tool.completed",
        runId: "run_123",
        toolName: "project_search",
        outputSummary: "Matched 2 files",
        timestamp: "2026-03-23T12:00:01.000Z",
      }),
    ).toThrow();
  });

  it("exports stable error codes that serialize as plain JSON", () => {
    expect(errorCodeValues).toEqual([
      "invalid_request",
      "run_not_found",
      "run_conflict",
      "run_failed",
      "tool_failed",
    ]);
    expect(JSON.parse(JSON.stringify(errorCodeValues))).toEqual(
      errorCodeValues,
    );
  });

  it("keeps run creation response stable for clients while hiding checkpoint internals", () => {
    const response = runCreateResponseSchema.parse({
      runId: "run_123",
      sessionId: "session_123",
      conversationId: "conversation_123",
      status: "accepted",
      checkpointId: "checkpoint_123",
      checkpointNamespace: "root",
    });

    expect(response).toEqual({
      runId: "run_123",
      sessionId: "session_123",
      conversationId: "conversation_123",
      status: "accepted",
    });
  });
});

type AssertTrue<T extends true> = T;
type Extends<T, U> = [T] extends [U] ? true : false;

const chatSessionRowSupportsServerOwnedThreadId: AssertTrue<
  Extends<
    Database["public"]["Tables"]["chat_sessions"]["Row"],
    { thread_id: string | null }
  >
> = true;

const agentRunsRowTracksSessionAndThread: AssertTrue<
  Extends<
    Database["public"]["Tables"]["agent_runs"]["Row"],
    {
      session_id: string;
      thread_id: string;
      status: string;
      created_at: string;
      completed_at: string | null;
      error_code: string | null;
      error_message: string | null;
    }
  >
> = true;

void chatSessionRowSupportsServerOwnedThreadId;
void agentRunsRowTracksSessionAndThread;

const langgraphCheckpointsRowMatchesOfficialSchema: AssertTrue<
  Extends<
    Database["langgraph"]["Tables"]["checkpoints"]["Row"],
    {
      thread_id: string;
      checkpoint_ns: string;
      checkpoint_id: string;
      checkpoint: unknown;
      metadata: unknown;
    }
  >
> = true;

void langgraphCheckpointsRowMatchesOfficialSchema;

function getExportedSchema(name: string): ZodType {
  const candidate = (sharedExports as Record<string, unknown>)[name];

  expect(candidate, `${name} export is missing`).toBeDefined();

  if (
    !candidate ||
    typeof candidate !== "object" ||
    !("parse" in candidate) ||
    typeof candidate.parse !== "function"
  ) {
    throw new Error(`${name} is not a Zod schema export.`);
  }

  return candidate as ZodType;
}

describe("run.usage 事件（上下文容量 / 缓存命中）", () => {
  it("接受带缓存字段的用量快照", () => {
    const event = streamEventSchema.parse({
      type: "run.usage",
      runId: "run_123",
      inputTokens: 614000,
      outputTokens: 1200,
      cachedInputTokens: 610000,
      timestamp: "2026-03-23T12:00:00.000Z",
    });
    expect(event.type).toBe("run.usage");
  });

  it("cachedInputTokens 可缺省（上游不上报缓存时不许编 0）", () => {
    const event = streamEventSchema.parse({
      type: "run.usage",
      runId: "run_123",
      inputTokens: 100,
      outputTokens: 1,
      timestamp: "2026-03-23T12:00:00.000Z",
    });
    expect(event).not.toHaveProperty("cachedInputTokens");
  });

  it("token 数必须是非负整数", () => {
    for (const bad of [-1, 1.5]) {
      expect(() =>
        streamEventSchema.parse({
          type: "run.usage",
          runId: "run_123",
          inputTokens: bad,
          outputTokens: 1,
          timestamp: "2026-03-23T12:00:00.000Z",
        }),
      ).toThrow();
    }
  });
});

describe("子代理与后台任务契约（DEC-14…DEC-19）", () => {
  const baseToolEvent = {
    runId: "run_123",
    toolCallId: "call_1",
    toolName: "task",
    timestamp: "2026-09-26T12:00:00.000Z",
  };

  it("tool.started/completed 接受可选 agentName（子代理归因，来源 metadata.lc_agent_name）", () => {
    const started = streamEventSchema.parse({
      type: "tool.started",
      ...baseToolEvent,
      input: { subagent_type: "explore", description: "调研登录链路" },
      agentName: "explore",
    });
    expect(started.agentName).toBe("explore");

    const completed = streamEventSchema.parse({
      type: "tool.completed",
      ...baseToolEvent,
      agentName: "explore",
    });
    expect(completed.agentName).toBe("explore");
  });

  it("不带 agentName 的旧事件照常解析（字段纯增量，无 fallback 分支）", () => {
    const started = streamEventSchema.parse({
      type: "tool.started",
      ...baseToolEvent,
    });
    expect(started).not.toHaveProperty("agentName");
  });

  it("task.notification 事件：后台任务终态通知载荷完整解析", () => {
    const event = streamEventSchema.parse({
      type: "task.notification",
      runId: "run_123",
      taskId: "task_abc123",
      kind: "subagent",
      label: "explore · 调研登录链路",
      status: "completed",
      summary: "定位到 3 处相关文件",
      nextStep: "可再次派生或直接继续主线",
      timestamp: "2026-09-26T12:05:00.000Z",
    });
    expect(event.type).toBe("task.notification");
    expect(event.kind).toBe("subagent");
    expect(event.nextStep).toContain("派生");
  });

  it("task.notification 拒绝非法 kind 与非终态 status", () => {
    const base = {
      runId: "run_123",
      taskId: "task_abc123",
      label: "x",
      summary: "s",
      timestamp: "2026-09-26T12:05:00.000Z",
    };
    expect(() =>
      streamEventSchema.parse({
        ...base,
        type: "task.notification",
        kind: "shell",
        status: "completed",
      }),
    ).toThrow();
    expect(() =>
      streamEventSchema.parse({
        ...base,
        type: "task.notification",
        kind: "subagent",
        status: "running",
      }),
    ).toThrow();
  });

  it("task_notification 消息块：转录落库与前端渲染共用同一形状", () => {
    const block = contentBlockSchema.parse({
      type: "task_notification",
      taskId: "task_abc123",
      kind: "command",
      label: "pnpm test",
      status: "failed",
      summary: "2 个用例失败",
      at: "2026-09-26T12:06:00.000Z",
    });
    expect(block.type).toBe("task_notification");
  });

  it("task_notification 块拒绝未知 status 与缺省 summary", () => {
    expect(() =>
      contentBlockSchema.parse({
        type: "task_notification",
        taskId: "task_abc123",
        kind: "subagent",
        label: "x",
        status: "pending",
        summary: "s",
      }),
    ).toThrow();
    expect(() =>
      contentBlockSchema.parse({
        type: "task_notification",
        taskId: "task_abc123",
        kind: "subagent",
        label: "x",
        status: "completed",
      }),
    ).toThrow();
  });
});
