import { describe, expect, it } from "vitest";

import {
  contextUsageModelMeta,
  contextUsageView,
  formatTokens,
  usageFromEvent,
} from "../src/lib/context-usage";

/**
 * 选中模型的容量元数据：两处编排器共用一份。
 *
 * **回归背景**（真机实测抓到接线漏项）：Code 与 Design 两处编排器此前各写各的
 * `models.find((m) => m.id === model)`，带真实用量的那处漏传 `maxOutputTokens`，
 * 于是「预留输出 / 剩余」两段与阈值刻度在任何模式下都不出现。组件单测直接渲染按钮，
 * 抓不到这种漏项——所以这里锁住「一个 id 解析出**两个**字段」这件事。
 */
describe("contextUsageModelMeta", () => {
  const catalog = [
    {
      id: "inst-a:GLM-5.3-Flash",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
    },
  ];

  it("一次拿到窗口与最大输出（调用方不必各自 find）", () => {
    expect(contextUsageModelMeta(catalog, "inst-a:GLM-5.3-Flash")).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
    });
  });

  it("实例被删 / localStorage 里留着旧 specifier：两个字段都给 null（不拿别的实例顶替）", () => {
    expect(
      contextUsageModelMeta(catalog, "inst-deleted:GLM-5.3-Flash"),
    ).toEqual({
      contextWindow: null,
      maxOutputTokens: null,
    });
  });

  it("模型没声明这两项：同样是 null（浮层就少画那两段，不编数字）", () => {
    expect(
      contextUsageModelMeta([{ id: "inst-b:bare" }], "inst-b:bare"),
    ).toEqual({ contextWindow: null, maxOutputTokens: null });
    expect(contextUsageModelMeta([], "anything")).toEqual({
      contextWindow: null,
      maxOutputTokens: null,
    });
  });
});

describe("formatTokens", () => {
  it("按中文习惯缩写万/亿，并去掉多余的 .0", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(614_000)).toBe("61.4万");
    expect(formatTokens(1_000_000)).toBe("100万");
    expect(formatTokens(12_000)).toBe("1.2万");
    expect(formatTokens(250_000_000)).toBe("2.5亿");
  });

  it("负数/非数当 0（不显示 NaN）", () => {
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});

describe("contextUsageView", () => {
  it("有窗口时给出容量与百分比", () => {
    const view = contextUsageView(
      { inputTokens: 614_000, outputTokens: 1200, cachedInputTokens: 613_000 },
      1_000_000,
    );
    expect(view).toMatchObject({
      hasUsage: true,
      inputLabel: "61.4万",
      windowLabel: "100万",
      percent: 61.4,
      percentLabel: "61.4%",
      cacheHitLabel: "99.8%",
      outputLabel: "1200",
    });
  });

  it("窗口未知：不给百分比（不编分母）", () => {
    const view = contextUsageView(
      { inputTokens: 1000, outputTokens: 10 },
      null,
    );
    expect(view.percent).toBeNull();
    expect(view.percentLabel).toBeNull();
    expect(view.inputLabel).toBe("1000");
  });

  it("上游未上报缓存：不给命中率（0% 会被读成缓存全失效）", () => {
    const view = contextUsageView(
      { inputTokens: 1000, outputTokens: 10 },
      8192,
    );
    expect(view.cacheHitLabel).toBeNull();
  });

  it("没有用量数据：整层为空态", () => {
    for (const usage of [
      null,
      undefined,
      { inputTokens: 0, outputTokens: 0 },
    ]) {
      expect(contextUsageView(usage, 1_000_000).hasUsage).toBe(false);
    }
  });

  it("超过窗口时封顶 100%（不出现 137% 这种读数）", () => {
    const view = contextUsageView(
      { inputTokens: 1_370_000, outputTokens: 1 },
      1_000_000,
    );
    expect(view.percent).toBe(100);
  });
});

describe("usageFromEvent（run.usage 载荷 → 页面状态）", () => {
  it("真实网关载荷（探针实测样本）映射成快照", () => {
    expect(
      usageFromEvent({
        type: "run.usage",
        runId: "run_1",
        inputTokens: 8561,
        outputTokens: 20,
        cachedInputTokens: 0,
        timestamp: "2026-09-15T17:35:54.747Z",
      }),
    ).toEqual({ inputTokens: 8561, outputTokens: 20, cachedInputTokens: 0 });
  });

  it("没有 inputTokens（老服务端不发这个事件）返回 null，不写成 0", () => {
    expect(usageFromEvent({ type: "run.usage", outputTokens: 5 })).toBeNull();
    expect(usageFromEvent(null)).toBeNull();
    expect(usageFromEvent("run.usage")).toBeNull();
  });

  it("上游未上报缓存：快照里没有 cachedInputTokens 字段", () => {
    expect(usageFromEvent({ inputTokens: 100 })).toEqual({
      inputTokens: 100,
      outputTokens: 0,
    });
  });
});

describe("窗口已知但本轮还没有用量（回归：文案不许把两件事混成一件）", () => {
  it("窗口已声明 + 无用量：windowKnown 为 true，不是「没有声明窗口」", () => {
    const view = contextUsageView(null, 1_000_000);
    expect(view.hasUsage).toBe(false);
    expect(view.windowKnown).toBe(true);
    expect(view.windowLabel).toBe("100万");
    expect(view.percent).toBeNull();
  });

  it("窗口缺失 + 无用量：windowKnown 为 false", () => {
    expect(contextUsageView(null, null).windowKnown).toBe(false);
    expect(contextUsageView(null, 0).windowKnown).toBe(false);
  });
});

/**
 * 平均缓存命中率的口径（用户点名要研究的那一项）。
 *
 * 口径：**累计命中缓存输入 ÷ 累计输入**（按 token 加权，跨本轮所有模型调用求和）。
 * 最容易写错的是「各次百分比的算术平均」——短调用权重过大，会把命中率算虚高。
 */
describe("平均缓存命中率（run 累计口径）", () => {
  it("有累计字段：按 token 加权，不用单次百分比", () => {
    const view = contextUsageView(
      {
        inputTokens: 900,
        outputTokens: 10,
        // 本次调用命中 0，但本轮累计命中 900/1000 → 90%
        cachedInputTokens: 0,
        runInputTokens: 1000,
        runCachedInputTokens: 900,
      },
      1_000_000,
    );
    expect(view.cacheHitLabel).toBe("90%");
    expect(view.cacheHitScope).toBe("run");
  });

  it("加权 ≠ 算术平均（两次调用 90%/0%，各自输入 100/900 → 9% 而不是 45%）", () => {
    // 第一次调用：input 100、cached 90；第二次：input 900、cached 0
    const view = contextUsageView(
      {
        inputTokens: 900,
        outputTokens: 0,
        cachedInputTokens: 0,
        runInputTokens: 1000,
        runCachedInputTokens: 90,
      },
      1_000_000,
    );
    expect(view.cacheHitLabel).toBe("9%");
  });

  it("服务端没带累计字段：退回单次并标注口径（不冒充平均）", () => {
    const view = contextUsageView(
      { inputTokens: 200, outputTokens: 0, cachedInputTokens: 150 },
      1_000_000,
    );
    expect(view.cacheHitLabel).toBe("75%");
    expect(view.cacheHitScope).toBe("call");
  });

  it("一次都没上报缓存：不给命中率（0% 会被读成「缓存全失效」）", () => {
    const view = contextUsageView(
      { inputTokens: 200, outputTokens: 0, runInputTokens: 200 },
      1_000_000,
    );
    expect(view.cacheHitLabel).toBeNull();
    expect(view.cacheHitScope).toBeNull();
  });
});

/**
 * 分类占比（R4-1 那一栏）的展示口径：按字符数算百分比、降序、无数据不编。
 */
describe("上下文分类占比", () => {
  it("按字符数折算百分比并降序（参考图那六行就是这个读法）", () => {
    const view = contextUsageView(
      {
        inputTokens: 1000,
        outputTokens: 0,
        composition: [
          { label: "消息", chars: 933 },
          { label: "MCP 工具", chars: 37 },
          { label: "系统工具", chars: 21 },
          { label: "其他", chars: 5 },
          { label: "系统提示词", chars: 3 },
          { label: "技能", chars: 1 },
        ],
      },
      1_000_000,
    );
    expect(view.composition.map((part) => part.label)).toEqual([
      "消息",
      "MCP 工具",
      "系统工具",
      "其他",
      "系统提示词",
      "技能",
    ]);
    expect(view.composition[0]?.percent).toBe(93.3);
  });

  it("没有分类数据（老服务端）：空数组，不编一段「其他 100%」", () => {
    const view = contextUsageView({ inputTokens: 10, outputTokens: 0 }, 1000);
    expect(view.composition).toEqual([]);
  });

  it("从 run.usage 事件里解出分段（只认 label 是字符串、chars 是数字的条目）", () => {
    const snapshot = usageFromEvent({
      inputTokens: 10,
      outputTokens: 1,
      composition: [
        { label: "消息", chars: 100 },
        { label: 42, chars: 5 },
        { chars: 7 },
      ],
    });
    expect(snapshot?.composition).toEqual([{ label: "消息", chars: 100 }]);
  });
});

/**
 * 「预留输出」段与输出预留线（Roo Code 三段条口径）。
 *
 * 口径必须钉住三件事：① 预留只在**模型声明了最大输出**时成立（不编数字）；
 * ② 阈值 = 窗口 − 预留，越线即「已经吃掉为回复留的空间」；③ 剩余不为负读数。
 */
describe("预留输出与输出预留线", () => {
  it("声明了最大输出：三段齐全，阈值 = 窗口 − 预留", () => {
    const view = contextUsageView(
      { inputTokens: 500_000, outputTokens: 1000 },
      1_000_000,
      "glm-5.3-flash",
      128_000,
    );
    expect(view.reserveLabel).toBe("12.8万");
    expect(view.thresholdPercent).toBe(87.2);
    expect(view.overThreshold).toBe(false);
    // 剩余 = 100万 − 50万 − 12.8万 = 37.2万
    expect(view.remainingLabel).toBe("37.2万");
  });

  it("吃掉预留空间：overThreshold 为真，剩余读成 0 而不是负数", () => {
    const view = contextUsageView(
      { inputTokens: 900_000, outputTokens: 10 },
      1_000_000,
      "glm-5.3-flash",
      128_000,
    );
    expect(view.overThreshold).toBe(true);
    expect(view.remainingLabel).toBe("0");
    // 阈值本身仍是窗口 − 预留（90万 > 87.2万）
    expect(view.thresholdPercent).toBe(87.2);
  });

  it("没声明最大输出：那一段与阈值都不画（不编数字）", () => {
    const view = contextUsageView(
      { inputTokens: 500_000, outputTokens: 1 },
      1_000_000,
      "glm-5.3-flash",
    );
    expect(view.reserveLabel).toBeNull();
    expect(view.reserveTokens).toBeNull();
    expect(view.thresholdPercent).toBeNull();
    expect(view.remainingLabel).toBeNull();
    expect(view.overThreshold).toBe(false);
    // 但「已用/窗口」的读数照旧
    expect(view.usageLine).toBe("50万/100万（50%）");
  });

  it("声明的最大输出大于窗口（配置写错）：预留封顶到窗口，阈值退到 0", () => {
    const view = contextUsageView(
      { inputTokens: 10, outputTokens: 1 },
      1000,
      "",
      5000,
    );
    expect(view.reserveTokens).toBe(1000);
    expect(view.thresholdPercent).toBe(0);
    expect(view.overThreshold).toBe(true);
  });

  it("窗口未知：有声明也不画预留（没有分母就没有百分比）", () => {
    const view = contextUsageView(
      { inputTokens: 10_000, outputTokens: 1 },
      null,
      "unknown-model-x",
      128_000,
    );
    expect(view.windowKnown).toBe(false);
    expect(view.reserveTokens).toBeNull();
    expect(view.thresholdPercent).toBeNull();
  });

  it("本轮无用量：预留与阈值一并缺省（空态不显示任何估算）", () => {
    const view = contextUsageView(null, 1_000_000, "glm-5.3-flash", 128_000);
    expect(view.hasUsage).toBe(false);
    expect(view.reserveLabel).toBeNull();
    expect(view.overThreshold).toBe(false);
  });
});

/**
 * 两位小数的精确读数（用户口径「需要到小数点后两位」）：`usageFineLine`。
 *
 * 去处是浮层首行与环的悬停读数（圆环里不写数字了，这里是唯一看得见精确值的地方）；
 * 满格写 `100`（不留 `100.00`）。一位小数的 `percentLabel` 仍按参考图口径保留。
 */
describe("两位小数的读数", () => {
  it("4.53 不会被四舍五入成 4.5", () => {
    const view = contextUsageView(
      { inputTokens: 45_300, outputTokens: 1 },
      1_000_000,
    );
    // token 量词仍是一位小数（`4.5万`），两位小数只加在百分比上
    expect(view.usageFineLine).toBe("4.5万/100万（4.53%）");
    // 一位小数的那份仍在（参考图口径）
    expect(view.percentLabel).toBe("4.5%");
    expect(view.usageLine).toBe("4.5万/100万（4.5%）");
  });

  it("大数同样两位；满格不写 100.00", () => {
    expect(
      contextUsageView({ inputTokens: 999_700, outputTokens: 1 }, 1_000_000)
        .usageFineLine,
    ).toBe("100万/100万（99.97%）");
    expect(
      contextUsageView({ inputTokens: 2_000_000, outputTokens: 1 }, 1_000_000)
        .usageFineLine,
    ).toBe("200万/100万（100%）");
  });

  it("窗口未知 / 无用量：不给精确读数（调用方退回 usageLine 或占位文案）", () => {
    expect(
      contextUsageView(
        { inputTokens: 1000, outputTokens: 1 },
        null,
        "unknown-x",
      ).usageFineLine,
    ).toBeNull();
    expect(contextUsageView(null, 1_000_000).usageFineLine).toBeNull();
  });
});
