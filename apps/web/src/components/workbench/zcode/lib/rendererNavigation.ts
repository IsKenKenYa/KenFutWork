interface RendererNavigationEntry {
  readonly type?: string;
}

function readRendererNavigationEntries(): RendererNavigationEntry[] {
  try {
    if (typeof globalThis.performance?.getEntriesByType !== "function") {
      return [];
    }
    const entries = globalThis.performance.getEntriesByType("navigation") as RendererNavigationEntry[];
    if (entries[0]?.type === "reload" || typeof window === "undefined" || window.parent === window) {
      return entries;
    }
    // Code 独立文档随同源工作台重建；父或 iframe 自身 reload 均保留原恢复资格。
    try {
      const parentEntries = window.parent.performance.getEntriesByType("navigation") as RendererNavigationEntry[];
      if (parentEntries[0]?.type === "reload") return parentEntries;
    } catch {
      // 跨源宿主不可读，保留当前 renderer 的原判定。
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * 区分 app 冷启动与同一 renderer 的刷新。
 * workspace/app 入口只应展示草稿，但输出中的 renderer reload 仍要恢复当前 pane 续流。
 */
export function isRendererReloadNavigation(
  entries: readonly RendererNavigationEntry[] = readRendererNavigationEntries(),
): boolean {
  return entries[0]?.type === "reload";
}
