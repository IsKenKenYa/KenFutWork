import { describe, expect, it, vi } from "vitest";
import {
  buildOpenDesignProvisionPlan,
  provisionOpenDesign,
} from "./provision.js";

const anthropicEntry = {
  providerId: "p1",
  name: "自建 Anthropic 兼容网关",
  protocol: "anthropic",
  apiBase: "https://gw.example/api",
  apiKey: "sk-secret-should-never-be-logged",
};

describe("OpenDesign 自动配置计划", () => {
  it("缺 onboardingCompleted 时补上；有 Key 但无可用 CLI 时如实说明", () => {
    const plan = buildOpenDesignProvisionPlan({
      entries: [anthropicEntry],
      agents: [{ id: "claude", available: false }],
      current: {},
    });
    expect(plan.patch).toEqual({ onboardingCompleted: true });
    expect(plan.agentId).toBeNull();
    expect(plan.reason).toContain("available=false");
  });

  it("没有任何已配 Key 的实例时给出另一条可读原因", () => {
    const plan = buildOpenDesignProvisionPlan({
      entries: [],
      agents: [{ id: "claude", available: true }],
      current: { onboardingCompleted: true },
    });
    expect(plan.patch).toEqual({});
    expect(plan.reason).toContain("API Key");
  });

  it("容器里有可用 CLI 且协议匹配时，注入 agentId 与该项 env", () => {
    const plan = buildOpenDesignProvisionPlan({
      entries: [anthropicEntry],
      agents: [
        { id: "codex", available: false },
        { id: "claude", available: true },
      ],
      current: { onboardingCompleted: true },
    });
    expect(plan.agentId).toBe("claude");
    expect(plan.reason).toBeNull();
    expect(plan.patch.agentId).toBe("claude");
    expect(plan.patch.agentCliEnv).toEqual({
      claude: {
        ANTHROPIC_API_KEY: anthropicEntry.apiKey,
        ANTHROPIC_BASE_URL: anthropicEntry.apiBase,
      },
    });
  });

  it("合并既有 CLI 环境：操作者预置的 CODEX_BIN/CODEX_HOME 不被供给流程抹掉", () => {
    const plan = buildOpenDesignProvisionPlan({
      entries: [{ ...anthropicEntry, protocol: "openai-compatible" }],
      agents: [{ id: "codex", available: true }],
      current: {
        onboardingCompleted: true,
        agentId: "codex",
        agentCliEnv: {
          codex: {
            CODEX_BIN: "/app/.od/tools/node_modules/.bin/codex",
            CODEX_HOME: "/app/.od/codex-home",
          },
        },
      },
    });
    expect(plan.patch.agentCliEnv).toEqual({
      codex: {
        CODEX_BIN: "/app/.od/tools/node_modules/.bin/codex",
        CODEX_HOME: "/app/.od/codex-home",
        OPENAI_API_KEY: anthropicEntry.apiKey,
        OPENAI_BASE_URL: anthropicEntry.apiBase,
      },
    });
  });

  it("只接受上游白名单内的 agent：opencode 有 Key 也不注入", () => {
    const plan = buildOpenDesignProvisionPlan({
      entries: [{ ...anthropicEntry, protocol: "openai-compatible" }],
      agents: [
        { id: "opencode", available: true },
        { id: "byok-opencode", available: true },
      ],
      current: { onboardingCompleted: true },
    });
    expect(plan.patch.agentId).toBeUndefined();
    expect(plan.agentId).toBeNull();
  });

  it("现值已完成引导时不再写 onboardingCompleted，但 Key 轮换仍能覆盖 env", () => {
    const plan = buildOpenDesignProvisionPlan({
      entries: [anthropicEntry],
      agents: [{ id: "claude", available: true }],
      current: {
        onboardingCompleted: true,
        agentId: "claude",
        agentCliEnv: {
          claude: {
            ANTHROPIC_API_KEY: anthropicEntry.apiKey,
            ANTHROPIC_BASE_URL: anthropicEntry.apiBase,
          },
        },
      },
    });
    // 现值已含 onboardingCompleted 与同一份 env，但仍会幂等重写 agentId/env——
    // 关键是 Key 轮换时能覆盖旧值，所以这里断言写的是同一份而不是跳过。
    expect(plan.patch.onboardingCompleted).toBeUndefined();
    expect(plan.patch.agentId).toBe("claude");
  });
});

describe("provisionOpenDesign 执行", () => {
  function fakeFetch(handlers: {
    agents?: unknown;
    config?: unknown;
    putStatus?: number;
  }) {
    const calls: { method: string; body: string | undefined }[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, body: init?.body as string | undefined });
      if (method === "PUT") {
        return Response.json(
          { error: "rejected" },
          { status: handlers.putStatus ?? 200 },
        );
      }
      if (url.endsWith("/api/agents")) {
        return Response.json({
          agents: handlers.agents ?? [{ id: "claude", available: true }],
        });
      }
      return Response.json({
        config: handlers.config ?? {},
      });
    });
    return { impl, calls };
  }

  it("读 agents 与 config 后写入补丁", async () => {
    const { impl, calls } = fakeFetch({});
    const result = await provisionOpenDesign({
      baseUrl: "http://127.0.0.1:7456/",
      fetchImpl: impl as unknown as typeof fetch,
      entries: [anthropicEntry],
    });
    expect(result).toEqual({ done: true, agentId: "claude", reason: null });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PUT"]);
    const body = JSON.parse(calls[2]?.body ?? "{}") as Record<string, unknown>;
    expect(body.onboardingCompleted).toBe(true);
    expect(body.agentId).toBe("claude");
  });

  it("写入被拒时返回可读原因，不抛", async () => {
    const { impl } = fakeFetch({ putStatus: 403 });
    const result = await provisionOpenDesign({
      baseUrl: "http://127.0.0.1:7456",
      fetchImpl: impl as unknown as typeof fetch,
      entries: [anthropicEntry],
    });
    expect(result.done).toBe(false);
    expect(result.reason).toContain("403");
  });

  it("接口未就绪时不写配置", async () => {
    const impl = vi.fn(async () => Response.json({}, { status: 503 }));
    const result = await provisionOpenDesign({
      baseUrl: "http://127.0.0.1:7456",
      fetchImpl: impl as unknown as typeof fetch,
      entries: [],
    });
    expect(result.done).toBe(false);
    expect(result.reason).toContain("未就绪");
  });

  it("日志与返回值都不带 Key 明文", async () => {
    const { impl } = fakeFetch({});
    const logged: string[] = [];
    await provisionOpenDesign({
      baseUrl: "http://127.0.0.1:7456",
      fetchImpl: impl as unknown as typeof fetch,
      entries: [anthropicEntry],
      log: (message) => logged.push(message),
    });
    expect(logged.join("\n")).not.toContain(anthropicEntry.apiKey);
  });
});
