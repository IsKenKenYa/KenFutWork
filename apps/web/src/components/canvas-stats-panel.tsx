"use client";

/**
 * 「画布与元素属性」面板的内容（汉化 + 排版）。
 *
 * 为什么自己画：Excalidraw 自带的那份在 zh-CN 语言包缺键，标题是中文、正文里
 * `General / Shapes / Canvas / Grid step` 却是英文，且模板是左标签右数值挤在一起。
 * Excalidraw 提供了 `renderCustomStats` 这个口子（实测是**追加**在默认内容之后），
 * 所以做法是：用 CSS 藏掉它的英文默认体，这里出一份中文、留白正常的版本。
 *
 * 数据一律**现取**（`excalidrawApi`），不依赖上游传进来的快照——面板开着时场景随时在变，
 * 上游给的两个参数只在拿不到 API 时兜底。
 */

type AnyElement = {
  isDeleted?: boolean;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

function SceneRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export function CanvasStatsPanel({
  elements,
  appState,
  excalidrawApi,
}: {
  elements?: AnyElement[] | undefined;
  appState?: Record<string, any> | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: Excalidraw API 无公开类型
  excalidrawApi?: any;
}) {
  let all: AnyElement[] = [];
  try {
    all = (excalidrawApi?.getSceneElements?.() ??
      elements ??
      []) as AnyElement[];
  } catch {
    all = (elements ?? []) as AnyElement[];
  }
  const live = all.filter((el) => !el.isDeleted);

  const state = (() => {
    try {
      return excalidrawApi?.getAppState?.() ?? appState ?? {};
    } catch {
      return appState ?? {};
    }
  })();

  // 元素整体包围盒（Excalidraw 的「宽度/高度」也是这个口径）
  let width = 0;
  let height = 0;
  if (live.length > 0) {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const el of live) {
      const x = el.x ?? 0;
      const y = el.y ?? 0;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + (el.width ?? 0));
      maxY = Math.max(maxY, y + (el.height ?? 0));
    }
    width = Math.round(maxX - minX);
    height = Math.round(maxY - minY);
  }

  const gridOn = Boolean(state.gridModeEnabled);
  const gridSize = state.gridSize ?? 20;
  const zoom = Math.round((state.zoom?.value ?? 1) * 100);
  const selected = Object.keys(state.selectedElementIds ?? {}).filter(
    (id) => (state.selectedElementIds ?? {})[id],
  ).length;

  return (
    <div className="flex flex-col gap-1 px-3 pb-3">
      <p className="pt-1 pb-0.5 text-xs font-medium text-foreground">画布</p>
      <SceneRow label="元素数" value={live.length} />
      <SceneRow label="宽度" value={width} />
      <SceneRow label="高度" value={height} />
      <SceneRow label="已选中" value={selected} />

      <p className="pt-3 pb-0.5 text-xs font-medium text-foreground">视图</p>
      <SceneRow label="网格" value={gridOn ? `${gridSize} px` : "关闭"} />
      <SceneRow label="缩放" value={`${zoom}%`} />
    </div>
  );
}
