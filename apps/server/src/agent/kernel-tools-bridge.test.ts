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

  it("array/嵌套 object 递归，深层降级为 record", () => {
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
    // 第 5 层起不再展开（降级 record），但整体仍可解析对象
    expect(deep.safeParse({ a: { b: { c: { d: { e: "v" } } } } }).success).toBe(
      true,
    );
  });

  it("无 type/空 schema 降级为空对象", () => {
    const schema = jsonSchemaToZod({}) as z.ZodObject<
      Record<string, z.ZodTypeAny>
    >;
    expect(schema.safeParse({}).success).toBe(true);
  });
});

describe("kernelToolToStructuredTool（模型可调用桥）", () => {
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

    // 模型只传部分字段 → zod default 补齐（JSON Schema 转换路径会丢 default）
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
