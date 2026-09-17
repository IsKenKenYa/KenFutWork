"use client";

import { useCallback, useEffect, useState } from "react";
import {
  type CodeIndexStats,
  clearCodeIndex,
  fetchCodeIndex,
  rebuildCodeIndex,
} from "@/lib/server-api";

/**
 * 设置 → 索引库（R4-3）。
 *
 * 索引是**本机缓存**（`<cwd>/.kenfutwork/index/<canvasId>.json`），进库表的东西一件没有：
 * 开关记在工作区设置里，索引文件在磁盘上。开关关着时右栏「文件目录」的搜索会如实报
 * 「索引库未开启」，而不是回一个空列表。
 */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatBuiltAt(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function IndexLibrarySection({
  accessToken,
  canvasId,
  enabled,
  onToggle,
}: {
  accessToken: string;
  /** 当前会话/项目的主画布（索引按画布即工作目录建）。 */
  canvasId: string | null;
  /** 工作区设置里的开关值（由设置模态统一读写，避免两处真相）。 */
  enabled: boolean;
  onToggle: (next: boolean) => Promise<void>;
}) {
  const [stats, setStats] = useState<CodeIndexStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canvasId) return;
    try {
      const status = await fetchCodeIndex(accessToken, canvasId);
      setStats(status.stats);
    } catch {
      setStats(null);
    }
  }, [accessToken, canvasId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: "rebuild" | "clear") => {
    if (!canvasId) return;
    setBusy(true);
    setMessage(null);
    try {
      if (action === "rebuild") {
        const result = await rebuildCodeIndex(accessToken, canvasId);
        setStats(result.stats);
        setMessage(
          `已重建：${result.stats?.files ?? 0} 个文件、${formatBytes(result.stats?.bytes ?? 0)}`,
        );
      } else {
        await clearCodeIndex(accessToken, canvasId);
        setStats(null);
        setMessage("已清空索引（下次搜索会按需重建）");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="索引库设置">
      <h3 className="mb-1 text-base font-medium">索引库</h3>
      <p className="mb-3 text-sm text-muted-foreground">
        给工作目录里的文件建一份**本机索引**（路径 / 大小 / 语言 / 摘要前 200
        字），
        右栏「文件目录」的搜索用它按文件名、路径和内容摘要找文件。索引文件存在服务端
        `/.kenfutwork/index/`，不进数据库，也不会写进你的工作目录。
      </p>

      <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => void onToggle(event.target.checked)}
          className="h-4 w-4"
        />
        <span>
          启用索引库
          <span className="ml-2 text-xs text-muted-foreground">
            关掉后「文件目录」搜索会提示未开启，其余功能不受影响
          </span>
        </span>
      </label>

      <div className="mt-3 rounded-lg border p-3 text-sm">
        {canvasId === null ? (
          <p className="text-muted-foreground">
            当前会话没有绑定工作目录——绑定后这里会显示索引统计。
          </p>
        ) : stats ? (
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>
              已索引 <span className="text-foreground">{stats.files}</span>{" "}
              个文件 · {formatBytes(stats.bytes)}
            </li>
            <li>索引文件 {formatBytes(stats.indexBytes)}</li>
            <li>上次构建 {formatBuiltAt(stats.builtAt)}</li>
            {stats.skipped > 0 ? (
              <li>读不出来的文件 {stats.skipped} 个（已跳过）</li>
            ) : null}
            {stats.truncated ? (
              <li>已达到条数/体积上限，只索引了前一部分</li>
            ) : null}
          </ul>
        ) : (
          <p className="text-muted-foreground">
            还没有索引——点「重建索引」建一份（或在「文件目录」里搜一次，会按需自动建）。
          </p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            disabled={busy || !canvasId}
            onClick={() => void run("rebuild")}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          >
            {busy ? "处理中…" : "重建索引"}
          </button>
          <button
            type="button"
            disabled={busy || !canvasId || !stats}
            onClick={() => void run("clear")}
            className="rounded-md border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-40"
          >
            清空
          </button>
        </div>
      </div>

      {message ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </section>
  );
}
