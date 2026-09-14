import { Loader2 } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";

/**
 * 列表三态（加载 / 空 / 失败）。
 *
 * **为什么单独抽出来**：MCP 与技能两处的市场列表此前只在按钮上写「检索中…」，
 * 列表区则是一片空白——用户看到空白无法判断是「正在加载」「没有结果」还是
 * 「请求失败了」，实测被当成 bug 反馈过。这里把三态做成带骨架与原因的显式状态，
 * 并且都带 `role="status"` / `aria-busy` 便于断言。
 */

/** 加载态：骨架行 + 说明正在做什么。 */
export function ListLoading({
  label,
  rows = 3,
}: {
  label: string;
  rows?: number;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="space-y-2"
    >
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {label}
      </p>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="rounded-xl border p-3">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-2 h-3 w-full" />
          <Skeleton className="mt-1.5 h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

/** 空态：说明「为什么空」以及下一步去哪。 */
export function ListEmpty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed p-4 text-center">
      <p className="text-sm text-muted-foreground">{title}</p>
      {hint ? (
        <p className="mt-1 text-xs text-muted-foreground/70">{hint}</p>
      ) : null}
    </div>
  );
}

/** 错误态：把原因摆出来，而不是留一片空白让人猜。 */
export function ListError({
  message,
  hint,
}: {
  message: string;
  hint?: string;
}) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-destructive/40 bg-destructive/5 p-4"
    >
      <p className="text-sm text-destructive">{message}</p>
      {hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
