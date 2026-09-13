import { describe, expect, it, vi } from "vitest";

import type { z } from "zod";
import { ToolDeniedError } from "../kernel/context.js";
import type { ToolDefinition } from "../kernel/types.js";
import {
  bridgeKernelTools,
  jsonSchemaToZod,
  kernelToolToStructuredTool,
} from "./kernel-tools-bridge.js";
import { resolvePresetForRun } from "./runtime.js";

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
    const result = (await structured.invoke({ q: "loomic" })) as string;
    expect(JSON.stringify(result)).toContain("loomic");
    expect(execute).toHaveBeenCalledWith(
      { q: "loomic" },
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
