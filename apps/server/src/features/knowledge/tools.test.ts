import { describe, expect, it } from "vitest";

import type { ToolExecutionContext } from "../../kernel/types.js";
import type { PluginsServiceLike } from "./service.js";
import type { KnowledgeRuntimeSettings } from "./settings.js";
import {
  createKnowledgeToolEntries,
  KNOWLEDGE_PANEL_ID,
  knowledgeBundleLoaded,
} from "./tools.js";
import { KNOWLEDGE_BUNDLE_ID, type KnowledgeService } from "./types.js";

const settings: KnowledgeRuntimeSettings = {
  autoInject: true,
  localMatch: false,
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

function plugins(
  entries: Array<{ pluginId: string; id: string }>,
): PluginsServiceLike {
  return {
    async list() {
      return [];
    },
    listUiEntries: () => entries,
  };
}

const loaded = plugins([
  { pluginId: `local__${KNOWLEDGE_BUNDLE_ID}`, id: KNOWLEDGE_PANEL_ID },
]);

function fakeKnowledge() {
  const calls: Array<{ method: string; input: unknown }> = [];
  const service: KnowledgeService = {
    async isActive() {
      return { ok: true, message: "" };
    },
    async status() {
      return {
        installed: true,
        enabled: true,
        active: true,
        cli: "available" as const,
        cliVersion: "0.1.8",
        reason: null,
      };
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
      return { path, action: "already-indexed" as const };
    },
    async search(input) {
      calls.push({ method: "search", input });
      return { scope: "D:/kb", results: [], truncated: false };
    },
    async read(input) {
      calls.push({ method: "read", input });
      return { path: input.path, content: "原文", truncated: false };
    },
    rootsRevision() {
      return 3;
    },
  };
  return { service, calls };
}

function entries(service: KnowledgeService, p: PluginsServiceLike | undefined) {
  return createKnowledgeToolEntries({
    knowledge: service,
    readSettings: async () => settings,
    tryGetPlugins: () => p,
  });
}

const execCtx = { instanceId: "inst-1" } as ToolExecutionContext;

describe("knowledge shared 工具（M3）", () => {
  it("同步门控：bundle 未装载 / 无同步视图时 resolve 返回 null，装载后下一轮出现", () => {
    const { service } = fakeKnowledge();
    expect(knowledgeBundleLoaded(undefined)).toBe(false);
    expect(knowledgeBundleLoaded({ list: async () => [] })).toBe(false);
    expect(knowledgeBundleLoaded(plugins([]))).toBe(false);
    expect(knowledgeBundleLoaded(loaded)).toBe(true);

    const hidden = entries(service, plugins([]));
    expect(hidden.map((entry) => entry.resolve({} as never))).toEqual([
      null,
      null,
      null,
    ]);
    const visible = entries(service, loaded).map((entry) =>
      entry.resolve({} as never),
    );
    expect(visible.map((tool) => tool?.name)).toEqual([
      "knowledge_search",
      "knowledge_read",
      "knowledge_status",
    ]);
    for (const tool of visible) {
      expect(tool?.scope).toBe("shared");
      expect(tool?.access).toBe("read");
    }
  });

  it("knowledge_search：查询走设置里的 maxResults/超时/本地档", async () => {
    const { service, calls } = fakeKnowledge();
    const tool = entries(service, loaded)[0]?.resolve({} as never);
    await tool?.execute({ query: "重试逻辑" }, execCtx);
    expect(calls[0]).toEqual({
      method: "search",
      input: {
        query: "重试逻辑",
        maxResults: 5,
        timeoutMs: 30_000,
        localMatch: false,
      },
    });
  });

  it("knowledge_read：按设置预算与行号取原文", async () => {
    const { service, calls } = fakeKnowledge();
    const tool = entries(service, loaded)[1]?.resolve({} as never);
    await tool?.execute(
      { path: "D:/kb/a.md", startLine: 10, endLine: 20 },
      execCtx,
    );
    expect(calls[0]).toEqual({
      method: "read",
      input: {
        path: "D:/kb/a.md",
        startLine: 10,
        endLine: 20,
        maxBytes: 1_048_576,
      },
    });
  });

  it("knowledge_status：合并服务状态与当前设置", async () => {
    const { service } = fakeKnowledge();
    const tool = entries(service, loaded)[2]?.resolve({} as never);
    const result = (await tool?.execute({}, execCtx)) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({
      installed: true,
      cliVersion: "0.1.8",
      settings: { maxResults: 5, autoInject: true },
    });
  });

  it("非法参数在工具内被 schema 拒绝（不把 ZodError 转储给模型）", async () => {
    const { service } = fakeKnowledge();
    const tool = entries(service, loaded)[0]?.resolve({} as never);
    await expect(
      tool?.execute({ query: "x".repeat(2001) }, execCtx),
    ).rejects.toThrow();
  });
});
