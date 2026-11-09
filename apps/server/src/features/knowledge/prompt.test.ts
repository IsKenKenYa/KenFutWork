import { describe, expect, it } from "vitest";

import type { PromptCompositionContext } from "../../kernel/types.js";
import { createKnowledgePromptSection } from "./prompt.js";
import type { KnowledgeRuntimeSettings } from "./settings.js";
import type { KnowledgeService } from "./types.js";

const settings: KnowledgeRuntimeSettings = {
  autoInject: true,
  localMatch: false,
  autoLocalFallback: true,
  maxResults: 5,
  minHits: 1,
  searchTimeoutMs: 30_000,
  maxConcurrentSearches: 2,
  evidenceMaxChars: 6_000,
  cacheTtlMs: 300_000,
  readMaxBytes: 1_048_576,
  listTimeoutMs: 120_000,
  listRetries: 1,
};

function service(active: boolean): KnowledgeService {
  return {
    async isActive() {
      return active
        ? { ok: true, message: "" }
        : { ok: false, message: "未安装" };
    },
    async status() {
      throw new Error("not used");
    },
    async initialize() {
      throw new Error("not used");
    },
    async listRoots() {
      return [];
    },
    async addRoot() {
      throw new Error("not used");
    },
    async removeRoot() {
      throw new Error("not used");
    },
    async ensureRoot(path) {
      return { path, action: "already-indexed" };
    },
    async search() {
      throw new Error("not used");
    },
    async read() {
      throw new Error("not used");
    },
    rootsRevision() {
      return 0;
    },
  };
}

const ctx = (preset: "code" | "design"): PromptCompositionContext => ({
  preset,
});

describe("knowledge 置顶提示段（M3）", () => {
  it("order -50 / scope always：双 preset 都挂载且排在内置模式段之前", async () => {
    const section = createKnowledgePromptSection({
      knowledge: service(true),
      readSettings: async () => settings,
    });
    expect(section.order).toBe(-50);
    expect(section.scope).toBe("always");
    expect(await section.resolve(ctx("code"))).toContain("本地知识库");
    expect(await section.resolve(ctx("design"))).toContain("本地知识库");
  });

  it("未安装时 resolve 返回 null（本 run 不出现）", async () => {
    const section = createKnowledgePromptSection({
      knowledge: service(false),
      readSettings: async () => settings,
    });
    expect(await section.resolve(ctx("code"))).toBeNull();
  });

  it("自动注入关闭 / 本地匹配档在提示段如实声明", async () => {
    const off = createKnowledgePromptSection({
      knowledge: service(true),
      readSettings: async () => ({ ...settings, autoInject: false }),
    });
    expect(await off.resolve(ctx("code"))).toContain("已关闭");

    const local = createKnowledgePromptSection({
      knowledge: service(true),
      readSettings: async () => ({ ...settings, localMatch: true }),
    });
    expect(await local.resolve(ctx("code"))).toContain("本地匹配");
  });
});
