import { describe, expect, it } from "vitest";

import { matchesMarketQuery } from "./marketplace-service.js";

/**
 * 回归背景：npm 的 `text=` 对多词是**相关性排序**而非过滤——查一个精确包名仍返回
 * 全部 keyword 命中项（实测 `sheleg-design-skill` → total 1061，目标排第一但列表没变），
 * 用户会以为搜索无效。服务端因此补一层显式过滤。
 */
const ITEM = {
  name: "sheleg-design-skill",
  description: "Design taste as an installable agent skill",
  keywords: ["agent-skill", "design"],
};

describe("市场查询过滤", () => {
  it("空查询放行全部（浏览模式）", () => {
    expect(matchesMarketQuery(ITEM, "")).toBe(true);
    expect(matchesMarketQuery(ITEM, "   ")).toBe(true);
  });

  it("命中名称 / 描述 / 关键词任一即可，大小写不敏感", () => {
    expect(matchesMarketQuery(ITEM, "sheleg")).toBe(true);
    expect(matchesMarketQuery(ITEM, "SHELEG")).toBe(true);
    expect(matchesMarketQuery(ITEM, "DESIGN")).toBe(true);
    expect(matchesMarketQuery(ITEM, "agent-skill")).toBe(true);
  });

  it("多词取「任一命中」（宽松：npm 结果已按相关性排序，过滤只做粗筛）", () => {
    expect(matchesMarketQuery(ITEM, "sheleg yahoo")).toBe(true);
  });

  it("不相关查询被过滤掉", () => {
    expect(matchesMarketQuery(ITEM, "yahoo-finance")).toBe(false);
    expect(matchesMarketQuery(ITEM, "zzz-not-exist")).toBe(false);
  });
});
