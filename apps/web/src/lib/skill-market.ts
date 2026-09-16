import type { MarketplaceSkill } from "@kenfutwork/shared";

/**
 * 技能市场的纯视图逻辑（搜索/安装面板用）。
 *
 * 市场数据源（服务端）：**npm registry** 按 `keywords:agent-skill` 发现候选，
 * 安装时再经 **skills.sh** 下载（`GET https://skills.sh/api/download/{owner}/{repo}/{slug}`），
 * 最终以 tarball 形式导入成技能。前端此前没有任何市场入口（我第一版技能页只做了
 * 「技能库 / 导入·新建」），所以用户"看不到丰富的技能"——不是市场为空。
 */

/** 搜索词规范化：trim + 折叠空白；空串表示「浏览全部」（服务端只按 keyword 检索）。 */
export function normalizeMarketQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

export interface MarketItemView extends MarketplaceSkill {
  /** 展示用作者（去 scoped 包名前缀的兜底）。 */
  authorLabel: string;
  /** 展示用下载量（1.2k / 3.4M）。 */
  downloadsLabel: string;
}

export function formatDownloads(downloads: number): string {
  if (!Number.isFinite(downloads) || downloads <= 0) {
    return "—";
  }
  if (downloads >= 1_000_000) {
    return `${(downloads / 1_000_000).toFixed(1)}M`;
  }
  if (downloads >= 1_000) {
    return `${(downloads / 1_000).toFixed(1)}k`;
  }
  return String(downloads);
}

export function toMarketItemView(skill: MarketplaceSkill): MarketItemView {
  const authorLabel = skill.author?.trim()
    ? skill.author.trim()
    : (skill.repository ?? "").replace(/^https?:\/\/github\.com\//, "");
  return {
    ...skill,
    authorLabel: authorLabel || "未知作者",
    downloadsLabel: formatDownloads(skill.downloads),
  };
}

/**
 * 安装结果提示文案：区分「已装过」（409）与其它失败，让用户知道下一步。
 */
export function describeInstallFailure(
  status: number,
  message?: string,
): string {
  if (status === 409) {
    return "该技能已安装过（可在「技能库」里启用）。";
  }
  if (message && message.trim()) {
    return message;
  }
  return "安装失败，请稍后重试。";
}
