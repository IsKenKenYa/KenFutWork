import { describe, expect, it } from "vitest";

import { StreamIdleTimeoutError } from "../agent/stream-idle-guard.js";
import {
  describeErrorDetail,
  sanitizeErrorForClient,
} from "./error-sanitizer.js";

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
    const message = sanitizeErrorForClient(internal);
    // 通用文案在前，后面挂脱敏后的原始错误（用户要求能读到原文，便于排查/贴给上游）
    expect(message.startsWith("请求处理失败，请重试。")).toBe(true);
    expect(message).toContain("原始错误：");
    expect(message).toContain("patchToolCallsMiddleware");
  });

  it("超长文案不透传（长度上限守住，防堆栈/JSON 直出）", () => {
    const long = new Error("x".repeat(400));
    Object.defineProperty(long, "exposeToClient", { value: true });
    const message = sanitizeErrorForClient(long);
    // 面向用户的自述文案有 200 字上限；原文另走「原始错误」段，且必须被截断
    expect(message.startsWith("请求处理失败，请重试。")).toBe(true);
    expect(message.length).toBeLessThan(400);
    expect(message.endsWith("…")).toBe(true);
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
    const message = sanitizeErrorForClient(wrapped);
    expect(message.startsWith("请求处理失败，请重试。")).toBe(true);
    // cause 链一并带出（顶层 + 内层），否则「Tool execution failed」等于没说
    expect(message).toContain("Tool execution failed");
    expect(message).toContain("ECONNREFUSED");
  });
});

/**
 * 原始错误的落点：结构化日志（ws/handler 的 run_failed）与用户可见文案同源。
 *
 * 背景（实测）：上游每轮 run 都失败时，原始错误只 `console.error` 到 stderr，
 * 终端一关就没了——既回溯不了上游返回了什么，也贴不给上游排查。
 */
describe("原始错误详情：脱敏与截断", () => {
  it("取顶层 message + cause 链 + 上游 HTTP 状态", () => {
    const inner = Object.assign(new Error("Bad Request"), { status: 400 });
    const wrapped = new Error("openai api error", { cause: inner });
    const detail = describeErrorDetail(wrapped);
    expect(detail).toContain("openai api error");
    expect(detail).toContain("Bad Request");
    expect(detail).toContain("HTTP 400");
  });

  it("Bearer / api_key / sk- 形态的凭证一律打码（Key 只写不读的红线）", () => {
    const raw =
      'Authorization: Bearer sk-abcdef1234567890abcdef, {"api_key":"QC-78b2ada128faa84ccf46c7cfde08a994-2d2095"}';
    const detail = describeErrorDetail(new Error(raw));
    expect(detail).not.toContain("sk-abcdef1234567890abcdef");
    expect(detail).not.toContain("78b2ada128faa84ccf46c7cfde08a994");
    expect(detail).toContain("***");
  });

  it("超长原文被截断（不把整页 JSON/堆栈塞进日志与对话）", () => {
    const detail = describeErrorDetail(new Error("y".repeat(900)));
    expect(detail.length).toBe(301);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("普通短文案脱敏后进用户可见文案（AI 服务暂时不可用 + 原始错误）", () => {
    const err = new Error('fetch failed: 400 {"error":{"message":"model not found"}}');
    const message = sanitizeErrorForClient(err);
    expect(message).toContain("AI 服务暂时不可用");
    expect(message).toContain("model not found");
  });
});
