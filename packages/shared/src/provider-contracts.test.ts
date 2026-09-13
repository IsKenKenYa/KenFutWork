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
  providerInstanceListResponseSchema,
  providerInstanceResponseSchema,
  providerProtocolSchema,
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
      name: "网关",
      protocol: "gemini",
      hasCredential: true,
      models: [{ id: "m1", name: "M1", capability: "image" }],
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
          name: "n",
          protocol: "volces",
          hasCredential: false,
          models: [{ id: "m", name: "M", capability: "video" }],
          enabled: false,
          apiKey: "leak",
        },
      ],
    });
    expect(JSON.stringify(list)).not.toContain("leak");
    expect(JSON.stringify(list)).not.toContain("apiKey");
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
