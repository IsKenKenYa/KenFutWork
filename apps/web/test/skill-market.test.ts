import { describe, expect, it } from "vitest";

import {
  describeInstallFailure,
  formatDownloads,
  normalizeMarketQuery,
  toMarketItemView,
} from "../src/lib/skill-market.js";

/**
 * 回归背景：技能市场（npm registry 按 keywords:agent-skill 发现 + skills.sh 下载）
 * 服务端可用但**前端一直没有入口**，用户以为"市场是空的"。这里锁搜索词规范、
 * 展示量与安装失败文案。
 */
describe("技能市场视图逻辑", () => {
  it("搜索词规范化：去首尾空白、折叠内部空白；空串=浏览全部", () => {
    expect(normalizeMarketQuery("  pdf   skill ")).toBe("pdf skill");
    expect(normalizeMarketQuery("   ")).toBe("");
    expect(normalizeMarketQuery("pdf")).toBe("pdf");
  });

  it("下载量展示：千/百万级缩写，0 或非法给占位符", () => {
    expect(formatDownloads(0)).toBe("—");
    expect(formatDownloads(Number.NaN)).toBe("—");
    expect(formatDownloads(42)).toBe("42");
    expect(formatDownloads(1500)).toBe("1.5k");
    expect(formatDownloads(2_450_000)).toBe("2.5M");
  });

  it("作者缺失时回落到仓库名，再回落到「未知作者」", () => {
    const base = {
      packageName: "pkg",
      name: "pkg",
      description: "",
      version: "1.0.0",
      downloads: 1,
      keywords: [],
    };
    expect(toMarketItemView({ ...base, author: " me " }).authorLabel).toBe(
      "me",
    );
    expect(
      toMarketItemView({
        ...base,
        author: "",
        repository: "https://github.com/owner/repo",
      }).authorLabel,
    ).toBe("owner/repo");
    expect(toMarketItemView({ ...base, author: "" }).authorLabel).toBe(
      "未知作者",
    );
  });

  it("安装失败文案：409 提示已装过并指向技能库，其它错误优先用服务端消息", () => {
    expect(describeInstallFailure(409)).toContain("已安装过");
    expect(describeInstallFailure(500, "下游超时")).toBe("下游超时");
    expect(describeInstallFailure(500, "   ")).toBe("安装失败，请稍后重试。");
  });
});
