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
 * 形态照参考图（`docs/参考图/索引库-代码库索引开关.png`）：「代码库」分组下**两行开关**，
 * 两行都是真行为（不是排版）：
 * 1. **索引新文件夹**：搜到还没有索引的工作目录时自动建一份（文件数 < 50,000 才建）；
 * 2. **索引存储库以实现即时搜索（测试版）**：右栏「文件目录」的搜索走索引。
 *
 * 索引是**本机缓存**（`<cwd>/.kenfutwork/index/<canvasId>.json`），进库表的东西一件没有：
 * 开关记在工作区设置里，索引文件在磁盘上。「所有数据均存储在本地」这句是承诺，所以
 * 界面上照写并说明落点。
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
  autoNewFolder,
  onToggle,
  onToggleAuto,
}: {
  accessToken: string;
  /** 当前会话/项目的主画布（索引按画布即工作目录建）。 */
  canvasId: string | null;
  /** ② 「索引存储库以实现即时搜索」：搜索走索引。 */
  enabled: boolean;
  /** ① 「索引新文件夹」：自动为尚无索引的工作目录建索引。 */
  autoNewFolder: boolean;
  /** 由设置模态统一读写，避免两处真相。 */
  onToggle: (next: boolean) => Promise<void>;
  onToggleAuto: (next: boolean) => Promise<void>;
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
        索引针对工作目录（Code 模式的项目目录）：记下每个文件的路径 / 大小 /
        语言 / 摘要前 200
        字，右栏「文件目录」的搜索用它按文件名、路径和内容摘要找文件。
      </p>

      <p className="mb-1 text-xs text-muted-foreground">代码库</p>
      <div className="divide-y rounded-lg border">
        <IndexToggle
          title="索引新文件夹"
          hint="自动索引文件数少于 50,000 的新文件夹。"
          checked={autoNewFolder}
          onChange={(next) => void onToggleAuto(next)}
        />
        <IndexToggle
          title="索引存储库以实现即时搜索（测试版）"
          hint="自动对仓库进行索引，以加快 Grep 搜索速度。所有数据均存储在本地。"
          checked={enabled}
          onChange={(next) => void onToggle(next)}
        />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        索引文件存在服务端的
        .kenfutwork/index/（本机缓存），不进数据库、也不会写进你的
        工作目录；「索引新文件夹」只在「即时搜索」开着时才起作用。
      </p>

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
            还没有索引——
            {autoNewFolder && enabled
              ? "在「文件目录」里搜一次会自动建一份，也可以点下面的「重建索引」。"
              : "点下面的「重建索引」建一份（「索引新文件夹」关着时不会自动建）。"}
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

/** 一行参考图式开关：整行可点，标题 + 说明在左、开关在右。 */
function IndexToggle({
  title,
  hint,
  checked,
  onChange,
}: {
  title: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 px-3 py-2.5">
      <span className="min-w-0">
        <span className="block text-sm">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label={title}
        aria-checked={checked}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-8 shrink-0 appearance-none rounded-full bg-muted transition-colors checked:bg-foreground/80 before:block before:h-3.5 before:w-3.5 before:translate-x-0.5 before:rounded-full before:bg-background before:transition-transform checked:before:translate-x-4"
      />
    </label>
  );
}
