import { describe, expect, it, vi } from "vitest";

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
    expect(message).toBe("请求处理失败，请重试。");
    expect(describeErrorDetail(internal)).toContain("patchToolCallsMiddleware");
  });

  it("超长文案不透传（长度上限守住，防堆栈/JSON 直出）", () => {
    const long = new Error("x".repeat(400));
    Object.defineProperty(long, "exposeToClient", { value: true });
    const message = sanitizeErrorForClient(long);
    expect(message).toBe("请求处理失败，请重试。");
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

  it("JSON解析的 Unexpected token 不会被误判成认证失败", () => {
    const error = new SyntaxError(
      `Unexpected token '工', "工" is not valid JSON`,
    );
    const message = sanitizeErrorForClient(error);

    expect(message.startsWith("请求处理失败，请重试。")).toBe(true);
    expect(message).not.toContain("认证凭证");
    expect(message).not.toContain("重新登录");
  });

  it.each([
    [
      "HTTP 401 metadata",
      Object.assign(new Error("OpenAI request failed"), {
        response: { status: 401 },
      }),
    ],
    ["invalid_api_key", new Error("OpenAI invalid_api_key")],
    ["expired access token", new Error("expired access token")],
  ])("真实凭证错误仍分类为认证失败：%s", (_label, error) => {
    expect(sanitizeErrorForClient(error)).toContain(
      "认证失败，请在模型或工具设置中检查凭据。",
    );
  });

  it("凭据在message/cause/response/details/stack与客户端透传中统一脱敏", () => {
    const key = "sk-abcdef1234567890abcdef";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const inner = new Error(`invalid API key ${key}`);
      const error = Object.assign(
        new Error(`OpenAI request Bearer ${key}`, { cause: inner }),
        {
          response: { status: 401, data: { api_key: key } },
          details: { password: "abcdefghijklmnop" },
        },
      );
      const message = sanitizeErrorForClient(error);
      const logs = JSON.stringify(spy.mock.calls);
      expect(message).toContain("认证失败");
      expect(message).not.toContain(key);
      expect(logs).not.toContain(key);
      expect(logs).not.toContain("abcdefghijklmnop");
      expect(logs).toContain("***");
      Object.defineProperty(inner, "exposeToClient", { value: true });
      expect(sanitizeErrorForClient(inner)).not.toContain(key);
    } finally {
      spy.mockRestore();
    }
  });

  it("嵌套网络异常只显示可以采取的操作", () => {
    const inner = new Error("connect ECONNREFUSED 127.0.0.1:9099");
    const wrapped = new Error("Tool execution failed", { cause: inner });
    const message = sanitizeErrorForClient(wrapped);
    expect(message).toBe("网络连接异常，请检查网络后重试。");
    expect(describeErrorDetail(wrapped)).toContain(
      "ECONNREFUSED 127.0.0.1:9099",
    );
  });

  it.each([
    [403, "供应商拒绝访问，请在供应商设置中检查密钥和权限。"],
    [404, "供应商找不到模型或接口，请检查模型和供应商地址。"],
    [413, "提交内容太大，请缩短输入或减少附件后重试。"],
    [503, "AI 服务暂时不可用，请稍后重试。"],
  ])("从包裹的 HTTP %s 读取公开原因", (status, expected) => {
    const upstream = Object.assign(new Error("PRIVATE_PROVIDER_DETAIL"), {
      response: new Response(null, { status }),
    });
    const wrapped = new Error("模型调用失败", { cause: upstream });
    expect(sanitizeErrorForClient(wrapped)).toBe(expected);
  });

  it("供应商错误文案出现取消字样时仍是失败", () => {
    expect(sanitizeErrorForClient(new Error("provider canceled request"))).toBe(
      "请求处理失败，请重试。",
    );
  });

  it("循环的异常原因不会阻止返回公开报错", () => {
    const error = new Error("错误中的循环引用");
    Object.defineProperty(error, "cause", { value: error });
    expect(describeErrorDetail(error)).toBe("错误中的循环引用");
    expect(sanitizeErrorForClient(error)).toBe("请求处理失败，请重试。");
  });
});

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

  it("没有结构化状态时仅通过可识别的类别生成提示", () => {
    const err = new Error(
      'fetch failed: 400 {"error":{"message":"model not found"}}',
    );
    const message = sanitizeErrorForClient(err);
    expect(message).toBe("AI 服务暂时不可用，请稍后重试。");
    expect(describeErrorDetail(err)).toContain("model not found");
  });
});
