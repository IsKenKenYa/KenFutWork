import type { AppUsageSnapshot } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import type { CodeUiHostRpcContext } from "../code-ui/host-rpc-handler.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { createCodeUiUsageHost } from "./code-ui-host.js";
import { createUsageRepository } from "./repository.js";

const INSTANCE_ID = "instance-usage-host";
const ACTOR: LocalActor = { instanceId: INSTANCE_ID, accessClientId: null };
// usage 宿主只消费 actor；context 按接口最小实现即可。
const CONTEXT: CodeUiHostRpcContext = {
  actor: ACTOR,
  connectionId: "test-connection",
  signal: new AbortController().signal,
  requireInitialized: () => {},
  onClose: () => () => {},
};

const LOCAL_INSTANCE_STUB: LocalInstanceService = {
  getContext: async () => ({ instanceId: INSTANCE_ID, dataDir: "/data" }),
  resolve: async () => ({ instanceId: INSTANCE_ID, dataDir: "/data" }),
  serviceActor: async () => ({ instanceId: INSTANCE_ID, accessClientId: null }),
  isDraining: () => false,
  assertReady() {},
  beginAdmission: () => () => {},
  activeAdmissionCount: () => 0,
  beginMaintenance: async () => {},
  cancelMaintenance() {},
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
    if (result instanceof Error) throw result;
    return result;
  };
  const runner: PostgresQueryRunner = {
    async query(text, values) {
      return run(text, values);
    },
    async acquire() {
      return {
        query: async (text: string, values: unknown[]) => run(text, values),
        release: () => {},
      };
    },
    async acquireSession() {
      throw new Error("此查询夹具不提供真实执行宿主会话。");
    },
    async end() {},
  };
  return { calls, runner };
}

function dayKey(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

const HOST = createCodeUiUsageHost({
  localInstance: LOCAL_INSTANCE_STUB,
  repository: {
    appUsageDaily: async () => [
      {
        day: dayKey(-1),
        model: "GLM-5.3-Flash",
        inputTokens: 100,
        outputTokens: 50,
        calls: 3,
        runs: 2,
      },
      {
        day: dayKey(-1),
        model: "glm-4-flash",
        inputTokens: 10,
        outputTokens: 10,
        calls: 1,
        runs: 1,
      },
      {
        day: dayKey(0),
        model: "GLM-5.3-Flash",
        inputTokens: 200,
        outputTokens: 100,
        calls: 2,
        runs: 1,
      },
    ],
    appUsageRunCount: async () => 4,
    longestSessionSeconds: async () => 1800,
  },
});

describe("usage code-ui 宿主：usage-stats.getAppUsageSnapshot", () => {
  it("真实聚合：总量/峰值/最爱模型份额/连续活跃/逐日模型/会话数（distinct run）", async () => {
    const snapshot = (await HOST["usage-stats.getAppUsageSnapshot"]?.call(
      ACTOR,
      [{ range: "7d", timeZone: "Asia/Shanghai" }],
      CONTEXT,
    )) as AppUsageSnapshot;
    expect(snapshot).toMatchObject({
      range: "7d",
      timeZone: "Asia/Shanghai",
      source: "agent-db",
    });
    expect(snapshot?.summary.totalTokens).toBe(470);
    expect(snapshot?.summary.inputTokens).toBe(310);
    expect(snapshot?.summary.outputTokens).toBe(160);
    expect(snapshot?.summary.peakDayTokens).toBe(300);
    expect(snapshot?.summary.totalSessions).toBe(4);
    expect(snapshot?.summary.totalTurns).toBe(6);
    expect(snapshot?.summary.activeDays).toBe(2);
    expect(snapshot?.summary.longestStreakDays).toBe(2);
    // 昨天活跃到今天 → 当前连续也应是 2
    expect(snapshot?.summary.currentStreakDays).toBe(2);
    expect(snapshot?.summary.longestSessionMs).toBe(1_800_000);
    expect(snapshot?.summary.favoriteModel).toEqual({
      modelId: "GLM-5.3-Flash",
      totalTokens: 450,
      share: 450 / 470,
    });
    // 未记录维度如实为零/null，不造数据
    expect(snapshot?.summary.reasoningTokens).toBe(0);
    expect(snapshot?.summary.avgTimeToFirstTokenMs).toBeNull();
    expect(snapshot?.tools).toEqual([]);

    // 热力图：两天都有格子、峰值日 level=4、非峰值日按比例降档
    const cells = (snapshot?.heatmap.weeks ?? [])
      .flatMap((week) => week.days)
      .filter((cell) => cell !== null);
    expect(cells.map((cell) => cell?.date)).toEqual(
      expect.arrayContaining([dayKey(-1), dayKey(0)]),
    );
    const peak = cells.find((cell) => cell?.date === dayKey(0));
    const lesser = cells.find((cell) => cell?.date === dayKey(-1));
    expect(peak?.level).toBe(4);
    expect(lesser?.level).toBe(3); // 170/300×4=2.27 → ceil=3

    // 逐日模型分布与逐模型汇总
    expect(snapshot?.dailyModelUsage).toHaveLength(2);
    const top = snapshot?.models[0];
    expect(top).toMatchObject({ modelId: "GLM-5.3-Flash", totalTokens: 450 });
  });

  it("空数据：全零 + 无最爱模型 + 空热力图，schema 仍通过", async () => {
    const emptyHost = createCodeUiUsageHost({
      localInstance: LOCAL_INSTANCE_STUB,
      repository: {
        appUsageDaily: async () => [],
        appUsageRunCount: async () => 0,
        longestSessionSeconds: async () => 0,
      },
    });
    const snapshot = (await emptyHost["usage-stats.getAppUsageSnapshot"]?.call(
      ACTOR,
      [{ range: "all" }],
      CONTEXT,
    )) as AppUsageSnapshot;
    expect(snapshot?.summary.totalTokens).toBe(0);
    expect(snapshot?.summary.favoriteModel).toBeNull();
    expect(snapshot?.heatmap.weeks).toEqual([]);
    expect(snapshot?.models).toEqual([]);
  });

  it("非法 range 拒绝并给可读原因", async () => {
    await expect(
      HOST["usage-stats.getAppUsageSnapshot"]?.call(
        ACTOR,
        [{ range: "42d" }],
        CONTEXT,
      ),
    ).rejects.toThrow(/7d \/ 30d \/ all/);
  });

  it("仓储 SQL：逐日聚合按 UTC 天+模型分组、去重 run 单独计数", async () => {
    const { calls, runner } = createRunner();
    const repository = createUsageRepository(
      createPersistenceFromRunner(runner),
    );
    const since = new Date("2026-10-18T00:00:00Z");
    await repository.appUsageDaily(INSTANCE_ID, since);
    await repository.appUsageRunCount(INSTANCE_ID, null);

    const daily = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(daily).toContain("from public.usage_records");
    expect(daily).toContain("to_char(occurred_at at time zone 'UTC'");
    expect(daily).toContain("group by 1, 2");
    // 实例绑定把 instanceId 追加在参数尾部
    expect(calls[0]?.values).toEqual([since, INSTANCE_ID]);

    const runCount = calls[1]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(runCount).toContain("count(distinct run_id)");
    expect(runCount).toContain("run_id is not null");
    expect(calls[1]?.values).toEqual([null, INSTANCE_ID]);
  });
});
