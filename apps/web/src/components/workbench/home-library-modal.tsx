"use client";

import type { HomeLibraryResponse } from "@loomic/shared";
import { Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { fetchHomeLibrary } from "@/lib/server-api";

/**
 * 首页示例库 / 发现库（Design 模式首页的灵感内容）。
 *
 * 数据来自服务端 `GET /api/home/library`（`home_example_examples` /
 * `home_discovery_cases` 静态种子，素材 URL 已由服务端经 blob 缝解析）。
 * 点卡片 = 把它的 prompt 交给画布（父组件负责选中/新建项目并带 prompt 打开）。
 */
export function HomeLibraryModal(options: {
  accessToken: string;
  onClose: () => void;
  /** 选中一张卡片：把 prompt 带进画布。 */
  onPick: (input: { prompt: string; title: string }) => void;
  open: boolean;
}) {
  const { accessToken, onClose, onPick, open } = options;
  const [library, setLibrary] = useState<HomeLibraryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  useEffect(() => {
    if (!open || library) {
      return;
    }
    let cancelled = false;
    void fetchHomeLibrary(accessToken)
      .then((data) => {
        if (!cancelled) {
          setLibrary(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("示例库加载失败，请稍后重试。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, library, open]);

  const visibleExamples = useMemo(() => {
    if (!library) {
      return [];
    }
    return activeCategory
      ? library.examples.filter((e) => e.categoryKey === activeCategory)
      : library.examples;
  }, [activeCategory, library]);

  const visibleDiscovery = useMemo(() => {
    if (!library) {
      return [];
    }
    return activeCategory
      ? library.discoveryCases.filter((c) => c.categoryKey === activeCategory)
      : library.discoveryCases;
  }, [activeCategory, library]);

  const handlePick = useCallback(
    (input: { prompt: string; title: string }) => {
      onPick(input);
      onClose();
    },
    [onClose, onPick],
  );

  return (
    // 与插件市场模态同形：受控开启，onOpenChange 只处理关闭
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-5xl overflow-y-auto p-0">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base font-medium">
            <Sparkles className="h-4 w-4" />
            示例库 / 发现库
          </DialogTitle>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          {error ? (
            <p className="py-10 text-center text-sm text-destructive">
              {error}
            </p>
          ) : null}

          {!library && !error ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              正在加载示例…
            </p>
          ) : null}

          {library ? (
            <>
              <div className="mb-4 flex flex-wrap gap-1.5">
                <CategoryChip
                  active={activeCategory === null}
                  label="全部"
                  onClick={() => setActiveCategory(null)}
                />
                {library.categories.map((category) => (
                  <CategoryChip
                    key={category.key}
                    active={activeCategory === category.key}
                    label={category.label}
                    onClick={() => setActiveCategory(category.key)}
                  />
                ))}
              </div>

              {visibleExamples.length > 0 ? (
                <section className="mb-6">
                  <h3 className="mb-2 text-sm font-medium">示例</h3>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {visibleExamples.map((example) => (
                      <button
                        key={example.id}
                        type="button"
                        onClick={() =>
                          handlePick({
                            prompt: example.prompt,
                            title: example.title,
                          })
                        }
                        className="group overflow-hidden rounded-xl border bg-card text-left transition-colors hover:border-foreground/30"
                      >
                        {example.imageUrls[0] ? (
                          // 素材 URL 已由服务端解析（blob 缝），此处直接展示
                          <img
                            src={example.imageUrls[0]}
                            alt={example.title}
                            className="h-32 w-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="h-32 w-full bg-muted" />
                        )}
                        <div className="p-2.5">
                          <p className="line-clamp-2 text-xs font-medium">
                            {example.title}
                          </p>
                          {example.inputMentions.length > 0 ? (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1">
                              {example.inputMentions
                                .slice(0, 3)
                                .map((mention, index) =>
                                  mention.imgSrc ? (
                                    <img
                                      key={`${mention.name}-${index}`}
                                      src={mention.imgSrc}
                                      alt={mention.name}
                                      title={mention.name}
                                      className="h-4 w-4 rounded border object-cover"
                                    />
                                  ) : null,
                                )}
                            </div>
                          ) : null}
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              {visibleDiscovery.length > 0 ? (
                <section>
                  <h3 className="mb-2 text-sm font-medium">发现</h3>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {visibleDiscovery.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        disabled={!item.seedPrompt}
                        onClick={() =>
                          handlePick({
                            prompt: item.seedPrompt,
                            title: item.title,
                          })
                        }
                        className="group overflow-hidden rounded-xl border bg-card text-left transition-colors hover:border-foreground/30 disabled:opacity-60"
                      >
                        {item.coverUrl ? (
                          <img
                            src={item.coverUrl}
                            alt={item.title}
                            className="h-32 w-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="h-32 w-full bg-muted" />
                        )}
                        <div className="p-2.5">
                          <p className="line-clamp-2 text-xs font-medium">
                            {item.title}
                          </p>
                          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            {item.authorAvatarUrl ? (
                              <img
                                src={item.authorAvatarUrl}
                                alt={item.authorName}
                                className="h-4 w-4 rounded-full object-cover"
                              />
                            ) : null}
                            <span className="truncate">{item.authorName}</span>
                            <span>· {item.viewCount} 浏览</span>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CategoryChip(options: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={options.onClick}
      data-active={options.active}
      className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground data-[active=true]:border-foreground/30 data-[active=true]:bg-muted data-[active=true]:text-foreground"
    >
      {options.label}
    </button>
  );
}
