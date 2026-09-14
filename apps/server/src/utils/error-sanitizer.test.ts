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

  /**
   * 回归（GUI 全流程实测）：工具抛的可读错误被 LangChain 包一层（原文在 `cause` 里），
   * 只看顶层的标记就会把它压成「请求处理失败，请重试。」——实测 web_search 打真实
   * 秘塔端点、Key 无效时用户只看到通用文案，看不出是 Key 的问题。
   */
  it("可读错误被包装进 cause 链时仍透传（取最内层面向用户的文案）", () => {
    const inner = new Error(
      "web_search 请求失败（API密钥无效），请检查搜索供应商配置。",
    );
    Object.defineProperty(inner, "exposeToClient", { value: true });
    const wrapped = new Error("Tool execution failed", { cause: inner });
    Object.defineProperty(wrapped, "exposeToClient", { value: false });

    expect(sanitizeErrorForClient(wrapped)).toBe(
      "web_search 请求失败（API密钥无效），请检查搜索供应商配置。",
    );
  });

  it("cause 链里没有面向用户的错误时仍走通用文案", () => {
    const inner = new Error("connect ECONNREFUSED 127.0.0.1:9099");
    const wrapped = new Error("Tool execution failed", { cause: inner });
    expect(sanitizeErrorForClient(wrapped)).toBe("请求处理失败，请重试。");
  });
});
