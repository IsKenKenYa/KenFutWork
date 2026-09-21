"use client";

import type {
  CheckpointSummary,
  ContentBlock,
  ExecutionMode,
  ProjectSummary,
} from "@kenfutwork/shared";
import {
  Blocks,
  Brain,
  Code2,
  Folder,
  FolderOpen,
  FolderPlus,
  Layers,
  Loader2,
  MessageSquare,
  Mic,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelsTopLeft,
  Plus,
  Send,
  Server,
  ShieldAlert,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChatContextMenu,
  useChatContextMenu,
} from "@/components/chat/chat-context-menu";
import {
  ComposerContextMenu,
  useComposerContextMenu,
} from "@/components/chat/composer-context-menu";
import { MarkdownRenderer } from "@/components/chat/markdown-renderer";
import { RunStopButton } from "@/components/chat/run-stop-button";
import { KenFutWorkLogo } from "@/components/icons/kenfutwork-logo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CheckpointChip } from "@/components/workbench/checkpoint-chip";
import {
  ComposerCompactSelect,
  THINKING_OPTIONS,
  THINKING_PROGRESS,
  TIER_OPTIONS,
  thinkingPromptHint,
  tierIcon,
} from "@/components/workbench/composer-compact-select";
import { ContextUsageButton } from "@/components/workbench/context-usage-button";
import { ElapsedEntry } from "@/components/workbench/elapsed-entry";
import { GitBranchSelect } from "@/components/workbench/git-branch-select";
import { McpModal } from "@/components/workbench/mcp-modal";
import { formatElementReference } from "@/components/workbench/panel-browser-view";
import { PluginMarketModal } from "@/components/workbench/plugin-market-modal";
import {
  SettingsModal,
  type SettingsTab,
} from "@/components/workbench/settings-modal";
import { SidebarRow } from "@/components/workbench/sidebar-row";
import { SkillsModal } from "@/components/workbench/skills-modal";
import { SubagentDirectoryView } from "@/components/workbench/subagent-directory-view";
import { TodoProgressPanel } from "@/components/workbench/todo-progress-panel";
import {
  ToolEventDetail,
  toolStatusMeta,
} from "@/components/workbench/tool-event";
import { toolIcon } from "@/components/workbench/tool-icons";
import { TrajectoryView } from "@/components/workbench/trajectory-view";
import { UserMenu, type WorkbenchUser } from "@/components/workbench/user-menu";
import { WorkDirectorySelect } from "@/components/workbench/work-directory-select";
import { WorkbenchSidePanel } from "@/components/workbench/workbench-side-panel";
import { useWebSocket } from "@/hooks/use-websocket";
import { useAuth } from "@/lib/auth-context";
import { onBrowserOpen } from "@/lib/browser-panel";
import { pickCheckpointForRun } from "@/lib/checkpoint-select";
import { fetchCheckpoints } from "@/lib/code-checkpoints-api";
import { commitGitAll } from "@/lib/code-git-api";
import {
  loadCodeWorkDir,
  reconcileCodeWorkDir,
  saveCodeWorkDir,
} from "@/lib/code-work-dir-preference";
import {
  contextUsageModelMeta,
  formatTokens,
  type RunUsageSnapshot,
  usageFromEvent,
} from "@/lib/context-usage";
import { resolveDesignAutoCanvas } from "@/lib/design-auto-canvas";
import { installDesktopExternalLinks } from "@/lib/desktop-system";
import { formatElapsedSeconds, parseTimestampMs } from "@/lib/elapsed";
import { getServerBaseUrl } from "@/lib/env";
import { executionModeOptions } from "@/lib/execution-modes";
import {
  MAX_SIDEBAR_WIDTH,
  MIN_CONVERSATION_WIDTH,
  MIN_SIDEBAR_WIDTH,
  panelWidthLimits,
  SIDEBAR_RAIL_WIDTH,
} from "@/lib/panel-layout";
import { PluginIcon, PluginPanelButtons } from "@/lib/plugin-panels";
import { dropPartialAssistantTail } from "@/lib/run-events";
import {
  ACK_POLL_MS,
  ACK_TIMEOUT_MS,
  decideAckTimeout,
  describeRunFailure,
} from "@/lib/run-failure";
import {
  createProject,
  deleteProject,
  fetchDirectoryPickerStatus,
  fetchMessages,
  fetchProjects,
  fetchViewer,
  fetchWorkspaceSettings,
  pickDirectory,
  updateProject,
} from "@/lib/server-api";
import {
  expandCommand,
  shouldSuggestCommands,
  type WorkspaceCommand,
} from "@/lib/slash-commands";
import {
  closeAllSubagents,
  type SubagentEntry,
} from "@/lib/subagent-directory";
import { createTaskSaver } from "@/lib/task-saver";
import type { TodoItem } from "@/lib/todo-progress";
import {
  deriveTurnProcesses,
  specCoveringIndex,
  type TurnProcessSpec,
} from "@/lib/turn-process";
import { formatTaskRelativeTime } from "@/lib/ui-format";
import {
  boundWorkDirPromptHint,
  folderPickerHint,
  resolveWorkDirProject,
  workDirectoryPromptHint,
  workDirNameFromPath,
  pickWorkDirectory as workDirPick,
} from "@/lib/work-directory";
import {
  resolveWorkbenchSurface,
  type WorkbenchMode,
} from "@/lib/workbench-surface";
import {
  previewGroup,
  resolveTaskIndicator,
  SESSION_PREVIEW_LIMIT,
} from "@/lib/workbench-task-list";
import {
  appendAssistantDelta,
  appendThinkingDelta,
  applyTaskToolEvent,
  groupAssistantBlocks,
  messagesBaseForResume,
  nextAssistantStartMs,
  rebuildAssistantBlocks,
  settleAssistantElapsed,
  settlePreviousAssistant,
  type TaskMessage,
  type TaskToolEntry,
  toolDisplayLabel,
  toolTargetParts,
} from "@/lib/workbench-tools";
import { buildTrajectory } from "@/lib/workbench-trajectory";

/**
 * Agent 工作台（产品主入口）：Code / Design 双模式（DEC-2）。
 * 模式切换、插件市场、任务列表与个人中心全部内聚在左侧栏（TRAE 式），
 * 设置与插件市场为居中模态；design 模式的画布经项目面板自动打开（KenFutWork
 * 仅作为 design 模式及其依赖能力的承载）。
 */

/** 压缩阈值来源 → 人话（阈值怎么来的要能一眼看懂，否则「为什么这么早就压了」无从判断）。 */
const COMPACT_SOURCE_LABELS: Record<
  "reserved-output" | "fraction" | "fallback",
  string
> = {
  "reserved-output": "窗口 − 预留输出",
  fraction: "窗口的 85%",
  fallback: "框架回退值",
};

type WorkbenchModelOption = {
  id: string;
  name: string;
  providerName?: string | undefined;
  vision?: boolean | undefined;
  contextWindow?: number | undefined;
  /** 单次最大输出（供应商实例声明）；上下文条「预留输出」段的来源。 */
  maxOutputTokens?: number | undefined;
};

interface WorkbenchTask {
  id: string; // conversationId
  sessionId: string;
  title: string;
  mode: WorkbenchMode;
  createdAt: number;
  messages: TaskMessage[];
  status: "running" | "completed" | "failed";
  /** 所属项目（projects 实体 id）；null = 未分组 */
  projectId?: string | null;
  /** 归档后不显示在项目分组中，仅出现在「已归档」区 */
  archived?: boolean;
  /**
   * 最近一轮 run 的起止（ISO，来自 run.started / 终态事件；R1-1 工作时间）
   */
  runStartedAt?: string | undefined;
  runEndedAt?: string | undefined;
  /** 子代理运行条目（R1-3：由 task/video_generate 工具事件推导） */
  subagents?: SubagentEntry[];
  /** agent 自己维护的待办表（R1-2：由 write_todos 工具事件推导） */
  todos?: TodoItem[];
  /**
   * 已按服务端 contentBlocks 真序重建过消息块的时刻（ISO）。
   *
   * v0 桌面包把一轮对话只存成「整段文本 + 任务级 tools（尾部 10 条）」，本地无时序，
   * 迁移只能把工具堆在消息尾部（2026-09-20 用户三次反馈）。服务端从第一版起就按事件
   * 顺序持久化 contentBlocks，启动后按 sessionId 拉回来重建一次并打这个戳——
   * 没有这个戳的旧任务下次启动还会再试（服务端当时不在线是常态）。
   */
  serverBlocksSyncedAt?: string | undefined;
  /** 本轮用量快照（R4-1：服务端 run.usage 事件，上下文容量/缓存命中浮层的数据源） */
  usage?: RunUsageSnapshot;
  /**
   * 本轮发生过上下文自动压缩（R4-1 输出预留线的执行面）。
   *
   * 为什么要显示：压缩改的是**模型看到的上下文**，库里的转录保持完整——不给信号的话，
   * 用户只会觉得「模型突然忘了前面的事」。事件由服务端在检测到摘要消息时下发（每轮一条）。
   */
  compacted?: {
    triggerTokens: number;
    triggerSource: "reserved-output" | "fraction" | "fallback";
    keepMessages: number;
  };
  /** 用户钩子（R5-2「钩子」）：本轮跑过的钩子命令与结果（旁路，失败也不影响本轮）。 */
  hookResults?: Array<{
    event: "turn-start" | "turn-end";
    command: string;
    exitCode: number | null;
    timedOut: boolean;
    output: string;
    durationMs: number;
  }>;
  /**
   * 本轮结束的检查点（Code 模式影子 git，终态时拉取）：chip 展示这轮改了什么，
   * 并提供「查看改动 / 回滚」入口。同一对话的下一轮终态会覆盖成最新 run 的检查点。
   */
  checkpoint?: CheckpointSummary;
  /** 在途 run 的 id（run.started 时登记，终态不清）：刷新后断线重接（canvas.resume）用。 */
  activeRunId?: string;
}

/**
 * 一轮助手回复的**逐个、按时序**渲染：正文段与每一次工具调用按发生顺序交错
 * （参考 deepseek-harness 展开后的 turn：每个工具调用是独立一行；Cherry Studio
 * 的 MessagePartsRenderer 同样逐行展示「编辑文件 xxx / 终端 … / 查阅 · N 搜 N 文件」）。
 *
 * 历史事故①：工具轨迹曾以 `task.tools` 挂在任务上、全部渲染在对话最底部——
 * 看不出每次调用属于哪轮对话、发生在哪段正文前后，跨轮任务还被 10 条上限截断
 * （2026-09-20 反馈）。
 * 历史事故②（同日二次反馈）：修好归属后又把连续调用收进「工具调用 × N」折叠组，
 * 用户「还是看不到详细的工具调用记录」——要的是**逐个展示、按时间顺序**，
 * 不能聚成一团。所以这里不做任何聚合：一次调用一行，行本身永远可见，
 * 只有行内的输出详情才默认折叠（点行展开）。
 *
 */
function AssistantTurn({
  msg,
  streaming = false,
  onInspectTool,
}: {
  msg: TaskMessage;
  /** 该消息是否仍在流式（任务运行中的最后一条）：思考行的「思考中」态用它。 */
  streaming?: boolean;
  /** 「查看轨迹」：切到轨迹页签并聚焦这次调用（dsh 的 Inspect 交叉跳转）。 */
  onInspectTool?: (toolCallId: string) => void;
}) {
  // 无 blocks 的消息（纯文本）就地归一化成单文本块——只有一条渲染路径，没有旧版分支
  const groups = useMemo(() => {
    const blocks =
      msg.blocks ??
      (msg.text ? [{ type: "text" as const, text: msg.text }] : []);
    // 纯空白文本段（模型在工具调用前后吐的换行）渲染成空泡泡纯属噪音
    return groupAssistantBlocks(blocks).filter(
      (g) => g.kind !== "text" || g.text.trim().length > 0,
    );
  }, [msg.blocks, msg.text]);
  return (
    <div className="flex w-full max-w-full flex-col items-start gap-2.5">
      {groups.map((group, gi) => {
        if (group.kind === "text") {
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 组序即时序，块内没有更稳定的身份
              key={gi}
              className="w-full max-w-full"
            >
              <MarkdownRenderer text={group.text} />
            </div>
          );
        }
        if (group.kind === "reasoning") {
          return (
            <ReasoningRow
              // biome-ignore lint/suspicious/noArrayIndexKey: 组序即时序，块内没有更稳定的身份
              key={gi}
              text={group.text}
              streaming={streaming && gi === groups.length - 1}
            />
          );
        }
        // 连续工具调用：一行一个，按发生顺序排。刻意**不**做「N 次工具调用」聚合折叠——
        // 聚在一起就又回到「看不出谁是谁、哪次在哪」的老问题。
        return group.tools.map((tool) => (
          <WorkbenchToolRow
            key={tool.toolCallId}
            tool={tool}
            {...(onInspectTool ? { onInspect: onInspectTool } : {})}
          />
        ));
      })}
    </div>
  );
}

/**
 * 对话里的工具调用行：**一次调用一行、永远可见**，视觉口径对齐 ZCode——
 * **无边框卡片**的扁平行（图标 + 动词 + 文件名/路径 或 命令 + 状态），行宽由内容
 * 决定（self-start），点整行展开详情（入参 + 输出，与轨迹视图同一份展开体）。
 *
 * 行永远可见是用户口径：「要按照时间顺序逐个展示，不能聚在一起」（2026-09-20）。
 * 外层圆角卡片是 2026-09-21 用户点名去掉的：「根本没必要有外面那一层圆角矩形」。
 * 成功态不渲染状态文字（ZCode 同款：安静）；只有运行中/失败/被拒才占行尾。
 * 「轨迹」跳转按钮与展开 chevron 都 hover 才显现。
 */
function WorkbenchToolRow({
  tool,
  onInspect,
}: {
  tool: TaskToolEntry;
  /** 「轨迹」小按钮：切到轨迹账本并聚焦这次调用（dsh 的 Inspect 交叉跳转）。 */
  onInspect?: (toolCallId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail =
    Boolean(tool.output) || Boolean(tool.summary) || Boolean(tool.input);
  const meta = toolStatusMeta(tool);
  const Icon = toolIcon(tool);
  const target = toolTargetParts(tool);
  /** 被拒/失败原因进 title（不点开也能看到为什么）。 */
  const failReason =
    tool.status === "denied"
      ? ((tool.output?.reason as string | undefined) ??
        tool.summary ??
        "被工具门拦下")
      : meta.failed
        ? (tool.summary ?? "执行失败")
        : null;
  return (
    <div className="group/tool-row w-full max-w-full">
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={!hasDetail}
          aria-expanded={hasDetail ? expanded : undefined}
          onClick={() => hasDetail && setExpanded((v) => !v)}
          className={`inline-flex min-w-0 max-w-full items-center gap-2 self-start py-0.5 text-left text-xs ${
            hasDetail ? "cursor-pointer" : "cursor-default"
          }`}
        >
          <Icon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground/60"
          />
          <span
            className={`shrink-0 font-medium ${
              meta.failed
                ? "text-red-600 dark:text-red-400"
                : "text-muted-foreground"
            }`}
            title={tool.toolName}
          >
            {toolDisplayLabel(tool.toolName)}
          </span>
          {target ? (
            target.isCommand ? (
              <code className="min-w-0 truncate font-sans text-muted-foreground/80">
                {target.primary}
              </code>
            ) : (
              <span
                className="flex min-w-0 items-baseline gap-1.5"
                title={
                  target.rest
                    ? `${target.rest}/${target.primary}`
                    : target.primary
                }
              >
                <span className="min-w-0 truncate text-foreground">
                  {target.primary}
                </span>
                {target.rest ? (
                  <span className="hidden min-w-0 truncate text-muted-foreground/50 @max-[520px]/conversation:hidden sm:inline">
                    {target.rest}
                  </span>
                ) : null}
              </span>
            )
          ) : null}
          {tool.status === "running" ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-muted-foreground">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
              执行中…
            </span>
          ) : meta.failed ? (
            <span
              className="shrink-0 cursor-help text-red-600 underline decoration-dotted underline-offset-2 dark:text-red-400"
              title={failReason ?? undefined}
            >
              失败
            </span>
          ) : tool.status === "denied" ? (
            <span
              className="shrink-0 cursor-help text-rose-600 underline decoration-dotted underline-offset-2 dark:text-rose-400"
              title={failReason ?? undefined}
            >
              被拒绝
            </span>
          ) : (
            // 完成态的安静标记：只留一颗小绿点（ZCode 口径——成功不占文字）
            <span
              role="img"
              aria-label="已完成"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500/70"
            />
          )}
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className={`h-3 w-3 shrink-0 text-muted-foreground/50 opacity-0 transition-[opacity,transform] group-hover/tool-row:opacity-100 ${
              expanded ? "rotate-90 opacity-100" : ""
            } ${hasDetail ? "" : "invisible"}`}
            fill="currentColor"
          >
            <path d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06L7.28 11.78a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
        {onInspect ? (
          <button
            type="button"
            onClick={() => onInspect(tool.toolCallId)}
            title="在轨迹账本中查看这次调用"
            aria-label="在轨迹账本中查看这次调用"
            className="shrink-0 rounded px-1 py-0.5 text-[10px] text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground group-hover/tool-row:opacity-100"
          >
            轨迹
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div className="mb-1 ml-6 border-l-2 border-border/50 pl-3">
          <ToolEventDetail tool={tool} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * 思考行（dsh ReasoningRow 数据源 + ZCode ReasoningRow 视觉）：无卡片的一行——
 * 脑图标 + 「思考」+ 摘要（流式时跟随最新一行），chevron hover 显现；展开正文
 * 走左竖线缩进的纯文本区（不做 markdown 渲染）。思考是推理过程不是结论，
 * 永远不给它正文的视觉权重。
 */
function ReasoningRow({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const summary = (streaming ? lines[lines.length - 1] : lines[0]) ?? "";
  const clipped = summary.length > 80 ? `${summary.slice(0, 79)}…` : summary;
  return (
    <div className="w-full max-w-full">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="group/reasoning inline-flex max-w-full items-center gap-2 self-start py-0.5 text-left text-xs text-muted-foreground/60"
      >
        <Brain
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground/50"
        />
        <span
          className={`shrink-0 font-medium ${streaming ? "text-foreground/80" : ""}`}
        >
          {streaming ? "思考中" : "思考"}
        </span>
        {open ? null : (
          <span className="min-w-0 truncate font-normal">{clipped}</span>
        )}
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className={`h-3 w-3 shrink-0 opacity-0 transition-[opacity,transform] group-hover/reasoning:opacity-100 ${
            open ? "rotate-90 opacity-100" : ""
          }`}
          fill="currentColor"
        >
          <path d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06L7.28 11.78a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z" />
        </svg>
      </button>
      {open ? (
        <div className="mb-1 ml-6 max-h-60 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-border/50 pl-3 text-[11px] leading-5 text-muted-foreground">
          {text}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 轮级过程折叠控制行（dsh TurnProcessNodeView 语义 + ZCode 组行视觉）：无卡片的
 * 一行「第 N 轮 · 思考与工具 · N 个工具调用 · …」，chevron hover 显现。展开后
 * 过程逐行原位可见（不是聚成一条摘要），再点收起。
 */
function TurnProcessRow({
  spec,
  expanded,
  onToggle,
}: {
  spec: TurnProcessSpec;
  expanded: boolean;
  onToggle: () => void;
}) {
  const parts = [`${spec.toolCount} 个工具调用`];
  if (spec.reasoningCount > 0) parts.push(`${spec.reasoningCount} 段思考`);
  if (spec.foldedTextCount > 0)
    parts.push(`${spec.foldedTextCount} 段中途输出`);
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      title="展开这一轮的完整过程（推理 / 工具 / 中途输出逐行保留）"
      className="inline-flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground/60 transition-colors hover:text-foreground"
    >
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className={`h-3 w-3 shrink-0 transition-transform ${
          expanded ? "rotate-90" : ""
        }`}
        fill="currentColor"
      >
        <path d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06L7.28 11.78a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z" />
      </svg>
      <span>第 {spec.turnIndex} 轮 · 思考与工具</span>
      <span className="text-muted-foreground/70">{parts.join(" · ")}</span>
    </button>
  );
}

const MODE_META: Record<
  WorkbenchMode,
  {
    label: string;
    title: string;
    placeholder: string;
    chips: string[];
  }
> = {
  code: {
    label: "Code",
    title: "Code with KenFutWork",
    placeholder:
      "帮你编写代码、调试 Bug、优化性能等开发工作，交付生产级代码产物。",
    chips: ["应用开发", "项目理解", "游戏创意", "工具脚本"],
  },
  design: {
    label: "Design",
    title: "Design with KenFutWork",
    placeholder: "从想法到设计，生成可交付的页面原型。",
    chips: ["设计还原", "概念成稿", "规范出图"],
  },
};

const TASKS_STORAGE_KEY = "workbench-tasks";

/** 「未分组」在「显示更多」展开状态里的分组 key（项目 id 不会取到这个名字）。 */
const UNGROUPED_KEY = "__ungrouped__";

function loadTasks(mode: WorkbenchMode): WorkbenchTask[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(`${TASKS_STORAGE_KEY}:${mode}`);
    if (!raw) return [];
    // 迁移：旧数据无 projectId/archived 字段时补默认值。
    // 注意：**不**在这里把旧的 `task.tools` 拼进消息——本地没有时序信息，只能拼出
    // 「文本在前、工具全部堆尾」，正是用户三次反馈的毛病。真序重建走服务端
    // contentBlocks（见下方 serverBlocksResync 副作用），拉取失败才退化为有损迁移。
    return (JSON.parse(raw) as WorkbenchTask[]).map((t) => ({
      ...t,
      projectId: t.projectId ?? null,
      archived: t.archived ?? false,
    }));
  } catch {
    return [];
  }
}

function saveTasks(mode: WorkbenchMode, tasks: WorkbenchTask[]) {
  try {
    window.localStorage.setItem(
      `${TASKS_STORAGE_KEY}:${mode}`,
      JSON.stringify(tasks.slice(0, 100)),
    );
  } catch {
    // 存储失败不阻塞会话
  }
}

/** browser localStorage（SSR / 无 window 时给 undefined，lib 侧当 no-op）。 */
function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

export function Workbench() {
  const router = useRouter();
  const { user, session, loading, signOut } = useAuth();
  const getToken = useCallback(() => session?.access_token ?? null, [session]);
  const ws = useWebSocket(getToken);

  const [mode, setMode] = useState<WorkbenchMode>("code");
  const [tasksByMode, setTasksByMode] = useState<
    Record<WorkbenchMode, WorkbenchTask[]>
  >({ code: [], design: [] });
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  /** Design 模式的输入交给画布页（`/canvas?...&prompt=`）自动发送，不落到工作台会话视图。 */
  const [canvasPrompt, setCanvasPrompt] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState("");
  /**
   * 转录区视图（参考 deepseek-harness 的「对话 / 轨迹」双页签）：对话按发生顺序
   * 交错展示，轨迹是按轮次分组的只读账本（每次调用的时间/耗时/入参/输出一表可查）。
   */
  const [transcriptTab, setTranscriptTab] = useState<"chat" | "trajectory">(
    "chat",
  );
  // Code 模式对话区右键菜单（原生菜单在应用内浏览器不弹，用户无法复制/粘贴）
  const chatMenu = useChatContextMenu();
  const codeMessagesRef = useRef<HTMLDivElement>(null);

  /**
   * 转录列预留的滚动条走廊宽度（`scrollbar-gutter: stable` 让滚动条不挤动内容，
   * 但那条走廊只属于 scroller——标题行与输入区若不留同样一条，三块内容就对不齐
   * （实测窄列差 10px、居中时中心差 5px）。宽度与平台/缩放有关，故量一次写进 CSS 变量。
   */
  const [scrollbarLane, setScrollbarLane] = useState(0);
  /** 流事件回调在挂载期注册（deps 只有 ws/mode），自动提交的实现经 ref 取最新值。 */
  const autoCommitTurnRef = useRef<(taskId: string | null) => Promise<void>>(
    async () => {},
  );
  /** 同 autoCommitTurnRef：终态拉检查点的实现也经 ref 取最新值（闭包会陈旧）。 */
  const fetchTurnCheckpointRef = useRef<
    (taskId: string, runId: string) => Promise<void>
  >(async () => {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeTaskId 只当触发器（量的是 DOM 宽度）；换任务后滚动条出现/消失要重新量
  useEffect(() => {
    const measure = () => {
      const el = codeMessagesRef.current;
      if (!el) return;
      setScrollbarLane(el.offsetWidth - el.clientWidth);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [activeTaskId]);
  const [chatNotice, setChatNotice] = useState<string | null>(null);
  /** Code 模式输入框（右键编辑菜单需要拿它的选区）。 */
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerMenu = useComposerContextMenu({
    value: followUp,
    setValue: setFollowUp,
    textareaRef: composerRef,
    onNotice: setChatNotice,
  });
  useEffect(() => {
    if (!chatNotice) return;
    const timer = window.setTimeout(() => setChatNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [chatNotice]);
  const [tier, setTier] = useState("default");
  /** 「完全访问」的风险确认弹窗（确认后才写库与生效）。 */
  const [pendingFullAccess, setPendingFullAccess] = useState(false);
  /**
   * Code 模式的「工作目录项目」（服务端 projects, kind='code'）。
   * 「工作目录=项目」：用户选的每个工作目录就是一个项目，对话挂在它下面。
   */
  const [codeProjects, setCodeProjects] = useState<ProjectSummary[]>([]);
  const [thinking, setThinking] = useState("default");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("agent");
  const [executionModes, setExecutionModes] = useState<
    Array<{
      id: ExecutionMode;
      label: string;
      description: string;
      inputDirective?: string | undefined;
    }>
  >([]);
  const [models, setModels] = useState<WorkbenchModelOption[]>([]);
  const [model, setModel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Design 模式：项目面板（创建/列表）+ 原版画布内嵌
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  /** 画布项目列表至少取过一次（成功或失败）——自动进画布的判据之一，避免拉取途中误建画布。 */
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Code 模式：本地工作目录（File System Access API，浏览器支持时可用）
  const [workDirName, setWorkDirName] = useState<string | null>(null);
  /** 目录选择的反馈（不支持/失败）；成功或取消时清空。 */
  const [workDirNotice, setWorkDirNotice] = useState<string | null>(null);
  /**
   * 服务端能不能弹**系统文件夹对话框**（桌面形态）。null = 还没探到。
   * 探到可用时「打开文件夹」走它（拿回绝对路径，真正绑定工作目录）；
   * 不可用则回落浏览器选择器（只有目录名）。
   */
  const [nativeDirPicker, setNativeDirPicker] = useState<{
    available: boolean;
    reason?: string | undefined;
  } | null>(null);
  /**
   * 自定义斜杠命令（设置 →「命令」）：输入框里 `/名字 参数` 在**提交前**展开成提示词。
   * 存在工作区设置里、这里读一份（改完设置下次拉取生效）；展开逻辑是纯函数
   * （`lib/slash-commands.ts`），工作台只负责调用。
   */
  const [commands, setCommands] = useState<WorkspaceCommand[]>([]);
  const [creatingProject, setCreatingProject] = useState(false);
  // 侧栏底部个人中心 + 模态（设置 / 插件市场）
  const [workbenchUser, setWorkbenchUser] = useState<WorkbenchUser | null>(
    null,
  );
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  /** 平台管理员标记：仅用于「显示后台入口」，鉴权在服务端（/api/admin/*）。 */
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  const activeRunIdRef = useRef<string | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);
  activeTaskIdRef.current = activeTaskId;

  /** tasksByMode 的镜像：事件回调里要读最新任务（状态更新是异步的）。 */
  const tasksByModeRef = useRef<Record<WorkbenchMode, WorkbenchTask[]>>({
    code: [],
    design: [],
  });
  tasksByModeRef.current = tasksByMode;

  /**
   * 旧任务消息块的**服务端真序重建**（一次性，2026-09-20）。
   *
   * 病史：v0 桌面包把一轮对话只存成「整段文本 + 任务级 tools（尾部 10 条）」，localStorage
   * 里没有任何时序信息——本地迁移只能拼出 [文本, 工具…]，用户看到的就是「工具调用全部
   * 堆在消息尾部」，且跨轮工具被 10 条上限截断（三次反馈同一个现象）。服务端从第一版起
   * 就按事件顺序持久化 contentBlocks（实测 `["text","tool","text","tool",…]` 交错），
   * 这里按 sessionId 拉回来、按**全文逐字相等**匹配本地助手消息，用服务端真序重建 blocks。
   *
   * 服务端是权威：匹配上就**覆盖**本地 blocks（v1 的有损迁移已经污染过存量数据，
   * 只补空缺的话污染永远冲不掉）；匹配不上的保持原样。消息文本绝不动——追问历史、
   * 复制、标题消费的是 text。拉取失败不打戳，下次启动再试（宁可看不到，也不要把
   * 工具按错位置钉在消息尾部）。
   */
  useEffect(() => {
    if (!session?.access_token) return;
    const token = session.access_token;
    let cancelled = false;
    void (async () => {
      for (const m of ["code", "design"] as const) {
        if (cancelled) return;
        const pending = tasksByModeRef.current[m].filter(
          (t) => t.status !== "running" && !t.serverBlocksSyncedAt,
        );
        if (pending.length === 0) continue;
        // 同一 sessionId 的任务共享一次拉取（每个任务自成会话）
        const bySession = new Map<string, string[]>();
        for (const t of pending) {
          bySession.set(t.sessionId, [
            ...(bySession.get(t.sessionId) ?? []),
            t.id,
          ]);
        }
        const serverBySession = new Map<
          string,
          Array<{ text: string; blocks: ContentBlock[] }>
        >();
        for (const sessionId of bySession.keys()) {
          try {
            const res = await fetchMessages(token, sessionId);
            serverBySession.set(
              sessionId,
              (res.messages ?? [])
                .filter(
                  (msg) =>
                    msg.role === "assistant" &&
                    (msg.contentBlocks?.length ?? 0) > 0,
                )
                .map((msg) => ({
                  text: msg.content,
                  blocks: msg.contentBlocks ?? [],
                })),
            );
          } catch {
            // 拉取失败：不打戳，下次启动再试（离线启动是常态）
          }
        }
        if (cancelled) return;
        const syncedAt = new Date().toISOString();
        setTasksByMode((prev) => {
          const list = prev[m].map((t) => {
            if (t.status === "running" || t.serverBlocksSyncedAt) return t;
            const server = serverBySession.get(t.sessionId);
            if (!server) return t; // 没拉到：原样保持，等下次
            // 按顺序贪心匹配：本地消息全文 == 服务端该轮文本块的拼接
            const cursor = { i: 0 };
            let changed = false;
            const messages = t.messages.map((msg) => {
              if (msg.role !== "assistant") return msg;
              const hitIdx = server.findIndex(
                (s, idx) => idx >= cursor.i && s.text === msg.text,
              );
              if (hitIdx < 0) return msg;
              cursor.i = hitIdx + 1;
              const hit = server[hitIdx];
              if (!hit) return msg;
              const blocks = rebuildAssistantBlocks(hit.blocks);
              if (blocks.length === 0) return msg;
              changed = true;
              // 从块里恢复 runId 归属（服务端 2026-09-21 存储改造后才有；
              // 旧数据没有就不伪造，折叠/轨迹对该轮退化为按用户消息分轮）
              const blockRunId = blocks.find(
                (b) => b.type === "tool" && b.tool.runId,
              );
              const runId =
                blockRunId?.type === "tool" ? blockRunId.tool.runId : undefined;
              return { ...msg, blocks, ...(runId ? { runId } : {}) };
            });
            if (!changed) return t;
            return { ...t, messages, serverBlocksSyncedAt: syncedAt };
          });
          if (list.every((t, i) => t === prev[m][i])) return prev;
          saveTasks(m, list);
          return { ...prev, [m]: list };
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.access_token]);

  const tasks = tasksByMode[mode];
  /**
   * 当前选中的项目：Code 模式在「工作目录项目」（kind='code'）里找，Design 在画布
   * 项目（kind='design'）里找。两类项目在服务端就分开了，故同一 selectedProjectId
   * 不会跨模式误命中。
   */
  const selectedProject =
    (mode === "code" ? codeProjects : projects).find(
      (p) => p.id === selectedProjectId,
    ) ?? null;

  const activeTask = useMemo(
    () => tasks.find((t) => t.id === activeTaskId) ?? null,
    [tasks, activeTaskId],
  );

  /**
   * 展示用的任务：旧数据（任务级 `tools`、无消息块）在此做**渲染兜底**迁移——
   * 工具挂进最后一条助手消息，至少看得到用过什么。真序仍以服务端重建为准
   * （serverBlocksSyncedAt 之后 blocks 已带工具块，迁移会自动让位，见 lib 实现）。
   * 刻意不落回存储：没有时序的顺序正是要淘汰的形态。
   */
  /** 轨迹账本（对话/轨迹双页签的「轨迹」侧）：按轮次分组、行序即时序。 */
  const trajectoryModel = useMemo(
    () => buildTrajectory(activeTask?.messages ?? []),
    [activeTask],
  );

  /** 从对话流工具行「查看轨迹」跳来的聚焦目标（轨迹页签滚动定位用）。 */
  const [trajectoryFocus, setTrajectoryFocus] = useState<string | null>(null);

  /**
   * 轮级过程折叠（deepseek-harness Turn Process Folding 同款）：跑完且产出了结论的
   * 轮，把结论之前的推理/工具/中途正文收进一行可展开的控制行。运行中不折叠，
   * 展开后过程逐行原位可见——不是「N 次调用」式的有损聚合（用户此前反对的是
   * 聚掉细节；dsh 折叠正是「默认收起、展开即全量」的过程披露）。
   */
  const turnProcesses = useMemo(
    () =>
      deriveTurnProcesses(
        activeTask?.messages ?? [],
        activeTask ? activeTask.status !== "running" : true,
      ),
    [activeTask],
  );
  /** 手动展开的折叠轮（会话级 state，不持久化——dsh 同款取舍）。 */
  const [expandedTurnProcesses, setExpandedTurnProcesses] = useState<
    ReadonlySet<string>
  >(new Set());

  /**
   * 选中模型的容量元数据（窗口 / 最大输出），两处编排器共用一份。
   *
   * 此前它们各写各的 `models.find(...)`，**带真实用量的那个漏传 `maxOutputTokens`**——
   * 上下文浮层「预留输出 / 剩余」两段与阈值刻度因此任何模式下都不出现（真机实测才发现）。
   */
  const modelMeta = useMemo(
    () => contextUsageModelMeta(models, model),
    [models, model],
  );

  /**
   * 对话视图里工作目录/分支该显示哪个项目：**以对话自己绑定的项目为准**
   * （run 的作用域就是它的主画布）。只认页面的 `selectedProjectId` 会让打开历史
   * 对话时两个 chip 消失/显示成别的工作目录——用户反馈「对话开始之后不显示」。
   */
  const conversationProject =
    mode === "code" && activeTask?.projectId
      ? (codeProjects.find((p) => p.id === activeTask.projectId) ?? null)
      : null;

  /** 最近一次「本轮自动提交」的时间戳（仅用于给用户一个可见回执 + 刷新分支 chip）。 */
  const [lastAutoCommitAt, setLastAutoCommitAt] = useState<string | null>(null);

  /**
   * 右栏停靠面板（R3-1）：编辑器式多标签（变更 / 文件目录 / 终端 / 浏览器 / 子智能体，
   * 以及逐个文件的「审查」「打开」）。标签的开关与顺序在面板内部（见 lib/panel-tabs），
   * 工作台只管开合——链接点击那一条经 `onRequestOpen` 把面板叫开。
   */
  /** 左侧栏宽度（可拖拽，持久化：与右栏面板同样，宽度是用户偏好）。 */
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === "undefined") return 256;
    const saved = Number(
      window.localStorage.getItem("workbench:sidebar-width"),
    );
    return Number.isFinite(saved) &&
      saved >= MIN_SIDEBAR_WIDTH &&
      saved <= MAX_SIDEBAR_WIDTH
      ? saved
      : 256;
  });

  const startSidebarResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      const clamp = (next: number) =>
        Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, next));
      const onMove = (moveEvent: MouseEvent) => {
        setSidebarWidth(clamp(startWidth + (moveEvent.clientX - startX)));
      };
      const onUp = (upEvent: MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.localStorage.setItem(
          "workbench:sidebar-width",
          String(clamp(startWidth + (upEvent.clientX - startX))),
        );
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sidebarWidth],
  );

  /**
   * 视口宽度（面板上限要按它现算：视口 − 左栏 − 对话列最小宽度）。
   * 窗口尺寸变化时重算，面板会被收回到新上限内（见 lib/panel-layout）。
   */
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const panelLimits = useMemo(
    () => panelWidthLimits({ windowWidth, sidebarWidth, sidebarCollapsed }),
    [windowWidth, sidebarWidth, sidebarCollapsed],
  );

  const [panelOpen, setPanelOpen] = useState(false);

  /**
   * 转录里点链接 → 自动打开右栏「浏览器」标签（用户口径：点对话里的 URL 就在右边打开）。
   * 面板自己订阅了同一个通道（它常驻挂载，标签状态在里面）；这里只在它收着时把它叫开。
   */
  useEffect(
    () =>
      onBrowserOpen(() => {
        setPanelOpen(true);
      }),
    [],
  );

  /** 侧栏里被收起的工作目录项目 id（默认全展开；持久化到 localStorage）。 */
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);

  /**
   * 侧栏里「显示更多」展开过的分组（项目 id / 未分组用常量 key；持久化）。
   * 一个工作目录下几十条对话时，默认只露前 `SESSION_PREVIEW_LIMIT` 条。
   */
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);

  /**
   * 已结束但用户还没打开过的对话 id（侧栏图标显示实心气泡）。
   * 跑完的那一刻若不在当前会话，就标记未读；打开即清（见下面的 effect）。
   */
  const [unreadTaskIds, setUnreadTaskIds] = useState<string[]>([]);

  /**
   * 本页确实在跑的那条会话（侧栏转圈只认它）。
   * 不能拿任务数据里的 `status === "running"` 当判据：那是「起过表、还没收到终态」，
   * 进程重启/关页会留下永远转圈的陈旧记录（实测侧栏一排假转圈）。
   */
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);

  /** 主区判定：Design 模式恒为画布（不变量集中在 resolveWorkbenchSurface 与它的测试里）。 */
  const surface = resolveWorkbenchSurface({
    hasActiveTask: activeTask !== null,
    hasSelectedProject: selectedProject !== null,
    mode,
  });

  // 鉴权守卫
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  // 任务列表载入 + 思考强度偏好
  useEffect(() => {
    setTasksByMode({
      code: loadTasks("code"),
      design: loadTasks("design"),
    });
    try {
      const rawCollapsed = window.localStorage.getItem(
        "workbench:collapsed-projects",
      );
      setCollapsedProjects(
        rawCollapsed ? (JSON.parse(rawCollapsed) as string[]) : [],
      );
    } catch {
      setCollapsedProjects([]);
    }
    try {
      setThinking(
        window.localStorage.getItem("workbench:thinking") ?? "default",
      );
    } catch {
      // 存储不可用时用默认档
    }
    try {
      // 上次选的模型；目录拉回后再校验是否仍存在（见下面的 setModel 回调）
      setModel(window.localStorage.getItem("workbench:model") ?? "");
    } catch {
      // 存储不可用：由目录第一条兜底
    }
    try {
      const rawExpanded = window.localStorage.getItem(
        "workbench:expanded-groups",
      );
      setExpandedGroups(
        rawExpanded ? (JSON.parse(rawExpanded) as string[]) : [],
      );
    } catch {
      setExpandedGroups([]);
    }
  }, []);

  // 未读数按模式各存一份（切模式不该把另一边清空）
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`workbench-unread:${mode}`);
      setUnreadTaskIds(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      setUnreadTaskIds([]);
    }
  }, [mode]);

  /** 未读标记的读写：写 localStorage 与 state 一起（打开会话即清）。 */
  const setTaskUnread = useCallback(
    (taskId: string, unread: boolean) => {
      setUnreadTaskIds((prev) => {
        const already = prev.includes(taskId);
        if (already === unread) return prev;
        const next = unread
          ? [...prev, taskId]
          : prev.filter((id) => id !== taskId);
        try {
          window.localStorage.setItem(
            `workbench-unread:${mode}`,
            JSON.stringify(next),
          );
        } catch {
          // 存储失败不影响本次会话内的标记
        }
        return next;
      });
    },
    [mode],
  );

  // 打开（或新建）会话即视为已读
  useEffect(() => {
    if (activeTaskId) setTaskUnread(activeTaskId, false);
  }, [activeTaskId, setTaskUnread]);

  /** 「显示更多 / 收起」：按分组切换并持久化（分组 key = 项目 id / 未分组常量）。 */
  const toggleGroupExpanded = useCallback((groupKey: string) => {
    setExpandedGroups((prev) => {
      const next = prev.includes(groupKey)
        ? prev.filter((key) => key !== groupKey)
        : [...prev, groupKey];
      try {
        window.localStorage.setItem(
          "workbench:expanded-groups",
          JSON.stringify(next),
        );
      } catch {
        // 存储失败不影响使用
      }
      return next;
    });
  }, []);

  /** run → 所属会话的映射（放在 ref 里供挂载期注册的事件回调读）。 */
  const runTaskIdRef = useRef<string | null>(null);
  /** 事件回调的 deps 只有 ws/mode，未读标记经 ref 读最新实现。 */
  const setTaskUnreadRef = useRef(setTaskUnread);
  setTaskUnreadRef.current = setTaskUnread;

  const handleThinkingChange = useCallback((next: string) => {
    setThinking(next);
    try {
      window.localStorage.setItem("workbench:thinking", next);
    } catch {
      // 存储失败不阻塞
    }
  }, []);

  // 个人中心用户信息（真实 viewer）
  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    fetchViewer(token)
      .then((viewer) =>
        setWorkbenchUser({
          displayName: viewer.profile.displayName,
          email: viewer.profile.email,
          avatarUrl: viewer.profile.avatarUrl ?? null,
        }),
      )
      .catch(() => {});
  }, [session]);

  const refreshProjects = useCallback(() => {
    const token = session?.access_token;
    if (!token) return;
    // 两类项目各取一份：design=画布项目，code=工作目录项目（「工作目录=项目」）。
    // 都在服务端一处持有，客户端不再另造 localStorage 项目（那是两套真相的来源）。
    fetchProjects(token, "design")
      .then((data) => {
        setProjects(data.projects);
        setProjectsLoaded(true);
      })
      .catch(() => {
        // 拉取失败也标记「已尝试」：否则 Design 模式会永远停在编排器；
        // 自动建画布只试一次，失败后由用户从侧栏手动新建。
        setProjectsLoaded(true);
      });
    fetchProjects(token, "code")
      .then((data) => setCodeProjects(data.projects))
      .catch(() => {});
  }, [session]);

  // 项目列表（两个模式各自一份 kind）
  useEffect(() => {
    if (session?.access_token) refreshProjects();
  }, [session, refreshProjects]);

  /**
   * 恢复上次选中的工作目录（只做一次）。
   *
   * 不恢复的后果不是「少点一下」：Code 模式的 run 作用域取「选中项目的主画布」，
   * 没选中时服务端懒供给隐藏 code 项目——**文件会落进 `tmp/sandbox/<canvasId>`
   * 而不是用户配的目录**，界面上完全看不出来（2026-09-20 真机走实测）。
   * 项目列表拿到之后再对账：项目被删了就只留名字，交给 startTask 的「按目录名补建」。
   */
  const workDirRestoredRef = useRef(false);
  useEffect(() => {
    if (workDirRestoredRef.current) return;
    if (codeProjects.length === 0) return;
    const saved = loadCodeWorkDir(browserStorage());
    if (!saved) {
      workDirRestoredRef.current = true;
      return;
    }
    const reconciled = reconcileCodeWorkDir(saved, codeProjects);
    setSelectedProjectId(reconciled.projectId);
    setWorkDirName(reconciled.name);
    workDirRestoredRef.current = true;
  }, [codeProjects]);

  /**
   * 探测服务端的原生目录对话框能力（桌面形态才有）。
   *
   * 只探一次：形态在进程生命周期里不会变。探测失败按「不可用」处理——回落浏览器
   * 选择器仍是一条能用的路，不必为探测失败弹错。
   */
  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    fetchDirectoryPickerStatus(token)
      .then((status) => setNativeDirPicker(status))
      .catch(() => setNativeDirPicker({ available: false }));
  }, [session]);

  /**
   * 桌面形态接管 `target="_blank"` 外链：WKWebView 开不了新窗口，点过去毫无反应——
   * 交给系统浏览器（`lib/desktop-system.ts`）。函数自身幂等，重复挂载安全。
   */
  useEffect(() => {
    installDesktopExternalLinks();
  }, []);

  // 自定义命令（需 token）：只在登录后拉一次，失败不阻断（没有命令就只是不展开）
  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    fetchWorkspaceSettings(token)
      .then((data) => setCommands(data.settings.commands))
      .catch(() => {});
  }, [session]);

  // 执行模式词汇表（需 token）
  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    fetch(`${getServerBaseUrl()}/api/execution-modes`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : { modes: [] }))
      .then(
        (data: {
          modes: Array<{
            id: ExecutionMode;
            label: string;
            description: string;
            inputDirective?: string | undefined;
          }>;
        }) => setExecutionModes(data.modes),
      )
      .catch(() => {});
  }, [session]);

  // 平台管理员标记（FORM-10）：决定是否显示「管理后台」入口，鉴权在服务端
  useEffect(() => {
    const token = session?.access_token;
    if (!token) {
      setIsPlatformAdmin(false);
      return;
    }
    let cancelled = false;
    fetch(`${getServerBaseUrl()}/api/admin/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : { isAdmin: false }))
      .then((data: { isAdmin?: boolean }) => {
        if (!cancelled) setIsPlatformAdmin(Boolean(data.isAdmin));
      })
      .catch(() => {
        if (!cancelled) setIsPlatformAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // 嵌入画布删除项目后回传：清选中并刷新列表
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as
        | { type?: string; projectId?: string }
        | null
        | undefined;
      if (data?.type === "workbench:project-created") {
        refreshProjects();
        // 画布里点「新建项目」：宿主直接把选中切到新项目（画布区随之打开新画布）。
        // 不这样做，用户会觉得「点了没反应」；而画布那边若自行开新标签，就会被「弹走」。
        if (data.projectId) setSelectedProjectId(data.projectId);
        return;
      }
      if (data?.type !== "workbench:project-deleted") return;
      setSelectedProjectId((current) =>
        current === data.projectId ? null : current,
      );
      refreshProjects();
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [refreshProjects]);

  /** 直接以指定名称创建项目（侧栏 + 号，跳过输入框）。 */
  const createProjectNamed = useCallback(
    async (name: string): Promise<ProjectSummary | null> => {
      const token = session?.access_token;
      if (!token) return null;
      setCreatingProject(true);
      try {
        const result = await createProject(token, { name });
        setProjects((prev) => [result.project, ...prev]);
        return result.project;
      } catch {
        return null;
      } finally {
        setCreatingProject(false);
      }
    },
    [session],
  );

  /** 项目重命名（updateProject API）。 */
  const renameProject = useCallback(
    async (projectId: string, name: string) => {
      const token = session?.access_token;
      if (!token) return;
      try {
        await updateProject(token, projectId, { name });
        setProjects((prev) =>
          prev.map((p) => (p.id === projectId ? { ...p, name } : p)),
        );
      } catch {
        // 失败保留旧名
      }
    },
    [session],
  );

  /** 项目删除：调 API 并清理本地两个模式的对话记录。 */
  const removeProject = useCallback(
    async (projectId: string) => {
      const token = session?.access_token;
      if (!token) return;
      try {
        await deleteProject(token, projectId);
      } catch {
        // mock/网络失败仍继续清本地，避免幽灵项目卡住 UI
      }
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
      setSelectedProjectId((current) =>
        current === projectId ? null : current,
      );
      setTasksByMode((prev) => {
        const next: typeof prev = { code: [], design: [] };
        for (const m of ["code", "design"] as const) {
          const kept = prev[m]
            .filter((t) => t.projectId !== projectId)
            .map((t) => (t.projectId == null ? t : t));
          next[m] = kept;
          saveTasks(m, kept);
        }
        return next;
      });
      setActiveTaskId(null);
      refreshProjects();
    },
    [session, refreshProjects],
  );

  // ── 对话（task）动作：重命名 / 归档 / 删除 / 恒恢复 ──
  const renameTask = useCallback(
    (taskId: string, title: string) => {
      setTasksByMode((prev) => {
        const list = prev[mode].map((t) =>
          t.id === taskId ? { ...t, title } : t,
        );
        saveTasks(mode, list);
        return { ...prev, [mode]: list };
      });
    },
    [mode],
  );

  const setTaskArchived = useCallback(
    (taskId: string, archived: boolean) => {
      setTasksByMode((prev) => {
        const list = prev[mode].map((t) =>
          t.id === taskId ? { ...t, archived } : t,
        );
        saveTasks(mode, list);
        return { ...prev, [mode]: list };
      });
      if (archived) {
        setActiveTaskId((current) => (current === taskId ? null : current));
      }
    },
    [mode],
  );

  // ── Code 项目（工作目录项目，kind='code'，与 Design 的画布项目分开）──
  /** 建工作目录项目并选中（「工作目录=项目」）；失败返回 null 由调用方提示。 */
  const createCodeProject = useCallback(
    async (name: string): Promise<ProjectSummary | null> => {
      const token = session?.access_token;
      if (!token) return null;
      setCreatingProject(true);
      try {
        const result = await createProject(token, { kind: "code", name });
        setCodeProjects((prev) => [result.project, ...prev]);
        return result.project;
      } catch {
        return null;
      } finally {
        setCreatingProject(false);
      }
    },
    [session],
  );

  const renameCodeProject = useCallback(
    async (id: string, name: string) => {
      const token = session?.access_token;
      if (!token) return;
      try {
        await updateProject(token, id, { name });
        setCodeProjects((prev) =>
          prev.map((p) => (p.id === id ? { ...p, name } : p)),
        );
      } catch {
        // 失败保留旧名
      }
    },
    [session],
  );

  const removeCodeProject = useCallback(
    async (id: string) => {
      const token = session?.access_token;
      if (token) {
        try {
          await deleteProject(token, id);
        } catch {
          // 服务端删除失败仍继续清本地，避免幽灵项目卡住 UI
        }
      }
      setCodeProjects((prev) => prev.filter((p) => p.id !== id));
      setSelectedProjectId((current) => (current === id ? null : current));
      // 其下对话转为未分组
      setTasksByMode((prev) => {
        const list = prev.code.map((t) =>
          t.projectId === id ? { ...t, projectId: null } : t,
        );
        saveTasks("code", list);
        return { ...prev, code: list };
      });
    },
    [session],
  );

  const deleteTask = useCallback(
    (taskId: string) => {
      setTasksByMode((prev) => {
        const list = prev[mode].filter((t) => t.id !== taskId);
        saveTasks(mode, list);
        return { ...prev, [mode]: list };
      });
      setActiveTaskId((current) => (current === taskId ? null : current));
    },
    [mode],
  );

  // Design 模式自动进画布：无选中项目时选第一个；列表为空则自动建「未命名画布」。
  // 判定抽到 `resolveDesignAutoCanvas`（纯函数 + 单测），这里只做副作用。
  /** 自动建画布只试一次：项目列表拉取失败时避免每次渲染都重发创建请求。 */
  const autoCanvasTriedRef = useRef(false);
  useEffect(() => {
    const decision = resolveDesignAutoCanvas({
      mode,
      activeTaskId,
      creatingProject,
      projectsLoaded,
      designProjectIds: projects.map((p) => p.id),
      selectedProjectId,
      autoCreateTried: autoCanvasTriedRef.current,
    });
    if (decision.kind === "select") {
      setSelectedProjectId(decision.projectId);
      return;
    }
    if (decision.kind === "create") {
      autoCanvasTriedRef.current = true;
      void createProjectNamed("未命名画布").then((project) => {
        if (project) setSelectedProjectId(project.id);
      });
    }
  }, [
    mode,
    activeTaskId,
    creatingProject,
    projectsLoaded,
    projects,
    selectedProjectId,
    createProjectNamed,
  ]);

  // 权限档位（DEC-4）与模型目录（含 BYOK 实例）：读取当前值
  useEffect(() => {
    if (!session?.access_token) return;
    fetch(`${getServerBaseUrl()}/api/permissions/tier`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.tier) setTier(data.tier);
      })
      .catch(() => {});
    // 模型目录（带凭证并入 BYOK 实例）
    fetch(`${getServerBaseUrl()}/api/models`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((data: { models: WorkbenchModelOption[] }) => {
        setModels(data.models);
        /**
         * 默认取「上次选的」（`workbench:model`），失效才回落目录第一条。
         *
         * 只取第一条会踩到：目录顺序取决于实例创建序，工作区里常同时挂着多个实例
         * （自带的、替身、平台池），刷新后默认模型可能变成用户没要的那个实例——
         * 实测因此拿着一个失效实例的 Key 每轮 401。
         */
        setModel((current) =>
          current && data.models.some((m) => m.id === current)
            ? current
            : (data.models[0]?.id ?? ""),
        );
      })
      .catch(() => {});
  }, [session]);

  /** 模型选择：记住到 localStorage（与 thinking 同一口径）。 */
  const handleModelChange = useCallback((next: string) => {
    setModel(next);
    try {
      window.localStorage.setItem("workbench:model", next);
    } catch {
      // 存储失败不阻塞
    }
  }, []);

  /**
   * 断线/刷新重接（canvas.resume）：进行中的任务在刷新后 activeRunIdRef 为空，
   * 重放的事件会被 runId 过滤整段丢掉——挂载期发现「运行中 + 有在途 runId」的
   * 当前任务就把跟踪值指回去并 resume，服务端事件缓冲整段重放，run 无缝续播。
   * 服务端已无该画布的在途 run（服务重启过）则明确报失败，不让任务永远「运行中」。
   */
  const resumedTasksRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!session?.access_token) return;
    const active = tasksByModeRef.current[mode].find(
      (t) => t.id === activeTaskId,
    );
    if (
      active?.status !== "running" ||
      !active.activeRunId ||
      resumedTasksRef.current.has(active.id)
    ) {
      return;
    }
    const project = codeProjects.find((p) => p.id === active.projectId);
    const canvasId = project?.primaryCanvas?.id ?? null;
    if (!canvasId) return;
    resumedTasksRef.current.add(active.id);
    activeRunIdRef.current = active.activeRunId;
    runTaskIdRef.current = active.id;
    // 丢掉断线前流出的半截内容（切口在最后一条用户消息），整段靠重放重建
    const saveMode = mode;
    setTasksByMode((prev) => {
      const list = prev[mode].map((t2) =>
        t2.id === active.id
          ? { ...t2, messages: messagesBaseForResume(t2.messages) }
          : t2,
      );
      saveTasks(saveMode as WorkbenchMode, list);
      return { ...prev, [mode]: list };
    });
    ws.resumeCanvas(canvasId, (ack) => {
      const payload = ack.payload as
        | { activeRunId?: string | null }
        | undefined;
      if (payload?.activeRunId) return;
      setTasksByMode((prev) => {
        const list = prev[mode].map((t2) =>
          t2.id === active.id
            ? {
                ...t2,
                status: "failed" as const,
                messages: [
                  ...t2.messages,
                  {
                    role: "assistant" as const,
                    text: "服务已重启，本轮运行中断，请重试。",
                  },
                ],
              }
            : t2,
        );
        saveTasks(saveMode as WorkbenchMode, list);
        return { ...prev, [mode]: list };
      });
      setRunningTaskId(null);
    });
  }, [session?.access_token, activeTaskId, codeProjects, mode, ws]);

  // 流事件 → 任务消息
  useEffect(() => {
    // 流式持久化节流：message/thinking delta 每 token 全量回写 localStorage 是
    // 长回答卡顿的大头——首写立即、尾巴合并，终态与清理时强制落盘（task-saver）。
    const taskSaver = createTaskSaver((saveMode, list) =>
      saveTasks(saveMode as WorkbenchMode, list as WorkbenchTask[]),
    );
    const off = ws.onEvent((evt) => {
      const type = (evt as { type?: string }).type;
      const runId = (evt as { runId?: string }).runId;
      /**
       * 事件归属：run 起跑时记下的那个会话，而不是「此刻打开的会话」——
       * 用户在运行中切到别的对话时，delta/工具/终态都还该落在原来那条对话上
       * （否则串到当前打开的会话里），且终态要能把后台那条对话标成未读。
       */
      const taskId = runTaskIdRef.current ?? activeTaskIdRef.current;
      if (!taskId) return;
      const apply = (mutate: (task: WorkbenchTask) => WorkbenchTask) => {
        setTasksByMode((prev) => {
          const list = prev[mode];
          const next = list.map((t) => (t.id === taskId ? mutate(t) : t));
          const nextAll = { ...prev, [mode]: next };
          taskSaver.save(mode, next);
          return nextAll;
        });
      };
      /** 终态：不在前台就标未读（侧栏图标转实心），并把转圈收掉。 */
      const markUnreadIfBackground = () => {
        setRunningTaskId(null);
        if (taskId !== activeTaskIdRef.current) {
          setTaskUnreadRef.current(taskId, true);
        }
      };
      /**
       * 重试：服务端整段重跑并**换一个新 runId**（事件里带的就是新 id）。
       * 这条必须在 runId 过滤**之前**处理——新 id 与跟踪值不相等，按常规过滤会被丢掉，
       * 紧接着这一轮所有事件（含终态）一起丢，任务永远停在「运行中」。
       */
      if (type === "run.retrying") {
        if (!runId || !activeRunIdRef.current) return;
        activeRunIdRef.current = runId;
        // 整段重来：丢掉上一轮已流出的半截回复，避免新旧内容接在一起
        apply((task) => ({
          ...task,
          messages: dropPartialAssistantTail(task.messages),
        }));
        taskSaver.flush(mode);
        return;
      }
      if (!runId || runId !== activeRunIdRef.current) return;
      if (type === "run.started") {
        // 服务端权威起表时刻（覆盖提交时的本地乐观值）+ 在途 runId（断线重接用）
        const ts = (evt as { timestamp?: string }).timestamp;
        apply((task) => ({
          ...task,
          ...(ts ? { runStartedAt: ts } : {}),
          ...(runId ? { activeRunId: runId } : {}),
        }));
      } else if (type === "tool.started" || type === "tool.completed") {
        // 工具轨迹对所有工具都记（含被工具门拒绝的合成事件），子代理工具另进目录。
        // 曾经这里写成「先处理子代理、非子代理直接 return」，把通用分支变成死代码。
        apply((task) =>
          applyTaskToolEvent<WorkbenchTask>(
            task,
            evt as Parameters<typeof applyTaskToolEvent>[1],
          ),
        );
      } else if (type === "run.hook") {
        const hook = evt as {
          event?: "turn-start" | "turn-end";
          command?: string;
          exitCode?: number | null;
          timedOut?: boolean;
          output?: string;
          durationMs?: number;
        };
        if (typeof hook.command === "string" && hook.event) {
          apply((task) => ({
            ...task,
            hookResults: [
              ...(task.hookResults ?? []),
              {
                event: hook.event as "turn-start" | "turn-end",
                command: hook.command as string,
                exitCode: hook.exitCode ?? null,
                timedOut: hook.timedOut ?? false,
                output: hook.output ?? "",
                durationMs: hook.durationMs ?? 0,
              },
            ],
          }));
        }
      } else if (type === "run.compacted") {
        const evt2 = evt as {
          triggerTokens?: number;
          triggerSource?: "reserved-output" | "fraction" | "fallback";
          keepMessages?: number;
        };
        if (
          typeof evt2.triggerTokens === "number" &&
          typeof evt2.keepMessages === "number"
        ) {
          apply((task) => ({
            ...task,
            compacted: {
              triggerTokens: evt2.triggerTokens as number,
              triggerSource: evt2.triggerSource ?? "fallback",
              keepMessages: evt2.keepMessages as number,
            },
          }));
        }
      } else if (type === "run.usage") {
        // 本轮最后一次模型调用的累计用量（上下文容量 / 缓存命中浮层）
        const usage = usageFromEvent(evt);
        if (usage) apply((task) => ({ ...task, usage }));
      } else if (type === "thinking.delta") {
        // 思考流（dsh 的 ReasoningRow 数据源）：并入助手消息的 reasoning 块，
        // 位置即真实顺序（与正文/工具互相打断）。此前这个事件被静默丢弃。
        const delta = (evt as { delta?: string }).delta ?? "";
        if (!delta) return;
        apply((task) => {
          const messages = [...task.messages];
          const last = messages[messages.length - 1];
          if (last && last.role === "assistant") {
            messages[messages.length - 1] = appendThinkingDelta(last, delta);
            return { ...task, messages };
          }
          // 思考先于正文到达（常态）：先建一条助手消息承载它
          const nextStartMs = nextAssistantStartMs(messages, task.runStartedAt);
          const settled = settlePreviousAssistant(messages, nextStartMs);
          settled.push({
            role: "assistant",
            text: "",
            startedAt: nextStartMs,
            ...(runId ? { runId } : {}),
            blocks: [{ type: "reasoning", text: delta }],
          });
          return { ...task, messages: settled };
        });
      } else if (type === "message.delta") {
        const delta = (evt as { delta?: string }).delta ?? "";
        if (!delta) return;
        apply((task) => {
          const messages = [...task.messages];
          const last = messages[messages.length - 1];
          if (last && last.role === "assistant") {
            // 追加进本轮这条助手消息的有序块：末尾是正文就续写，末尾是工具调用
            // （工具刚跑完）就新起一段——工具之后的正文不会再和工具前的糊成一段。
            messages[messages.length - 1] = appendAssistantDelta(last, delta);
            return { ...task, messages };
          }
          // 新的一条助手消息：起点取「上一条结束的时刻」，没有就退到本轮起点——
          // 这样它记的是这一段的整段时间（含中间的思考与工具调用）
          const nextStartMs = nextAssistantStartMs(messages, task.runStartedAt);
          /*
            上一条助手消息到此定稿（模型已经开了下一轮）：把它的耗时结算掉。
            只在终态结算最后一条时，中间那些消息永远没有 elapsedMs，界面上就
            「只显示一部分」——用户口径是每条 AI 消息都要显示工作时间。
          */
          const settled = settlePreviousAssistant(messages, nextStartMs);
          settled.push({
            role: "assistant",
            text: delta,
            startedAt: nextStartMs,
            ...(runId ? { runId } : {}),
            blocks: [{ type: "text", text: delta }],
          });
          return { ...task, messages: settled };
        });
      } else if (type === "run.completed") {
        const ts = (evt as { timestamp?: string }).timestamp;
        apply((task) =>
          settleAssistantElapsed({
            ...task,
            status: "completed",
            ...(ts ? { runEndedAt: ts } : {}),
            ...(task.subagents && ts
              ? { subagents: closeAllSubagents(task.subagents, ts) }
              : {}),
          }),
        );
        // 每轮成功结束自动提交一次（Code 模式 + 已绑项目），让对话在 git 里有迹可循
        taskSaver.flush(mode);
        if (mode === "code") {
          void autoCommitTurnRef.current(taskId);
        }
        // 本轮结束拉取该 run 的检查点（Code 模式），任务卡上出现检查点条
        if (mode === "code" && runId) {
          void fetchTurnCheckpointRef.current(taskId, runId);
        }
        markUnreadIfBackground();
      } else if (type === "billing.error") {
        // 平台池额度/套餐拦截（FORM-10）：服务端给的是可读原因，
        // 直接透出，别让用户只看到「运行失败，请重试」。
        const message =
          (evt as { message?: string }).message ?? "额度不足，请联系管理员。";
        apply((task) => ({
          ...task,
          status: "failed",
          messages: [...task.messages, { role: "assistant", text: message }],
        }));
        taskSaver.flush(mode);
        markUnreadIfBackground();
      } else if (type === "run.failed") {
        // 服务端在 error.message 里给的是可读原因（如「模型流已 180 秒没有任何
        // 输出（上游停滞）」「run 未绑定项目」）。此前一律丢弃、只显示固定文案，
        // 用户无法判断该重试、换模型还是去建项目——这里按 billing.error 的同一
        // 口径透出；确实没有原因时才回落到通用文案。
        const failureText = describeRunFailure(evt);
        const failedTs = (evt as { timestamp?: string }).timestamp;
        apply((task) => ({
          ...task,
          status: "failed",
          ...(failedTs ? { runEndedAt: failedTs } : {}),
          ...(task.subagents && failedTs
            ? { subagents: closeAllSubagents(task.subagents, failedTs) }
            : {}),
          messages: [
            ...task.messages,
            { role: "assistant", text: failureText },
          ],
        }));
        // 失败的轮也可能已写文件（服务端收尾 finally 里照打结束快照）：同样补检查点条
        if (mode === "code" && runId) {
          void fetchTurnCheckpointRef.current(taskId, runId);
        }
        taskSaver.flush(mode);
        markUnreadIfBackground();
      } else if (type === "run.canceled") {
        const canceledTs = (evt as { timestamp?: string }).timestamp;
        apply((task) =>
          settleAssistantElapsed({
            ...task,
            status: "completed",
            ...(canceledTs ? { runEndedAt: canceledTs } : {}),
            ...(task.subagents && canceledTs
              ? { subagents: closeAllSubagents(task.subagents, canceledTs) }
              : {}),
          }),
        );
        taskSaver.flush(mode);
        // 用户自己按的停止：算已读，但转圈要收掉
        setRunningTaskId(null);
      }
    });
    // 事件监听随 mode/ws 变化重挂：节流窗口里的待写内容先落盘，不留给新的 saver 实例
    return () => {
      taskSaver.flush();
      off();
    };
  }, [ws, mode]);

  /** 真正落库并生效（确认弹窗与其余三档都走它）。 */
  const applyTier = useCallback(
    async (next: string) => {
      setTier(next);
      if (!session?.access_token) return;
      try {
        await fetch(`${getServerBaseUrl()}/api/permissions/tier`, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ tier: next }),
        });
      } catch {
        // 权限档位失败不阻塞任务
      }
    },
    [session],
  );

  /**
   * 切档：**「完全访问」先过一道风险确认**（用户口径：不要用括号交代风险，改成弹窗提示并确认）。
   * 其余三档直接生效。
   */
  const handleTierChange = useCallback(
    async (next: string) => {
      if (next === "full-access" && tier !== "full-access") {
        setPendingFullAccess(true);
        return;
      }
      await applyTier(next);
    },
    [applyTier, tier],
  );

  /**
   * 选中工作目录（项目）——**三处入口都走它**，好让「记住这个选择」只有一处实现。
   *
   * 为什么要记住：刷新后 `selectedProjectId` / `workDirName` 本来会归零，而 Code 模式的
   * run 作用域取「选中项目的主画布」——没选中时服务端懒供给隐藏 code 项目，**文件会悄悄
   * 落进 `<sandboxRoot>/<canvasId>` 而不是用户配的目录**，界面上看不出差别。
   */
  const selectWorkDir = useCallback(
    (selection: { projectId: string; name: string } | null) => {
      setSelectedProjectId(selection?.projectId ?? null);
      setWorkDirName(selection?.name ?? null);
      setWorkDirNotice(null);
      saveCodeWorkDir(browserStorage(), selection);
    },
    [],
  );

  /**
   * 「不在项目中工作」：清掉工作目录与项目选择。
   * run 会退回会话自身的作用域（服务端懒供给的 Code 载体），不再绑定工作目录项目。
   */
  const clearWorkDirectory = useCallback(() => {
    selectWorkDir(null);
  }, [selectWorkDir]);

  /**
   * 「填本机路径」：把用户填的绝对路径绑成工作目录项目的 `projects.work_dir`。
   *
   * 这是 Web 形态唯一能真正绑定本机目录的路子：`showDirectoryPicker` 只给得到目录名，
   * 而服务端要的是绝对路径。校验在服务端做（绝对路径 + 存在 + 是目录），不合格时
   * 抛出的可读原因由选择器表单显示——不吞成「失败」。
   */
  const bindWorkDirectory = useCallback(
    async (path: string) => {
      const token = session?.access_token;
      if (!token) throw new Error("尚未登录，无法绑定工作目录。");
      const name = workDirNameFromPath(path) || path.trim();
      const plan = resolveWorkDirProject(name, codeProjects);

      if (plan.kind === "reuse") {
        await updateProject(token, plan.projectId, { work_dir: path });
        setCodeProjects((prev) =>
          prev.map((project) =>
            project.id === plan.projectId
              ? { ...project, workDir: path }
              : project,
          ),
        );
        selectWorkDir({ projectId: plan.projectId, name });
        return;
      }

      const result = await createProject(token, {
        kind: "code",
        name,
        work_dir: path,
      });
      setCodeProjects((prev) => [result.project, ...prev]);
      selectWorkDir({
        projectId: result.project.id,
        name: result.project.name,
      });
    },
    [session, codeProjects, selectWorkDir],
  );

  const pickWorkDirectory = useCallback(async () => {
    const token = session?.access_token;
    /**
     * 桌面形态先走**服务端系统对话框**：只有那一条能拿回绝对路径、真正绑定工作目录
     * （浏览器侧 `showDirectoryPicker` 只给得到目录名）。分流口径：
     * - 选中 → 走「填本机路径」同一条绑定链（`bindWorkDirectory`）；
     * - 取消 → 静默（用户主动取消不是错误）；
     * - 不可用 → **回落浏览器选择器**，并把原因一并说出来；
     * - 失败 → 只报原因，不静默换选择器（否则用户会以为「系统对话框怎么变成了浏览器弹窗」）。
     */
    let fallbackReason = nativeDirPicker?.reason ?? null;
    if (token && nativeDirPicker?.available) {
      try {
        const native = await pickDirectory(token);
        if (native.status === "picked") {
          await bindWorkDirectory(native.path);
          return;
        }
        if (native.status === "cancelled") return;
        if (native.status === "failed") {
          setWorkDirNotice(native.reason);
          return;
        }
        fallbackReason = native.reason;
      } catch (error) {
        setWorkDirNotice(
          `系统文件夹对话框不可用：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
    }

    const result = await workDirPick(window);
    if (result.status === "picked") {
      // Code 模式：**工作目录即项目**。run 的生产后端要求绑定项目
      // （缺 canvasId 会立刻失败），而浏览器只拿得到目录名——所以这里按目录名
      // 建同名项目并选中，run 以该项目的主画布为作用域，文件落在项目的沙箱目录里。
      if (mode === "code") {
        // 目录名 → 工作目录项目：同名复用，没有就自动建（服务端 kind='code'）
        const plan = resolveWorkDirProject(result.name, codeProjects);
        if (plan.kind === "reuse") {
          selectWorkDir({ projectId: plan.projectId, name: result.name });
          return;
        }
        const created = await createCodeProject(plan.name);
        if (created) {
          selectWorkDir({ projectId: created.id, name: created.name });
          return;
        }
        setWorkDirName(result.name);
        setWorkDirNotice(null);
        setWorkDirNotice(
          "已选定目录名，但项目创建失败，本次运行可能无法开始。",
        );
        return;
      }
      setWorkDirName(result.name);
      setWorkDirNotice(null);
      return;
    }
    if (result.status === "cancelled") {
      // 用户主动取消：不打扰
      return;
    }
    // 不支持/失败都必须说出来（曾经是静默 return + 空 catch），并附上「为什么没用系统对话框」
    setWorkDirNotice(
      fallbackReason
        ? `${result.notice}（未用系统对话框：${fallbackReason}）`
        : result.notice,
    );
  }, [
    mode,
    codeProjects,
    createCodeProject,
    selectWorkDir,
    session,
    nativeDirPicker,
    bindWorkDirectory,
  ]);

  /**
   * 插件「使用」：跳到**真正消费这个插件的界面**（市场里已装条目就是这个键）。
   * 表在 plugin-market-modal 里（显式列表），这里只负责跳。
   */
  const handlePluginUse = useCallback((pluginName: string) => {
    setPluginsOpen(false);
    if (pluginName === "mcp") {
      setMcpOpen(true);
      return;
    }
    if (pluginName === "skills") {
      setSkillsOpen(true);
      return;
    }
    if (pluginName === "canvas") {
      // 画布的消费界面就是 Design 模式主区（与 switchMode 同一动作）
      setMode("design");
      setActiveTaskId(null);
      return;
    }
    if (pluginName === "model-providers") {
      setSettingsTab("providers");
      return;
    }
    if (pluginName === "search") {
      // 默认搜索引擎在「浏览器 → 通用」里（联网检索用的就是它）
      setSettingsTab("browser");
      return;
    }
    // plugin-registry：插件面板
    setSettingsTab("pluginPanels");
  }, []);

  /**
   * 把一份工作树路径绑成**当前项目**的工作目录（工作树对话框里的「绑为工作目录」）。
   *
   * 与「填本机路径」的区别：那条会按目录名去找/建项目，这条**不动项目身份**——
   * 工作树就是这个项目的另一份检出，绑完下一轮 run 起在那一份里干活。
   */
  const bindWorktreeToProject = useCallback(
    async (path: string) => {
      const token = session?.access_token;
      const project = selectedProject;
      if (!token) throw new Error("尚未登录，无法绑定工作目录。");
      if (!project) throw new Error("先选中一个工作目录项目。");
      await updateProject(token, project.id, { work_dir: path });
      setCodeProjects((prev) =>
        prev.map((item) =>
          item.id === project.id ? { ...item, workDir: path } : item,
        ),
      );
      setWorkDirNotice(`工作目录已绑到工作树：${path}`);
    },
    [session, selectedProject],
  );

  const switchMode = useCallback((next: WorkbenchMode) => {
    setMode(next);
    setActiveTaskId(null);
  }, []);

  const startTask = useCallback(
    async (text: string) => {
      if (!text.trim() || !session?.access_token) return;

      if (mode === "design") {
        // Design 模式：主区是画布，对话属于画布页自己的助手面板。
        // 这里把输入交给画布（`/canvas?id=...&prompt=...` 由画布页自动发送），
        // **不**创建工作任务、**不**激活会话视图——否则对话框会把画布顶掉。
        setPrompt("");
        setCanvasPrompt(text.trim());
        return;
      }

      const sessionId = crypto.randomUUID();
      const conversationId = crypto.randomUUID();

      // Code 模式：工作目录=项目。选了工作目录却没有对应项目（项目被删过、或历史
      // 会话只留了目录名）时按目录名自动补建——否则 run 绑不上项目会整轮秒失败。
      let resolvedProject = mode === "code" ? selectedProject : null;
      if (mode === "code" && !resolvedProject && workDirName) {
        const plan = resolveWorkDirProject(workDirName, codeProjects);
        resolvedProject =
          plan.kind === "reuse"
            ? (codeProjects.find((p) => p.id === plan.projectId) ?? null)
            : await createCodeProject(plan.name);
        if (resolvedProject) setSelectedProjectId(resolvedProject.id);
      }
      // 作用域：项目主画布优先；未选工作目录时退回会话自身（服务端懒供给 Code 载体）
      const runCanvasId =
        mode === "code"
          ? (resolvedProject?.primaryCanvas?.id ?? conversationId)
          : conversationId;

      const title = text.trim().slice(0, 24) || "新任务";
      const task: WorkbenchTask = {
        id: conversationId,
        sessionId,
        title,
        mode,
        createdAt: Date.now(),
        messages: [{ role: "user", text: text.trim(), startedAt: Date.now() }],
        status: "running",
        projectId: mode === "code" ? (resolvedProject?.id ?? null) : null,
        archived: false,
        // 先用本地时钟乐观起表，run.started 事件到达后以服务端时间戳为准
        runStartedAt: new Date().toISOString(),
      };
      setTasksByMode((prev) => {
        const list = [task, ...prev[mode]];
        saveTasks(mode, list);
        return { ...prev, [mode]: list };
      });
      setActiveTaskId(task.id);
      setPrompt("");
      setSubmitting(true);

      // 失败兜底：WS 命令可能被丢弃（重连窗口）或 ack 丢失。没有兜底时任务会永远停在
      // 「生成中」，且 submitting 不归位会让发送按钮**永久禁用**——用户只能刷新页面。
      const markFailed = (text: string) => {
        setTasksByMode((prev) => {
          const list = prev[mode].map((t) =>
            t.id === task.id && t.status === "running"
              ? {
                  ...t,
                  status: "failed" as const,
                  runEndedAt: new Date().toISOString(),
                  messages: [
                    ...t.messages,
                    { role: "assistant" as const, text },
                  ],
                }
              : t,
          );
          saveTasks(mode, list);
          return { ...prev, [mode]: list };
        });
        setSubmitting(false);
      };

      if (!ws.connected) {
        markFailed("连接未就绪，正在重连，请稍后重试。");
        return;
      }

      let acked = false;
      /**
       * ack 超时的处置交给纯函数判定（口径只有一处，见 `lib/run-failure.ts`）。
       *
       * 两条实测教训写在那个函数里：① 连接断着时不能一律报「请重试」——服务端会按
       * lastSeq 重放，本轮能自己接上；② **看着连着却收不到 ack** 时更不能报「请重试」
       * ——那是半开连接，服务端已经把 run 跑起来了，照着提示重发会造出重复 run。
       */
      let waitedMs = 0;
      let ackTimer: number;
      const checkAck = () => {
        if (acked) return;
        waitedMs += ACK_TIMEOUT_MS;
        const decision = decideAckTimeout({
          connected: ws.connected,
          waitedMs,
        });
        if (decision.action === "fail") {
          markFailed(decision.text);
          return;
        }
        if (decision.action === "reconnect") {
          ws.reconnectNow();
        }
        ackTimer = window.setTimeout(checkAck, ACK_POLL_MS);
      };
      ackTimer = window.setTimeout(checkAck, ACK_TIMEOUT_MS);

      ws.startRun(
        {
          sessionId,
          conversationId,
          // state 后端要求 run 挂项目。Code 模式下「工作目录=项目」：选中项目时
          // 用它的主画布作作用域（同一项目的多次运行共享同一沙箱目录）；
          // 未选工作目录时退回 conversationId，由服务端懒供给会话。
          canvasId: runCanvasId,
          // 模式指令（inputDirective）由服务端 pre-step 事件缝注入，客户端不再拼接
          prompt: `${
            mode === "code"
              ? resolvedProject?.workDir
                ? // 已绑定真实目录（projects.work_dir）：可以说出工作区根，路径仍相对书写
                  `${boundWorkDirPromptHint(resolvedProject.workDir)}

`
                : workDirName
                  ? `${workDirectoryPromptHint(workDirName)}

`
                  : ""
              : ""
          }${thinkingPromptHint(thinking)}${text.trim()}`,
          ...(model ? { model } : {}),
          executionMode,
        },
        (ack) => {
          acked = true;
          window.clearTimeout(ackTimer);
          const payload = ack.payload as { runId?: string } | undefined;
          if (payload?.runId) {
            activeRunIdRef.current = payload.runId;
            // 事件归属：本轮 run 属于哪个会话（用户中途切走也不会串台）
            runTaskIdRef.current = task.id;
            setRunningTaskId(task.id);
          }
          setSubmitting(false);
        },
      );
    },
    [
      mode,
      model,
      workDirName,
      thinking,
      executionMode,
      selectedProject,
      codeProjects,
      createCodeProject,
      session,
      ws,
    ],
  );

  const handleSignOut = useCallback(() => {
    void signOut();
    router.push("/login");
  }, [signOut, router]);

  /**
   * 本轮结束自动提交（「每次对话用 git 跟踪」）：Code 模式 + 已绑工作目录项目时，
   * 把这一轮的改动提交到工作目录的仓库里，便于回滚。
   *
   * 静默失败：不是 git 仓库 / 改动的就是没东西可提交 / git 不可用——都不打扰用户
   * （分支 chip 上本来就写着「非 Git 仓库」）。
   */
  /** 事件回调注册在挂载期（deps 只有 ws/mode），必须经 ref 读最新值——否则拿到的是
      首轮的 null（实测：自动提交静默不触发，就是因为闭包里的 token/项目是 null）。 */
  const autoCommitContextRef = useRef<{
    token: string | null;
    canvasId: string | null;
  }>({
    token: null,
    canvasId: null,
  });
  autoCommitContextRef.current = {
    token: session?.access_token ?? null,
    canvasId: selectedProject?.primaryCanvas?.id ?? null,
  };

  const autoCommitTurn = useCallback(async (taskId: string | null) => {
    const { token, canvasId } = autoCommitContextRef.current;
    if (!token || !canvasId || !taskId) return;
    const task = tasksByModeRef.current.code.find((t) => t.id === taskId);
    if (!task) return;
    const round = Math.max(
      1,
      task.messages.filter((m) => m.role === "assistant").length,
    );
    try {
      await commitGitAll(token, canvasId, `${task.title}（第 ${round} 轮）`);
      setLastAutoCommitAt(new Date().toISOString());
    } catch {
      // 没有仓库 / 无改动可提交：跳过
    }
  }, []);
  autoCommitTurnRef.current = autoCommitTurn;

  /**
   * 本轮终态后拉取该 run 的检查点并写回任务（Code 模式）。
   *
   * 时序：服务端的**结束快照在终态事件之后**才落行（runtime 的 afterTurn 挂在收尾
   * finally 里，而终态事件从流内 yield）——立刻拉会抢空，所以拉不到该 run 的行时
   * 退避重试几次，拉到即停。拉取失败一律静默：检查点条是附赠视图，不打扰用户
   * （该轮就是没有条）。
   */
  const fetchTurnCheckpoint = useCallback(
    async (taskId: string, runId: string) => {
      const { token, canvasId } = autoCommitContextRef.current;
      if (!token || !canvasId) return;
      for (const wait of [0, 1000, 2000, 4000]) {
        if (wait > 0) {
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
        try {
          const picked = pickCheckpointForRun(
            await fetchCheckpoints(token, canvasId),
            runId,
          );
          if (!picked) continue;
          // 写死 code 列表：检查点只在 Code 模式任务上，此刻用户可能已切到 Design
          setTasksByMode((prev) => {
            const list = prev.code.map((t) =>
              t.id === taskId ? { ...t, checkpoint: picked } : t,
            );
            saveTasks("code", list);
            return { ...prev, code: list };
          });
          return;
        } catch {
          return; // 网络/鉴权失败：该轮没有检查点条
        }
      }
    },
    [],
  );
  fetchTurnCheckpointRef.current = fetchTurnCheckpoint;

  /** 任务视图内继续追问：追加 user 消息并复用同一会话发起新 run。 */
  const continueTask = useCallback(
    (text: string) => {
      const taskId = activeTaskId;
      if (!text.trim() || !taskId || !session?.access_token) return;
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;
      // 追问发生在对话里：从轨迹页签发消息要跳回对话页，让新内容立即可见
      setTranscriptTab("chat");
      setTasksByMode((prev) => {
        const list = prev[mode].map((t) =>
          t.id === taskId
            ? {
                ...t,
                messages: [
                  ...t.messages,
                  {
                    role: "user" as const,
                    text: text.trim(),
                    startedAt: Date.now(),
                  },
                ],
                status: "running" as const,
                // 新一轮起表，清掉上一轮的终态时刻
                runStartedAt: new Date().toISOString(),
                runEndedAt: undefined,
              }
            : t,
        );
        saveTasks(mode, list);
        return { ...prev, [mode]: list };
      });
      setSubmitting(true);
      const thinkingHint =
        thinking === "default" ? "" : `【思考强度：${thinking}】\n`;
      const history = task.messages
        .slice(-12)
        .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.text}`)
        .join("\n\n");
      const historyBlock = history
        ? `【对话历史（供参考，延续上文语境）】\n${history}\n\n【本轮用户消息】\n`
        : "";
      // 模式指令由服务端 pre-step 事件缝注入；这里只随载荷声明当前模式，
      // 服务端按 threadId 重新激活（continueTask 复用同一 thread）
      // 作用域必须与首轮一致：Code 模式下 run 挂的是项目主画布（工作目录=项目），
      // 追问若退回 conversationId 会换到另一个沙箱目录，上一轮写的文件就"消失"了。
      const taskProject =
        mode === "code" && task.projectId
          ? codeProjects.find((p) => p.id === task.projectId)
          : null;
      const taskCanvasId = taskProject?.primaryCanvas?.id ?? task.id;
      ws.startRun(
        {
          sessionId: task.sessionId,
          conversationId: task.id,
          canvasId: taskCanvasId,
          prompt: `${thinkingHint}${historyBlock}${text.trim()}`,
          ...(model ? { model } : {}),
          executionMode,
        },
        (ack) => {
          const payload = ack.payload as { runId?: string } | undefined;
          if (payload?.runId) {
            activeRunIdRef.current = payload.runId;
            runTaskIdRef.current = taskId;
            setRunningTaskId(taskId);
          }
          setSubmitting(false);
        },
      );
    },
    [
      activeTaskId,
      tasks,
      mode,
      model,
      thinking,
      executionMode,
      session,
      ws,
      codeProjects,
    ],
  );

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        加载中…
      </div>
    );
  }
  if (!user) return null;

  const meta = MODE_META[mode];

  const modeItems = (["code", "design"] as const).map((m) => ({
    id: m,
    label: MODE_META[m].label,
    icon:
      m === "code" ? (
        <Code2 className="h-4 w-4 shrink-0" />
      ) : (
        <Palette className="h-4 w-4 shrink-0" />
      ),
  }));

  return (
    <div
      className="flex h-screen bg-background text-foreground"
      style={
        {
          "--workbench-sidebar": `${
            sidebarCollapsed ? SIDEBAR_RAIL_WIDTH : sidebarWidth
          }px`,
        } as React.CSSProperties
      }
    >
      {sidebarCollapsed ? (
        /* 收起态：图标栏（模式切换 + 插件 + 底部头像） */
        <aside className="flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-card py-2">
          <KenFutWorkLogo className="mb-1 size-7 shrink-0" />
          <button
            type="button"
            aria-label="展开侧栏"
            onClick={() => setSidebarCollapsed(false)}
            className="rounded-md p-2 hover:bg-muted"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
          <div className="my-1 w-6 border-t" />
          {modeItems.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.label}
              aria-label={item.label}
              data-active={mode === item.id}
              onClick={() => switchMode(item.id)}
              className="rounded-md p-2 hover:bg-muted data-[active=true]:bg-muted data-[active=true]:text-foreground data-[active=false]:text-muted-foreground"
            >
              {item.icon}
            </button>
          ))}
          <button
            type="button"
            title="插件"
            aria-label="插件"
            onClick={() => setPluginsOpen(true)}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Layers className="h-4 w-4" />
          </button>
          <div className="mt-auto">
            <UserMenu
              user={workbenchUser}
              collapsed
              isAdmin={isPlatformAdmin}
              onOpenSettings={() => setSettingsTab("general")}
              onOpenAdmin={() => router.push("/admin")}
              onSignOut={handleSignOut}
            />
          </div>
        </aside>
      ) : (
        /* 展开态：logo + 模式切换 + 插件 + 项目(design) + 任务列表 + 底部个人中心 */
        <aside
          style={{ width: sidebarWidth }}
          className="relative flex shrink-0 flex-col border-r bg-card"
        >
          {/* 拖拽把手：贴侧栏右边缘；向右拖 = 变宽 */}
          {/* biome-ignore lint/a11y/useSemanticElements: 拖拽改宽的把手，不是 <hr>（内容分隔线） */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧栏宽度"
            onMouseDown={startSidebarResize}
            className="absolute top-0 -right-0.5 z-10 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-foreground/20"
          />
          <div className="flex items-center justify-between px-3 pt-3 pb-2">
            {/* 左内边距与下面的模式切换控件对齐（外层 px-3 + 分段控件内 p-1 ⇒ pl-4）；
                logo 与字标之间留 5px（用户口径） */}
            <span className="flex items-center gap-[5px] pl-1">
              <KenFutWorkLogo className="h-[15px] w-auto text-foreground" />
              {/* 字标：Momo Trust Display + **三色**渐变（左深右浅；变量见 globals.css，
                  显式 sRGB 插值——oklab 中段会发灰显脏） */}
              <span
                className="font-wordmark bg-clip-text text-xl tracking-tight text-transparent"
                style={{ backgroundImage: "var(--wordmark-gradient)" }}
              >
                KenFutWork
              </span>
            </span>
            <button
              type="button"
              aria-label="收起侧栏"
              onClick={() => setSidebarCollapsed(true)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>

          {/* 模式切换（开关式：一个分段控件内左右切换 Code / Design） */}
          <div className="px-3 pt-1 pb-0.5">
            <div
              role="radiogroup"
              aria-label="模式切换"
              className="flex items-center gap-1 rounded-lg bg-muted p-1"
            >
              {modeItems.map((item) => (
                // biome-ignore lint/a11y/useSemanticElements: 分段控件用的是 radiogroup/radio 模式（原生 radio 无法承载这套样式与布局）
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === item.id}
                  data-active={mode === item.id}
                  onClick={() => switchMode(item.id)}
                  className="flex min-h-[30px] flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:text-foreground data-[active=true]:bg-card data-[active=true]:font-medium data-[active=true]:text-foreground data-[active=true]:shadow-sm"
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mx-3 my-2 border-t" />

          <nav className="space-y-0.5 px-2">
            <button
              type="button"
              onClick={() => setPluginsOpen(true)}
              className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Layers className="h-4 w-4 shrink-0" /> 插件
            </button>
            <button
              type="button"
              onClick={() => setSkillsOpen(true)}
              className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Blocks className="h-4 w-4 shrink-0" /> 技能
            </button>
            <button
              type="button"
              onClick={() => setMcpOpen(true)}
              className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {/* Server 而不是 Plug：插头字形天生窄（墨迹只占格子 58%），居中也会显得缩在
                  右边；Server 与相邻图标一样填满格子（92%），不必再做尺寸特例 */}
              <Server className="h-4 w-4 shrink-0" /> MCP
            </button>
            {/* 插件面板（能力 `ui`）：侧栏槽位 */}
            <PluginPanelButtons
              accessToken={session?.access_token ?? null}
              slot="sidebar"
              renderButton={(panel, open) => (
                <button
                  key={panel.id}
                  type="button"
                  onClick={open}
                  title={`插件 ${panel.pluginId} 提供的面板`}
                  className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {/* 插件图标：单色渲染（跟随本行文字色），槽位与本体都 16px——
                      与 MCP/技能/插件 三个满格字形（墨迹 92%）同尺寸才不显小 */}
                  <PluginIcon icon={panel.icon} pluginId={panel.pluginId} />{" "}
                  {panel.title}
                </button>
              )}
            />
          </nav>

          <div className="mx-3 my-2 border-t" />

          {mode === "design" ? (
            /* Design：项目列表（+ 直接创建，无任务列表） */
            <div className="flex min-h-0 flex-1 flex-col px-2">
              <div className="flex items-center justify-between px-1 pb-1">
                <span className="text-xs text-muted-foreground">项目</span>
                <button
                  type="button"
                  aria-label="创建项目"
                  title="创建项目"
                  disabled={creatingProject}
                  onClick={() => {
                    void createProjectNamed("未命名画布").then((project) => {
                      if (project) setSelectedProjectId(project.id);
                    });
                  }}
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-1">
                {projects.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                    {creatingProject ? "创建中…" : "暂无项目"}
                  </p>
                ) : (
                  projects.map((p) => (
                    <SidebarRow
                      key={p.id}
                      label={p.name}
                      active={selectedProjectId === p.id}
                      icon={
                        <Palette className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      }
                      onOpen={() => {
                        setSelectedProjectId(p.id);
                        setActiveTaskId(null);
                      }}
                      onRename={(next) => void renameProject(p.id, next)}
                      onDelete={() => void removeProject(p.id)}
                    />
                  ))
                )}
              </div>
            </div>
          ) : (
            /* Code：项目列表（工作目录=项目，下面挂对话；右键重命名/归档/删除） */
            <div className="flex min-h-0 flex-1 flex-col px-2">
              <div className="flex items-center justify-between px-1 pb-1">
                <span className="text-xs text-muted-foreground">工作目录</span>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    aria-label="新建工作目录"
                    title="新建工作目录"
                    disabled={creatingProject}
                    onClick={() => {
                      void createCodeProject("未命名工作目录").then(
                        (project) => {
                          if (project) setSelectedProjectId(project.id);
                        },
                      );
                    }}
                    className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="新建对话"
                    title={
                      selectedProject
                        ? `在「${selectedProject.name}」下新建对话`
                        : "选中工作目录后新建对话会自动关联它"
                    }
                    onClick={() => {
                      // 新建对话：保留当前选中的工作目录，新对话即挂在它下面
                      setActiveTaskId(null);
                    }}
                    className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pb-1">
                {(() => {
                  const knownProjectIds = new Set(
                    codeProjects.map((p) => p.id),
                  );
                  /**
                   * 未分组 = 没有项目，或 projectId 指向一个已不存在的项目。
                   * 后者是必须的防御：项目被删/换库后，任务若仍带着孤儿 id，
                   * 既进不了任何项目分组、也不进未分组——对话会「凭空消失」。
                   */
                  const ungrouped = tasks.filter(
                    (t) =>
                      !t.archived &&
                      (t.projectId == null ||
                        !knownProjectIds.has(t.projectId)),
                  );
                  const archived = tasks.filter((t) => t.archived);
                  const taskRow = (t: WorkbenchTask) => {
                    const indicator = resolveTaskIndicator(
                      t.status === "running" && runningTaskId === t.id,
                      unreadTaskIds.includes(t.id),
                    );
                    return (
                      <SidebarRow
                        key={t.id}
                        label={t.title}
                        active={activeTaskId === t.id}
                        icon={
                          indicator === "running" ? (
                            /* 与对话图标同色（不再用琥珀色：侧栏一排转圈太抢眼） */
                            <Loader2
                              aria-label="运行中"
                              className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
                            />
                          ) : (
                            <MessageSquare
                              className={`h-3.5 w-3.5 shrink-0 ${
                                indicator === "unread"
                                  ? "fill-current text-foreground"
                                  : "text-muted-foreground"
                              }`}
                            />
                          )
                        }
                        trailing={formatTaskRelativeTime(
                          t.runEndedAt ?? t.createdAt,
                        )}
                        onOpen={() => setActiveTaskId(t.id)}
                        onRename={(next) => renameTask(t.id, next)}
                        onArchive={() => setTaskArchived(t.id, true)}
                        onDelete={() => deleteTask(t.id)}
                      />
                    );
                  };
                  /**
                   * 分组内的对话列表：默认只露前 `SESSION_PREVIEW_LIMIT` 条，
                   * 其余收进「显示更多」——一个工作目录下几十条对话时，侧栏不该被单个
                   * 工作目录撑满（展开状态按分组持久化）。
                   */
                  const taskGroup = (
                    groupKey: string,
                    items: WorkbenchTask[],
                  ) => {
                    const { visible, hiddenCount } = previewGroup(
                      items,
                      expandedGroups.includes(groupKey),
                    );
                    return (
                      <div className="ml-4 space-y-0.5 border-l pl-1">
                        {visible.map(taskRow)}
                        {hiddenCount > 0 ? (
                          <button
                            type="button"
                            onClick={() => toggleGroupExpanded(groupKey)}
                            className="w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            显示更多
                          </button>
                        ) : null}
                        {items.length > SESSION_PREVIEW_LIMIT &&
                        expandedGroups.includes(groupKey) ? (
                          <button
                            type="button"
                            onClick={() => toggleGroupExpanded(groupKey)}
                            className="w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground/70 transition-colors hover:bg-muted hover:text-muted-foreground"
                          >
                            收起
                          </button>
                        ) : null}
                      </div>
                    );
                  };
                  return (
                    <>
                      {codeProjects.map((p) => {
                        const items = tasks.filter(
                          (t) => !t.archived && t.projectId === p.id,
                        );
                        return (
                          <div key={p.id}>
                            <SidebarRow
                              label={p.name}
                              active={selectedProjectId === p.id}
                              icon={
                                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              }
                              expanded={!collapsedProjects.includes(p.id)}
                              onToggleExpanded={() =>
                                setCollapsedProjects((prev) => {
                                  const next = prev.includes(p.id)
                                    ? prev.filter((id) => id !== p.id)
                                    : [...prev, p.id];
                                  try {
                                    window.localStorage.setItem(
                                      "workbench:collapsed-projects",
                                      JSON.stringify(next),
                                    );
                                  } catch {
                                    // 存储失败不影响使用
                                  }
                                  return next;
                                })
                              }
                              onOpen={() => {
                                selectWorkDir({
                                  projectId: p.id,
                                  name: p.name,
                                });
                              }}
                              onRename={(next) =>
                                void renameCodeProject(p.id, next)
                              }
                              onDelete={() => void removeCodeProject(p.id)}
                            />
                            {collapsedProjects.includes(
                              p.id,
                            ) ? null : items.length === 0 ? (
                              <div className="ml-4 space-y-0.5 border-l pl-1">
                                <p className="px-2 py-1 text-xs text-muted-foreground/70">
                                  暂无对话
                                </p>
                              </div>
                            ) : (
                              taskGroup(p.id, items)
                            )}
                          </div>
                        );
                      })}
                      {ungrouped.length > 0 ? (
                        <div>
                          <p className="px-2 py-1 text-xs text-muted-foreground">
                            未分组
                          </p>
                          {taskGroup(UNGROUPED_KEY, ungrouped)}
                        </div>
                      ) : null}
                      {archived.length > 0 ? (
                        <details className="px-1">
                          <summary className="cursor-pointer px-1 py-1 text-xs text-muted-foreground hover:text-foreground">
                            已归档（{archived.length}）
                          </summary>
                          <div className="ml-4 space-y-0.5 border-l pl-1">
                            {archived.map((t) => (
                              <SidebarRow
                                key={t.id}
                                label={t.title}
                                icon={
                                  <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                                }
                                onOpen={() => setActiveTaskId(t.id)}
                                onRename={(next) => renameTask(t.id, next)}
                                onRestore={() => setTaskArchived(t.id, false)}
                                onDelete={() => deleteTask(t.id)}
                              />
                            ))}
                          </div>
                        </details>
                      ) : null}
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {/* 底部：个人中心（头像弹出） */}
          <div className="border-t p-2">
            <UserMenu
              user={workbenchUser}
              collapsed={false}
              isAdmin={isPlatformAdmin}
              onOpenSettings={() => setSettingsTab("general")}
              onOpenAdmin={() => router.push("/admin")}
              onSignOut={handleSignOut}
            />
          </div>
        </aside>
      )}

      {/* 主区：Design＝画布（恒为画布，见 resolveWorkbenchSurface）/ Code＝任务视图 或 居中编排器 */}
      <main className="min-w-0 flex-1 overflow-hidden bg-card">
        {surface === "canvas" ? (
          /* Design：选中项目后画布自动打开（原版 KenFutWork 画布，对话在画布内助手里） */
          <iframe
            key={`${selectedProject?.primaryCanvas.id}:${canvasPrompt ?? ""}`}
            src={`/canvas?id=${selectedProject?.primaryCanvas.id}${
              canvasPrompt ? `&prompt=${encodeURIComponent(canvasPrompt)}` : ""
            }`}
            title={`${selectedProject?.name ?? ""} 画布`}
            className="h-full w-full border-0"
          />
        ) : activeTask ? (
          /* 转录列 + 右栏停靠面板（面板收起时返回 null，不占宽）。 */
          <div className="flex h-full">
            <div
              className="flex h-full min-w-0 flex-1 flex-col"
              style={
                {
                  "--scrollbar-lane": `${scrollbarLane}px`,
                } as React.CSSProperties
              }
            >
              {/* 标题行：会话标题 + 本轮回执 + 插件面板入口；右端贴住工作目录与分支。
                这两个 chip 取**对话自己绑定的项目**（run 的作用域就是它），
                不依赖侧栏选中态——否则打开历史对话时它们会消失（用户反馈）。 */}
              <div className="shrink-0 pr-[var(--scrollbar-lane,0px)]">
                <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-6 pt-6 pb-4">
                  <h1 className="min-w-0 truncate text-lg font-medium">
                    {activeTask.title}
                  </h1>
                  {lastAutoCommitAt ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      已自动提交本轮
                    </span>
                  ) : null}
                  {/* 插件面板（能力 `ui`）：对话槽位 */}
                  <PluginPanelButtons
                    accessToken={session?.access_token ?? null}
                    slot="conversation"
                    renderButton={(panel, open) => (
                      <button
                        key={panel.id}
                        type="button"
                        onClick={open}
                        title={`插件 ${panel.pluginId} 提供的面板`}
                        className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                      >
                        <PanelsTopLeft className="h-3.5 w-3.5" />
                        {panel.title}
                      </button>
                    )}
                  />
                  {mode === "code" ? (
                    <div className="ml-auto flex shrink-0 items-center gap-2">
                      <WorkDirectorySelect
                        projects={codeProjects}
                        selectedProjectId={conversationProject?.id ?? null}
                        lockedHint={
                          conversationProject
                            ? `本次对话已绑定工作目录「${conversationProject.name}」`
                            : "本次对话没有绑定工作目录"
                        }
                        busy={creatingProject}
                        onSelect={() => undefined}
                        onOpenFolder={() => undefined}
                        onClear={() => undefined}
                      />
                      <GitBranchSelect
                        accessToken={session?.access_token ?? null}
                        canvasId={conversationProject?.primaryCanvas.id ?? null}
                        /* 自动提交后 key 变化 → 重新拉取更改统计 */
                        key={`${conversationProject?.primaryCanvas.id ?? ""}:${lastAutoCommitAt ?? ""}`}
                      />
                      {/* 面板开关：与参考图一致，右栏由这个键开合 */}
                      <button
                        type="button"
                        aria-label="面板"
                        aria-expanded={panelOpen}
                        title={
                          panelOpen
                            ? "收起面板"
                            : "打开面板（变更 / 文件 / 终端 / 浏览器 / 子智能体）"
                        }
                        onClick={() => setPanelOpen((current) => !current)}
                        className="rounded-md border p-1.5 text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground data-[active=true]:border-foreground/30 data-[active=true]:text-foreground"
                        data-active={panelOpen}
                      >
                        <PanelRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
              {/* 对话 / 轨迹 双页签（参考 deepseek-harness 的会话头）。
                对话 = 按发生顺序交错的流；轨迹 = 按轮次分组的只读账本。 */}
              <div className="shrink-0 pr-[var(--scrollbar-lane,0px)]">
                <div
                  role="tablist"
                  aria-label="转录视图"
                  className="mx-auto flex w-full max-w-3xl items-center gap-1 px-6"
                >
                  {(
                    [
                      ["chat", "对话"],
                      ["trajectory", "轨迹"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={transcriptTab === value}
                      onClick={() => setTranscriptTab(value)}
                      className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                        transcriptTab === value
                          ? "bg-muted font-medium text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div
                ref={codeMessagesRef}
                role="none"
                className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
                onContextMenu={chatMenu.open}
              >
                <div className="mx-auto w-full max-w-3xl space-y-4 px-6 pb-2">
                  {transcriptTab === "trajectory" ? (
                    <TrajectoryView
                      model={trajectoryModel}
                      startedAtMs={
                        activeTask.runStartedAt
                          ? parseTimestampMs(activeTask.runStartedAt)
                          : null
                      }
                      endedAtMs={
                        activeTask.runEndedAt
                          ? parseTimestampMs(activeTask.runEndedAt)
                          : null
                      }
                      focusToolCallId={trajectoryFocus}
                    />
                  ) : (
                    <>
                      {activeTask.runStartedAt ? (
                        <ElapsedEntry
                          startedAt={activeTask.runStartedAt}
                          endedAt={activeTask.runEndedAt}
                          running={activeTask.status === "running"}
                        />
                      ) : null}
                      {/*
                    上下文已自动压缩（R4-1 输出预留线的执行面）：说明「模型看到的历史被摘要过」，
                    而库里的转录仍然完整——不说这一句，用户会以为模型突然忘了前面的事。
                  */}
                      {activeTask.compacted ? (
                        <p
                          role="status"
                          className="rounded-md border bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground"
                        >
                          上下文已自动压缩：模型上下文超过{" "}
                          {formatTokens(activeTask.compacted.triggerTokens)}（
                          {
                            COMPACT_SOURCE_LABELS[
                              activeTask.compacted.triggerSource
                            ]
                          }
                          ）后，较早的消息被摘要成一条，只保留最近{" "}
                          {activeTask.compacted.keepMessages}{" "}
                          条；原文存在工作区的
                          /conversation_history/，这条对话的完整记录不受影响。
                        </p>
                      ) : null}
                      {/*
                    用户钩子（R5-2「钩子」）：在项目工作目录里跑的命令，成败都如实列出——
                    配了钩子却看不到结果，等于不知道它跑没跑。失败不影响本轮。
                  */}
                      {(activeTask.hookResults ?? []).map((hook) => (
                        <p
                          /* 同一条命令在起点/终点各配一次时事件不同，键按「事件+命令+耗时」取；
                         同一轮里同事件同命令只会出现一次（钩子表本身按事件+命令去重执行） */
                          key={`${hook.event}::${hook.command}::${hook.durationMs}`}
                          role="status"
                          className="rounded-md border bg-muted/40 px-3 py-1.5 font-mono text-[11px] text-muted-foreground"
                        >
                          {hook.event === "turn-start"
                            ? "本轮开始钩子"
                            : "本轮结束钩子"}
                          ：{hook.command}
                          {" · "}
                          {hook.timedOut
                            ? "超时被杀"
                            : hook.exitCode === 0
                              ? "成功"
                              : `退出码 ${hook.exitCode ?? "?"}`}
                          {hook.output ? ` · ${hook.output}` : ""}
                          {` · ${Math.max(1, Math.round(hook.durationMs / 1000))}s`}
                        </p>
                      ))}
                      {/* 目标 + 进度（R1-2）：模型用了 write_todos 才出现，条数从事件流推导 */}
                      {activeTask.todos && activeTask.todos.length > 0 ? (
                        <TodoProgressPanel
                          /* 目标 = 本轮的用户诉求（最后一条用户消息），不是首条——
                     首条是这条对话最初问的，跟当前这轮的待办不是一回事 */
                          goal={
                            [...activeTask.messages]
                              .reverse()
                              .find((message) => message.role === "user")
                              ?.text ?? activeTask.title
                          }
                          items={activeTask.todos}
                          running={activeTask.status === "running"}
                        />
                      ) : null}
                      {activeTask.subagents &&
                      activeTask.subagents.length > 0 ? (
                        <SubagentDirectoryView
                          entries={activeTask.subagents}
                          running={activeTask.status === "running"}
                        />
                      ) : null}
                      {(() => {
                        // 「最终总结」标题挂在本轮最后一个 assistant 消息上方（R1-1 收尾总结）
                        const shown = activeTask;
                        const lastAssistantIdx = shown.messages.reduce(
                          (last, msg, idx) =>
                            msg.role === "assistant" ? idx : last,
                          -1,
                        );
                        const showSummary =
                          activeTask.status === "completed" &&
                          Boolean(activeTask.runEndedAt) &&
                          lastAssistantIdx >= 0;
                        const streaming = activeTask.status === "running";
                        return shown.messages.map((msg, i) => {
                          // 轮级过程折叠（dsh 同款）：跑完且有结论的轮，结论前的
                          // 推理/工具/中途输出收进控制行；手动展开后逐行原位可见
                          const spec = specCoveringIndex(turnProcesses, i);
                          const foldKey = spec
                            ? `${activeTask.id}:${spec.turnIndex}`
                            : null;
                          const folded =
                            spec !== null &&
                            foldKey !== null &&
                            !expandedTurnProcesses.has(foldKey);
                          if (
                            folded &&
                            spec &&
                            i > spec.startIndex &&
                            i < spec.answerIndex
                          ) {
                            // 折叠区内的过程行：控制行展开后原位回来
                            return null;
                          }
                          const tailOnly =
                            folded &&
                            spec !== null &&
                            i === spec.answerIndex &&
                            msg.role === "assistant";
                          return (
                            // biome-ignore lint/suspicious/noArrayIndexKey: 流式为追加列表，消息的稳定身份就是位置；内容键会每个 token 换 key，把整条消息重挂载
                            <div key={i} className="space-y-2">
                              {spec && i === spec.startIndex ? (
                                <TurnProcessRow
                                  spec={spec}
                                  expanded={Boolean(
                                    foldKey &&
                                      expandedTurnProcesses.has(foldKey),
                                  )}
                                  onToggle={() =>
                                    setExpandedTurnProcesses((prev) => {
                                      const next = new Set(prev);
                                      if (foldKey && next.has(foldKey)) {
                                        next.delete(foldKey);
                                      } else if (foldKey) {
                                        next.add(foldKey);
                                      }
                                      return next;
                                    })
                                  }
                                />
                              ) : null}
                              {showSummary && i === lastAssistantIdx ? (
                                <div className="text-xs font-medium text-muted-foreground">
                                  最终总结
                                </div>
                              ) : null}
                              {/* 每条助手消息都带上「工作了多久」（用户口径：不能只显示一部分） */}
                              {msg.role === "assistant" &&
                              msg.elapsedMs !== undefined ? (
                                <div className="text-[11px] text-muted-foreground">
                                  已工作{" "}
                                  {formatElapsedSeconds(msg.elapsedMs / 1000)}
                                </div>
                              ) : null}
                              {msg.role === "user" ? (
                                <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground whitespace-pre-wrap">
                                  {msg.text}
                                </div>
                              ) : tailOnly && spec ? (
                                // 折叠态：答案消息只渲染尾部正文（过程块都在控制行里）；
                                // 与展开态同款无气泡排版
                                <div className="w-full max-w-full">
                                  <MarkdownRenderer
                                    text={spec.answerTailText}
                                  />
                                </div>
                              ) : (
                                <AssistantTurn
                                  msg={msg}
                                  streaming={
                                    streaming && i === shown.messages.length - 1
                                  }
                                  onInspectTool={(toolCallId) => {
                                    setTranscriptTab("trajectory");
                                    setTrajectoryFocus(toolCallId);
                                  }}
                                />
                              )}
                            </div>
                          );
                        });
                      })()}
                      {/*
                    检查点条（Code 模式）：本轮终态后拉到的影子快照——改了什么、可回滚。
                    仍在本轮运行中时禁用回滚（工作目录正被写入）。
                  */}
                      {activeTask.checkpoint ? (
                        <CheckpointChip
                          checkpoint={activeTask.checkpoint}
                          accessToken={session?.access_token ?? null}
                          canvasId={
                            conversationProject?.primaryCanvas.id ?? null
                          }
                          restoreDisabled={activeTask.status === "running"}
                        />
                      ) : null}
                      {activeTask.status === "running" ? (
                        <div
                          role="status"
                          className="flex w-fit items-center gap-1.5 rounded-2xl rounded-bl-md bg-muted px-4 py-3"
                          aria-label="生成中"
                        >
                          {[0, 1, 2].map((dot) => (
                            <span
                              key={dot}
                              className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/70"
                              style={{ animationDelay: `${dot * 150}ms` }}
                            />
                          ))}
                          <span className="ml-1 text-xs text-muted-foreground">
                            生成中…
                          </span>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
              {/* 底部：继续对话（完整版工具行 + 多轮，复用同一会话）。
                工作目录与分支已移到标题行右端，输入框不再背标签条。 */}

              <div className="shrink-0 pr-[var(--scrollbar-lane,0px)]">
                <form
                  className="mx-auto w-full max-w-3xl px-6 pt-3 pb-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const value = expandCommand(followUp, commands).text;
                    setFollowUp("");
                    continueTask(value);
                  }}
                >
                  <div className="@container/composer rounded-xl border bg-background px-3 pt-2.5 pb-2">
                    <textarea
                      ref={composerRef}
                      aria-label="继续对话"
                      value={followUp}
                      onChange={(e) => {
                        setFollowUp(e.target.value);
                        // 自动长高（并隐藏滚动条：对话框右侧不出现滚动条）
                        const el = e.currentTarget;
                        el.style.height = "auto";
                        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                      }}
                      onContextMenu={composerMenu.open}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          const value = followUp;
                          setFollowUp("");
                          continueTask(value);
                        }
                      }}
                      rows={1}
                      placeholder="继续追问…"
                      style={{ scrollbarWidth: "none" }}
                      className="max-h-40 min-h-[24px] w-full resize-none overflow-hidden bg-transparent text-sm outline-none placeholder:text-muted-foreground [&::-webkit-scrollbar]:hidden"
                    />
                    {workDirNotice ? (
                      <p className="mt-2 text-xs text-destructive">
                        {workDirNotice}
                      </p>
                    ) : null}
                    <div className="mt-1 flex items-center justify-between">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <button
                          type="button"
                          title="附件（即将上线）"
                          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                        <ComposerCompactSelect
                          ariaLabel="权限档位"
                          /* 图标随当前档位（四档各不相同），别再写死一个通用盾牌 */
                          icon={tierIcon(tier)}
                          options={TIER_OPTIONS}
                          value={tier}
                          onChange={(next) => {
                            void handleTierChange(next);
                          }}
                        />
                        <Select
                          aria-label="执行模式"
                          value={executionMode}
                          onValueChange={(next) => {
                            if (typeof next === "string")
                              setExecutionMode(next as ExecutionMode);
                          }}
                          // 词表可能还没到（要等会话就绪）：用本地兜底补齐六档，
                          // 否则这里会渲染原始 id（英文 agent），点开还是空列表
                          items={executionModeOptions(executionModes).map(
                            (m) => ({
                              value: m.id,
                              label: m.label,
                            }),
                          )}
                        >
                          <SelectTrigger
                            className="h-7 gap-1 border-transparent bg-muted/60 px-2 text-xs"
                            aria-label="执行模式"
                            hideChevron
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="min-w-28">
                            {executionModeOptions(executionModes).map((m) => (
                              <SelectItem key={m.id} value={m.id}>
                                {m.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select
                          aria-label="模型"
                          value={model}
                          onValueChange={(next) => {
                            if (typeof next === "string")
                              handleModelChange(next);
                          }}
                          items={
                            models.length === 0
                              ? [{ value: "", label: "未配置模型" }]
                              : models.map((m) => ({
                                  value: m.id,
                                  label: m.name,
                                }))
                          }
                        >
                          <SelectTrigger
                            className="h-7 max-w-[200px] gap-1 border-transparent bg-muted/60 px-2 text-xs"
                            aria-label="模型"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="max-w-[300px]">
                            {models.length === 0 ? (
                              <>
                                {/* 目录为空 = 没配过供应商（打包版首启动就是这个状态）：
                                    只显示「未配置模型」等于把用户留在死胡同，给一条直达设置的路 */}
                                <SelectItem value="">未配置模型</SelectItem>
                                <div className="-mx-1 my-1 border-t" />
                                <button
                                  type="button"
                                  onClick={() => setSettingsTab("providers")}
                                  className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                                >
                                  添加供应商…
                                </button>
                              </>
                            ) : (
                              models.map((m) => (
                                <SelectItem key={m.id} value={m.id}>
                                  <span className="flex items-center gap-1.5">
                                    <span>{m.name}</span>
                                    {m.vision ? (
                                      <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                                        视觉
                                      </span>
                                    ) : null}
                                  </span>
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                        {/* 上下文容量 / 缓存命中（R4-1）：模型旁一个圆形入口 */}
                        <ContextUsageButton
                          usage={activeTask.usage ?? null}
                          modelId={model}
                          contextWindow={modelMeta.contextWindow}
                          maxOutputTokens={modelMeta.maxOutputTokens}
                        />
                        <ComposerCompactSelect
                          ariaLabel="思考强度"
                          icon={<Brain className="h-3.5 w-3.5" />}
                          options={THINKING_OPTIONS}
                          value={thinking}
                          onChange={handleThinkingChange}
                          contentClassName="min-w-24"
                          progress={THINKING_PROGRESS[thinking] ?? 0}
                        />
                      </div>
                      {/* 右簇：麦克风 / 发送 —— 与左簇同一个 h-7 口径 */}
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          title="语音（即将上线）"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                        >
                          <Mic className="h-4 w-4" />
                        </button>
                        {activeTask.status === "running" &&
                        activeRunIdRef.current ? (
                          /* 停止 = 暂停图标（与发送按钮同一个图标位，不再是一枚突兀的文字按钮）；
                       与 Design 画布助手共用同一个组件，免得两处图标/文案漂移 */
                          <RunStopButton
                            onStop={() => {
                              const runId = activeRunIdRef.current;
                              if (runId) ws.cancelRun(runId);
                            }}
                          />
                        ) : (
                          <button
                            type="submit"
                            aria-label="发送"
                            disabled={!followUp.trim()}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
                          >
                            <Send className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </form>
              </div>
            </div>
            {/* 右栏停靠面板：编辑器式多标签（参考图 R3-1 的标签面板） */}
            <WorkbenchSidePanel
              open={panelOpen}
              onRequestOpen={() => setPanelOpen(true)}
              accessToken={session?.access_token ?? null}
              canvasId={conversationProject?.primaryCanvas.id ?? null}
              subagents={activeTask.subagents ?? []}
              running={activeTask.status === "running"}
              ws={ws}
              widthLimits={panelLimits}
              /* CSS 兜底：宿主不派发 resize 事件时 JS 的 limits 会陈旧，这条由排版保证
               对话列 ≥ MIN_CONVERSATION_WIDTH（数值与 lib/panel-layout 同一口径） */
              maxWidthExpression={`calc(100vw - var(--workbench-sidebar, 256px) - ${MIN_CONVERSATION_WIDTH}px)`}
              /* 拖到上限还往里拉 → 收起左栏腾地方（用户口径：再往左边拉，侧栏自动收起来） */
              onGrowBlocked={() => setSidebarCollapsed(true)}
              /* 右栏浏览器里拾取到的元素（R3-4）：写进追问输入框，用户补一句话就能发 */
              onPickElement={(picked) => {
                setFollowUp((current) =>
                  current.trim()
                    ? `${current}
${formatElementReference(picked)}`
                    : formatElementReference(picked),
                );
                composerRef.current?.focus();
              }}
            />
          </div>
        ) : (
          <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center px-6">
            <div className="mb-9 flex items-center gap-3">
              {/* 尺寸与笔画各调过一轮（用户口径：h-14 + stroke 3 太粗太大 → stroke 2 又太细）：
                  现在 h-9（36px 盒 → 墨高 18px）+ strokeWidth 2.5，取中间 */}
              {mode === "code" ? (
                <Code2 className="h-9 w-9" strokeWidth={2.5} />
              ) : (
                <Palette className="h-9 w-9" strokeWidth={2.5} />
              )}
              {/* 标题颜色**不动**（用户口径：这句的蓝色还原回去）——只保留字标字体 */}
              <h1 className="font-wordmark text-4xl tracking-tight">
                {meta.title}
              </h1>
            </div>

            <div className="w-full">
              {/* 工作目录 + 分支：贴住输入框上沿的标签条（文件夹标签的读法），
                  不再挤进输入框底部那排小控件 */}
              <div className="flex items-center gap-3 rounded-t-2xl border border-b-0 bg-muted/50 px-3 py-1.5">
                <WorkDirectorySelect
                  projects={codeProjects}
                  selectedProjectId={selectedProjectId}
                  busy={creatingProject}
                  onSelect={(projectId) => {
                    const project = codeProjects.find(
                      (p) => p.id === projectId,
                    );
                    selectWorkDir({
                      projectId,
                      name: project?.name ?? projectId,
                    });
                  }}
                  onOpenFolder={() => void pickWorkDirectory()}
                  onBindPath={bindWorkDirectory}
                  folderHint={folderPickerHint(nativeDirPicker)}
                  onClear={clearWorkDirectory}
                />
                <GitBranchSelect
                  accessToken={session?.access_token ?? null}
                  canvasId={selectedProject?.primaryCanvas.id ?? null}
                  /* 工作树里「绑为工作目录」：把这份工作树绑成当前项目的工作目录。
                     之后 agent/终端/git 都在那一份检出里跑——与「填本机路径」同一条
                     projects.work_dir 链，只是路径由工作树挑 */
                  onBindWorkDir={bindWorktreeToProject}
                />
              </div>
              <div className="@container/composer rounded-b-2xl border bg-background px-3 pt-3 pb-2.5 shadow-sm">
                <textarea
                  aria-label="任务描述"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      // 斜杠命令在提交前展开（转录里看到的就是实际发出去的）
                      startTask(expandCommand(prompt, commands).text);
                    }
                  }}
                  rows={2}
                  placeholder={
                    mode === "design"
                      ? "从想法到设计，生成可交付的页面原型。先在左侧创建一个项目。"
                      : meta.placeholder
                  }
                  className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
                {/* 正在敲 `/` 时的可用命令提示（有命令才出现；点一条即补全成 `/名字 `） */}
                {shouldSuggestCommands(prompt) && commands.length > 0 ? (
                  <p
                    role="status"
                    className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground"
                  >
                    <span>可用命令：</span>
                    {commands.map((command) => (
                      <button
                        key={command.name}
                        type="button"
                        title={
                          command.description || command.prompt.slice(0, 80)
                        }
                        onClick={() => setPrompt(`/${command.name} `)}
                        className="rounded bg-muted px-1.5 py-0.5 font-mono hover:text-foreground"
                      >
                        /{command.name}
                      </button>
                    ))}
                  </p>
                ) : null}
                {workDirNotice ? (
                  <p className="mt-2 text-xs text-destructive">
                    {workDirNotice}
                  </p>
                ) : null}
                <div className="mt-1.5 flex items-center justify-between">
                  {/* 左簇：附件 / 权限 / 执行模式 / 模型 / 上下文环 / 思考强度 —— 统一 h-7 与 gap-1.5 */}
                  <div className="flex min-w-0 items-center gap-1.5">
                    <button
                      type="button"
                      title="附件（即将上线）"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                    <ComposerCompactSelect
                      ariaLabel="权限档位"
                      icon={tierIcon(tier)}
                      options={TIER_OPTIONS}
                      value={tier}
                      onChange={(next) => {
                        void handleTierChange(next);
                      }}
                    />
                    <Select
                      aria-label="执行模式"
                      value={executionMode}
                      onValueChange={(next) => {
                        if (typeof next === "string")
                          setExecutionMode(next as ExecutionMode);
                      }}
                      items={executionModeOptions(executionModes).map((m) => ({
                        value: m.id,
                        label: m.label,
                      }))}
                    >
                      <SelectTrigger
                        className="h-7 gap-1 border-transparent bg-muted/60 px-2 text-xs"
                        aria-label="执行模式"
                        hideChevron
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="min-w-28">
                        {executionModeOptions(executionModes).map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      aria-label="模型"
                      value={model}
                      onValueChange={(next) => {
                        if (typeof next === "string") handleModelChange(next);
                      }}
                      items={
                        models.length === 0
                          ? [{ value: "", label: "未配置模型" }]
                          : models.map((m) => ({ value: m.id, label: m.name }))
                      }
                    >
                      <SelectTrigger
                        className="h-7 max-w-[200px] gap-1 border-transparent bg-muted/60 px-2 text-xs"
                        aria-label="模型"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-w-[300px]">
                        {models.length === 0 ? (
                          <>
                            {/* 目录为空就是「没配过供应商」：只显示「未配置模型」等于把用户
                                留在死胡同里（打包版首启动就是这个状态），给一条直达设置的路 */}
                            <SelectItem value="">未配置模型</SelectItem>
                            <div className="-mx-1 my-1 border-t" />
                            <button
                              type="button"
                              onClick={() => setSettingsTab("providers")}
                              className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                              添加供应商…
                            </button>
                          </>
                        ) : (
                          <>
                            {(() => {
                              // BYOK（providerName 存在）分组在前，内置目录在后
                              const byok = models.filter((m) => m.providerName);
                              const builtin = models.filter(
                                (m) => !m.providerName,
                              );
                              const badge = (m: (typeof models)[number]) => (
                                <>
                                  {m.vision ? (
                                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                                      视觉
                                    </span>
                                  ) : null}
                                  {m.contextWindow &&
                                  m.contextWindow >= 1_000_000 ? (
                                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                                      1M
                                    </span>
                                  ) : null}
                                </>
                              );
                              return (
                                <>
                                  {byok.length > 0 ? (
                                    <>
                                      <SelectLabel>
                                        {byok.at(0)?.providerName?.trim() ??
                                          "我的供应商"}
                                      </SelectLabel>
                                      {byok.map((m) => (
                                        <SelectItem key={m.id} value={m.id}>
                                          <span className="flex items-center gap-1.5">
                                            <span>{m.name}</span>
                                            {badge(m)}
                                          </span>
                                        </SelectItem>
                                      ))}
                                    </>
                                  ) : null}
                                  {builtin.length > 0 ? (
                                    <>
                                      <SelectLabel>内置模型</SelectLabel>
                                      {builtin.map((m) => (
                                        <SelectItem key={m.id} value={m.id}>
                                          <span className="flex items-center gap-1.5">
                                            <span>{m.name}</span>
                                            {badge(m)}
                                          </span>
                                        </SelectItem>
                                      ))}
                                    </>
                                  ) : null}
                                </>
                              );
                            })()}
                            <div className="-mx-1 my-1 border-t" />
                            <button
                              type="button"
                              onClick={() => setSettingsTab("providers")}
                              className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                              管理模型…
                            </button>
                          </>
                        )}
                      </SelectContent>
                    </Select>
                    {/* 上下文容量 / 缓存命中（R4-1）：模型旁一个圆形入口 */}
                    <ContextUsageButton
                      usage={null}
                      modelId={model}
                      contextWindow={modelMeta.contextWindow}
                      maxOutputTokens={modelMeta.maxOutputTokens}
                    />
                    <ComposerCompactSelect
                      ariaLabel="思考强度"
                      icon={<Brain className="h-3.5 w-3.5" />}
                      options={THINKING_OPTIONS}
                      value={thinking}
                      onChange={handleThinkingChange}
                      contentClassName="min-w-24"
                      progress={THINKING_PROGRESS[thinking] ?? 0}
                    />
                  </div>
                  {/* 右簇：麦克风 / 发送 —— 与左簇同一个 h-7 口径 */}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      title="语音（即将上线）"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                    >
                      <Mic className="h-4 w-4" />
                    </button>
                    {submitting ? (
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-label="发送"
                        disabled={!prompt.trim()}
                        onClick={() =>
                          startTask(expandCommand(prompt, commands).text)
                        }
                        className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
                      >
                        <Send className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-5 flex items-center gap-3">
              {meta.chips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => setPrompt(chip)}
                  className="rounded-full border px-4 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}
      </main>

      {/**
       * 「完全访问」的风险确认（用户口径：别用括号交代风险，改成弹窗 + 确定）。
       * 文案不用 markdown 语法（`**…**` 会原样显示出来）；按钮用仓库统一的 Button。
       */}
      <Dialog open={pendingFullAccess} onOpenChange={setPendingFullAccess}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-destructive" />
              开启「完全访问」？
            </DialogTitle>
            <DialogDescription>
              这一档不再逐条询问：改文件、跑命令、调用外部工具都会直接执行，出问题无法回滚。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPendingFullAccess(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => {
                setPendingFullAccess(false);
                void applyTier("full-access");
              }}
            >
              仍要开启
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SettingsModal
        open={settingsTab !== null}
        initialTab={settingsTab === null ? undefined : settingsTab}
        onClose={() => setSettingsTab(null)}
        accessToken={session?.access_token ?? null}
        /* 索引库按「画布 = 工作目录」建：Code 模式取对话绑定的项目，Design 取选中项目 */
        activeCanvasId={
          (mode === "code"
            ? (conversationProject ?? selectedProject)
            : selectedProject
          )?.primaryCanvas?.id ?? null
        }
        /* 引导页的状态来自真实数据：有没有工作目录项目、已有多少会话 */
        hasWorkDir={codeProjects.length > 0}
        conversationCount={tasks.length}
        isAdmin={isPlatformAdmin}
        onOpenAdmin={() => router.push("/admin")}
        key={mode}
      />
      {pluginsOpen ? (
        <PluginMarketModal
          open={pluginsOpen}
          onUse={handlePluginUse}
          onClose={() => setPluginsOpen(false)}
          accessToken={session?.access_token ?? null}
          // 「从工作目录安装」用：服务端据此解析沙箱目录
          canvasId={selectedProject?.primaryCanvas?.id ?? null}
          isAdmin={isPlatformAdmin}
        />
      ) : null}
      {skillsOpen ? (
        <SkillsModal
          open={skillsOpen}
          onClose={() => setSkillsOpen(false)}
          accessToken={session?.access_token ?? null}
          // 「从工作目录导入」用：两类项目都有主画布，服务端据此解析沙箱目录
          canvasId={selectedProject?.primaryCanvas?.id ?? null}
        />
      ) : null}
      {/* MCP 管理：从「设置」挪到侧栏（与技能并列），页面带精选目录与官方注册表 */}
      {mcpOpen ? (
        <McpModal
          open={mcpOpen}
          onClose={() => setMcpOpen(false)}
          accessToken={session?.access_token ?? null}
        />
      ) : null}
      <ComposerContextMenu
        state={composerMenu.state}
        items={composerMenu.items}
        onRun={(item) => void composerMenu.run(item)}
        onClose={composerMenu.close}
      />
      <ChatContextMenu
        state={chatMenu.state}
        messages={(activeTask?.messages ?? []).map((message) => ({
          role: message.role,
          text: message.text,
        }))}
        containerRef={codeMessagesRef}
        onPasteText={(text) => setFollowUp((prev) => `${prev}${text}`)}
        onNotice={(message) => setChatNotice(message)}
        onClose={chatMenu.close}
      />
      {chatNotice ? (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-[3000] -translate-x-1/2 rounded-xl border border-border bg-card px-4 py-2 text-xs text-foreground shadow-lg"
        >
          {chatNotice}
        </div>
      ) : null}
    </div>
  );
}
