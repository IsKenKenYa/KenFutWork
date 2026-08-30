"use client";

import { useMemo, useState } from "react";

import type {
  HomeDiscoveryCase,
  HomeDiscoveryCategory,
  HomeDiscoverySelection,
} from "@/lib/home-discovery-seeds";
import { cn } from "@/lib/utils";

type HomeDiscoveryGalleryProps = {
  categories: HomeDiscoveryCategory[];
  onCaseSelect: (selection: HomeDiscoverySelection) => void;
};

type DiscoveryTabProps = {
  active: boolean;
  label: string;
  onClick: () => void;
};

function DiscoveryTab({ active, label, onClick }: DiscoveryTabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1.5 text-sm transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-background text-muted-foreground hover:border-foreground/25 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function formatMetric(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

export function HomeDiscoveryGallery({
  categories,
  onCaseSelect,
}: HomeDiscoveryGalleryProps) {
  const [activeCategoryKey, setActiveCategoryKey] = useState<string>("all");

  const visibleCases = useMemo<
    Array<HomeDiscoveryCase & { categoryKey: string; categoryLabel: string }>
  >(() => {
    if (activeCategoryKey === "all") {
      return categories.flatMap((category) =>
        category.cases.map((item) => ({
          ...item,
          categoryKey: category.key,
          categoryLabel: category.label,
        })),
      );
    }

    const currentCategory = categories.find(
      (category) => category.key === activeCategoryKey,
    );

    if (!currentCategory) {
      return [];
    }

    return currentCategory.cases.map((item) => ({
      ...item,
      categoryKey: currentCategory.key,
      categoryLabel: currentCategory.label,
    }));
  }, [activeCategoryKey, categories]);

  if (categories.length === 0) {
    return null;
  }

  const handleCaseClick = (
    categoryKey: string,
    categoryLabel: string,
    item: HomeDiscoveryCase,
  ) => {
    const { sourceUrl: _sourceUrl, ...selectionCase } = item;
    onCaseSelect({
      ...selectionCase,
      categoryKey,
      categoryLabel,
    });
  };

  return (
    <section className="mt-14 w-full">
      <div className="mb-5 flex flex-col gap-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium text-foreground">灵感发现</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              点击卡片后会直接按这条案例思路新建 Loomic 项目，并进入 agent
              对话流。
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <DiscoveryTab
            active={activeCategoryKey === "all"}
            label="全部"
            onClick={() => setActiveCategoryKey("all")}
          />
          {categories.map((category) => (
            <DiscoveryTab
              key={category.key}
              active={activeCategoryKey === category.key}
              label={category.label}
              onClick={() => setActiveCategoryKey(category.key)}
            />
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {visibleCases.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-label={item.title}
            onClick={() =>
              handleCaseClick(item.categoryKey, item.categoryLabel, item)
            }
            className="group overflow-hidden rounded-2xl border border-border bg-card shadow-card transition-all duration-300 hover:-translate-y-1 hover:shadow-md"
          >
            <div className="relative aspect-[4/5] overflow-hidden bg-muted">
              <img
                src={item.coverImageUrl}
                alt={item.title}
                loading="lazy"
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
              />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent p-4">
                <span className="inline-flex rounded-full bg-white/12 px-2 py-1 text-[11px] text-white/85 backdrop-blur-sm">
                  {item.categoryLabel}
                </span>
                <p className="mt-2 line-clamp-2 text-sm font-medium text-white">
                  {item.title}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <img
                    src={item.authorAvatarUrl}
                    alt=""
                    className="h-6 w-6 rounded-full object-cover"
                  />
                  <span className="truncate text-sm text-foreground">
                    {item.authorName}
                  </span>
                </div>
                <p className="mt-1 text-left text-xs text-muted-foreground">
                  点击后直接作为 Loomic 的起始需求
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                <span>{formatMetric(item.viewCount)} 浏览</span>
                <span>{formatMetric(item.likeCount)} 赞</span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
