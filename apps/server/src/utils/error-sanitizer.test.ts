import { describe, expect, it } from "vitest";

import { StreamIdleTimeoutError } from "../agent/stream-idle-guard.js";
import { sanitizeErrorForClient } from "./error-sanitizer.js";

describe("error-sanitizer 的面向用户错误透传", () => {
  it("标记 exposeToClient 的错误原样透传（可执行信息不被压成通用文案）", () => {
    const error = new StreamIdleTimeoutError(180_000);
    const message = sanitizeErrorForClient(error);
    expect(message).toContain("没有任何输出");
    expect(message).toContain("请重试或更换模型");
    // 不是通用兜底文案
    expect(message).not.toBe("请求处理失败，请重试。");
  });

  it("未标记的内部错误仍套用通用文案（不泄露内部细节）", () => {
    const internal = new Error(
      'Invalid response from "wrapModelCall" in middleware "patchToolCallsMiddleware": expected AIMessage or Command, got object',
    );
    expect(sanitizeErrorForClient(internal)).toBe("请求处理失败，请重试。");
  });

  it("超长文案不透传（长度上限守住，防堆栈/JSON 直出）", () => {
    const long = new Error("x".repeat(300));
    Object.defineProperty(long, "exposeToClient", { value: true });
    expect(sanitizeErrorForClient(long)).toBe("请求处理失败，请重试。");
  });
});
