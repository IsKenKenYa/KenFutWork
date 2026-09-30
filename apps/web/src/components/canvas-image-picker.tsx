"use client";

import { useEffect, useRef, useState } from "react";

export type CanvasImageItem = {
  kind: "canvas-image";
  id: string;
  name: string;
  thumbnailUrl: string;
  assetId: string;
  url: string;
  mimeType: string;
};

export type BrandKitMentionItem = {
  kind: "brand-kit-asset";
  id: string;
  label: string;
  assetType: "color" | "font" | "logo" | "image";
  textContent?: string | null;
  fileUrl?: string | null;
  thumbnailUrl?: string | null;
};

export type ImageModelMentionItem = {
  kind: "image-model";
  id: string;
  label: string;
  description?: string;
  iconUrl?: string;
};

export type SkillMentionItem = {
  kind: "skill";
  id: string;
  label: string;
  slug: string;
  description?: string;
};

export type MessageMentionPickerItem =
  | CanvasImageItem
  | BrandKitMentionItem
  | ImageModelMentionItem
  | SkillMentionItem;

type MessageMentionPickerProps = {
  items: MessageMentionPickerItem[];
  query?: string;
  onSelect: (item: MessageMentionPickerItem) => void;
  onClose: () => void;
};

function itemLabel(item: MessageMentionPickerItem): string {
  return item.kind === "canvas-image" ? item.name : item.label;
}

function itemKeywords(item: MessageMentionPickerItem): string[] {
  if (item.kind === "canvas-image") return [item.name];
  if (item.kind === "image-model") return [item.label, item.description ?? ""];
  if (item.kind === "skill")
    return [item.label, item.slug, item.description ?? ""];
  return [item.label, item.assetType, item.textContent ?? ""];
}

function groupTitle(kind: MessageMentionPickerItem["kind"]): string {
  if (kind === "canvas-image") return "本项目";
  if (kind === "brand-kit-asset") return "品牌套件";
  if (kind === "skill") return "技能";
  return "模型";
}

/** 分组在弹层里的先后（键盘上下键按这个顺序走）。 */
const MENTION_KIND_ORDER: MessageMentionPickerItem["kind"][] = [
  "canvas-image",
  "brand-kit-asset",
  "image-model",
  "skill",
];

export function MessageMentionPicker({
  items,
  query,
  onSelect,
  onClose,
}: MessageMentionPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 键盘选择（↑↓ 选、回车确认、Esc 关闭）：光标在输入框里、列表只是弹出层，
  // 所以监听挂在 document 的捕获阶段，并且命中这些键时 stopPropagation——
  // 否则输入框的回车会抢先把半截「@查询词」当消息发出去。
  const [activeIndex, setActiveIndex] = useState(0);

  const filteredItems = query
    ? items.filter((item) =>
        itemKeywords(item).some((keyword) =>
          keyword.toLowerCase().includes(query.toLowerCase()),
        ),
      )
    : items;

  const groupedItems = filteredItems.reduce<
    Record<MessageMentionPickerItem["kind"], MessageMentionPickerItem[]>
  >(
    (acc, item) => {
      acc[item.kind].push(item);
      return acc;
    },
    {
      "canvas-image": [],
      "brand-kit-asset": [],
      "image-model": [],
      skill: [],
    },
  );

  // 键盘索引与视觉顺序一致：按分组顺序摊平
  const visibleItems = MENTION_KIND_ORDER.flatMap((kind) => groupedItems[kind]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  // 查询词变了：回到第一项（否则索引会指到别人身上）
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setActiveIndex((index) =>
          Math.min(index + 1, Math.max(visibleItems.length - 1, 0)),
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setActiveIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        const item = visibleItems[activeIndex];
        if (!item) return;
        e.preventDefault();
        e.stopPropagation();
        onSelect(item);
        onClose();
        return;
      }
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey, true);
    return () => document.removeEventListener("keydown", handleKey, true);
  }, [visibleItems, activeIndex, onSelect, onClose]);

  if (filteredItems.length === 0) {
    return (
      <div
        ref={containerRef}
        className="absolute bottom-full left-2 mb-2 w-56 rounded-xl border border-border bg-popover p-3 shadow-lg"
      >
        <p className="text-xs text-muted-foreground">
          {items.length === 0
            ? "没有可引用的条目"
            : `没有匹配「${query}」的条目`}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-2 mb-2 max-h-64 w-64 overflow-y-auto rounded-xl border border-border bg-popover shadow-lg"
    >
      <div className="p-2">
        {MENTION_KIND_ORDER.map((kind) => {
          const sectionItems = groupedItems[kind];
          if (!sectionItems.length) return null;
          return (
            <div key={kind} className="mb-2 last:mb-0">
              <div className="mb-1.5 px-1 text-[11px] font-medium text-muted-foreground">
                {groupTitle(kind)}
              </div>
              {sectionItems.map((item) => {
                const active = visibleItems[activeIndex] === item;
                return (
                  <button
                    key={`${item.kind}:${item.id}`}
                    type="button"
                    data-active={active || undefined}
                    onMouseEnter={() =>
                      setActiveIndex(visibleItems.indexOf(item))
                    }
                    onClick={() => {
                      onSelect(item);
                      onClose();
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                      active ? "bg-muted" : "hover:bg-muted"
                    }`}
                  >
                    <PickerLeadingVisual item={item} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-foreground">
                        {itemLabel(item)}
                      </div>
                      {item.kind === "brand-kit-asset" && (
                        <div className="truncate text-[11px] text-muted-foreground">
                          {item.assetType}
                          {item.textContent ? ` · ${item.textContent}` : ""}
                        </div>
                      )}
                      {item.kind === "image-model" && item.description && (
                        <div className="truncate text-[11px] text-muted-foreground">
                          {item.description}
                        </div>
                      )}
                      {item.kind === "skill" && item.description && (
                        <div className="truncate text-[11px] text-muted-foreground">
                          {item.description}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PickerLeadingVisual({ item }: { item: MessageMentionPickerItem }) {
  if (item.kind === "canvas-image") {
    return (
      // biome-ignore lint/performance/noImgElement: 运行时 URL（data:/blob:/签名），尺寸未知，静态导出（output: "export"）下 next/image 不能用
      <img
        src={item.thumbnailUrl}
        alt={item.name}
        className="h-8 w-8 shrink-0 rounded border border-border object-cover"
      />
    );
  }

  if (item.kind === "brand-kit-asset" && item.thumbnailUrl) {
    return (
      // biome-ignore lint/performance/noImgElement: 运行时 URL（data:/blob:/签名），尺寸未知，静态导出（output: "export"）下 next/image 不能用
      <img
        src={item.thumbnailUrl}
        alt={item.label}
        className="h-8 w-8 shrink-0 rounded border border-border object-cover"
      />
    );
  }

  if (item.kind === "image-model" && item.iconUrl) {
    return (
      // biome-ignore lint/performance/noImgElement: 运行时 URL（data:/blob:/签名），尺寸未知，静态导出（output: "export"）下 next/image 不能用
      <img
        src={item.iconUrl}
        alt={item.label}
        className="h-8 w-8 shrink-0 rounded-full border border-border object-cover"
      />
    );
  }

  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border bg-muted text-[10px] font-medium uppercase text-muted-foreground">
      {item.kind === "brand-kit-asset"
        ? item.assetType.slice(0, 2)
        : item.kind === "skill"
          ? "SK"
          : "AI"}
    </div>
  );
}
