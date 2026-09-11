"use client";

import type { UsageSummaryResponse } from "@loomic/shared";
import { useCallback, useEffect, useState } from "react";
import { fetchUsageSummary } from "@/lib/server-api";

/** 用量摘要（DEC-6）：BYOK token/成本计量展示，数据来自 usage 表工作区汇总。 */
export function UsageSummarySection({ accessToken }: { accessToken: string }) {
  const [summary, setSummary] = useState<UsageSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSummary(await fetchUsageSummary(accessToken));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法加载用量");
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <section aria-label="用量摘要">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      </section>
    );
  }

  if (!summary) {
    return (
      <section aria-label="用量摘要">
        <p className="text-sm text-muted-foreground">加载中…</p>
      </section>
    );
  }

  const fmt = (n: number) => n.toLocaleString("en-US");

  return (
    <section aria-label="用量摘要">
      <h3 className="mb-1 text-base font-medium">用量摘要</h3>
      <p className="mb-3 text-sm text-muted-foreground">
        输入 {fmt(summary.totals.inputTokens)} tokens · 输出{" "}
        {fmt(summary.totals.outputTokens)} tokens
        {summary.totals.costUsd != null
          ? ` · 约 $${summary.totals.costUsd.toFixed(4)}`
          : ""}
      </p>
      {summary.byModel.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无用量记录</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="py-1.5 pr-2">供应商</th>
              <th className="py-1.5 pr-2">模型</th>
              <th className="py-1.5 pr-2">类型</th>
              <th className="py-1.5 pr-2">输入</th>
              <th className="py-1.5 pr-2">输出</th>
            </tr>
          </thead>
          <tbody>
            {summary.byModel.map((row) => (
              <tr key={`${row.provider}:${row.model}`} className="border-b">
                <td className="py-1.5 pr-2">{row.provider}</td>
                <td className="py-1.5 pr-2">{row.model}</td>
                <td className="py-1.5 pr-2">{row.capability}</td>
                <td className="py-1.5 pr-2">{fmt(row.inputTokens)}</td>
                <td className="py-1.5 pr-2">{fmt(row.outputTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
