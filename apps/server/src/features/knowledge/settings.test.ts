import { describe, expect, it, vi } from "vitest";

import type { PersistenceService } from "../persistence/types.js";
import { createKnowledgeSettingsReader } from "./settings.js";

function fakePersistence(
  runtimeGovernance: Record<string, unknown> | Error,
): PersistenceService {
  return {
    forInstance: () => ({
      queryOne: async () => {
        if (runtimeGovernance instanceof Error) throw runtimeGovernance;
        return { runtime_governance: runtimeGovernance };
      },
    }),
  } as unknown as PersistenceService;
}

describe("knowledge 设置读取（DEC-18 优先级）", () => {
  it("无持久化/无实例时落默认值", async () => {
    const read = createKnowledgeSettingsReader({});
    expect(await read(undefined)).toMatchObject({
      autoInject: true,
      localMatch: false,
      maxResults: 5,
      minHits: 1,
      searchTimeoutMs: 30_000,
      cacheTtlMs: 300_000,
    });
  });

  it("库值优先于 env 兜底，且越界钳回护栏", async () => {
    const read = createKnowledgeSettingsReader({
      persistence: fakePersistence({
        knowledgeMaxResults: 9,
        knowledgeSearchTimeoutMs: 999_999_999,
        knowledgeAutoInject: false,
      }),
      env: { knowledgeMaxResults: 20, knowledgeLocalMatch: true },
    });
    const settings = await read("inst-1");
    expect(settings.maxResults).toBe(9);
    expect(settings.searchTimeoutMs).toBe(300_000);
    expect(settings.autoInject).toBe(false);
    expect(settings.localMatch).toBe(true);
  });

  it("读库失败回落 env/默认值并告警，不抛出（preflight 不阻断对话）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const read = createKnowledgeSettingsReader({
      persistence: fakePersistence(new Error("连接中断")),
      env: { knowledgeMaxResults: 7 },
    });
    const settings = await read("inst-1");
    expect(settings.maxResults).toBe(7);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
