"use client";

/**
 * 画布页顶部的多标签栏：会话 / 图层 / 文件。
 *
 * 这三块内容原先散在三处——对话是右侧面板，图层与生成文件是画布上的两块左侧浮层
 * （各自带标题栏和关闭按钮）。现在只有一条标签栏在页面最上方，右侧面板按选中标签
 * 渲染对应内容；标签栏本身与面板解耦（面板收起时它仍在，点一下即展开面板）。
 */
export type SidePanelTab = "chat" | "layers" | "files";

const SIDE_PANEL_TABS: Array<{ id: SidePanelTab; label: string }> = [
  { id: "chat", label: "会话" },
  { id: "layers", label: "图层" },
  { id: "files", label: "文件" },
];

export function SidePanelTabs({
  value,
  onChange,
}: {
  value: SidePanelTab;
  onChange?: ((tab: SidePanelTab) => void) | undefined;
}) {
  return (
    <div
      role="tablist"
      aria-label="右侧面板"
      className="flex h-full items-stretch gap-0.5"
    >
      {SIDE_PANEL_TABS.map((tab) => {
        const active = value === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange?.(tab.id)}
            className={`relative -mb-px px-3 text-xs transition-colors ${
              active
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            {/* 选中下划线：顶部标签栏的常见读法（与面板内容对齐） */}
            <span
              aria-hidden
              className={`absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-colors ${
                active ? "bg-foreground" : "bg-transparent"
              }`}
            />
          </button>
        );
      })}
    </div>
  );
}
