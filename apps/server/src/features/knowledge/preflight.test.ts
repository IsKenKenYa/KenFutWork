import { describe, expect, it } from "vitest";

import type { PreStepPayload } from "../../kernel/types.js";
import {
  buildKnowledgeEvidenceBlock,
  createKnowledgePreflight,
  extractKnowledgeQuery,
  knowledgeQuerySkipReason,
} from "./preflight.js";
import type { KnowledgeRuntimeSettings } from "./settings.js";
import type {
  KnowledgeEnsureResult,
  KnowledgeEvidence,
  KnowledgeSearchResult,
  KnowledgeService,
} from "./types.js";
import { dedupeKnowledgeEvidence } from "./types.js";

const defaults: KnowledgeRuntimeSettings = {
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

const evidence = (
  path: string,
  startLine: number,
  content = "正文",
): KnowledgeEvidence => ({
  path,
  absolutePath: `D:/kb/${path}`,
  startLine,
  endLine: startLine + 3,
  content,
});

interface FakeServiceOptions {
  active?: boolean;
  revision?: number;
  results?: KnowledgeSearchResult["results"];
  searchError?: Error;
  searchGate?: Promise<void>;
  ensure?: KnowledgeEnsureResult;
}

function fakeService(options: FakeServiceOptions = {}) {
  const searches: Array<Record<string, unknown>> = [];
  const ensures: string[] = [];
  let revision = options.revision ?? 1;
  const service: KnowledgeService = {
    async isActive() {
      return options.active === false
        ? { ok: false, message: "知识库插件未安装" }
        : { ok: true, message: "" };
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
      ensures.push(path);
      return (
        options.ensure ?? {
          path,
          action: "already-indexed" as const,
        }
      );
    },
    async search(input) {
      searches.push({ ...input });
      if (options.searchGate) await options.searchGate;
      if (options.searchError) throw options.searchError;
      return {
        scope: "D:/kb",
        results: options.results ?? [evidence("a.md", 10, "重试逻辑说明")],
        truncated: false,
      };
    },
    async read() {
      throw new Error("not used");
    },
    rootsRevision() {
      return revision;
    },
    async library() {
      return { root: "", files: [] };
    },
    async uploadFile() {
      throw new Error("not used");
    },
  };
  return {
    service,
    searches,
    ensures,
    bumpRevision: () => {
      revision += 1;
    },
  };
}

function payload(input: string, extra: Partial<PreStepPayload> = {}) {
  return { input, runId: "run-1", ...extra } as PreStepPayload;
}

function setup(
  options: FakeServiceOptions & {
    settings?: Partial<KnowledgeRuntimeSettings>;
    root?: string;
    active?: boolean;
  } = {},
) {
  const fake = fakeService(options);
  const preflight = createKnowledgePreflight({
    knowledge: fake.service,
    readSettings: async () => ({ ...defaults, ...options.settings }),
    resolveRoot: async () => options.root,
  });
  const run = async (input: string, runId = "run-1") => {
    let forwarded: PreStepPayload | undefined;
    let nextCalls = 0;
    const result = await preflight.listener(
      payload(input, { runId }),
      async (p) => {
        nextCalls += 1;
        forwarded = p;
        return p;
      },
    );
    return { result, forwarded, nextCalls, input: String(result.input) };
  };
  return { ...fake, preflight, run };
}

describe("query 抽取与意图门（纯规则）", () => {
  it("剥离 execution_mode 指令与尾部 XML 上下文块", () => {
    const input = `<execution_mode name="plan">\n先计划\n</execution_mode>\n\n查一下重试逻辑\n\n<canvas_state>\n{...}\n</canvas_state>`;
    expect(extractKnowledgeQuery(input)).toBe("查一下重试逻辑");
  });

  it("无 XML 时取全文；超长截到上游硬限 2000", () => {
    expect(extractKnowledgeQuery("  普通问题  ")).toBe("普通问题");
    expect(extractKnowledgeQuery("x".repeat(2500))).toHaveLength(2000);
  });

  it("意图门命中：寒暄/确认/计算/时间/密钥样式", () => {
    expect(knowledgeQuerySkipReason("")).toBe("空输入");
    expect(knowledgeQuerySkipReason("你好")).toContain("寒暄");
    expect(knowledgeQuerySkipReason("继续")).toContain("确认");
    expect(knowledgeQuerySkipReason("1 + 2 * 3 =")).toContain("计算");
    expect(knowledgeQuerySkipReason("现在几点？")).toContain("时间");
    expect(
      knowledgeQuerySkipReason("api_key = sk-abcdefghijklmnop123"),
    ).toContain("密钥");
    expect(knowledgeQuerySkipReason("重试逻辑在哪")).toBeNull();
  });

  it("证据按 路径+行范围 去重", () => {
    const list = [
      evidence("a.md", 10),
      evidence("a.md", 10, "另一段正文"),
      evidence("a.md", 20),
    ];
    expect(dedupeKnowledgeEvidence(list)).toHaveLength(2);
  });

  it("证据块带行号与预算裁剪标记", () => {
    const block = buildKnowledgeEvidenceBlock(
      [evidence("a.md", 10, "甲".repeat(200))],
      80,
      false,
    );
    expect(block).toContain("<knowledge_evidence>");
    expect(block).toContain("a.md:10-13");
    expect(block).toContain("裁剪");
    expect(block.length).toBeLessThan(500);
  });
});

describe("preflight waterfall 监听器（M3）", () => {
  it("未安装：直接放行、不检索、不写状态块，且 next() 只调一次", async () => {
    const { run, searches } = setup({ active: false });
    const out = await run("查一下重试逻辑");
    expect(searches).toHaveLength(0);
    expect(out.nextCalls).toBe(1);
    expect(out.input).toBe("查一下重试逻辑");
    expect(out.input).not.toContain("knowledge_status");
  });

  it("自动注入关闭：跳过且不写状态块", async () => {
    const { run, searches, preflight } = setup({
      settings: { autoInject: false },
    });
    const out = await run("查一下重试逻辑");
    expect(searches).toHaveLength(0);
    expect(out.input).not.toContain("knowledge_evidence");
    expect(preflight.lastOutcome()).toMatchObject({
      outcome: "skipped",
      reason: "自动注入已关闭",
    });
  });

  it("意图门命中不检索（寒暄 / 密钥样式）", async () => {
    const { run, searches } = setup();
    await run("你好呀");
    await run("token = abcdef1234567890", "run-2");
    expect(searches).toHaveLength(0);
  });

  it("正常检索：注入证据块（路径+行号+正文），request 携带治理参数", async () => {
    const { run, searches, ensures } = setup({ root: "D:/kb" });
    const out = await run("查一下重试逻辑");
    expect(out.input).toContain("<knowledge_evidence>");
    expect(out.input).toContain("D:/kb/a.md:10-13");
    expect(out.input).toContain("重试逻辑说明");
    expect(ensures).toEqual(["D:/kb"]);
    expect(searches[0]).toMatchObject({
      query: "查一下重试逻辑",
      path: "D:/kb",
      maxResults: 5,
      localMatch: false,
    });
  });

  it("零命中：不注入证据，明确写「未找到相关证据」状态块", async () => {
    const { run, preflight } = setup({ results: [] });
    const out = await run("查一下重试逻辑");
    expect(out.input).not.toContain("<knowledge_evidence>");
    expect(out.input).toContain("本轮未找到相关证据");
    expect(preflight.lastOutcome()?.outcome).toBe("no-evidence");
  });

  it("相关性门槛：命中数低于 minHits 不注入", async () => {
    const { run } = setup({ settings: { minHits: 2 } });
    const out = await run("查一下重试逻辑");
    expect(out.input).not.toContain("<knowledge_evidence>");
    expect(out.input).toContain("本轮未找到相关证据");
  });

  it("检索失败不阻断对话：状态块 + 放行，原因可读", async () => {
    const { run, preflight } = setup({
      searchError: new Error("JEV 未配置"),
    });
    const out = await run("查一下重试逻辑");
    expect(out.nextCalls).toBe(1);
    expect(out.input).toContain("本轮知识库检索失败：JEV 未配置");
    expect(preflight.lastOutcome()).toMatchObject({
      outcome: "failed",
      reason: "JEV 未配置",
    });
  });

  it("失败原因不把 Zod 转储塞进输入：转成一句人话（回归）", async () => {
    const fake = fakeService();
    const zodLike = new Error(
      '[\n  {\n    "code": "invalid_format",\n    "path": ["instanceId"],\n    "message": "Invalid UUID"\n  }\n]',
    );
    zodLike.name = "ZodError";
    fake.service.isActive = async () => {
      throw zodLike;
    };
    const preflight = createKnowledgePreflight({
      knowledge: fake.service,
      readSettings: async () => defaults,
      resolveRoot: async () => undefined,
    });
    const result = await preflight.listener(payload("问题"), async (p) => p);
    const input = String(result.input);
    expect(input).toContain("内部错误（参数校验失败");
    expect(input).not.toContain("invalid_format");
    expect(input).not.toContain("instanceId");
  });

  it("isActive 抛错也不阻断，next() 仍被调用（waterfall 回归）", async () => {
    const fake = fakeService();
    fake.service.isActive = async () => {
      throw new Error("注册表损坏");
    };
    const preflight = createKnowledgePreflight({
      knowledge: fake.service,
      readSettings: async () => defaults,
      resolveRoot: async () => undefined,
    });
    let nextCalls = 0;
    const result = await preflight.listener(payload("问题"), async (p) => {
      nextCalls += 1;
      return p;
    });
    expect(nextCalls).toBe(1);
    expect(String(result.input)).toContain("注册表损坏");
  });

  it("每 run 最多一次自动检索；换 run 同问题走缓存不重复检索", async () => {
    const { run, searches } = setup();
    await run("查一下重试逻辑", "run-1");
    await run("查一下重试逻辑", "run-1");
    expect(searches).toHaveLength(1);
    const second = await run("查一下重试逻辑", "run-2");
    expect(searches).toHaveLength(1);
    expect(second.input).toContain("<knowledge_evidence>");
  });

  it("缓存按根集合修订号失效：revision 变化后重新检索", async () => {
    const { run, searches, bumpRevision } = setup();
    await run("查一下重试逻辑", "run-1");
    bumpRevision();
    await run("查一下重试逻辑", "run-2");
    expect(searches).toHaveLength(2);
  });

  it("缓存 TTL=0 时禁用缓存", async () => {
    const { run, searches } = setup({ settings: { cacheTtlMs: 0 } });
    await run("查一下重试逻辑", "run-1");
    await run("查一下重试逻辑", "run-2");
    expect(searches).toHaveLength(2);
  });

  it("并发上限：超出本轮跳过并不排队", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { preflight, service, searches } = (() => {
      const fake = fakeService({ searchGate: gate });
      return {
        preflight: createKnowledgePreflight({
          knowledge: fake.service,
          readSettings: async () => ({ ...defaults, maxConcurrentSearches: 1 }),
          resolveRoot: async () => undefined,
        }),
        service: fake.service,
        searches: fake.searches,
      };
    })();
    void service;
    const first = preflight.listener(
      payload("问题一", { runId: "r1" }),
      async (p) => p,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    let secondNext = 0;
    await preflight.listener(payload("问题二", { runId: "r2" }), async (p) => {
      secondNext += 1;
      return p;
    });
    expect(secondNext).toBe(1);
    expect(searches).toHaveLength(1);
    expect(preflight.lastOutcome()).toMatchObject({
      outcome: "skipped",
      reason: "检索并发已满，本轮跳过",
    });
    release();
    await first;
  });

  it("ensureRoot 拒绝/延后：不检索并写明确状态", async () => {
    const { run, searches } = setup({
      root: "C:/Users/me/Desktop",
      ensure: {
        path: "C:/Users/me/Desktop",
        action: "rejected",
        reason: "拒绝自动索引个人目录。",
      },
    });
    const out = await run("查一下重试逻辑");
    expect(searches).toHaveLength(0);
    expect(out.input).toContain("知识库未检索：拒绝自动索引个人目录。");
  });

  it("ensureRoot 结果按修订号缓存：同一根不重复 check", async () => {
    const { run, ensures } = setup({ root: "D:/kb" });
    await run("问题一", "r1");
    await run("问题二", "r2");
    expect(ensures).toHaveLength(1);
  });
});
