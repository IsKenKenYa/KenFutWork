"use client";

import {
  Bot,
  FileText,
  ListTodo,
  Pencil,
  PenLine,
  Search,
  SquareTerminal,
} from "lucide-react";
import type { ReactNode } from "react";

import type { TaskToolEntry } from "@/lib/workbench-tools";
import { MessageResponse } from "./message-response";
import { ToolLayout } from "./tool-layout";

/**
 * zcode 工具 renderer 集（references/zcode packages/ui ToolCallBlocks/renderers
 * 照搬，数据源换成我们的 TaskToolEntry）：read 单行、edit 带 diff 计数与行内
 * diff、execute 终端面板、search/write/todo/agent。resolveToolRenderer 按
 * toolName 分流，未登记的工具走 fallback（通用展开 = 命令/入参 + 输出）。
 *
 * 状态口径与 zcode 一致：完成态安静（无状态词），运行态 kindLabel 流光
 * 「正在…」，失败态红色状态词 + title 带原因。
 */

function str(
  input: Record<string, unknown> | undefined,
  keys: string[],
): string | null {
  if (!input) return null;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0)
      return value.trim();
  }
  return null;
}

/** 文件 chip（zcode ReadFileChip 同款）：文件名 + hover 展示完整路径。 */
function FileChip({ path }: { path: string }) {
  const normalized = path.replace(/\\/g, "/");
  const fileName = normalized.split("/").filter(Boolean).pop() ?? normalized;
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground-subtle"
      title={path}
    >
      <FileText aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{fileName}</span>
    </span>
  );
}

/** edit 的 +N/-N 计数（zcode renderDiffCount 同款：绿加红减）。 */
function DiffCount({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
      <span className="text-muted-foreground/50"> </span>
      <span className="text-red-600 dark:text-red-400">-{removed}</span>
    </span>
  );
}

/** 从 edit 工具输出里抽 changeStat（服务端 execute/edit 汇总字段尽力而为）。 */
function readChangeStat(
  tool: TaskToolEntry,
): { added: number; removed: number } | null {
  const out = tool.output;
  if (!out) return null;
  const added = out.addedLines ?? out.added;
  const removed = out.removedLines ?? out.removed;
  if (typeof added === "number" && typeof removed === "number") {
    return { added, removed };
  }
  return null;
}

/** 通用输出块（fallback 展开体）：summary 文本或输出 JSON（zcode ToolCallBody 简化）。 */
function ToolOutputBody({ tool }: { tool: TaskToolEntry }) {
  if (tool.summary) {
    const failed = tool.summary.startsWith("失败");
    return (
      <div
        className={`whitespace-pre-wrap break-words text-ui-sm ${
          failed ? "text-red-600 dark:text-red-400" : "text-foreground-subtle"
        }`}
      >
        {tool.summary}
      </div>
    );
  }
  if (tool.output && Object.keys(tool.output).length > 0) {
    return (
      <div className="max-h-60 overflow-auto rounded-xl border border-border bg-card px-4 py-3">
        <pre className="overflow-x-auto font-mono text-xs text-foreground-subtle">
          {JSON.stringify(tool.output, null, 2)}
        </pre>
      </div>
    );
  }
  return null;
}

function statusText(tool: TaskToolEntry, running: string): ReactNode {
  if (tool.status === "denied") return "被拒绝";
  const failed = tool.summary?.startsWith("失败") === true;
  if (tool.status === "completed" && failed) return "失败";
  return running;
}

/** read（含 ls/glob 的目录读取）：单行不可展开（zcode ReadToolCallBlock 同口径）。 */
function ReadBlock({ tool }: { tool: TaskToolEntry }) {
  const path = str(tool.input, ["file_path", "path", "filePath", "filename"]);
  const running = tool.status === "running";
  return (
    <ToolLayout
      toolId={tool.toolCallId}
      canToggle={false}
      icon={<Search className="size-4 shrink-0 text-foreground-subtle" />}
      kindLabel={running ? "正在读取" : "读取"}
      primaryText={path ? <FileChip path={path} /> : (tool.summary ?? null)}
      secondaryText={
        path ? path.replace(/\\/g, "/").replace(/\/[^/]+$/, "") || "/" : null
      }
      isRunning={running}
      statusLabel={
        tool.status === "completed" ? statusText(tool, "") : undefined
      }
      statusTooltip={
        tool.summary?.startsWith("失败") ? tool.summary : undefined
      }
      showFailureStatus={tool.summary?.startsWith("失败") === true}
      title={path ?? undefined}
    />
  );
}

/** edit/write：文件 chip + diff 计数；展开 = 行内输出（zcode EditToolCallBlock 口径）。 */
function EditBlock({
  tool,
  write = false,
}: {
  tool: TaskToolEntry;
  write?: boolean;
}) {
  const path = str(tool.input, ["file_path", "path", "filePath", "filename"]);
  const running = tool.status === "running";
  const changeStat = readChangeStat(tool);
  const failed = tool.summary?.startsWith("失败") === true;
  const content = (tool.output?.diff ?? tool.output?.patch) as
    | string
    | undefined;
  return (
    <ToolLayout
      toolId={tool.toolCallId}
      icon={
        write ? (
          <PenLine className="size-4 shrink-0 text-foreground-subtle" />
        ) : (
          <Pencil className="size-4 shrink-0 text-foreground-subtle" />
        )
      }
      autoOpen={!running && !failed && Boolean(content)}
      kindLabel={
        running ? (write ? "正在写入" : "正在编辑") : write ? "写入" : "编辑"
      }
      primaryText={path ? <FileChip path={path} /> : (tool.summary ?? null)}
      secondaryText={
        path ? path.replace(/\\/g, "/").replace(/\/[^/]+$/, "") || "/" : null
      }
      diffCount={changeStat ? <DiffCount {...changeStat} /> : null}
      hideDiffCountWhenOpen
      isRunning={running}
      statusLabel={statusText(tool, "")}
      statusTooltip={failed ? tool.summary : undefined}
      showFailureStatus={failed}
      title={path ?? undefined}
      content={
        content ? (
          <div className="max-h-72 overflow-auto rounded-xl border border-border bg-card px-4 py-3">
            <pre className="overflow-x-auto font-mono text-xs leading-5">
              {content}
            </pre>
          </div>
        ) : (
          <ToolOutputBody tool={tool} />
        )
      }
    />
  );
}

/** execute：终端命令行 + 输出面板（zcode ExecuteToolCallBlock 同款）。 */
function ExecuteBlock({ tool }: { tool: TaskToolEntry }) {
  const command = str(tool.input, ["command", "cmd", "script"]);
  const running = tool.status === "running";
  const failed = tool.summary?.startsWith("失败") === true;
  const outputText =
    (typeof tool.output?.output === "string" ? tool.output.output : null) ??
    (failed || tool.summary ? tool.summary : null);
  return (
    <ToolLayout
      toolId={tool.toolCallId}
      icon={
        <SquareTerminal className="size-4 shrink-0 text-foreground-subtle" />
      }
      hideSecondaryTextWhenOpen
      kindLabel={running ? "正在运行" : "终端"}
      primaryText={
        command ? <code className="truncate font-sans">{command}</code> : null
      }
      isRunning={running}
      statusLabel={statusText(tool, "")}
      statusTooltip={failed ? tool.summary : undefined}
      showFailureStatus={failed}
      title={command ?? undefined}
      content={
        <div className="mb-2 space-y-3 rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex items-start gap-2 text-ui-base text-foreground">
            <span className="shrink-0 text-foreground-subtle">$</span>
            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-sans">
              {command}
            </pre>
          </div>
          {outputText ? (
            <div className="max-h-60 overflow-auto">
              <pre className="whitespace-pre-wrap break-words font-mono text-ui-sm text-foreground-subtle">
                {outputText}
              </pre>
            </div>
          ) : (
            !running && (
              <p className="font-mono text-ui-base text-foreground-subtlest">
                （无输出）
              </p>
            )
          )}
        </div>
      }
    />
  );
}

/** search：project_search/grep/glob 单行（zcode SearchToolCallBlock 口径）。 */
function SearchBlock({ tool }: { tool: TaskToolEntry }) {
  const query = str(tool.input, ["query", "pattern", "keyword"]);
  const running = tool.status === "running";
  const failed = tool.summary?.startsWith("失败") === true;
  const matchCount =
    typeof tool.output?.matches === "number" ? tool.output.matches : null;
  return (
    <ToolLayout
      toolId={tool.toolCallId}
      canToggle={false}
      icon={<Search className="size-4 shrink-0 text-foreground-subtle" />}
      kindLabel={running ? "正在搜索" : "搜索"}
      primaryText={
        query ? (
          <span className="min-w-0 truncate text-foreground">{query}</span>
        ) : (
          (tool.summary ?? null)
        )
      }
      secondaryText={matchCount != null ? `${matchCount} 处匹配` : null}
      isRunning={running}
      statusLabel={statusText(tool, "")}
      statusTooltip={failed ? tool.summary : undefined}
      showFailureStatus={failed}
      title={query ?? undefined}
    />
  );
}

/** todo：单行（进度在独立 TodoProgressPanel，工具行不重复画）。 */
function TodoBlock({ tool }: { tool: TaskToolEntry }) {
  const running = tool.status === "running";
  return (
    <ToolLayout
      toolId={tool.toolCallId}
      canToggle={false}
      icon={<ListTodo className="size-4 shrink-0 text-foreground-subtle" />}
      kindLabel={running ? "正在更新" : "更新目标"}
      primaryText={tool.summary ?? null}
      isRunning={running}
      statusLabel={statusText(tool, "")}
    />
  );
}

/**
 * agent（子代理派发）：父对话只保留单行摘要（zcode AgentToolCallBlock 产品边界），
 * kindDetail = 子代理名，整行 summaryAction → 打开右栏子智能体线程。
 */
function AgentBlock({
  tool,
  onOpenThread,
}: {
  tool: TaskToolEntry;
  onOpenThread?: (() => void) | undefined;
}) {
  const agentType = str(tool.input, ["subagent_type"]);
  const description = str(tool.input, ["description"]);
  const running = tool.status === "running";
  const failed = tool.summary?.startsWith("失败") === true;
  return (
    <ToolLayout
      toolId={tool.toolCallId}
      canToggle={false}
      icon={<Bot className="size-4 shrink-0 text-foreground-subtle" />}
      kindLabel="子智能体"
      kindDetail={
        agentType ? (
          <span
            className="inline-flex max-w-36 items-center truncate font-mono text-ui-base font-medium leading-[1.5] text-foreground-subtle"
            title={agentType}
          >
            {agentType}
          </span>
        ) : null
      }
      separator="·"
      primaryText={
        description ? <span className="truncate">{description}</span> : null
      }
      isRunning={running}
      statusLabel={statusText(tool, "运行中")}
      statusTooltip={failed ? tool.summary : undefined}
      showFailureStatus={failed}
      title={description ?? agentType ?? undefined}
      summaryAction={
        onOpenThread
          ? { ariaLabel: "在右侧查看子智能体", onActivate: onOpenThread }
          : undefined
      }
    />
  );
}

/** 未登记工具的 fallback：标签 + 单行摘要，展开看输出。 */
function FallbackBlock({
  tool,
  label,
}: {
  tool: TaskToolEntry;
  label: string;
}) {
  const running = tool.status === "running";
  const failed = tool.summary?.startsWith("失败") === true;
  const hasOutput = Boolean(tool.output && Object.keys(tool.output).length > 0);
  return (
    <ToolLayout
      toolId={tool.toolCallId}
      icon={<FileText className="size-4 shrink-0 text-foreground-subtle" />}
      canToggle={hasOutput || Boolean(tool.summary)}
      kindLabel={label}
      primaryText={
        tool.summary ? <span className="truncate">{tool.summary}</span> : null
      }
      isRunning={running}
      statusLabel={statusText(tool, "")}
      statusTooltip={failed ? tool.summary : undefined}
      showFailureStatus={failed}
      content={<ToolOutputBody tool={tool} />}
    />
  );
}

export function resolveToolRenderer(
  tool: TaskToolEntry,
  label: string,
  onOpenAgentThread?: () => void,
): ReactNode {
  switch (tool.toolName) {
    case "read_file":
    case "ls":
    case "glob":
      return <ReadBlock tool={tool} />;
    case "edit_file":
      return <EditBlock tool={tool} />;
    case "write_file":
      return <EditBlock tool={tool} write />;
    case "execute":
    case "execute_background":
      return <ExecuteBlock tool={tool} />;
    case "grep":
    case "project_search":
    case "web_search":
      return <SearchBlock tool={tool} />;
    case "write_todos":
      return <TodoBlock tool={tool} />;
    case "subagent_task":
    case "subagent_background":
      return <AgentBlock tool={tool} onOpenThread={onOpenAgentThread} />;
    default:
      return <FallbackBlock tool={tool} label={label} />;
  }
}

/** zcode AgentPromptSection 同款：派发说明卡片（右栏线程头部用）。 */
export function AgentPromptSection({ prompt }: { prompt: string }) {
  return (
    <section className="space-y-2">
      <div className="flex flex-col rounded-lg border border-border bg-background/40">
        <h4 className="p-3 text-ui-base font-medium uppercase tracking-wide text-foreground-subtlest">
          任务说明
        </h4>
        <div className="max-h-64 overflow-auto">
          <MessageResponse
            text={prompt}
            className="min-w-0 break-words px-3 py-2 text-ui-base [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          />
        </div>
      </div>
    </section>
  );
}

/** zcode AgentActivitySection 同款：Agent 思考/输出区（右栏线程用）。 */
export function AgentActivitySection({
  label,
  content,
}: {
  label: string;
  content: string;
}) {
  return (
    <section className="space-y-2">
      <div className="flex flex-col rounded-lg border border-border bg-background/40">
        <h4 className="p-3 text-ui-base font-medium uppercase tracking-wide text-foreground-subtlest">
          {label}
        </h4>
        <div className="max-h-64 overflow-auto">
          <MessageResponse
            text={content}
            className="min-w-0 break-words px-3 py-2 text-ui-base [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          />
        </div>
      </div>
    </section>
  );
}
