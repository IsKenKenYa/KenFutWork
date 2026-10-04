import { describe, expect, it, vi } from "vitest";

import { z } from "zod";
import { ToolDeniedError } from "../kernel/context.js";
import type { ToolDefinition } from "../kernel/types.js";
import {
  bridgeKernelTools,
  jsonSchemaToZod,
  kernelToolToStructuredTool,
} from "./kernel-tools-bridge.js";
import { resolveCanvasStateForRun, resolvePresetForRun } from "./runtime.js";

describe("jsonSchemaToZod（桥接转换）", () => {
  it("object 属性与 required 生成校验", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        query: { type: "string", description: "查询词" },
        num: { type: "number" },
        flag: { type: "boolean" },
      },
      required: ["query"],
    }) as z.ZodObject<Record<string, z.ZodTypeAny>>;
    expect(schema.safeParse({ query: "x" }).success).toBe(true);
    expect(schema.safeParse({ num: 3 }).success).toBe(false);
    expect(schema.safeParse({ query: 1 }).success).toBe(false);
  });

  it("array/嵌套 object保留完整校验语义", () => {
    const arraySchema = jsonSchemaToZod({
      type: "array",
      items: { type: "string" },
    }) as z.ZodArray<z.ZodString>;
    expect(arraySchema.safeParse(["a"]).success).toBe(true);
    expect(arraySchema.safeParse([1]).success).toBe(false);

    const deep = jsonSchemaToZod({
      type: "object",
      properties: {
        a: {
          type: "object",
          properties: {
            b: {
              type: "object",
              properties: {
                c: {
                  type: "object",
                  properties: {
                    d: {
                      type: "object",
                      properties: { e: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }) as z.ZodObject<Record<string, z.ZodTypeAny>>;
    // 深层对象仍按属主schema校验，不用无关深度值削弱校验。
    expect(deep.safeParse({ a: { b: { c: { d: { e: "v" } } } } }).success).toBe(
      true,
    );
  });

  it("无 type/空 schema按工具参数对象解析", () => {
    const schema = jsonSchemaToZod({}) as z.ZodObject<
      Record<string, z.ZodTypeAny>
    >;
    expect(schema.safeParse({}).success).toBe(true);
  });
});

describe("kernelToolToStructuredTool（模型可调用桥）", () => {
  it("JSON属主schema的default/enum在模型桥与审批入口保持同样参数语义", async () => {
    const bridge = kernelToolToStructuredTool({
      name: "external",
      scope: "shared",
      description: "external",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["fast", "safe"] },
          count: { type: "integer", default: 2 },
        },
        required: ["mode"],
        additionalProperties: false,
      },
      execute: async (args) => args,
    });
    expect(await bridge.invoke({ mode: "safe" })).toMatchObject({
      mode: "safe",
      count: 2,
    });
    await expect(bridge.invoke({ mode: "invalid" })).rejects.toThrow();
  });
  it("真实调用身份与媒体内容进入模型，完整结果单独留给界面", async () => {
    let observedCallId: string | undefined;
    const block = {
      type: "image",
      source_type: "base64",
      mime_type: "image/png",
      data: "cG5n",
    };
    const raw = {
      type: "image",
      filePath: "/project/proof.png",
      modelContent: [block],
      display: { kind: "image" },
    };
    const bridged = kernelToolToStructuredTool({
      name: "Read",
      description: "读取",
      scope: "code",
      parameters: { type: "object" },
      execute: async (_args, context) => {
        observedCallId = context.toolCallId;
        return raw;
      },
    });
    const message = await bridged.invoke({
      type: "tool_call",
      name: "Read",
      id: "model-call-1",
      args: {},
    });
    expect(observedCallId).toBe("model-call-1");
    expect(message).toMatchObject({
      content: [block],
      artifact: { canonicalOutput: raw },
    });
  });
  it("调用透传 args 与执行上下文", async () => {
    const execute = vi.fn(async (args: Record<string, unknown>) => ({
      echo: args.q,
      runId: (args as { __runId?: string }).__runId,
    }));
    const def: ToolDefinition = {
      name: "web_search",
      description: "搜索",
      scope: "shared",
      parameters: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      },
      execute,
    };
    const structured = kernelToolToStructuredTool(def, { runId: "run-1" });
    const result = (await structured.invoke({ q: "kenfutwork" })) as string;
    expect(JSON.stringify(result)).toContain("kenfutwork");
    expect(execute).toHaveBeenCalledWith(
      { q: "kenfutwork" },
      expect.objectContaining({ runId: "run-1" }),
    );
  });

  it("原执行canonical与模型内容不混入独立UI展示，artifact保完整结果与display", async () => {
    const canonical = { type: "update", filePath: "/work/a.ts", content: "new\n", originalFile: "old\n", version: "v2" };
    const content = [{ type: "text", text: "已修改a.ts" }];
    const display = { kind: "file_diff", filePath: canonical.filePath, additions: 1, deletions: 1, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }] };
    const output = { canonicalOutput: canonical, modelContent: content, display };
    const before = structuredClone(output);
    const bridged = kernelToolToStructuredTool({ name: "Edit", description: "修改", scope: "code", parameters: { type: "object" }, execute: async () => output });
    const message = await bridged.invoke({ type: "tool_call", name: "Edit", id: "display-separate", args: {} });
    expect(message).toMatchObject({ content, artifact: { canonicalOutput: canonical, display } });
    expect(output).toEqual(before);
    expect(JSON.stringify(message.content)).not.toContain("structuredPatch");
    expect(message.artifact.canonicalOutput).not.toHaveProperty("display");
  });

  it("bridgeKernelTools 批量桥接并保留名称", () => {
    const defs: ToolDefinition[] = ["a", "b"].map((name) => ({
      name: `mcp__srv__${name}`,
      description: "",
      scope: "shared",
      parameters: { type: "object" },
      execute: async () => name,
    }));
    const bridged = bridgeKernelTools(defs);
    expect(bridged.map((t) => t.name)).toEqual(["mcp__srv__a", "mcp__srv__b"]);
  });

  it("invoke 期 configurable 的 user_attachment_map 透传进 execCtx（副本不污染）", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const definition: ToolDefinition = {
      name: "attachment_tool",
      description: "",
      scope: "design",
      parameters: { type: "object" },
      execute: async (_args, execCtx) => {
        seen.push(execCtx.userAttachmentMap);
        return "ok";
      },
    };
    const bridged = kernelToolToStructuredTool(definition, { runId: "r1" });

    // invoke 带 configurable（runtime 的 run 级注入路径）
    await bridged.invoke(
      {} as never,
      {
        configurable: {
          user_attachment_map: { asset_1: "data:image/png;base64,x" },
        },
      } as never,
    );
    // invoke 不带 configurable：execCtx 原样（无该字段）
    await bridged.invoke({} as never);

    expect(seen[0]).toEqual({ asset_1: "data:image/png;base64,x" });
    expect(seen[1]).toBeUndefined();
  });

  it("zodSchema 优先直通：default/enum 精度不因 JSON Schema 往返丢失", async () => {
    const zodSchema = z.object({
      level: z.enum(["low", "high"]).default("low"),
      count: z.number().default(3),
    });
    const seen: Array<Record<string, unknown>> = [];
    const bridged = kernelToolToStructuredTool({
      name: "native_zod_tool",
      description: "",
      scope: "design",
      parameters: { type: "object" },
      zodSchema,
      execute: async (args) => {
        seen.push(args);
        return "ok";
      },
    });

    // 模型只传部分字段 → 属主zod default补齐。
    const result = await bridged.invoke({} as never);
    expect(result).toBe("ok");
    expect(seen.at(0)).toEqual({ level: "low", count: 3 });
  });
});

/**
 * 回归：权限拒绝**不得**中断整轮 run。
 * 原先 ToolDeniedError 从工具节点抛出，默认权限档下任何 mcp__ 调用都会让整轮以
 * 一个与因果无关的 LangChain 中间件错误收场（实测）。拒绝应作为工具级结果交回模型。
 */
describe("权限拒绝转工具级结果（回归）", () => {
  function deniedTool(): ToolDefinition {
    return {
      name: "mcp__srv__danger",
      description: "",
      scope: "shared",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw new ToolDeniedError("mcp__srv__danger", "危险操作需审批");
      },
    };
  }

  it("ToolDeniedError 转为可读字符串结果，而不是抛出", async () => {
    const structured = kernelToolToStructuredTool(deniedTool());
    const result = await structured.invoke({});
    expect(typeof result).toBe("string");
    expect(result as string).toContain("mcp__srv__danger");
    expect(result as string).toContain("危险操作需审批");
  });

  it("拒绝结果经 JSON 序列化后仍可读（模型能看到原因）", async () => {
    const structured = kernelToolToStructuredTool(deniedTool());
    const result = await structured.invoke({});
    expect(JSON.stringify(result)).toContain("危险操作需审批");
  });

  it("非拒绝类错误仍然抛出（不把真实故障吞成正常结果）", async () => {
    const broken: ToolDefinition = {
      name: "mcp__srv__broken",
      description: "",
      scope: "shared",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("上游连接断开");
      },
    };
    const structured = kernelToolToStructuredTool(broken);
    await expect(structured.invoke({})).rejects.toThrow("上游连接断开");
  });

  it("正常工具不受影响", async () => {
    const ok: ToolDefinition = {
      name: "ok",
      description: "",
      scope: "shared",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ value: 42 }),
    };
    const structured = kernelToolToStructuredTool(ok);
    await expect(structured.invoke({})).resolves.toEqual({ value: 42 });
  });
});

describe("resolvePresetForRun（DEC-2 会话级 preset）", () => {
  it("画布运行归 design，纯会话归 code，显式传入优先", () => {
    expect(resolvePresetForRun({ canvasId: "c1" })).toBe("design");
    expect(resolvePresetForRun({})).toBe("code");
    expect(resolvePresetForRun({ canvasId: "c1", preset: "code" })).toBe(
      "code",
    );
  });
});

describe("resolveCanvasStateForRun（DEC-2 画布状态门控：design 才注入）", () => {
  const CANVAS_ID = "canvas-1";
  const elements = [
    { id: "r1", type: "rectangle", x: 0, y: 0, width: 100, height: 50 },
  ];

  function deps(overrides: { findById?: () => unknown } = {}) {
    return {
      viewerService: {
        resolveWorkspace: async () => ({ id: "ws-1" }),
      } as never,
      canvasRepository: {
        findById: async () => ({ content: { elements } }),
        findWorkspaceIdByCanvas: async () => "ws-1",
        findProjectBrandKitId: async () => null,
        saveContent: async () => 1,
        appendContent: async () => 1,
        ...overrides,
      } as never,
    };
  }

  it("design（含 canvasId 兜底路径）：解析画布并产出摘要", async () => {
    const summary = await resolveCanvasStateForRun(
      { canvasId: CANVAS_ID, userId: "u1", preset: "design" },
      deps(),
    );
    expect(summary).toContain("Canvas: 1 elements");
    expect(summary).toContain("rectangle#r1");

    // 未显式声明 preset、带 canvasId → design 兜底，同样注入
    const fallback = await resolveCanvasStateForRun(
      { canvasId: CANVAS_ID, userId: "u1" },
      deps(),
    );
    expect(fallback).toContain("Canvas: 1 elements");
  });

  it("code：即使带真实 canvasId（项目主画布）也不注入", async () => {
    const summary = await resolveCanvasStateForRun(
      { canvasId: CANVAS_ID, userId: "u1", preset: "code" },
      deps(),
    );
    expect(summary).toBeNull();
  });

  it("design 但仓储缺席 / 画布解析失败 → null（非关键）", async () => {
    expect(
      await resolveCanvasStateForRun(
        { canvasId: CANVAS_ID, userId: "u1", preset: "design" },
        {},
      ),
    ).toBeNull();
    expect(
      await resolveCanvasStateForRun(
        { canvasId: CANVAS_ID, userId: "u1", preset: "design" },
        deps({ findById: () => null }),
      ),
    ).toBeNull();
  });
});
