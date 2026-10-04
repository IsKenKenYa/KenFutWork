import { describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../auth/types.js";
import type { ViewerRepository } from "../bootstrap/repository.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { createUsageRepository, type UsageRepository } from "./repository.js";
import { createUsageService } from "./usage-service.js";

const USER_ID = "user-1";
const WORKSPACE_ID = "ws-1";

const USER: AuthenticatedUser = {
  accessToken: "token",
  email: "user@example.com",
  id: USER_ID,
  userMetadata: {},
};

type FakeResult = { rowCount: number | null; rows: unknown[] } | Error;

function createRunner(
  respond: (text: string, values: unknown[]) => FakeResult = () => ({
    rowCount: 0,
    rows: [],
  }),
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];

  const run = (text: string, values: unknown[]) => {
    calls.push({ text, values });
    const result = respond(text, values);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };

  const runner: PostgresQueryRunner = {
    async query(text, values) {
      return run(text, values);
    },
    async acquire() {
      return {
        query: async (text, values) => run(text, values),
        release: () => {},
      };
    },
    async acquireSession() {
      throw new Error("此查询夹具不提供真实执行宿主会话。");
    },
    async end() {},
  };

  return {
    calls,
    sqls: () => calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
    runner,
  };
}

const WORKSPACES_STUB: ViewerRepository = {
  bootstrap: async () => {},
  findMembership: async () => null,
  findPersonalWorkspace: async () => ({
    id: WORKSPACE_ID,
    name: "Personal Workspace",
    ownerUserId: USER_ID,
    type: "personal",
  }),
  findProfile: async () => null,
  findPlatformRole: async () => null,
  updatePlatformRole: async () => 0,
  updateDisplayName: async () => null,
};

function createFakeRepository(
  overrides: Partial<UsageRepository> = {},
): UsageRepository {
  return {
    insert: async () => {},
    listRecent: async () => [],
    longestSessionSeconds: async () => 0,
    ...overrides,
  };
}

describe("usage repository（workspace 作用域 + 驱动数值归一）", () => {
  it("写入按工作区绑定，缺省可选字段落 NULL、token 缺省落 0", async () => {
    const { calls, runner } = createRunner();

    await createUsageRepository(createPersistenceFromRunner(runner)).insert({
      workspaceId: WORKSPACE_ID,
      provider: "openai",
      model: "gpt-4.1",
      capability: "chat",
    });

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("insert into public.usage_records");
    expect(sql).toContain(
      "values ($12, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    );
    expect(calls[0]?.values).toEqual([
      null,
      "openai",
      "gpt-4.1",
      "chat",
      null,
      null,
      null,
      0,
      0,
      null,
      null,
      WORKSPACE_ID,
    ]);
  });

  it("写入透传全部可选字段", async () => {
    const { calls, runner } = createRunner();

    await createUsageRepository(createPersistenceFromRunner(runner)).insert({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      provider: "anthropic",
      model: "claude",
      capability: "image",
      providerInstanceId: "inst-1",
      runId: "run-1",
      jobId: "job-1",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      costUsd: 0.5,
    });

    expect(calls[0]?.values).toEqual([
      USER_ID,
      "anthropic",
      "claude",
      "image",
      "inst-1",
      "run-1",
      "job-1",
      10,
      20,
      30,
      0.5,
      WORKSPACE_ID,
    ]);
  });

  it("读取按工作区限定，bigint/numeric 字符串归一为 number，occurred_at 归一为 ISO", async () => {
    const { calls, runner } = createRunner(() => ({
      rowCount: 2,
      rows: [
        {
          provider: "openai",
          model: "gpt-4.1",
          capability: "chat",
          // 驱动对 bigint / numeric 返回字符串（PostgREST 曾返回 number）
          input_tokens: "120",
          output_tokens: "80",
          cost_usd: "0.0123",
          occurred_at: "2026-09-14 12:00:00+00",
        },
        {
          provider: "openai",
          model: "gpt-4.1",
          capability: "chat",
          input_tokens: "1",
          output_tokens: "2",
          cost_usd: null,
          occurred_at: new Date("2026-09-15T08:00:00Z"),
        },
      ],
    }));

    const rows = await createUsageRepository(
      createPersistenceFromRunner(runner),
    ).listRecent(WORKSPACE_ID, 10000);

    expect(rows[0]?.input_tokens).toBe(120);
    expect(rows[0]?.output_tokens).toBe(80);
    expect(rows[0]?.cost_usd).toBe(0.0123);
    expect(rows[0]?.occurred_at).toBe("2026-09-14 12:00:00+00");
    expect(typeof rows[0]?.input_tokens).toBe("number");
    expect(rows[1]?.cost_usd).toBeNull();
    expect(rows[1]?.occurred_at).toBe("2026-09-15T08:00:00.000Z");

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("where workspace_id = $2");
    expect(sql).toContain("order by occurred_at desc");
    expect(sql).toContain("limit $1");
    expect(calls[0]?.values).toEqual([10000, WORKSPACE_ID]);
  });

  /**
   * 最长聊天时长（R4-2 剩下的卡）。这条口径最容易写错成「所有消息的首尾差」——
   * 那会把跨天的多条对话算成一条。这里锁死「先按会话分组取跨度、再取最大值」，
   * 以及 FORM-9 的父链谓词（chat_sessions 没有 workspace_id 列）。
   */
  it("最长聊天时长：按会话分组取首尾跨度，谓词走 canvases → projects 父链", async () => {
    const { calls, runner } = createRunner(() => ({
      rowCount: 1,
      rows: [{ seconds: "42300" }],
    }));

    const seconds = await createUsageRepository(
      createPersistenceFromRunner(runner),
    ).longestSessionSeconds(WORKSPACE_ID);

    expect(seconds).toBe(42300);
    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("max(m.created_at) - min(m.created_at)");
    expect(sql).toContain("group by s.id");
    expect(sql).toContain("join public.canvases c on c.id = s.canvas_id");
    // `:workspace` 由 persistence 层重写成位置参数；本条语句只有它一个参数，故是 $1
    expect(sql).toContain("p.workspace_id = $1");
    expect(calls[0]?.values).toEqual([WORKSPACE_ID]);
    // 没有任何会话时 coalesce 兜 0，而不是把 null 透出去
    expect(sql).toContain("coalesce(max(span_seconds), 0)");
  });

  it("最长聊天时长：NULL / 负值 / 非数字一律归 0（统计页不该出现 -1 秒）", async () => {
    for (const raw of [null, "-5", "abc"]) {
      const { runner } = createRunner(() => ({
        rowCount: 1,
        rows: [{ seconds: raw }],
      }));
      const seconds = await createUsageRepository(
        createPersistenceFromRunner(runner),
      ).longestSessionSeconds(WORKSPACE_ID);
      expect(seconds).toBe(0);
    }
  });
});

describe("usage service", () => {
  it("汇总按 provider:model 分组累计，cost 为 0 时省略字段", async () => {
    const service = createUsageService({
      repository: createFakeRepository({
        listRecent: async () => [
          {
            provider: "openai",
            model: "gpt-4.1",
            capability: "chat",
            input_tokens: 100,
            output_tokens: 50,
            cost_usd: 0.25,
            occurred_at: "2026-09-15T10:00:00.000Z",
          },
          {
            provider: "openai",
            model: "gpt-4.1",
            capability: "chat",
            input_tokens: 20,
            output_tokens: 10,
            cost_usd: null,
            occurred_at: "2026-09-15T10:01:00.000Z",
          },
          {
            provider: "google",
            model: "gemini",
            capability: "image",
            input_tokens: 5,
            output_tokens: 0,
            cost_usd: 0,
            occurred_at: "2026-09-15T10:02:00.000Z",
          },
        ],
      }),
      workspaces: WORKSPACES_STUB,
    });

    const summary = await service.summarize(USER);

    expect(summary.totals).toEqual({
      inputTokens: 125,
      outputTokens: 60,
      costUsd: 0.25,
    });
    expect(summary.byModel).toEqual([
      {
        provider: "openai",
        model: "gpt-4.1",
        capability: "chat",
        inputTokens: 120,
        outputTokens: 60,
        costUsd: 0.25,
      },
      {
        provider: "google",
        model: "gemini",
        capability: "image",
        inputTokens: 5,
        outputTokens: 0,
      },
    ]);
  });

  it("工作区解析不到时汇总报错（不静默返回空）", async () => {
    const service = createUsageService({
      repository: createFakeRepository(),
      workspaces: {
        ...WORKSPACES_STUB,
        findPersonalWorkspace: async () => null,
      },
    });

    await expect(service.summarize(USER)).rejects.toThrow(
      /summary query failed/,
    );
  });

  it("resolveWorkspaceIdByUser 复用 workspaces 域查询（worker 无 auth 也能用）", async () => {
    const service = createUsageService({
      repository: createFakeRepository(),
      workspaces: WORKSPACES_STUB,
    });
    await expect(service.resolveWorkspaceIdByUser(USER_ID)).resolves.toBe(
      WORKSPACE_ID,
    );

    const missing = createUsageService({
      repository: createFakeRepository(),
      workspaces: {
        ...WORKSPACES_STUB,
        findPersonalWorkspace: async () => null,
      },
    });
    await expect(
      missing.resolveWorkspaceIdByUser(USER_ID),
    ).resolves.toBeUndefined();
  });

  it("落账失败只告警不抛错（计量是旁路，不阻断主链路）", async () => {
    const service = createUsageService({
      repository: createFakeRepository({
        insert: async () => {
          throw new Error("connection reset");
        },
      }),
      workspaces: WORKSPACES_STUB,
    });

    await expect(
      service.record({
        workspaceId: WORKSPACE_ID,
        provider: "openai",
        model: "gpt-4.1",
        capability: "chat",
      }),
    ).resolves.toBeUndefined();
  });

  it("summarize 查询失败包装为明确的错误信息", async () => {
    const service = createUsageService({
      repository: createFakeRepository({
        listRecent: async () => {
          throw new Error("permission denied");
        },
      }),
      workspaces: WORKSPACES_STUB,
    });

    await expect(service.summarize(USER)).rejects.toThrow(
      /summary query failed: permission denied/,
    );
  });
});

describe("usage stats（R4-2 用户侧使用统计）", () => {
  const NOW = new Date("2026-09-15T12:00:00Z");
  const day = (offsetFromToday: number, hour = 12) =>
    new Date(
      Date.parse("2026-09-15T00:00:00Z") +
        offsetFromToday * 86_400_000 +
        hour * 3_600_000,
    ).toISOString();

  function rowsFor(
    entries: Array<{
      offsetFromToday: number;
      model: string;
      input: number;
      output: number;
    }>,
  ) {
    return entries.map((entry) => ({
      provider: "openai",
      model: entry.model,
      capability: "chat" as const,
      input_tokens: entry.input,
      output_tokens: entry.output,
      cost_usd: null,
      occurred_at: day(entry.offsetFromToday),
    }));
  }

  function createStatsService(listRecent: () => ReturnType<typeof rowsFor>) {
    return createUsageService({
      repository: createFakeRepository({
        listRecent: async () => listRecent(),
      }),
      workspaces: WORKSPACES_STUB,
      now: () => NOW,
    });
  }

  it("按天聚合补零成连续序列，给峰值与总量（R4-2 汇总卡）", async () => {
    const service = createStatsService(() =>
      rowsFor([
        { offsetFromToday: 0, model: "gpt-4.1", input: 300, output: 100 },
        { offsetFromToday: -2, model: "gpt-4.1", input: 1000, output: 500 },
        { offsetFromToday: -2, model: "gemini", input: 50, output: 10 },
      ]),
    );

    const stats = await service.stats(USER, 7);

    expect(stats.rangeDays).toBe(7);
    expect(stats.daily).toHaveLength(7);
    expect(stats.daily[6]).toEqual({ date: "2026-09-15", tokens: 400 });
    expect(stats.daily[4]).toEqual({ date: "2026-09-13", tokens: 1560 });
    expect(stats.daily[5]?.tokens).toBe(0);
    expect(stats.totals).toEqual({
      tokens: 1960,
      inputTokens: 1350,
      outputTokens: 610,
    });
    expect(stats.peakDayTokens).toBe(1560);
  });

  it("窗口外（30 天前）的记录不计入 7 日统计", async () => {
    const service = createStatsService(() =>
      rowsFor([
        { offsetFromToday: -20, model: "gpt-4.1", input: 9, output: 1 },
      ]),
    );

    const stats = await service.stats(USER, 7);
    expect(stats.totals.tokens).toBe(0);
    expect(stats.byModel).toEqual([]);
  });

  it("连续天数：今天有活动从今天倒数；今天没有则从昨天起算；最长段取窗口内最大", async () => {
    const service = createStatsService(() =>
      rowsFor([
        { offsetFromToday: 0, model: "m", input: 1, output: 1 },
        { offsetFromToday: -1, model: "m", input: 1, output: 1 },
        { offsetFromToday: -2, model: "m", input: 1, output: 1 },
        // -3、-4 空档
        { offsetFromToday: -5, model: "m", input: 1, output: 1 },
      ]),
    );

    const stats = await service.stats(USER, 7);
    expect(stats.currentStreakDays).toBe(3);
    expect(stats.longestStreakDays).toBe(3);
  });

  it("今天没活动时当前连续天数从昨天起算（不打断昨天刚跑完的用户）", async () => {
    const service = createStatsService(() =>
      rowsFor([
        { offsetFromToday: -1, model: "m", input: 1, output: 1 },
        { offsetFromToday: -2, model: "m", input: 1, output: 1 },
      ]),
    );

    const stats = await service.stats(USER, 7);
    expect(stats.currentStreakDays).toBe(2);
  });

  it("按模型聚合降序排列", async () => {
    const service = createStatsService(() =>
      rowsFor([
        { offsetFromToday: 0, model: "small", input: 10, output: 0 },
        { offsetFromToday: 0, model: "big", input: 500, output: 0 },
      ]),
    );

    const stats = await service.stats(USER, 7);
    expect(stats.byModel.map((entry) => entry.model)).toEqual(["big", "small"]);
  });

  it("最长聊天时长透出到响应（来自会话表的第二个数据源）", async () => {
    const service = createUsageService({
      repository: createFakeRepository({
        listRecent: async () => [],
        longestSessionSeconds: async () => 42_300,
      }),
      workspaces: WORKSPACES_STUB,
      now: () => NOW,
    });

    expect((await service.stats(USER, 7)).longestSessionSeconds).toBe(42_300);
  });

  /**
   * 会话表那条查询失败时，**不该把整页统计打成 500**：token 数字仍然有效，
   * 缺的只是那一张卡。这里锁「其余字段照常给 + 该字段回落 0」。
   */
  it("最长聊天时长查询失败：统计仍返回，该字段回落 0", async () => {
    const service = createUsageService({
      repository: createFakeRepository({
        listRecent: async () =>
          rowsFor([{ offsetFromToday: 0, model: "m", input: 10, output: 5 }]),
        longestSessionSeconds: async () => {
          throw new Error("relation does not exist");
        },
      }),
      workspaces: WORKSPACES_STUB,
      now: () => NOW,
    });

    const stats = await service.stats(USER, 7);
    expect(stats.longestSessionSeconds).toBe(0);
    expect(stats.totals.tokens).toBe(15);
  });
});

/**
 * 热力图窗口（用户反馈「格子要显示全，而不是就一点点」）。
 *
 * 与 7/30 天的 `daily` 分开：热力图是「一年活动全貌」，固定 365 天、缺数据补 0，
 * 不随范围切换变窄。这里锁「长度恒为 365、末位是今天、窗口外的旧数据不计入」。
 */
describe("usage stats 热力图窗口", () => {
  const NOW = new Date("2026-09-15T12:00:00Z");
  const dayIso = (offset: number) =>
    new Date(
      Date.parse("2026-09-15T00:00:00Z") + offset * 86_400_000,
    ).toISOString();

  it("恒为 365 天、末位是今天；一年内的量进图、去年的不进", async () => {
    const service = createUsageService({
      repository: createFakeRepository({
        listRecent: async () => [
          {
            provider: "openai",
            model: "m",
            capability: "chat",
            input_tokens: 100,
            output_tokens: 0,
            cost_usd: null,
            occurred_at: dayIso(-200),
          },
          {
            provider: "openai",
            model: "m",
            capability: "chat",
            input_tokens: 999,
            output_tokens: 0,
            cost_usd: null,
            occurred_at: dayIso(-400),
          },
        ],
      }),
      workspaces: WORKSPACES_STUB,
      now: () => NOW,
    });

    const stats = await service.stats(USER, 7);
    expect(stats.heatmap).toHaveLength(365);
    expect(stats.heatmap.at(-1)?.date).toBe("2026-09-15");
    expect(stats.heatmap.map((d) => d.tokens).reduce((a, b) => a + b, 0)).toBe(
      100,
    );
    // 7 天窗口里没有这些天 → daily 全 0（两条都在窗口外）
    expect(stats.daily.every((d) => d.tokens === 0)).toBe(true);
  });
});
