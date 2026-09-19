import type { ProviderProtocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";

import { probeInstance } from "./probe.js";

/**
 * 实例能力探测（阶段 E）：fetch 注入 + 抓包口径——断言探测请求打到哪里、
 * 判定分类是否正确（true / false / notes），各探测项独立互不拖垮。
 */

const OPENAI_TARGET = {
  protocol: "openai-compatible" as ProviderProtocol,
  baseUrl: "https://gw.example/v1",
  apiKey: "sk-probe",
  model: "gpt-x",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("probeInstance（openai-compatible 四探测项）", () => {
  it("全支持：四项全 true 且无 notes；请求带凭证头与探测体", async () => {
    // include_usage 与 strict 同端点——按调用序处理：第一击 include_usage，
    // 第二击 strict。
    let chatCalls = 0;
    const fetchFn2 = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/chat/completions")) {
        chatCalls += 1;
        if (chatCalls === 1) {
          return new Response(
            'data: {"choices":[]}\n\ndata: {"usage":{"total_tokens":5}}\n\ndata: [DONE]\n',
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return jsonResponse(200, { choices: [] });
      }
      if (url.endsWith("/responses")) return jsonResponse(200, { id: "r" });
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await probeInstance(fetchFn2, OPENAI_TARGET);

    expect(result).toMatchObject({
      streamUsage: true,
      strictToolSchema: true,
      responsesApi: true,
    });
    expect(result.notes).toBeUndefined();
    // 第一击（include_usage）必须带流式探测体与凭证头
    const firstCall = (fetchFn2 as ReturnType<typeof vi.fn>).mock
      .calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(firstCall[0]).toBe("https://gw.example/v1/chat/completions");
    expect(firstCall[1].headers.Authorization).toBe("Bearer sk-probe");
    expect(firstCall[1].headers.Authorization).not.toContain("sk-probe, ");
  });

  it("include_usage 流式响应缺 usage chunk → false + 可读 note（P0 盲区）", async () => {
    let chatCalls = 0;
    const fetchFn = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/chat/completions")) {
        chatCalls += 1;
        if (chatCalls === 1) {
          return new Response('data: {"choices":[]}\n\ndata: [DONE]\n', {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return jsonResponse(200, { choices: [] });
      }
      return jsonResponse(200, { id: "r" });
    }) as unknown as typeof fetch;

    const result = await probeInstance(fetchFn, OPENAI_TARGET);
    expect(result.streamUsage).toBe(false);
    expect(result.notes?.some((n) => n.includes("include_usage"))).toBe(true);
  });

  it("strict tool schema 被网关拒绝（400）→ false；Responses 404 → false", async () => {
    let chatCalls = 0;
    const fetchFn = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/chat/completions")) {
        chatCalls += 1;
        if (chatCalls === 1) {
          return new Response('data: {"choices":[]}\n\ndata: {"usage":{}}\n', {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return jsonResponse(400, {
          error: { message: "strict not supported" },
        });
      }
      if (url.endsWith("/responses")) return jsonResponse(404, { error: "nf" });
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await probeInstance(fetchFn, OPENAI_TARGET);
    expect(result.strictToolSchema).toBe(false);
    expect(result.responsesApi).toBe(false);
    expect(result.notes?.length).toBeGreaterThan(0);
  });

  it("网络异常单项独立：notes 记录异常，其余项照常探测", async () => {
    const fetchFn = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/chat/completions")) {
        throw new Error("network down");
      }
      if (url.endsWith("/responses")) return jsonResponse(200, { id: "r" });
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await probeInstance(fetchFn, OPENAI_TARGET);
    expect(result.streamUsage).toBeUndefined();
    expect(result.responsesApi).toBe(true);
    expect(result.notes?.some((n) => n.includes("include_usage"))).toBe(true);
    expect(result.notes?.some((n) => n.includes("strict"))).toBe(true);
  });
});

describe("probeInstance（anthropic cache_control）", () => {
  it("200 → true，请求带 x-api-key 与 anthropic-version", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { id: "msg-1" }));
    const result = await probeInstance(fetchFn as unknown as typeof fetch, {
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "ak-probe",
    });
    expect(result.cacheControl).toBe(true);
    const call = (fetchFn as ReturnType<typeof vi.fn>).mock
      .calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(call[0]).toContain("/messages");
    expect(call[1].headers["x-api-key"]).toBe("ak-probe");
    expect(call[1].headers["anthropic-version"]).toBeTruthy();
  });

  it("4xx → false + note", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(400, { error: "bad" }));
    const result = await probeInstance(fetchFn as unknown as typeof fetch, {
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "ak",
    });
    expect(result.cacheControl).toBe(false);
  });
});

describe("probeInstance（不适用协议）", () => {
  it("生成类协议无探测项：只回 probedAt + 说明 note", async () => {
    const fetchFn = vi.fn();
    const result = await probeInstance(fetchFn as unknown as typeof fetch, {
      protocol: "replicate",
      baseUrl: "https://api.replicate.com",
      apiKey: "k",
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.probedAt).toBeTruthy();
    expect(
      Object.keys(result).filter((k) => k !== "probedAt" && k !== "notes"),
    ).toHaveLength(0);
    expect(result.notes?.[0]).toContain("replicate");
  });
});
