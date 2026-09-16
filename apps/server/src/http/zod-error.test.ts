import { describe, expect, it } from "vitest";
import { z } from "zod";

import { describeZodIssues, isZodError } from "./zod-error.js";

/** 共享的 ZodError 判定/描述（原先在 11 个路由文件里各写一份，逐字相同）。 */

describe("isZodError", () => {
  it("识别真实 ZodError（zod 4 解析失败）", () => {
    const result = z.object({ name: z.string() }).safeParse({ name: 1 });
    expect(result.success).toBe(false);
    expect(isZodError(result.error)).toBe(true);
  });

  it("不误判普通 Error 与伪造 name 的对象", () => {
    expect(isZodError(new Error("boom"))).toBe(false);
    expect(isZodError({ name: "ZodError" })).toBe(false); // 没有 issues 数组
    expect(isZodError(null)).toBe(false);
    expect(isZodError(undefined)).toBe(false);
    expect(isZodError("ZodError")).toBe(false);
  });

  it("鸭子类型：跨模块副本的同类错误仍被识别（instanceof 会假失败）", () => {
    const fake = Object.assign(new Error("Invalid input"), {
      name: "ZodError",
      issues: [{ message: "头名非法", path: ["headers", "x bad"] }],
    });
    expect(isZodError(fake)).toBe(true);
  });
});

describe("describeZodIssues", () => {
  it("拼成「字段路径：规则说明」，多问题用分号连接", () => {
    expect(
      describeZodIssues([
        { message: "头名必须是合法 HTTP token", path: ["headers", "x bad"] },
        { message: "必填", path: ["apiKey"] },
      ]),
    ).toBe("headers.x bad：头名必须是合法 HTTP token；apiKey：必填");
  });

  it("封顶 5 条，且无路径时只回说明；空 issues 给兜底文案", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      message: `问题${i}`,
      path: [`f${i}`],
    }));
    expect(describeZodIssues(many).split("；")).toHaveLength(5);
    expect(describeZodIssues([{ message: "顶层不合法" }])).toBe("顶层不合法");
    expect(describeZodIssues([])).toBe("请求体不符合契约。");
  });

  it("不回显收到的值：issue 里带 input 也只输出路径与说明", () => {
    const description = describeZodIssues([
      {
        message: "头值只能含可打印 ASCII 字符",
        path: ["headers", "x-tenant"],
        input: "secret-value-from-request",
      },
    ]);
    expect(description).toContain("headers.x-tenant");
    expect(description).not.toContain("secret-value-from-request");
  });
});
