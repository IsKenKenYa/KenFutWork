import { describe, expect, it, vi } from "vitest";

import type { z } from "zod";
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

describe("resolvePresetForRun（DEC-2 会话级 preset）", () => {
  it("画布运行归 design，纯会话归 code，显式传入优先", () => {
    expect(resolvePresetForRun({ canvasId: "c1" })).toBe("design");
    expect(resolvePresetForRun({})).toBe("code");
    expect(resolvePresetForRun({ canvasId: "c1", preset: "code" })).toBe(
      "code",
    );
  });
});
