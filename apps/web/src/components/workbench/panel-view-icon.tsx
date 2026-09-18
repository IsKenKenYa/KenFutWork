"use client";

import {
  Bot,
  FileCode2,
  FileDiff,
  Folder,
  Globe,
  SquareTerminal,
} from "lucide-react";
import type { PanelViewKind } from "@/lib/panel-tabs";

/**
 * 右栏视图的图标（**单一来源**：标签条与空态都用它）。
 *
 * 为什么抽出来：标签条的图标与「空态」的图标必须是同一个，否则同一个视图在两处长得不一样；
 * 之前图标表私藏在标签条里，空态就只能自己再挑一个（那正是漂移的开始）。
 */
export function PanelViewIcon({
  kind,
  className = "h-3.5 w-3.5",
}: {
  kind: PanelViewKind;
  className?: string;
}) {
  switch (kind) {
    case "changes":
      return <FileDiff className={className} />;
    case "files":
      return <Folder className={className} />;
    case "terminal":
      return <SquareTerminal className={className} />;
    case "browser":
      return <Globe className={className} />;
    case "subagents":
      return <Bot className={className} />;
    case "diff":
      return <FileDiff className={className} />;
    case "file":
      return <FileCode2 className={className} />;
  }
}

/**
 * 右栏视图的空态：**居中**（水平 + 垂直）+ 视图图标 + 稍大的字（用户口径）。
 *
 * 空态是「这个视图现在没东西」的唯一表达，散在各视图里各写一段 `<p>` 会同时丢掉居中与图标——
 * 收成一个组件，谁也漏不掉。
 */
export function PanelEmptyState({
  kind,
  title,
  hint,
}: {
  kind: PanelViewKind;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
      <PanelViewIcon kind={kind} className="size-7 text-muted-foreground/60" />
      <p className="text-sm text-muted-foreground">{title}</p>
      {hint ? (
        <p className="max-w-56 text-xs text-muted-foreground/80">{hint}</p>
      ) : null}
    </div>
  );
}
