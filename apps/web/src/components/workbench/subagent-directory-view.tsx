"use client";

import { ArrowLeft, CheckCircle2, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import {
  elapsedSecondsBetween,
  formatElapsedSeconds,
  parseTimestampMs,
} from "@/lib/elapsed";
import type {
  SubagentBlock,
  SubagentEntry,
  SubagentToolRow,
} from "@/lib/subagent-directory";
import { formatTaskRelativeTime } from "@/lib/ui-format";
import { AgentActivitySection } from "./zcode/ToolCallBlocks/renderers/agent";
import { AgentPromptSection } from "./zcode/ToolCallBlocks/renderers/agentPromptSection";

/**
 * 「子智能体」视图（zcode 右栏模型）：主对话只保留父派发调用的紧凑行；
 * 列表点条目 → 整个面板切成该子代理的**独立线程视图**（正文/思考/工具
 * 平铺 + 顶部返回），不是行内折叠——子代理是独立会话线程。条目转录由带
 * agentCallId 的事件路由进 SubagentEntry.blocks（lib/subagent-directory），
 * 不进主对话流。
 */
export function SubagentDirectoryView({
  entries,
}: {
  entries: SubagentEntry[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 秒级心跳：运行中条目的时长实时走动（全部结束后不空转）
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasRunning = entries.some((entry) => !entry.endedAt);
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  if (entries.length === 0) return null;

  const selected = selectedId
    ? entries.find((entry) => entry.toolCallId === selectedId)
    : undefined;
  if (selected) {
    return (
      <SubagentThreadView
        entry={selected}
        nowMs={nowMs}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  const runningEntries = entries.filter((entry) => !entry.endedAt);
  const finished = entries.length - runningEntries.length;

  return (
    // zcode SubagentDirectorySidePane 视觉规格（references app-shell 同名件）：
    // 分组头 text-ui-sm subtlest + DirectoryRow（状态图标/标题/状态词/相对时间）
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
      <section>
        <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
          正在运行 · {runningEntries.length}
        </h3>
        {runningEntries.length > 0 ? (
          runningEntries.map((entry) => (
            <SubagentDirectoryRow
              key={entry.toolCallId}
              entry={entry}
              onOpen={() => setSelectedId(entry.toolCallId)}
            />
          ))
        ) : (
          <p className="px-3 py-3 text-ui-base text-foreground-subtlest">
            没有正在运行的子智能体
          </p>
        )}
      </section>
      <section className="mt-5">
        <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
          已结束 · {finished}
        </h3>
        {finished > 0 ? (
          entries
            .filter((entry) => entry.endedAt)
            .map((entry) => (
              <SubagentDirectoryRow
                key={entry.toolCallId}
                entry={entry}
                onOpen={() => setSelectedId(entry.toolCallId)}
              />
            ))
        ) : (
          <p className="px-3 py-3 text-ui-base text-foreground-subtlest">
            暂无
          </p>
        )}
      </section>
    </div>
  );
}

/** zcode DirectoryRow 同款行：状态图标 + 标题 + 状态词 + 相对时间。 */
function SubagentDirectoryRow({
  entry,
  onOpen,
}: {
  entry: SubagentEntry;
  onOpen: () => void;
}) {
  const status = entry.endedAt ? "success" : "running";
  const timestamp = entry.endedAt ?? entry.startedAt;
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 text-left text-ui-base transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border"
      onClick={onOpen}
    >
      <StatusIcon status={status} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-foreground">
            {entry.name}
          </span>
          <span className="shrink-0 text-ui-sm text-foreground-subtlest">
            {entry.endedAt ? "已结束" : "运行中"}
          </span>
        </span>
        {entry.description ? (
          <span className="mt-0.5 block truncate text-ui-sm text-foreground-subtle">
            {entry.description}
          </span>
        ) : null}
      </span>
      {timestamp ? (
        <span className="shrink-0 text-ui-sm text-foreground-subtlest">
          {formatTaskRelativeTime(timestamp)}
        </span>
      ) : null}
    </button>
  );
}

/** zcode StatusIcon 同款（running=旋转/success=勾），we only have two states. */
function StatusIcon({ status }: { status: "running" | "success" }) {
  if (status === "running") {
    return (
      <LoaderCircle
        aria-hidden
        className="mt-0.5 size-4 shrink-0 animate-spin text-foreground-subtle"
      />
    );
  }
  return (
    <CheckCircle2
      aria-hidden
      className="mt-0.5 size-4 shrink-0 text-foreground-subtle"
    />
  );
}

/**
 * 单个子代理的独立线程视图：头部（返回 + 名字 + 状态 + 时长）+ 全量转录。
 * （zcode 交互：列表点条目 → 整面板切线程；转录区形态见下方 SubagentTranscript。）
 */
function SubagentThreadView({
  entry,
  nowMs,
  onBack,
}: {
  entry: SubagentEntry;
  nowMs: number;
  onBack: () => void;
}) {
  const startMs = parseTimestampMs(entry.startedAt);
  const endMs = entry.endedAt ? parseTimestampMs(entry.endedAt) : null;
  const seconds =
    startMs === null
      ? 0
      : elapsedSecondsBetween(startMs, endMs ?? undefined, nowMs);
  return (
    <div className="px-1 py-2">
      <div className="flex items-center gap-1.5 pb-2 text-xs">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回子智能体列表"
          className="flex items-center gap-0.5 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
          子智能体
        </button>
        <span className="ml-1 min-w-0 flex-1 truncate font-medium text-foreground">
          {entry.name}
        </span>
        <span
          className={
            entry.endedAt
              ? "shrink-0 text-muted-foreground/70"
              : "shrink-0 text-emerald-600"
          }
        >
          {entry.endedAt ? "已结束" : "运行中"}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground/70">
          {formatElapsedSeconds(seconds)}
        </span>
      </div>
      <div className="ml-2 space-y-3 border-border border-l pt-2 pl-3.5">
        {entry.description ? (
          /* workspacePath 传空：我方无工作区文件链接语义，zcode 原件内的链接解析自然降级 */
          <AgentPromptSection prompt={entry.description} workspacePath="" />
        ) : null}
        <SubagentTranscript entry={entry} />
      </div>
    </div>
  );
}

/**
 * 子代理转录（zcode AgentToolCallBlock 展开区同构）：思考/输出各成一张
 * AgentActivitySection 卡（markdown 渲染），子工具在左竖线缩进列表里
 * 一行一条（无图标，zcode AgentChildToolList 口径）。
 */
function SubagentTranscript({ entry }: { entry: SubagentEntry }) {
  if (entry.blocks.length === 0) {
    return (
      <p className="py-1 text-ui-sm text-muted-foreground/60">
        {entry.endedAt ? "该子智能体没有产出可显示的内容" : "正在执行…"}
      </p>
    );
  }
  // zcode 分区：Agent thought 区 / Agent output 区 / child tools 区。
  // 思考与正文各自按到达顺序拼接（块内是流式增量，同类相邻合并）。
  const thoughtParts: string[] = [];
  const outputParts: string[] = [];
  type ToolBlock = Extract<SubagentBlock, { type: "tool" }>;
  const toolBlocks: ToolBlock[] = [];
  for (const block of entry.blocks) {
    if (block.type === "thinking") {
      thoughtParts.push(block.text);
    } else if (block.type === "text") {
      outputParts.push(block.text);
    } else if (block.type === "tool") {
      toolBlocks.push(block);
    }
  }
  return (
    <div className="space-y-3">
      {toolBlocks.length > 0 ? (
        <div className="ml-2 space-y-2 border-border border-l pl-3.5">
          {toolBlocks.map((block) => (
            <SubagentToolRowView
              key={block.tool.toolCallId}
              tool={block.tool}
            />
          ))}
        </div>
      ) : null}
      {thoughtParts.length > 0 ? (
        <AgentActivitySection
          label="Agent 思考"
          content={thoughtParts.join("\n\n")}
          workspacePath=""
        />
      ) : null}
      {outputParts.length > 0 ? (
        <AgentActivitySection
          label="Agent 输出"
          content={outputParts.join("\n\n")}
          workspacePath=""
        />
      ) : null}
      {thoughtParts.length === 0 &&
      outputParts.length === 0 &&
      toolBlocks.length === 0 ? (
        <p className="py-1 text-ui-sm text-muted-foreground/60">正在执行…</p>
      ) : null}
    </div>
  );
}

/** 子工具行（zcode 子工具：无图标，quiet 完成态，运行态流光标签）。 */
function SubagentToolRowView({ tool }: { tool: SubagentToolRow }) {
  const running = tool.status === "running";
  const duration =
    tool.startedAt !== undefined && tool.endedAt !== undefined
      ? formatElapsedSeconds(
          elapsedSecondsBetween(tool.startedAt, tool.endedAt, Date.now()),
        )
      : null;
  return (
    <div className="flex w-full items-center gap-2 text-ui-base">
      <span
        className={`shrink-0 font-medium whitespace-nowrap ${
          running ? "animated-gradient-text" : "text-foreground-subtlest"
        }`}
      >
        {tool.toolName}
      </span>
      {tool.outputSummary ? (
        <span className="min-w-0 truncate text-foreground-subtlest">
          {tool.outputSummary}
        </span>
      ) : null}
      {duration ? (
        <span className="ml-auto shrink-0 tabular-nums text-foreground-subtlest">
          {duration}
        </span>
      ) : null}
    </div>
  );
}
