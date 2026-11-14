import {
  mediaDriverQueryResultSchema,
  mediaDriverSubmitResultSchema,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { previewMediaDriverSource } from "./preview.js";

const source = `
export const manifest = {
  apiVersion: 1,
  id: "example-media",
  version: "1.0.0",
  name: "示例供应商",
  origins: ["https://media.example.com"],
  connectionFields: [{ key: "apiKey", label: "API Key", secret: true }],
  models: [{
    id: "native-image-v2", name: "图片模型", capability: "image",
    execution: "async", imageGeneration: { maxOutputs: 2 },
    parameters: [{ key: "strength", label: "强度", type: "number", min: 0, max: 1 }]
  }]
};
throw new Error("预览不能执行文件");
export async function submit(input: unknown, host: unknown) {
  return { state: "pending", handle: { id: "external-task" } };
}
export async function query(handle: unknown, host: unknown) {
  return { state: "pending" };
}
`;

describe("供应商文件预览", () => {
  it("公开文件接口区分最终产物、可恢复句柄和查询等待", () => {
    expect(
      mediaDriverSubmitResultSchema.parse({
        state: "pending",
        handle: { id: "upstream-17", region: "local" },
      }),
    ).toEqual({
      state: "pending",
      handle: { id: "upstream-17", region: "local" },
    });
    expect(mediaDriverQueryResultSchema.parse({ state: "pending" })).toEqual({
      state: "pending",
    });
    expect(
      mediaDriverSubmitResultSchema.safeParse({ state: "pending" }).success,
    ).toBe(false);
    expect(
      mediaDriverSubmitResultSchema.safeParse({
        state: "succeeded",
        outputs: [],
      }).success,
    ).toBe(false);
  });
  it("解析真实 TypeScript 并返回模型与参数，预览不执行文件", async () => {
    const result = await previewMediaDriverSource(source, {
      maxBytes: 1_048_576,
    });
    expect(result.manifest.models[0]).toEqual({
      id: "native-image-v2",
      name: "图片模型",
      capability: "image",
      execution: "async",
      imageGeneration: { maxOutputs: 2 },
      parameters: [
        { key: "strength", label: "强度", type: "number", min: 0, max: 1 },
      ],
    });
    expect(result.methods).toEqual(["submit", "query"]);
    expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.compiledCode).not.toContain("input: unknown");
  });

  it("拒绝函数内部的动态模块导入", async () => {
    await expect(
      previewMediaDriverSource(
        source.replace(
          'return { state: "pending" };',
          'await import("node:fs"); return { state: "pending" };',
        ),
        { maxBytes: 1_048_576 },
      ),
    ).rejects.toThrow("模块导入");
  });

  it("接受导出的箭头函数方法", async () => {
    const arrowSource = source.replace(
      "export async function submit(input: unknown, host: unknown) {",
      "export const submit = async (input: unknown, host: unknown) => {",
    );
    const result = await previewMediaDriverSource(arrowSource, {
      maxBytes: 1_048_576,
    });
    expect(result.methods).toEqual(["submit", "query"]);
  });

  it.each([
    ["未知接口版本", "apiVersion: 1", "apiVersion: 2"],
    ["异步缺少查询", "export async function query", "async function query"],
    [
      "重复模型",
      'id: "native-image-v2", name:',
      'id: "native-image-v2", id: "duplicate", name:',
    ],
    [
      "地址含密钥",
      "https://media.example.com",
      "https://secret@media.example.com",
    ],
    ["地址含路径", "https://media.example.com", "https://media.example.com/v1"],
    ["秘密默认值", "secret: true", 'secret: true, default: "credential"'],
    ["动态声明", "apiVersion: 1", 'apiVersion: Number("1")'],
    ["参数默认值越界", "min: 0, max: 1", "min: 0, max: 1, default: 2"],
    ["类型错误", 'capability: "image"', 'capability: "audio"'],
  ])("拒绝非法声明：%s", async (_label, previous, replacement) => {
    await expect(
      previewMediaDriverSource(source.replace(previous, replacement), {
        maxBytes: 1_048_576,
      }),
    ).rejects.toThrow();
  });

  it("按 UTF-8 字节检查文件上限", async () => {
    await expect(
      previewMediaDriverSource(source, {
        maxBytes: Buffer.byteLength(source) - 1,
      }),
    ).rejects.toThrow("大小");
    const result = await previewMediaDriverSource(source, {
      maxBytes: Buffer.byteLength(source),
    });
    expect(result.sourceBytes).toBe(Buffer.byteLength(source));
  });
});
