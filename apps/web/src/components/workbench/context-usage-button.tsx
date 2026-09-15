"use client";

import { Gauge } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  contextUsageView,
  type RunUsageSnapshot,
} from "@/lib/context-usage";

/**
 * 模型选择器旁的「上下文容量 / 缓存命中」浮层（R4-1）。
 *
 * 圆形图标按钮 + 点开浮层，数据来自服务端 `run.usage`（本轮最后一次模型调用的
 * 累计用量）与模型目录里的上下文窗口。**没有数据时不显示 0**——分类占比那一块
 * 参考图里有，但服务端根本没有「按分类拆 token」的采集口径，宁缺毋滥。
 */
export function ContextUsageButton({
  usage,
  contextWindow,
}: {
  usage: RunUsageSnapshot | null | undefined;
  contextWindow: number | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const view = contextUsageView(usage, contextWindow);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="上下文容量"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="上下文容量与缓存命中"
        onClick={() => setOpen((current) => !current)}
        className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Gauge className="h-4 w-4" />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="上下文容量与缓存命中"
          className="absolute right-0 bottom-full z-50 mb-2 w-72 rounded-xl border bg-popover p-3 text-popover-foreground shadow-md"
        >
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">上下文容量</span>
            <span className="tabular-nums text-muted-foreground">
              {view.hasUsage
                ? `${view.inputLabel}${view.windowLabel ? `/${view.windowLabel}` : ""}${
                    view.percentLabel ? `（${view.percentLabel}）` : ""
                  }`
                : "本轮暂无用量"}
            </span>
          </div>

          {view.percent !== null ? (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-foreground/70"
                style={{ width: `${view.percent}%` }}
              />
            </div>
          ) : null}

          <dl className="mt-3 space-y-1 text-xs">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">输入 token</dt>
              <dd className="tabular-nums">{view.inputLabel ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">输出 token</dt>
              <dd className="tabular-nums">{view.outputLabel ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">缓存命中率</dt>
              <dd className="tabular-nums">
                {view.cacheHitLabel ?? "上游未上报"}
              </dd>
            </div>
          </dl>

          {view.windowLabel === null ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              该模型没有声明上下文窗口，无法计算容量占比。
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
