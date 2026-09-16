import { describe, expect, it } from "vitest";
import {
  agentRunEventNameSchema,
  executionModeSchema,
  permissionTierSchema,
  usageRecordSchema,
} from "./capability-contracts.js";
import {
  modelCapabilitySchema,
  providerInstanceConfigSchema,
  providerInstanceCreateRequestSchema,
  providerInstanceHeadersSchema,
  providerInstanceListResponseSchema,
  providerInstanceResponseSchema,
  providerInstanceUpdateRequestSchema,
  providerProtocolSchema,
  reservedProviderHeaderNames,
} from "./provider-contracts.js";

describe("provider-contracts（BYOK 供应商缝）", () => {
  it("协议是封闭集合：未知协议拒绝", () => {
    expect(providerProtocolSchema.safeParse("openai-compatible").success).toBe(
      true,
    );
    expect(providerProtocolSchema.safeParse("not-a-protocol").success).toBe(
      false,
    );
  });

  it("能力词汇表：chat/image/video 之外拒绝", () => {
    expect(modelCapabilitySchema.safeParse("audio").success).toBe(false);
    expect(modelCapabilitySchema.safeParse("image").success).toBe(true);
  });

  it("实例 config：空 models 与空 apiKeyRef 拒绝", () => {
    const base = {
      id: "inst-1",
      workspaceId: "ws-1",
      name: "我的网关",
      protocol: "openai-compatible",
      apiKeyRef: "ref-1",
      models: [{ id: "gpt-x", name: "GPT X", capability: "chat" }],
      enabled: true,
    };
    expect(providerInstanceConfigSchema.safeParse(base).success).toBe(true);
    expect(
      providerInstanceConfigSchema.safeParse({ ...base, models: [] }).success,
    ).toBe(false);
    expect(
      providerInstanceConfigSchema.safeParse({ ...base, apiKeyRef: "" })
        .success,
    ).toBe(false);
  });

  it("创建请求必须携带明文 apiKey（只写通道）", () => {
    const base = {
      name: "网关",
      protocol: "anthropic",
      models: [{ id: "claude-x", name: "Claude X", capability: "chat" }],
    };
    expect(
      providerInstanceCreateRequestSchema.safeParse({ ...base, apiKey: "k-1" })
        .success,
    ).toBe(true);
    expect(providerInstanceCreateRequestSchema.safeParse(base).success).toBe(
      false,
    );
  });

  it("凭证红线：响应 schema 不含 apiKey/apiKeyRef 字段（多余的 key 会被剥掉）", () => {
    const parsed = providerInstanceResponseSchema.parse({
      id: "inst-1",
      scope: "workspace",
      name: "网关",
      protocol: "gemini",
      hasCredential: true,
      models: [{ id: "m1", name: "M1", capability: "image" }],
      headerKeys: [],
      enabled: true,
      // 恶意/误传的敏感字段必须被剥除而非透传
      apiKey: "secret",
      apiKeyRef: "ref-1",
    });
    expect(parsed).not.toHaveProperty("apiKey");
    expect(parsed).not.toHaveProperty("apiKeyRef");
    expect(parsed.hasCredential).toBe(true);

    const list = providerInstanceListResponseSchema.parse({
      instances: [
        {
          id: "i",
          scope: "workspace",
          name: "n",
          protocol: "volces",
          hasCredential: false,
          models: [{ id: "m", name: "M", capability: "video" }],
          headerKeys: ["x-opencode-session"],
          enabled: false,
          apiKey: "leak",
        },
      ],
    });
    expect(JSON.stringify(list)).not.toContain("leak");
    expect(JSON.stringify(list)).not.toContain("apiKey");
  });
});

describe("provider-contracts 自定义请求头（§4.8，R6-1）", () => {
  const parseHeaders = (headers: Record<string, string>) =>
    providerInstanceHeadersSchema.safeParse(headers);

  it("静态头与白名单占位符通过", () => {
    expect(
      parseHeaders({
        "x-opencode-session": "{{sessionId}}",
        "x-opencode-client": "loomic",
        "x-tenant-id": "ws-42",
      }).success,
    ).toBe(true);
  });

  it("保留头拒绝（大小写不敏感）——否则可顶掉凭证头", () => {
    for (const reserved of reservedProviderHeaderNames) {
      expect(parseHeaders({ [reserved]: "x" }).success).toBe(false);
      expect(parseHeaders({ [reserved.toUpperCase()]: "x" }).success).toBe(
        false,
      );
    }
    expect(parseHeaders({ Authorization: "Bearer sk-evil" }).success).toBe(
      false,
    );
    expect(parseHeaders({ "X-Api-Key": "sk-evil" }).success).toBe(false);
  });

  it("头名必须是合法 HTTP token（空格/冒号/中文一律拒绝）", () => {
    expect(parseHeaders({ "x bad": "1" }).success).toBe(false);
    expect(parseHeaders({ "x-bad:": "1" }).success).toBe(false);
    expect(parseHeaders({ "x-租户": "1" }).success).toBe(false);
    expect(parseHeaders({ "": "1" }).success).toBe(false);
  });

  it("头值禁 CR/LF 与控制字符——否则可注入额外头（请求走私）", () => {
    expect(parseHeaders({ "x-a": "v1\r\nx-evil: 1" }).success).toBe(false);
    expect(parseHeaders({ "x-a": "v1\nX" }).success).toBe(false);
    expect(parseHeaders({ "x-a": "v1\u0000" }).success).toBe(false);
    expect(parseHeaders({ "x-a": "中文值" }).success).toBe(false);
    expect(parseHeaders({ "x-a": "a b\tc".replace("\t", " ") }).success).toBe(
      true,
    );
    // 空值是合法头值（`x-a:`）
    expect(parseHeaders({ "x-a": "" }).success).toBe(true);
  });

  it("占位符白名单：只有 {{sessionId}} / {{threadId}}，白名单外不做模板求值", () => {
    expect(parseHeaders({ "x-tenant": "{{workspaceId}}" }).success).toBe(false);
    expect(parseHeaders({ "x-tenant": "{{}} " }).success).toBe(false);
    expect(
      parseHeaders({ "x-tenant": "prefix-{{threadId}}-suffix" }).success,
    ).toBe(true);
  });

  it("条数上限与大小写重复拒绝", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 33; i += 1) many[`x-h-${i}`] = "v";
    expect(parseHeaders(many).success).toBe(false);

    expect(parseHeaders({ "x-a": "1", "X-A": "2" }).success).toBe(false);
  });

  it("创建/更新请求携带 headers；更新传 {} 合法（= 清空）", () => {
    const base = {
      name: "网关",
      protocol: "openai-compatible",
      models: [{ id: "gpt-x", name: "GPT X", capability: "chat" }],
      apiKey: "k-1",
    };
    expect(
      providerInstanceCreateRequestSchema.safeParse({
        ...base,
        headers: { "x-opencode-session": "{{sessionId}}" },
      }).success,
    ).toBe(true);
    expect(
      providerInstanceCreateRequestSchema.safeParse({
        ...base,
        headers: { Authorization: "Bearer leak" },
      }).success,
    ).toBe(false);
    expect(
      providerInstanceUpdateRequestSchema.safeParse({ headers: {} }).success,
    ).toBe(true);
  });

  it("响应侧只回 headerKeys：值即使误传也被剥除", () => {
    const parsed = providerInstanceResponseSchema.parse({
      id: "inst-1",
      scope: "workspace",
      name: "opencode",
      protocol: "openai-compatible",
      hasCredential: true,
      models: [{ id: "m1", name: "M1", capability: "chat" }],
      headerKeys: ["x-opencode-session"],
      enabled: true,
      // 误传的敏感字段：必须被剥除
      headers: { "x-opencode-session": "sess-abc123" },
    });

    expect(parsed.headerKeys).toEqual(["x-opencode-session"]);
    expect(parsed).not.toHaveProperty("headers");
    expect(JSON.stringify(parsed)).not.toContain("sess-abc123");
  });
});

describe("capability-contracts（能力层共享契约）", () => {
  it("执行模式与权限档位词汇表按 DEC-3/DEC-4 封闭", () => {
    expect(executionModeSchema.safeParse("agent").success).toBe(true);
    expect(executionModeSchema.safeParse("plan").success).toBe(true);
    expect(executionModeSchema.safeParse("goal").success).toBe(true);
    expect(executionModeSchema.safeParse("loop").success).toBe(true);
    expect(executionModeSchema.safeParse("solo").success).toBe(true);
    expect(executionModeSchema.safeParse("creative").success).toBe(true);
    expect(executionModeSchema.safeParse("auto").success).toBe(false);
    expect(permissionTierSchema.safeParse("default").success).toBe(true);
    expect(permissionTierSchema.safeParse("full-access").success).toBe(true);
    expect(permissionTierSchema.safeParse("unlimited").success).toBe(false);
  });

  it("agent-run 事件只有 3 个（DEC-1）", () => {
    expect(agentRunEventNameSchema.safeParse("pre-step").success).toBe(true);
    expect(agentRunEventNameSchema.safeParse("post-step").success).toBe(false);
  });

  it("用量记录：token 数必须非负整数，agent/直连两链路字段可选", () => {
    const base = {
      workspaceId: "ws-1",
      provider: "openai-compatible",
      model: "gpt-x",
      capability: "chat",
      inputTokens: 10,
      outputTokens: 20,
      occurredAt: "2026-09-12T00:00:00Z",
    };
    expect(usageRecordSchema.safeParse(base).success).toBe(true);
    expect(
      usageRecordSchema.safeParse({ ...base, inputTokens: -1 }).success,
    ).toBe(false);
    expect(
      usageRecordSchema.safeParse({ ...base, outputTokens: 1.5 }).success,
    ).toBe(false);
    expect(
      usageRecordSchema.safeParse({
        ...base,
        runId: "run-1",
        jobId: "job-1",
        totalTokens: 30,
        costUsd: 0.01,
      }).success,
    ).toBe(true);
  });
});
