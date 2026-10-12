"use client";

import type {
  ContentBlock,
  DesignApprovalListResponse,
  DesignApprovalResolveRequest,
  DesignGoalResponse,
  DesignTaskPolicyResponse,
  ImageArtifact,
  ImageGenerationPreference,
  MessageMention,
  StreamEvent,
  VideoArtifact,
} from "@kenfutwork/shared";
import { buildRefineContext } from "@kenfutwork/voice-ui";
import { PanelRight as PanelRightIcon, PanelsTopLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toChatMenuMessages } from "@/lib/chat-menu";
import { PluginPanelButtons } from "@/lib/plugin-panels";
import { extractSpeakableText, getVoicePlayback } from "@/lib/voice-playback";
import { useAgentModel } from "../hooks/use-agent-model";
import { useBreakpoint } from "../hooks/use-breakpoint";
import { useChatSessions } from "../hooks/use-chat-sessions";
import { useChatStream } from "../hooks/use-chat-stream";
import {
  INITIAL_AGENT_MODEL_KEY,
  INITIAL_ATTACHMENTS_KEY,
  INITIAL_IMAGE_GENERATION_PREFERENCE_KEY,
} from "../hooks/use-create-project";
import type { ReadyAttachment } from "../hooks/use-image-attachments";
import { useImageAttachments } from "../hooks/use-image-attachments";
import { useImageModelPreference } from "../hooks/use-image-model-preference";
import { useVideoModelPreference } from "../hooks/use-video-model-preference";
import type { WebSocketHandle } from "../hooks/use-websocket";
import { fetchBrandKit } from "../lib/brand-kit-api";
import {
  type ChatTab,
  closeTab as closeChatTab,
  loadTabs,
  pruneTabs,
  saveTabs,
  type TabKind,
  upsertTab,
  VIEW_TAB_TITLES,
} from "../lib/chat-tabs";
import {
  ApiApplicationError,
  createDesignGoal,
  fetchDesignGoal,
  fetchDesignTaskApprovals,
  fetchDesignTaskPolicy,
  fetchExecutionMode,
  fetchImageModels,
  fetchInstanceSkills,
  pauseDesignGoal,
  provisionDesignTask,
  resolveDesignTaskApproval,
  resumeDesignGoal,
  saveMessage,
  setDesignGoalBudget,
  updateDesignTaskPolicy,
} from "../lib/server-api";
import type { CanvasSelectedElement } from "./canvas-editor";
import {
  type BrandKitMentionItem,
  type CanvasImageItem,
  type ImageModelMentionItem,
  MessageMentionPicker,
  type MessageMentionPickerItem,
  type SkillMentionItem,
} from "./canvas-image-picker";
import { ChatContextMenu, useChatContextMenu } from "./chat/chat-context-menu";
import { ChatInput } from "./chat-input";
import { ChatMessage } from "./chat-message";
import { ChatSkills } from "./chat-skills";
import { useVoiceSettings } from "./composer-voice";
import { ErrorBoundary } from "./error-boundary";
import { ExecutionModeSelect } from "./execution-mode-select";
import { SessionSelector } from "./session-selector";
import { useToast } from "./toast";

/** 图层图标：空心叠层（同一套线宽与视框）。 */
function LayersStackIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2 2 7l10 5 10-5-10-5Z" />
      <path d="m2 17 10 5 10-5" />
      <path d="m2 12 10 5 10-5" />
    </svg>
  );
}

/** 生成文件图标：**原来在画布底部工具条上的那个**（折角文档 + 两行字）。 */
function GeneratedFileIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 17h6M9 13h6M13 3H8.2c-1.12 0-1.68 0-2.108.218a2 2 0 0 0-.874.874C5 4.52 5 5.08 5 6.2v11.6c0 1.12 0 1.68.218 2.108a2 2 0 0 0 .874.874C6.52 21 7.08 21 8.2 21h7.6c1.12 0 1.68 0 2.108-.218a2 2 0 0 0 .874-.874C19 19.48 19 18.92 19 17.8V9m-6-6 6 6m-6-6v4.4c0 .56 0 .84.109 1.054a1 1 0 0 0 .437.437C13.76 9 14.04 9 14.6 9H19" />
    </svg>
  );
}

/** 面板的三个视图：对话 / 图层 / 生成文件（对话视图内部再分「对话标签页」）。 */
export type SidePanelTab = "chat" | "layers" | "files";

type DesignTaskApproval = DesignApprovalListResponse["approvals"][number];
type DesignTaskApprovalPayload = DesignTaskApproval["payload"];
type DesignTaskApprovalOfKind<Kind extends DesignTaskApprovalPayload["kind"]> =
  Omit<DesignTaskApproval, "kind" | "payload"> & {
    kind: Kind;
    payload: Extract<DesignTaskApprovalPayload, { kind: Kind }>;
  };
type DesignTaskPermissionPayload = Extract<
  DesignTaskApprovalPayload,
  { kind: "permission" }
>;
type DesignTaskUserInputPayload = Extract<
  DesignTaskApprovalPayload,
  { kind: "userInput" }
>;

function mergeSelectedCanvasAttachments(
  attachments: ReadyAttachment[],
  selectedElements: CanvasSelectedElement[] | undefined = [],
  includeSelection: boolean,
): ReadyAttachment[] {
  if (!includeSelection) return attachments;
  const existingIds = new Set(
    attachments.map((attachment) => attachment.assetId),
  );
  const selected = (selectedElements ?? [])
    .filter(
      (element) =>
        element.type === "image" &&
        element.fileId &&
        (element.storageUrl || element.dataUrl),
    )
    .filter((element) => !existingIds.has(element.id))
    .map(
      (element): ReadyAttachment => ({
        assetId: element.id,
        url: element.storageUrl ?? element.dataUrl ?? "",
        mimeType: "image/png",
        source: "canvas-ref",
        name: `Canvas selection ${element.id.slice(0, 6)}`,
      }),
    );
  return selected.length ? [...attachments, ...selected] : attachments;
}

function createUserContentBlocks(
  text: string,
  mentions: MessageMention[],
  attachments: ReadyAttachment[],
): ContentBlock[] {
  const mentionBlocks: ContentBlock[] = mentions.map((mention) => {
    if (mention.mentionType === "image-model")
      return {
        type: "mention",
        mentionType: "image-model",
        id: mention.id,
        label: mention.label,
      };
    if (mention.mentionType === "brand-kit-asset")
      return {
        type: "mention",
        mentionType: "brand-kit-asset",
        id: mention.id,
        label: mention.label,
        assetType: mention.assetType,
        ...(mention.textContent !== undefined && mention.textContent !== null
          ? { textContent: mention.textContent }
          : {}),
        ...(mention.fileUrl !== undefined && mention.fileUrl !== null
          ? { fileUrl: mention.fileUrl }
          : {}),
      };
    return {
      type: "mention",
      mentionType: "skill",
      id: mention.id,
      label: mention.label,
      slug: mention.slug,
    };
  });
  return [
    { type: "text", text },
    ...mentionBlocks,
    ...attachments.map(
      (attachment): ContentBlock => ({
        type: "image",
        assetId: attachment.assetId,
        url: attachment.url,
        mimeType: attachment.mimeType,
        source: attachment.source,
        ...(attachment.name ? { name: attachment.name } : {}),
      }),
    ),
  ];
}

function designGoalStatusLabel(
  status: NonNullable<DesignGoalResponse["goal"]>["status"],
): string {
  return {
    active: "进行中",
    paused: "已暂停",
    verifying: "验证中",
    complete: "已完成",
    notSatisfied: "未满足",
    failed: "失败",
  }[status];
}

const DESIGN_GOAL_REASON_LABELS: Record<string, string> = {
  "user.pause": "手动暂停",
  "budget.stop": "预算已用尽",
  "budget.usageUnavailable": "用量暂不可用",
  "run.failed": "任务失败",
  "run.canceled": "任务已取消",
  "run.cancelled": "任务已取消",
  "task.branchChanged": "工作分支已变更",
  "host.restarted": "服务已重启",
  "plan.waiting": "等待计划确认",
  "interaction.waiting": "等待用户输入",
};

function designGoalReasonLabel(reason: string): string {
  return DESIGN_GOAL_REASON_LABELS[reason] ?? reason;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanApprovalInteraction(
  interaction: DesignTaskApproval,
): interaction is DesignTaskApprovalOfKind<"userInput"> {
  if (
    interaction.kind !== "userInput" ||
    interaction.payload.kind !== "userInput"
  )
    return false;
  const schema = interaction.payload.schema;
  return (
    isRecord(schema) &&
    schema.interaction === "plan_approval" &&
    schema.toolName === "ExitPlanMode"
  );
}

function planText(payload: DesignTaskUserInputPayload): string | null {
  if (!isRecord(payload.input)) return null;
  return typeof payload.input.plan === "string" ? payload.input.plan : null;
}

type ChatSidebarProps = {
  accessToken: string | null;
  canvasId: string;
  open: boolean;
  onToggle: () => void;
  onImageGenerated?: (artifact: ImageArtifact) => void;
  onVideoGenerated?: (artifact: VideoArtifact) => void;
  onCanvasSync?: () => void;
  /** Called for every stream event — used by job fallback polling to detect timed-out jobs */
  onStreamEvent?: (event: StreamEvent) => void;
  initialPrompt?: string | undefined;
  initialSessionId?: string | undefined;
  onSessionChange?: (sessionId: string) => void;
  onRequestCanvasImages?: () => CanvasImageItem[];
  currentBrandKitId?: string | null;
  ws: WebSocketHandle;
  selectedCanvasElements?: CanvasSelectedElement[];
  /** 当前标签（缺省「会话」）。 */
  panelTab?: SidePanelTab;
  onPanelTabChange?: (tab: SidePanelTab) => void;
  /** 「图层」标签的内容（由画布页提供）。 */
  layersPanel?: ReactNode;
  /** 「文件」标签的内容（由画布页提供）。 */
  filesPanel?: ReactNode;
};

export function ChatSidebar({
  accessToken,
  canvasId,
  open,
  onToggle,
  onImageGenerated,
  onVideoGenerated,
  onCanvasSync,
  onStreamEvent,
  initialPrompt,
  initialSessionId,
  onSessionChange,
  onRequestCanvasImages,
  currentBrandKitId,
  ws,
  selectedCanvasElements,
  panelTab = "chat",
  onPanelTabChange,
  layersPanel,
  filesPanel,
}: ChatSidebarProps) {
  const breakpoint = useBreakpoint();
  const isOverlay = breakpoint !== "desktop";

  // ── Session & message management (extracted hook with LRU cache) ──
  const {
    sessions,
    activeSessionId,
    activeSessionIdRef,
    messages,
    sessionsLoading,
    messagesLoading,
    streaming,
    setStreaming,
    updateSessionMessages,
    handleSelectSession,
    handleNewChat,
    handleDeleteSession,
    autoTitleSession,
    reloadMessages,
    readSessionMessages,
    accessTokenRef,
  } = useChatSessions({
    canvasId,
    accessToken,
    initialSessionId,
    onSessionChange,
  });

  // ── Stream event handler (extracted hook, shared between send & reconnect) ──
  const { applyStreamEvent, subscribeTaskEvents } = useChatStream(
    updateSessionMessages,
    ws,
  );

  /**
   * 语音播报（规划 §4.2「说」段 + §7 的「朗读回复」开关）：完整回路 + 开关打开时，
   * run 收尾后念这一轮的助手正文。读正文走 `readSessionMessages`（缓存同步写穿，
   * 含最后一批 delta）——读 React state 会漏掉收尾的最后一帧。
   */
  const voiceSettings = useVoiceSettings(accessToken);
  const voiceSettingsRef = useRef(voiceSettings);
  voiceSettingsRef.current = voiceSettings;
  // 切走画布（或卸载）即停播：播报属于当前画布，不该跟到下一页
  // biome-ignore lint/correctness/useExhaustiveDependencies: canvasId 只当触发器（换画布 = 停播），清理时读的 stop() 与它无关
  useEffect(() => () => getVoicePlayback().stop(), [canvasId]);
  /** 「想」段的指代消解上下文：最近几条会话消息（单条截断、条数封顶，见 voice-ui）。 */
  const voiceRecentMessages = useMemo(
    () =>
      buildRefineContext(
        messages.flatMap((message) =>
          message.role === "user" || message.role === "assistant"
            ? [
                {
                  role: message.role,
                  text: message.contentBlocks
                    .flatMap((block) =>
                      block.type === "text" ? [block.text] : [],
                    )
                    .join("\n"),
                },
              ]
            : [],
        ),
      ),
    [messages],
  );

  /**
   * 面板标签页：**对话**（每个打开的历史对话一个）＋**视图**（图层 / 生成文件，
   * 点对应按钮就开一个标签）。可多开、可关闭、左对齐；按画布分别存 localStorage，刷新后仍在。
   * 点历史对话＝新开一个标签而不是顶掉当前这轮。
   */
  const [openTabs, setOpenTabs] = useState<ChatTab[]>(() => loadTabs(canvasId));

  // 换画布 → 换一套标签
  useEffect(() => {
    setOpenTabs(loadTabs(canvasId));
  }, [canvasId]);

  // 当前会话始终保证有一个标签，标题随会话自动标题同步
  useEffect(() => {
    const current = sessions.find((s) => s.id === activeSessionId);
    if (!activeSessionId || !current) return;
    setOpenTabs((prev) => {
      const next = upsertTab(prev, {
        kind: "chat",
        id: current.id,
        title: current.title,
      });
      if (next !== prev) saveTabs(canvasId, next);
      return next;
    });
  }, [canvasId, activeSessionId, sessions]);

  // 会话被删（或在别处删了）→ 清掉对应标签；列表还在加载时不动，避免误清空
  useEffect(() => {
    if (sessionsLoading || sessions.length === 0) return;
    setOpenTabs((prev) => {
      const next = pruneTabs(
        prev,
        sessions.map((s) => s.id),
      );
      if (next !== prev) saveTabs(canvasId, next);
      return next;
    });
  }, [canvasId, sessions, sessionsLoading]);

  /** 打开（或切到）一个对话标签：已开过就切过去，没开过就新开一个。 */
  const handleOpenSessionTab = useCallback(
    (sessionId: string) => {
      const target = sessions.find((s) => s.id === sessionId);
      setOpenTabs((prev) => {
        const next = upsertTab(prev, {
          kind: "chat",
          id: sessionId,
          title: target?.title ?? "新对话",
        });
        if (next !== prev) saveTabs(canvasId, next);
        return next;
      });
      void handleSelectSession(sessionId);
    },
    [canvasId, sessions, handleSelectSession],
  );

  /** 打开（或切到）一个**视图标签**（图层 / 生成文件）：点按钮就多一个标签而不是切走。 */
  const handleOpenViewTab = useCallback(
    (kind: Exclude<TabKind, "chat">) => {
      setOpenTabs((prev) => {
        const next = upsertTab(prev, {
          kind,
          id: kind,
          title: VIEW_TAB_TITLES[kind],
        });
        if (next !== prev) saveTabs(canvasId, next);
        return next;
      });
      onPanelTabChange?.(kind);
    },
    [canvasId, onPanelTabChange],
  );

  /** 关标签：接替者由 closeTab 决定（右邻优先、其次左邻）；关光了就开一个空白对话。 */
  const handleCloseSessionTab = useCallback(
    (id: string, kind: TabKind) => {
      const { tabs: next, nextActiveId } = closeChatTab(
        openTabs,
        id,
        kind,
        panelTab === "chat" ? activeSessionId : panelTab,
      );
      if (next === openTabs) return;
      setOpenTabs(next);
      saveTabs(canvasId, next);
      if (!nextActiveId) {
        onPanelTabChange?.("chat");
        void handleNewChat();
        return;
      }
      // 接替者可能是视图标签（id 即视图名）也可能是会话标签
      const nextTab = next.find((t) => t.id === nextActiveId);
      if (nextTab && nextTab.kind !== "chat") {
        onPanelTabChange?.(nextTab.kind);
        return;
      }
      onPanelTabChange?.("chat");
      if (nextActiveId !== activeSessionId) {
        void handleSelectSession(nextActiveId);
      }
    },
    [
      canvasId,
      openTabs,
      activeSessionId,
      panelTab,
      onPanelTabChange,
      handleSelectSession,
      handleNewChat,
    ],
  );

  // ── Mention & attachment state ──
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [messageMentions, setMessageMentions] = useState<MessageMention[]>([]);
  const [brandKitMentionItems, setBrandKitMentionItems] = useState<
    BrandKitMentionItem[]
  >([]);
  const [imageModelMentionItems, setImageModelMentionItems] = useState<
    ImageModelMentionItem[]
  >([]);
  const [skillMentionItems, setSkillMentionItems] = useState<
    SkillMentionItem[]
  >([]);
  const chatInputRef = useRef<import("./chat-input").ChatInputHandle>(null);
  // 对话区右键菜单（原生菜单在应用内浏览器里不弹，用户无法复制/粘贴）
  const chatMenu = useChatContextMenu();

  const initialPromptSent = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  /** 对话内容容器（右键菜单「全选对话」用）。 */
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);
  /**
   * 当前在跑的 run id（提成状态是为了给「停止本轮」按钮用）。
   *
   * 事件回调里那个 `runIdRef` 是闭包内的临时变量，渲染层读不到，所以此前只有
   * 「等整轮跑完」一条路；重试换 id（run.retrying）时要同步更新，否则停的是旧 id。
   */
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const activeRunTaskIdRef = useRef<string | null>(null);
  const foregroundRunRef = useRef<{ taskId: string; runId: string } | null>(
    null,
  );
  const lastSeqByTaskRef = useRef(new Map<string, number>());
  const pendingAssistantByTaskRef = useRef(new Map<string, string>());
  const policyRequestRef = useRef(0);
  const designTaskPolicyRef = useRef<DesignTaskPolicyResponse["task"] | null>(
    null,
  );
  const [designGoalResponse, setDesignGoalResponse] =
    useState<DesignGoalResponse | null>(null);
  const [designGoalObjective, setDesignGoalObjective] = useState("");
  const [designGoalBudget, setDesignGoalBudgetInput] = useState("");
  const [designGoalError, setDesignGoalError] = useState<string | null>(null);
  const [designGoalBusy, setDesignGoalBusy] = useState(false);
  const [queuedGoalMessages, setQueuedGoalMessages] = useState(0);
  const [pendingGoalUserRuns, setPendingGoalUserRuns] = useState(0);
  const [pendingGoalAdmissions, setPendingGoalAdmissions] = useState(0);
  const pendingGoalAdmissionsRef = useRef(0);
  const designGoalResponseRef = useRef<DesignGoalResponse | null>(null);
  designGoalResponseRef.current = designGoalResponse;
  const designGoalTaskIdRef = useRef<string | null>(null);
  const designGoalFetchRequestRef = useRef(0);
  const goalUserInputChainRef = useRef<Promise<void>>(Promise.resolve());
  const goalUserRunIdsRef = useRef(
    new Map<string, { assistantId: string; queued: boolean }>(),
  );
  const queueTaskIdRef = useRef(activeSessionId);
  useEffect(() => {
    if (queueTaskIdRef.current === activeSessionId) return;
    queueTaskIdRef.current = activeSessionId;
    setDesignGoalObjective("");
    setDesignGoalBudgetInput("");
    goalUserRunIdsRef.current.clear();
    goalUserInputChainRef.current = Promise.resolve();
    setQueuedGoalMessages(0);
    setPendingGoalUserRuns(0);
    pendingGoalAdmissionsRef.current = 0;
    setPendingGoalAdmissions(0);
  }, [activeSessionId]);
  const [designTaskStatus, setDesignTaskStatus] = useState<
    "loading" | "ready" | "unprovisioned" | "provisioning" | "error"
  >("loading");
  const [designTaskError, setDesignTaskError] = useState<string | null>(null);
  const [designApprovals, setDesignApprovals] = useState<DesignTaskApproval[]>(
    [],
  );
  const [designApprovalsTaskId, setDesignApprovalsTaskId] = useState<
    string | null
  >(null);
  const [designApprovalError, setDesignApprovalError] = useState<string | null>(
    null,
  );
  const [designApprovalErrorTaskId, setDesignApprovalErrorTaskId] = useState<
    string | null
  >(null);
  const [resolvingInteractionId, setResolvingInteractionId] = useState<
    string | null
  >(null);
  const approvalRequestRef = useRef(0);
  const messageMentionsRef = useRef(messageMentions);
  messageMentionsRef.current = messageMentions;
  const selectedCanvasElementsRef = useRef(selectedCanvasElements);
  selectedCanvasElementsRef.current = selectedCanvasElements;
  const prevConnectedRef = useRef(false);

  const {
    attachments: imageAttachments,
    addFiles,
    addCanvasRef,
    retryUpload,
    removeAttachment,
    clearAll: clearAttachments,
    isUploading,
    readyAttachments,
  } = useImageAttachments(accessToken);

  const { activeImageGenerationPreference } = useImageModelPreference();
  const activeImageGenerationPreferenceRef = useRef(
    activeImageGenerationPreference,
  );
  activeImageGenerationPreferenceRef.current = activeImageGenerationPreference;

  const { activeVideoGenerationPreference } = useVideoModelPreference();
  const activeVideoGenerationPreferenceRef = useRef(
    activeVideoGenerationPreference,
  );
  activeVideoGenerationPreferenceRef.current = activeVideoGenerationPreference;

  const { model: agentModel } = useAgentModel();
  const agentModelRef = useRef(agentModel);
  agentModelRef.current = agentModel;

  const { toast: showToast } = useToast();
  const acceptDesignTaskPolicy = useCallback(
    (policy: DesignTaskPolicyResponse["task"]) => {
      if (policy.executionState !== "ready") {
        designTaskPolicyRef.current = null;
        setDesignTaskStatus("error");
        setDesignTaskError("画布任务当前不可运行，请重新加载。");
        return;
      }
      designTaskPolicyRef.current = policy;
      setDesignTaskStatus("ready");
      setDesignTaskError(null);
    },
    [],
  );

  useEffect(() => {
    const requestId = ++policyRequestRef.current;
    const sessionId = activeSessionId;
    designTaskPolicyRef.current = null;
    setDesignTaskError(null);
    if (!sessionId) {
      setDesignTaskStatus("error");
      setDesignTaskError("当前画布没有可用对话。");
      return;
    }
    setDesignTaskStatus("loading");
    void fetchDesignTaskPolicy(accessToken, sessionId)
      .then(({ task }) => {
        if (requestId !== policyRequestRef.current) return;
        if (task.taskId !== sessionId || task.canvasId !== canvasId) {
          setDesignTaskStatus("error");
          setDesignTaskError("当前对话与画布关联不一致，请重新加载。");
          return;
        }
        acceptDesignTaskPolicy(task);
      })
      .catch((error: unknown) => {
        if (requestId !== policyRequestRef.current) return;
        if (
          error instanceof ApiApplicationError &&
          error.code === "session_not_found"
        ) {
          setDesignTaskStatus("unprovisioned");
          return;
        }
        setDesignTaskStatus("error");
        setDesignTaskError(
          error instanceof Error ? error.message : "读取画布任务失败。",
        );
      });
  }, [accessToken, activeSessionId, acceptDesignTaskPolicy, canvasId]);

  useEffect(() => {
    const taskId = activeSessionId;
    if (designGoalTaskIdRef.current !== taskId) {
      designGoalTaskIdRef.current = taskId;
      designGoalResponseRef.current = null;
      setDesignGoalResponse(null);
    }
    setDesignGoalError(null);
    if (!taskId || designTaskStatus !== "ready") return;
    const requestId = ++designGoalFetchRequestRef.current;
    let cancelled = false;
    void fetchDesignGoal(accessToken, taskId)
      .then((response) => {
        if (
          !cancelled &&
          requestId === designGoalFetchRequestRef.current &&
          response.task.taskId === taskId &&
          response.task.canvasId === canvasId
        ) {
          designGoalResponseRef.current = response;
          setDesignGoalResponse(response);
          if (
            response.goal?.status === "active" ||
            response.goal?.status === "verifying"
          ) {
            setStreaming(true);
            if (response.acceptedRunId) {
              activeRunTaskIdRef.current = taskId;
              setActiveRunId(response.acceptedRunId);
            }
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setDesignGoalError(
            error instanceof Error ? error.message : "读取目标失败。",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, activeSessionId, canvasId, designTaskStatus, setStreaming]);

  const acceptGoalResponse = useCallback(
    (response: DesignGoalResponse) => {
      const taskId = activeSessionIdRef.current;
      if (
        !taskId ||
        response.task.taskId !== taskId ||
        response.task.canvasId !== canvasId
      ) {
        setDesignGoalError("目标与当前任务不匹配，请刷新后重试。");
        return false;
      }
      designGoalFetchRequestRef.current += 1;
      acceptDesignTaskPolicy(response.task);
      designGoalResponseRef.current = response;
      setDesignGoalResponse(response);
      setDesignGoalError(null);
      const foregroundRun = foregroundRunRef.current;
      const taskRunId = response.task.activeRunId;
      if (
        taskRunId &&
        ((foregroundRun?.taskId === taskId &&
          foregroundRun.runId === taskRunId) ||
          goalUserRunIdsRef.current.has(taskRunId))
      ) {
        setStreaming(true);
        activeRunTaskIdRef.current = taskId;
        setActiveRunId(taskRunId);
      } else if (
        goalUserRunIdsRef.current.size > 0 ||
        pendingGoalAdmissionsRef.current > 0
      ) {
        setStreaming(true);
        activeRunTaskIdRef.current = taskId;
        setActiveRunId(null);
      } else if (
        response.goal?.status === "active" ||
        response.goal?.status === "verifying"
      ) {
        setStreaming(true);
        const runId = response.acceptedRunId ?? taskRunId;
        if (runId) {
          activeRunTaskIdRef.current = taskId;
          setActiveRunId(runId);
        }
      } else {
        setStreaming(false);
        setActiveRunId(null);
        activeRunTaskIdRef.current = null;
      }
      return true;
    },
    [acceptDesignTaskPolicy, activeSessionIdRef, canvasId, setStreaming],
  );

  const mutateDesignGoal = useCallback(
    async (action: "create" | "pause" | "resume" | "budget") => {
      const task = designTaskPolicyRef.current;
      const goal = designGoalResponse?.goal;
      const taskId = activeSessionIdRef.current;
      if (!task || !taskId || task.taskId !== taskId || designGoalBusy) return;
      setDesignGoalBusy(true);
      setDesignGoalError(null);
      try {
        const fence = goal
          ? {
              goalId: goal.goalId,
              revision: goal.revision,
              branchGeneration: task.branchGeneration,
            }
          : null;
        let response: DesignGoalResponse;
        if (action === "create") {
          const tokenBudget = designGoalBudget.trim()
            ? Number(designGoalBudget)
            : null;
          if (
            tokenBudget !== null &&
            (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
          ) {
            setDesignGoalError("预算必须是正整数。");
            return;
          }
          response = await createDesignGoal(accessTokenRef.current, taskId, {
            objective: designGoalObjective,
            tokenBudget,
            expectedBranchGeneration: task.branchGeneration,
            expectedGoal: fence
              ? { goalId: fence.goalId, revision: fence.revision }
              : null,
            ...(typeof agentModelRef.current === "string"
              ? { model: agentModelRef.current }
              : {}),
          });
        } else {
          if (!fence) return;
          const request = { ...fence };
          if (action === "pause")
            response = await pauseDesignGoal(
              accessTokenRef.current,
              taskId,
              request,
            );
          else if (action === "resume")
            response = await resumeDesignGoal(accessTokenRef.current, taskId, {
              ...request,
              ...(typeof agentModelRef.current === "string"
                ? { model: agentModelRef.current }
                : {}),
            });
          else {
            const tokenBudget = designGoalBudget.trim()
              ? Number(designGoalBudget)
              : null;
            if (
              tokenBudget !== null &&
              (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
            ) {
              setDesignGoalError("预算必须是正整数。");
              return;
            }
            response = await setDesignGoalBudget(
              accessTokenRef.current,
              taskId,
              { ...request, tokenBudget },
            );
          }
        }
        if (acceptGoalResponse(response)) {
          if (action === "create") {
            setDesignGoalObjective("");
            setDesignGoalBudgetInput("");
          }
          if (response.acceptedRunId) {
            setActiveRunId(response.acceptedRunId);
            activeRunTaskIdRef.current = taskId;
            setStreaming(true);
          } else if (action === "create" || action === "resume") {
            const [refreshed] = await Promise.all([
              fetchDesignGoal(accessTokenRef.current, taskId),
              reloadMessages(taskId),
            ]);
            acceptGoalResponse(refreshed);
          }
        }
      } catch (error) {
        setDesignGoalError(
          error instanceof Error ? error.message : "目标操作失败。",
        );
      } finally {
        setDesignGoalBusy(false);
      }
    },
    [
      accessTokenRef,
      acceptGoalResponse,
      activeSessionIdRef,
      designGoalBudget,
      designGoalBusy,
      designGoalObjective,
      designGoalResponse,
      reloadMessages,
      setStreaming,
    ],
  );

  const handleProvisionDesignTask = useCallback(async () => {
    const taskId = activeSessionIdRef.current;
    if (!taskId || designTaskStatus !== "unprovisioned") return;
    const requestId = ++policyRequestRef.current;
    setDesignTaskStatus("provisioning");
    setDesignTaskError(null);
    try {
      const { task } = await provisionDesignTask(
        accessTokenRef.current,
        taskId,
      );
      if (requestId !== policyRequestRef.current) return;
      if (task.taskId !== taskId || task.canvasId !== canvasId) {
        setDesignTaskStatus("error");
        setDesignTaskError("当前对话与画布关联不一致，请重新加载。");
        return;
      }
      acceptDesignTaskPolicy(task);
    } catch (error) {
      if (requestId !== policyRequestRef.current) return;
      setDesignTaskStatus("error");
      setDesignTaskError(
        error instanceof Error ? error.message : "准备画布任务失败。",
      );
    }
  }, [
    acceptDesignTaskPolicy,
    activeSessionIdRef,
    canvasId,
    designTaskStatus,
    accessTokenRef,
  ]);

  // ── Sidebar resize ──
  const SIDEBAR_MIN = 300;
  const SIDEBAR_MAX = 600;
  const SIDEBAR_KEYBOARD_STEP = 20;
  const [sidebarWidth, setSidebarWidth] = useState(400);
  const isResizing = useRef(false);

  const clampWidth = useCallback(
    (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)),
    [],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isResizing.current) return;
        const delta = startX - moveEvent.clientX;
        setSidebarWidth(clampWidth(startWidth + delta));
      };

      const handleMouseUp = () => {
        isResizing.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [sidebarWidth, clampWidth],
  );

  // Touch support for resize handle (mobile / tablet)
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      isResizing.current = true;
      const startX = touch.clientX;
      const startWidth = sidebarWidth;

      const handleTouchMove = (moveEvent: TouchEvent) => {
        if (!isResizing.current) return;
        const t = moveEvent.touches[0];
        if (!t) return;
        moveEvent.preventDefault(); // prevent scroll during resize
        const delta = startX - t.clientX;
        setSidebarWidth(clampWidth(startWidth + delta));
      };

      const handleTouchEnd = () => {
        isResizing.current = false;
        document.removeEventListener("touchmove", handleTouchMove);
        document.removeEventListener("touchend", handleTouchEnd);
        document.removeEventListener("touchcancel", handleTouchEnd);
      };

      document.addEventListener("touchmove", handleTouchMove, {
        passive: false,
      });
      document.addEventListener("touchend", handleTouchEnd);
      document.addEventListener("touchcancel", handleTouchEnd);
    },
    [sidebarWidth, clampWidth],
  );

  // Keyboard support for resize handle (ArrowLeft/ArrowRight)
  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setSidebarWidth((prev) => clampWidth(prev + SIDEBAR_KEYBOARD_STEP));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setSidebarWidth((prev) => clampWidth(prev - SIDEBAR_KEYBOARD_STEP));
      }
    },
    [clampWidth],
  );

  // ── Auto-scroll to bottom ──
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: messages 只当触发器（滚动本身不读它）；去掉后新消息到达不再自动滚到底
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // ── Fetch image models for @mention picker ──
  useEffect(() => {
    let cancelled = false;

    fetchImageModels()
      .then((data) => {
        if (cancelled) return;
        setImageModelMentionItems(
          data.models.map((model) => ({
            kind: "image-model",
            id: model.id,
            label: model.displayName,
            description: model.description,
            ...(model.iconUrl ? { iconUrl: model.iconUrl } : {}),
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setImageModelMentionItems([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch enabled workspace skills for @ mention
  useEffect(() => {
    let cancelled = false;

    fetchInstanceSkills(accessToken)
      .then((data) => {
        if (cancelled) return;
        const allSkills = data.skills ?? [];
        const enabledSkills = allSkills.filter((s) => s.enabled);
        console.log(
          `[chat-sidebar] Workspace skills loaded: ${allSkills.length} total, ${enabledSkills.length} enabled`,
        );
        setSkillMentionItems(
          enabledSkills.map((s) => ({
            kind: "skill" as const,
            id: s.id,
            label: s.name,
            slug: s.slug,
            description: s.description,
          })),
        );
      })
      .catch((err) => {
        console.error("[chat-sidebar] Failed to load workspace skills:", err);
        if (!cancelled) setSkillMentionItems([]);
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  // ── Fetch brand kit items for @mention picker ──
  useEffect(() => {
    if (!currentBrandKitId) {
      setBrandKitMentionItems([]);
      return;
    }

    let cancelled = false;
    fetchBrandKit(accessTokenRef.current, currentBrandKitId)
      .then((kit) => {
        if (cancelled) return;
        setBrandKitMentionItems(
          kit.assets.map((asset) => ({
            kind: "brand-kit-asset" as const,
            id: asset.id,
            label: asset.display_name,
            assetType: asset.asset_type,
            textContent: asset.text_content,
            fileUrl: asset.file_url,
            thumbnailUrl:
              asset.asset_type === "logo" || asset.asset_type === "image"
                ? asset.file_url
                : null,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setBrandKitMentionItems([]);
      });

    return () => {
      cancelled = true;
    };
  }, [currentBrandKitId, accessTokenRef]);

  const submitGoalUserInput = useCallback(
    async (
      expectedTaskId: string,
      text: string,
      attachmentsOverride?: ReadyAttachment[],
      imagePreferenceOverride?: ImageGenerationPreference,
      mentionsOverride?: MessageMention[],
    ) => {
      const taskId = expectedTaskId;
      const task = designTaskPolicyRef.current;
      if (
        !taskId ||
        activeSessionIdRef.current !== taskId ||
        !task ||
        task.taskId !== taskId ||
        task.executionState !== "ready"
      )
        return;
      const mentions = mentionsOverride ?? messageMentionsRef.current;
      const attachments = mergeSelectedCanvasAttachments(
        attachmentsOverride ?? readyAttachments,
        selectedCanvasElementsRef.current,
        !attachmentsOverride,
      );
      const blocks = createUserContentBlocks(text, mentions, attachments);
      try {
        const saved = await saveMessage(accessTokenRef.current, taskId, {
          role: "user",
          content: text,
          contentBlocks: blocks,
        });
        if (activeSessionIdRef.current !== taskId) return;
        const inputId = saved.message.id;
        updateSessionMessages(taskId, (previous) => [
          ...previous,
          { id: inputId, role: "user" as const, contentBlocks: blocks },
        ]);
        autoTitleSession(text);
        const assistantId = `assistant-${inputId}`;
        pendingAssistantByTaskRef.current.set(taskId, assistantId);
        updateSessionMessages(taskId, (previous) => [
          ...previous,
          { id: assistantId, role: "assistant" as const, contentBlocks: [] },
        ]);

        let currentTask = (
          await fetchDesignTaskPolicy(accessTokenRef.current, taskId)
        ).task;
        if (
          activeSessionIdRef.current !== taskId ||
          currentTask.taskId !== taskId ||
          currentTask.canvasId !== canvasId ||
          currentTask.executionState !== "ready"
        )
          throw new Error("当前对话与画布关联不一致，请重新加载。");
        const mode = await fetchExecutionMode(accessTokenRef.current, taskId);
        if (activeSessionIdRef.current !== taskId) return;
        const planEnabled = mode.mode === "plan";
        if (currentTask.planEnabled !== planEnabled) {
          currentTask = (
            await updateDesignTaskPolicy(accessTokenRef.current, taskId, {
              expectedScopeGeneration: currentTask.scopeGeneration,
              expectedBranchGeneration: currentTask.branchGeneration,
              planEnabled,
            })
          ).task;
          if (activeSessionIdRef.current !== taskId) return;
        }
        acceptDesignTaskPolicy(currentTask);

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("WebSocket ack timeout")),
            10_000,
          );
          ws.startRun(
            {
              sessionId: taskId,
              conversationId: taskId,
              projectId: currentTask.projectId,
              taskId,
              canvasId: currentTask.canvasId,
              preset: "design",
              executionMode: mode.mode,
              inputId,
              scopeGeneration: currentTask.scopeGeneration,
              branchGeneration: currentTask.branchGeneration,
              prompt: text,
              ...(attachments.length ? { attachments } : {}),
              ...(mentions.length ? { mentions } : {}),
              ...((imagePreferenceOverride ??
              activeImageGenerationPreferenceRef.current)
                ? {
                    imageGenerationPreference:
                      imagePreferenceOverride ??
                      activeImageGenerationPreferenceRef.current,
                  }
                : {}),
              ...(activeVideoGenerationPreferenceRef.current
                ? {
                    videoGenerationPreference:
                      activeVideoGenerationPreferenceRef.current,
                  }
                : {}),
              ...(agentModelRef.current
                ? { model: agentModelRef.current }
                : {}),
            },
            (ack) => {
              clearTimeout(timeout);
              const payload = ack.payload as Record<string, unknown>;
              const id = payload.runId;
              if (payload.status === "rejected") {
                reject(
                  new ApiApplicationError(
                    typeof payload.code === "string"
                      ? payload.code
                      : "invalid_request",
                    typeof payload.message === "string"
                      ? payload.message
                      : "消息未能加入任务队列。",
                  ),
                );
                return;
              }
              if (
                payload.taskId !== taskId ||
                payload.sessionId !== taskId ||
                payload.inputId !== inputId ||
                typeof id !== "string"
              ) {
                reject(new Error("运行确认与当前对话不匹配，请刷新后重试。"));
                return;
              }
              const queued = payload.delivery === "queued";
              goalUserRunIdsRef.current.set(id, { assistantId, queued });
              setPendingGoalUserRuns((count) => count + 1);
              if (queued) setQueuedGoalMessages((count) => count + 1);
              clearAttachments();
              setMessageMentions([]);
              resolve();
            },
          );
        });
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : "消息未能加入任务队列。",
          "error",
        );
      }
    },
    [
      accessTokenRef,
      acceptDesignTaskPolicy,
      activeSessionIdRef,
      autoTitleSession,
      canvasId,
      clearAttachments,
      readyAttachments,
      showToast,
      updateSessionMessages,
      ws,
    ],
  );

  // ── Send message ──
  const handleSend = useCallback(
    async (
      text: string,
      attachmentsOverride?: ReadyAttachment[],
      imageGenerationPreferenceOverride?: ImageGenerationPreference,
      mentionsOverride?: MessageMention[],
    ) => {
      const currentSessionId = activeSessionIdRef.current;
      const goal = designGoalResponseRef.current?.goal;
      const taskQueueActive =
        goal?.status === "active" ||
        goal?.status === "verifying" ||
        goalUserRunIdsRef.current.size > 0 ||
        pendingGoalAdmissionsRef.current > 0;
      if (streaming || taskQueueActive) {
        if (
          currentSessionId &&
          taskQueueActive &&
          designTaskPolicyRef.current?.taskId === currentSessionId
        ) {
          pendingGoalAdmissionsRef.current += 1;
          setPendingGoalAdmissions(pendingGoalAdmissionsRef.current);
          goalUserInputChainRef.current = goalUserInputChainRef.current
            .then(() =>
              submitGoalUserInput(
                currentSessionId,
                text,
                attachmentsOverride,
                imageGenerationPreferenceOverride,
                mentionsOverride,
              ),
            )
            .catch((error: unknown) =>
              showToast(
                error instanceof Error
                  ? error.message
                  : "消息未能加入任务队列。",
                "error",
              ),
            )
            .finally(() => {
              pendingGoalAdmissionsRef.current = Math.max(
                0,
                pendingGoalAdmissionsRef.current - 1,
              );
              setPendingGoalAdmissions(pendingGoalAdmissionsRef.current);
              const currentGoal = designGoalResponseRef.current?.goal;
              if (
                pendingGoalAdmissionsRef.current === 0 &&
                goalUserRunIdsRef.current.size === 0 &&
                currentGoal?.status !== "active" &&
                currentGoal?.status !== "verifying"
              ) {
                setStreaming(false);
                setActiveRunId(null);
                activeRunTaskIdRef.current = null;
              }
            });
        }
        return;
      }
      if (!currentSessionId) return;
      if (designTaskStatus !== "ready") {
        if (designTaskStatus === "unprovisioned")
          showToast("请先准备画布任务", "error");
        else if (designTaskError) showToast(designTaskError, "error");
        return;
      }

      // 新的一次发送：上一句播报立刻让位（念着旧回复等新回复是最刺耳的形态）
      getVoicePlayback().stop();

      // Merge explicitly-attached images with auto-sensed canvas selection images
      const currentAttachments = mergeSelectedCanvasAttachments(
        attachmentsOverride ?? readyAttachments,
        selectedCanvasElementsRef.current,
        !attachmentsOverride,
      );
      const currentImageGenerationPreference =
        imageGenerationPreferenceOverride ??
        activeImageGenerationPreferenceRef.current;
      const currentVideoGenerationPreference =
        activeVideoGenerationPreferenceRef.current;
      const currentMentions = mentionsOverride ?? messageMentionsRef.current;

      setStreaming(true);
      abortRef.current = false;
      let assistantId: string | null = null;
      let cleanup: (() => void) | null = null;

      try {
        const contentBlocks = createUserContentBlocks(
          text,
          currentMentions,
          currentAttachments,
        );
        const saved = await saveMessage(
          accessTokenRef.current,
          currentSessionId,
          { role: "user", content: text, contentBlocks },
        );
        const inputId = saved.message.id;
        updateSessionMessages(currentSessionId, (prev) => [
          ...prev,
          { id: inputId, role: "user" as const, contentBlocks },
        ]);
        autoTitleSession(text);

        assistantId = `assistant-${inputId}`;
        pendingAssistantByTaskRef.current.set(currentSessionId, assistantId);
        updateSessionMessages(currentSessionId, (prev) => [
          ...prev,
          {
            id: assistantId as string,
            role: "assistant" as const,
            contentBlocks: [],
          },
        ]);
        let taskPolicy = (
          await fetchDesignTaskPolicy(accessTokenRef.current, currentSessionId)
        ).task;
        if (
          taskPolicy.taskId !== currentSessionId ||
          taskPolicy.canvasId !== canvasId
        )
          throw new Error("当前对话与画布关联不一致，请重新加载。");
        if (taskPolicy.executionState !== "ready")
          throw new Error("画布任务当前不可运行，请重新加载。");
        const { mode } = await fetchExecutionMode(
          accessTokenRef.current,
          currentSessionId,
        );
        const planEnabled = mode === "plan";
        if (taskPolicy.planEnabled !== planEnabled) {
          taskPolicy = (
            await updateDesignTaskPolicy(
              accessTokenRef.current,
              currentSessionId,
              {
                expectedScopeGeneration: taskPolicy.scopeGeneration,
                expectedBranchGeneration: taskPolicy.branchGeneration,
                planEnabled,
              },
            )
          ).task;
          if (
            taskPolicy.taskId !== currentSessionId ||
            taskPolicy.canvasId !== canvasId ||
            taskPolicy.planEnabled !== planEnabled ||
            taskPolicy.executionState !== "ready"
          )
            throw new Error("画布任务策略更新未生效，请重新加载。");
        }
        acceptDesignTaskPolicy(taskPolicy);

        const perf = {
          t0Send: performance.now(),
          tAck: 0,
          tFirstToken: 0,
          gotFirstToken: false,
        };

        let resolveStream: () => void;
        const streamDone = new Promise<void>((r) => {
          resolveStream = r;
        });
        let currentRunId = "";
        cleanup = subscribeTaskEvents(
          currentSessionId,
          "send",
          (event, seq, eventTaskId) => {
            if (
              activeRunTaskIdRef.current !== currentSessionId ||
              (eventTaskId !== undefined && eventTaskId !== currentSessionId)
            )
              return;
            // 重试会换一个新 runId（服务端 run.retrying 带着新 id）：先认领再过滤，
            // 否则这一轮后续事件（含终态）全被丢掉，助手永远停在「正在生成」。
            if (event.type === "run.retrying" && currentRunId) {
              currentRunId = event.runId;
              foregroundRunRef.current = {
                taskId: currentSessionId,
                runId: event.runId,
              };
              setActiveRunId(event.runId);
            }
            if (!currentRunId || event.runId !== currentRunId) return;
            if (seq !== undefined)
              lastSeqByTaskRef.current.set(
                currentSessionId,
                Math.max(
                  lastSeqByTaskRef.current.get(currentSessionId) ?? 0,
                  seq,
                ),
              );
            if (abortRef.current) {
              resolveStream();
              return;
            }

            // Track first token timing
            if (!perf.gotFirstToken && event.type === "message.delta") {
              perf.tFirstToken = performance.now();
              perf.gotFirstToken = true;
              console.log(
                `[perf] send → first token: ${(perf.tFirstToken - perf.t0Send).toFixed(0)}ms` +
                  ` (ack→token: ${(perf.tFirstToken - perf.tAck).toFixed(0)}ms)`,
              );
            }

            // Apply event to messages (single source of truth — shared with reconnect)
            applyStreamEvent(event, assistantId as string, currentSessionId);

            // Forward event to parent for fallback job polling (timed-out generation recovery)
            onStreamEvent?.(event);

            // Fire canvas insertion callbacks for image/video artifacts.
            // Skip if the backend already inserted the element (elementId in output).
            const backendInserted =
              event.type === "tool.completed" &&
              event.output &&
              typeof (event.output as Record<string, unknown>).elementId ===
                "string";
            if (
              event.type === "tool.completed" &&
              event.artifacts &&
              event.toolName !== "screenshot_canvas" &&
              !backendInserted
            ) {
              for (const artifact of event.artifacts) {
                if (artifact.type === "image" && onImageGenerated) {
                  onImageGenerated(artifact as ImageArtifact);
                }
                if (artifact.type === "video" && onVideoGenerated) {
                  onVideoGenerated(artifact as VideoArtifact);
                }
              }
            }

            if (event.type === "canvas.sync" && onCanvasSync) {
              onCanvasSync();
            }

            // Preview model hint: suggest switching when run fails
            if (event.type === "run.failed") {
              const currentModel = agentModelRef.current ?? "";
              if (currentModel.includes("preview")) {
                showToast(
                  "当前 Preview 模型请求不稳定，建议切换模型后重试",
                  "error",
                );
              }
            }

            if (
              event.type === "run.completed" ||
              event.type === "run.failed" ||
              event.type === "run.canceled"
            ) {
              if (foregroundRunRef.current?.taskId === currentSessionId)
                foregroundRunRef.current = null;
              pendingAssistantByTaskRef.current.delete(currentSessionId);
              resolveStream();
            }
          },
        );

        // Start run via WebSocket
        await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup?.();
            cleanup = null;
            reject(new Error("WebSocket ack timeout — connection may be down"));
          }, 10_000);

          ws.startRun(
            {
              sessionId: currentSessionId,
              conversationId: currentSessionId,
              projectId: taskPolicy.projectId,
              taskId: currentSessionId,
              canvasId: taskPolicy.canvasId,
              preset: "design",
              executionMode: mode,
              inputId,
              scopeGeneration: taskPolicy.scopeGeneration,
              branchGeneration: taskPolicy.branchGeneration,
              prompt: text,
              ...(currentAttachments.length > 0
                ? { attachments: currentAttachments }
                : {}),
              ...(currentMentions.length > 0
                ? { mentions: currentMentions }
                : {}),
              ...(currentImageGenerationPreference
                ? {
                    imageGenerationPreference: currentImageGenerationPreference,
                  }
                : {}),
              ...(currentVideoGenerationPreference
                ? {
                    videoGenerationPreference: currentVideoGenerationPreference,
                  }
                : {}),
              ...(agentModelRef.current
                ? { model: agentModelRef.current }
                : {}),
            },
            (ack) => {
              clearTimeout(timeout);
              perf.tAck = performance.now();
              console.log(
                `[perf] send → ack: ${(perf.tAck - perf.t0Send).toFixed(0)}ms`,
              );
              const payload = ack.payload as Record<string, unknown>;
              if (payload.status === "rejected") {
                pendingAssistantByTaskRef.current.delete(currentSessionId);
                reject(
                  new ApiApplicationError(
                    typeof payload.code === "string"
                      ? payload.code
                      : "invalid_request",
                    typeof payload.message === "string"
                      ? payload.message
                      : "画布任务未能受理此消息。",
                  ),
                );
                return;
              }
              const id = payload.runId;
              if (
                payload.taskId !== currentSessionId ||
                payload.sessionId !== currentSessionId ||
                payload.inputId !== inputId ||
                payload.scopeGeneration !== taskPolicy.scopeGeneration ||
                payload.branchGeneration !== taskPolicy.branchGeneration ||
                typeof id !== "string"
              ) {
                reject(new Error("运行确认与当前对话不匹配，请重新加载。"));
                return;
              }
              currentRunId = id;
              activeRunTaskIdRef.current = currentSessionId;
              foregroundRunRef.current = {
                taskId: currentSessionId,
                runId: id,
              };
              setActiveRunId(id);
              resolve(id);
            },
          );
        });
        clearAttachments();
        setMessageMentions([]);

        await streamDone;
        cleanup();
        cleanup = null;

        // 「说」段（规划 §4.2）：念这一轮的助手正文（代码块剔除）。只念该念的，
        // 失败静默——正文已在屏幕上，念不出来不影响用。
        const voice = voiceSettingsRef.current;
        if (voice.mode === "loop" && voice.speakReplies) {
          const reply = readSessionMessages(currentSessionId)?.find(
            (message) => message.id === assistantId,
          );
          const text = (reply?.contentBlocks ?? [])
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n");
          const speakable = extractSpeakableText(text);
          if (speakable) {
            void getVoicePlayback()
              .speak(accessTokenRef.current, speakable)
              .catch(() => undefined);
          }
        }
      } catch (error) {
        cleanup?.();
        const ackTimedOut =
          error instanceof Error && error.message.includes("ack timeout");
        const reason =
          error instanceof Error ? error.message : "发送消息失败。";
        if (ackTimedOut) {
          showToast("连接中断，正在续接任务。", "error");
          ws.reconnectNow();
        }
        if (assistantId) {
          if (!ackTimedOut)
            pendingAssistantByTaskRef.current.delete(currentSessionId);
          updateSessionMessages(currentSessionId, (prev) =>
            prev.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    contentBlocks: ackTimedOut
                      ? message.contentBlocks
                      : [
                          ...message.contentBlocks.filter(
                            (block) => block.type !== "text",
                          ),
                          { type: "text" as const, text: reason },
                        ],
                  }
                : message,
            ),
          );
        } else showToast(reason, "error");
      } finally {
        setStreaming(false);
        setActiveRunId(null);
        activeRunTaskIdRef.current = null;
        if (foregroundRunRef.current?.taskId === currentSessionId)
          foregroundRunRef.current = null;
      }
    },
    [
      streaming,
      designTaskStatus,
      designTaskError,
      acceptDesignTaskPolicy,
      canvasId,
      applyStreamEvent,
      setStreaming,
      showToast,
      updateSessionMessages,
      onImageGenerated,
      onVideoGenerated,
      onCanvasSync,
      onStreamEvent,
      readyAttachments,
      clearAttachments,
      ws,
      autoTitleSession,
      accessTokenRef,
      activeSessionIdRef,
      submitGoalUserInput,
      subscribeTaskEvents,
      readSessionMessages,
    ],
  );

  const handleResolveDesignApproval = useCallback(
    async (
      interaction: DesignTaskApproval,
      answer: DesignApprovalResolveRequest["answer"],
    ) => {
      const taskId = activeSessionIdRef.current;
      if (!taskId || taskId !== designApprovalsTaskId) return;
      setResolvingInteractionId(interaction.interactionId);
      setDesignApprovalError(null);
      try {
        await resolveDesignTaskApproval(
          accessTokenRef.current,
          taskId,
          interaction.interactionId,
          { answer },
        );
        if (activeSessionIdRef.current !== taskId) return;
        setDesignApprovals((previous) =>
          previous.filter(
            (item) => item.interactionId !== interaction.interactionId,
          ),
        );
      } catch (error) {
        if (activeSessionIdRef.current !== taskId) return;
        setDesignApprovalError(
          error instanceof Error
            ? error.message
            : "审批未能提交，请刷新后重试。",
        );
        setDesignApprovalErrorTaskId(taskId);
      } finally {
        setResolvingInteractionId(null);
      }
    },
    [accessTokenRef, activeSessionIdRef, designApprovalsTaskId],
  );

  useEffect(() => {
    const taskId = activeSessionId;
    const requestId = ++approvalRequestRef.current;
    setDesignApprovals([]);
    setDesignApprovalsTaskId(taskId);
    setDesignApprovalError(null);
    setDesignApprovalErrorTaskId(taskId);
    setResolvingInteractionId(null);
    if (!taskId || designTaskStatus !== "ready") return;

    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetchDesignTaskApprovals(
          accessTokenRef.current,
          taskId,
        );
        if (
          cancelled ||
          requestId !== approvalRequestRef.current ||
          activeSessionIdRef.current !== taskId
        )
          return;
        setDesignApprovalsTaskId(taskId);
        setDesignApprovals(response.approvals);
        setDesignApprovalError(null);
      } catch (error) {
        if (cancelled || activeSessionIdRef.current !== taskId) return;
        setDesignApprovalError(
          error instanceof Error ? error.message : "读取审批请求失败。",
        );
        setDesignApprovalErrorTaskId(taskId);
      }
    };
    void refresh();
    const polling =
      streaming && activeRunId !== null && activeRunTaskIdRef.current === taskId
        ? window.setInterval(refresh, 1000)
        : null;
    return () => {
      cancelled = true;
      if (polling !== null) window.clearInterval(polling);
    };
  }, [
    accessTokenRef,
    activeRunId,
    activeSessionId,
    activeSessionIdRef,
    designTaskStatus,
    streaming,
  ]);

  // ── Mention picker ──
  const mentionPickerItems: MessageMentionPickerItem[] = [
    ...(onRequestCanvasImages ? onRequestCanvasImages() : []),
    ...brandKitMentionItems,
    ...imageModelMentionItems,
    ...skillMentionItems,
  ];

  const handleMentionSelect = useCallback(
    (item: MessageMentionPickerItem) => {
      if (item.kind === "canvas-image") {
        addCanvasRef({
          assetId: item.assetId,
          url: item.url,
          mimeType: item.mimeType,
          name: item.name,
        });
        return;
      }

      setMessageMentions((prev) => {
        let nextMention: MessageMention;
        if (item.kind === "image-model") {
          nextMention = {
            mentionType: "image-model",
            id: item.id,
            label: item.label,
          };
        } else if (item.kind === "skill") {
          nextMention = {
            mentionType: "skill",
            id: item.id,
            label: item.label,
            slug: item.slug,
          };
        } else {
          nextMention = {
            mentionType: "brand-kit-asset",
            id: item.id,
            label: item.label,
            assetType: item.assetType,
            ...(item.textContent !== undefined
              ? { textContent: item.textContent }
              : {}),
            ...(item.fileUrl !== undefined ? { fileUrl: item.fileUrl } : {}),
          };
        }

        if (
          prev.some(
            (m) =>
              m.mentionType === nextMention.mentionType &&
              m.id === nextMention.id,
          )
        ) {
          return prev;
        }
        return [...prev, nextMention];
      });
    },
    [addCanvasRef],
  );

  const handleRemoveMention = useCallback((mention: MessageMention) => {
    setMessageMentions((prev) =>
      prev.filter(
        (item) =>
          !(item.mentionType === mention.mentionType && item.id === mention.id),
      ),
    );
  }, []);

  // ── Auto-send initial prompt ──
  useEffect(() => {
    if (
      !initialPrompt ||
      sessionsLoading ||
      !ws.connected ||
      designTaskStatus !== "ready" ||
      initialPromptSent.current
    )
      return;

    let storedAttachments: ReadyAttachment[] | undefined;
    let storedImageGenerationPreference: ImageGenerationPreference | undefined;
    let storedAgentModel: string | undefined;
    try {
      const raw = sessionStorage.getItem(INITIAL_ATTACHMENTS_KEY);
      if (raw) {
        storedAttachments = JSON.parse(raw) as ReadyAttachment[];
        sessionStorage.removeItem(INITIAL_ATTACHMENTS_KEY);
      }

      const preferenceRaw = sessionStorage.getItem(
        INITIAL_IMAGE_GENERATION_PREFERENCE_KEY,
      );
      if (preferenceRaw) {
        storedImageGenerationPreference = JSON.parse(
          preferenceRaw,
        ) as ImageGenerationPreference;
        sessionStorage.removeItem(INITIAL_IMAGE_GENERATION_PREFERENCE_KEY);
      }

      const modelRaw = sessionStorage.getItem(INITIAL_AGENT_MODEL_KEY);
      if (modelRaw) {
        storedAgentModel = modelRaw;
        sessionStorage.removeItem(INITIAL_AGENT_MODEL_KEY);
      }
    } catch {
      // Malformed JSON or unavailable storage
    }

    if (storedAgentModel) {
      agentModelRef.current = storedAgentModel;
    }

    const timer = setTimeout(() => {
      if (!activeSessionIdRef.current) return;
      initialPromptSent.current = true;
      void handleSend(
        initialPrompt,
        storedAttachments,
        storedImageGenerationPreference,
      );
    }, 0);

    return () => clearTimeout(timer);
  }, [
    initialPrompt,
    sessionsLoading,
    ws.connected,
    designTaskStatus,
    handleSend,
    activeSessionIdRef,
  ]);

  // ── Reconnection: resume the exact Design Task + reload messages ──
  // Uses the shared applyStreamEvent to handle live events — no duplicated logic.
  useEffect(() => {
    if (!ws.connected || sessionsLoading) {
      if (!ws.connected) prevConnectedRef.current = false;
      return;
    }
    if (prevConnectedRef.current) return;
    prevConnectedRef.current = true;

    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;

    // Skip if initialPrompt effect will handle binding
    if (initialPrompt && !initialPromptSent.current) return;
    const policyRequestId = ++policyRequestRef.current;

    void (async () => {
      // Reload messages from DB (server may have persisted while disconnected)
      await reloadMessages(sessionId);
      if (policyRequestId !== policyRequestRef.current) return;

      try {
        const { task } = await fetchDesignTaskPolicy(
          accessTokenRef.current,
          sessionId,
        );
        if (policyRequestId !== policyRequestRef.current) return;
        if (task.taskId !== sessionId || task.canvasId !== canvasId) {
          setDesignTaskStatus("error");
          setDesignTaskError("当前对话与画布关联不一致，请重新加载。");
          return;
        }
        acceptDesignTaskPolicy(task);
      } catch (error) {
        if (policyRequestId !== policyRequestRef.current) return;
        if (
          error instanceof ApiApplicationError &&
          error.code === "session_not_found"
        ) {
          designTaskPolicyRef.current = null;
          setDesignTaskStatus("unprovisioned");
          return;
        }
        setDesignTaskStatus("error");
        setDesignTaskError(
          error instanceof Error ? error.message : "读取画布任务失败。",
        );
        return;
      }

      try {
        const requestId = ++designGoalFetchRequestRef.current;
        const goalResponse = await fetchDesignGoal(
          accessTokenRef.current,
          sessionId,
        );
        if (
          requestId === designGoalFetchRequestRef.current &&
          activeSessionIdRef.current === sessionId &&
          goalResponse.task.taskId === sessionId &&
          goalResponse.task.canvasId === canvasId
        ) {
          designGoalTaskIdRef.current = sessionId;
          designGoalResponseRef.current = goalResponse;
          setDesignGoalResponse(goalResponse);
        }
      } catch (error) {
        if (activeSessionIdRef.current === sessionId)
          setDesignGoalError(
            error instanceof Error ? error.message : "读取目标失败。",
          );
      }

      try {
        ws.resumeTask(
          sessionId,
          lastSeqByTaskRef.current.get(sessionId) ?? 0,
          (ack) => {
            const payload = ack.payload as Record<string, unknown>;
            if (payload.status === "rejected") {
              setDesignTaskStatus("error");
              setDesignTaskError(
                typeof payload.message === "string"
                  ? payload.message
                  : "任务续接失败。",
              );
              return;
            }
            if (
              payload.taskId !== sessionId ||
              payload.canvasId !== canvasId ||
              typeof payload.latestSeq !== "number"
            ) {
              setDesignTaskStatus("error");
              setDesignTaskError("任务续接确认与当前对话不匹配，请重新加载。");
              setStreaming(false);
              setActiveRunId(null);
              return;
            }
            lastSeqByTaskRef.current.set(sessionId, payload.latestSeq);
            const replayGap = payload.replayGap === true;
            const activeRunId = payload.activeRunId;
            const refreshAfterGap = async () => {
              const requestId = ++policyRequestRef.current;
              await reloadMessages(sessionId);
              if (requestId !== policyRequestRef.current) return;
              const refreshed = await fetchDesignTaskPolicy(
                accessTokenRef.current,
                sessionId,
              );
              if (requestId !== policyRequestRef.current) return;
              if (
                refreshed.task.taskId !== sessionId ||
                refreshed.task.canvasId !== canvasId
              )
                throw new Error("当前对话与画布关联不一致，请重新加载。");
              acceptDesignTaskPolicy(refreshed.task);
            };
            /**
             * 服务端说「没有在跑的 run」时要把本地的「生成中」收掉。
             *
             * GUI 实测踩到：进程重启（含 dev 的 --watch 重建）会把在飞的 run 收敛成 failed，
             * 但客户端不知道——`streaming` 停在 true ⇒ 停止键常驻、输入框一直禁用，而那颗键
             * 指向一个已经不存在的 run（点了没反应）。这里是「run 失踪」的唯一兜底信号。
             */
            if (!activeRunId || typeof activeRunId !== "string") {
              setStreaming(false);
              setActiveRunId(null);
              activeRunTaskIdRef.current = null;
              if (foregroundRunRef.current?.taskId === sessionId)
                foregroundRunRef.current = null;
              pendingAssistantByTaskRef.current.delete(sessionId);
              if (replayGap)
                void refreshAfterGap().catch((error: unknown) => {
                  setDesignTaskStatus("error");
                  setDesignTaskError(
                    error instanceof Error ? error.message : "刷新对话失败。",
                  );
                });
              return;
            }
            {
              setStreaming(true);
              // 断线重连接上的这一轮同样要能停（否则重连后按钮消失，只能干等）
              activeRunTaskIdRef.current = sessionId;
              foregroundRunRef.current =
                designGoalResponseRef.current?.acceptedRunId === activeRunId
                  ? null
                  : { taskId: sessionId, runId: activeRunId };
              setActiveRunId(activeRunId);

              const assistantId =
                goalUserRunIdsRef.current.get(activeRunId)?.assistantId ??
                (designGoalResponseRef.current?.acceptedRunId === activeRunId &&
                designGoalResponseRef.current.goal
                  ? `goal-${designGoalResponseRef.current.goal.goalId}-${activeRunId}`
                  : (pendingAssistantByTaskRef.current.get(sessionId) ??
                    `resumed_${activeRunId}`));
              // Must use updateSessionMessages (not setMessages) so the placeholder
              // lands in msgCacheRef as well as React state. applyStreamEvent reads
              // from the cache — if the placeholder only lives in React state, stream
              // events can't find it and the first updateSessionMessages call
              // overwrites state back to the stale cache (losing the placeholder).
              updateSessionMessages(sessionId, (prev) => {
                if (prev.some((m) => m.id === assistantId)) return prev;
                return [
                  ...prev,
                  {
                    id: assistantId,
                    role: "assistant" as const,
                    contentBlocks: [],
                  },
                ];
              });

              // Reuse the shared stream event handler — eliminates ~70 lines of duplication
              let runId = activeRunId;
              let replayReady = !replayGap;
              const replayQueue: Array<{
                event: StreamEvent;
                seq?: number;
                taskId?: string;
              }> = [];
              const applyResumedEvent = (
                evt: StreamEvent,
                seq?: number,
                eventTaskId?: string,
              ) => {
                if (
                  activeRunTaskIdRef.current !== sessionId ||
                  (eventTaskId !== undefined && eventTaskId !== sessionId)
                )
                  return;
                if (evt.type === "run.retrying" && runId) {
                  runId = evt.runId;
                  foregroundRunRef.current = {
                    taskId: sessionId,
                    runId: evt.runId,
                  };
                  setActiveRunId(runId);
                }
                if (evt.runId !== runId) return;
                if (seq !== undefined)
                  lastSeqByTaskRef.current.set(
                    sessionId,
                    Math.max(lastSeqByTaskRef.current.get(sessionId) ?? 0, seq),
                  );

                applyStreamEvent(evt, assistantId, sessionId);
                onStreamEvent?.(evt);

                // Fire canvas insertion callbacks for artifacts arriving after reconnect.
                // Skip if the backend already inserted the element (elementId in output).
                const wsBackendInserted =
                  evt.type === "tool.completed" &&
                  evt.output &&
                  typeof (evt.output as Record<string, unknown>).elementId ===
                    "string";
                if (
                  evt.type === "tool.completed" &&
                  evt.artifacts &&
                  evt.toolName !== "screenshot_canvas" &&
                  !wsBackendInserted
                ) {
                  for (const artifact of evt.artifacts) {
                    if (artifact.type === "image" && onImageGenerated) {
                      onImageGenerated(artifact as ImageArtifact);
                    }
                    if (artifact.type === "video" && onVideoGenerated) {
                      onVideoGenerated(artifact as VideoArtifact);
                    }
                  }
                }

                if (evt.type === "canvas.sync" && onCanvasSync) {
                  onCanvasSync();
                }

                if (
                  evt.type === "run.completed" ||
                  evt.type === "run.failed" ||
                  evt.type === "run.canceled"
                ) {
                  const currentGoal = designGoalResponseRef.current?.goal;
                  if (currentGoal) {
                    void Promise.all([
                      fetchDesignGoal(accessTokenRef.current, sessionId),
                      reloadMessages(sessionId),
                    ]).then(([next]) => acceptGoalResponse(next));
                  } else {
                    setStreaming(false);
                    setActiveRunId(null);
                    activeRunTaskIdRef.current = null;
                    if (foregroundRunRef.current?.taskId === sessionId)
                      foregroundRunRef.current = null;
                    pendingAssistantByTaskRef.current.delete(sessionId);
                  }
                  unsub();
                }
              };
              let unsub = subscribeTaskEvents(
                sessionId,
                replayGap ? "replay" : "resume",
                (evt, seq, eventTaskId) => {
                  if (!replayReady) {
                    replayQueue.push({
                      event: evt,
                      ...(seq !== undefined ? { seq } : {}),
                      ...(eventTaskId ? { taskId: eventTaskId } : {}),
                    });
                    return;
                  }
                  applyResumedEvent(evt, seq, eventTaskId);
                },
              );
              if (replayGap)
                void refreshAfterGap()
                  .catch((error: unknown) => {
                    setDesignTaskStatus("error");
                    setDesignTaskError(
                      error instanceof Error ? error.message : "刷新对话失败。",
                    );
                  })
                  .finally(() => {
                    updateSessionMessages(sessionId, (previous) =>
                      previous.some((message) => message.id === assistantId)
                        ? previous
                        : [
                            ...previous,
                            {
                              id: assistantId,
                              role: "assistant" as const,
                              contentBlocks: [],
                            },
                          ],
                    );
                    replayReady = true;
                    for (const queued of replayQueue)
                      applyResumedEvent(
                        queued.event,
                        queued.seq,
                        queued.taskId,
                      );
                    unsub();
                    unsub = subscribeTaskEvents(
                      sessionId,
                      "resume",
                      applyResumedEvent,
                    );
                  });
            }
          },
        );
      } catch (error) {
        setDesignTaskStatus("error");
        setDesignTaskError(
          error instanceof Error ? error.message : "任务续接失败。",
        );
      }
    })();
  }, [
    ws.connected,
    ws,
    canvasId,
    sessionsLoading,
    applyStreamEvent,
    onStreamEvent,
    onImageGenerated,
    onVideoGenerated,
    onCanvasSync,
    activeSessionIdRef,
    accessTokenRef,
    acceptDesignTaskPolicy,
    reloadMessages,
    updateSessionMessages,
    setStreaming,
    initialPrompt,
    subscribeTaskEvents,
    acceptGoalResponse,
  ]);

  const currentDesignApprovals =
    designApprovalsTaskId === activeSessionId ? designApprovals : [];
  const currentDesignGoal =
    designGoalResponse?.task.taskId === activeSessionId
      ? designGoalResponse.goal
      : null;
  const queuedGoalMessageCount = queuedGoalMessages;

  useEffect(() => {
    const response = designGoalResponse;
    const taskId = activeSessionId;
    const goal = response?.goal;
    const goalActive =
      goal?.status === "active" || goal?.status === "verifying";
    const activeTaskRunId = response?.task.activeRunId;
    const taskRunBelongsToOtherInput =
      activeTaskRunId !== null &&
      activeTaskRunId !== undefined &&
      response?.acceptedRunId !== activeTaskRunId &&
      !goalUserRunIdsRef.current.has(activeTaskRunId);
    if (
      !taskId ||
      !goal ||
      (goalActive && taskRunBelongsToOtherInput) ||
      (!goalActive && goalUserRunIdsRef.current.size === 0)
    )
      return;
    let runId =
      response.acceptedRunId ??
      (activeTaskRunId && goalUserRunIdsRef.current.has(activeTaskRunId)
        ? activeTaskRunId
        : null);
    let assistantId = runId
      ? (goalUserRunIdsRef.current.get(runId)?.assistantId ??
        `goal-${goal.goalId}-${runId}`)
      : "";
    if (runId && goalUserRunIdsRef.current.has(runId))
      foregroundRunRef.current = { taskId, runId };
    let cancelled = false;
    if (runId) {
      activeRunTaskIdRef.current = taskId;
      setActiveRunId(runId);
      setStreaming(true);
      updateSessionMessages(taskId, (previous) =>
        previous.some((message) => message.id === assistantId)
          ? previous
          : [
              ...previous,
              {
                id: assistantId,
                role: "assistant" as const,
                contentBlocks: [],
              },
            ],
      );
    }
    let ownershipCheckRunId: string | null = null;
    let ownershipCheckEvents: Array<{
      event: StreamEvent;
      seq?: number;
      taskId?: string;
    }> = [];
    const handleGoalEvent = (
      event: StreamEvent,
      seq?: number,
      eventTaskId?: string,
    ) => {
      if (
        cancelled ||
        activeSessionIdRef.current !== taskId ||
        (eventTaskId && eventTaskId !== taskId)
      )
        return;
      if (ownershipCheckRunId) {
        if (event.runId === ownershipCheckRunId)
          ownershipCheckEvents.push({
            event,
            ...(seq !== undefined ? { seq } : {}),
            ...(eventTaskId ? { taskId: eventTaskId } : {}),
          });
        return;
      }
      if (
        event.type === "run.started" &&
        !runId &&
        !goalUserRunIdsRef.current.has(event.runId) &&
        goalActive
      ) {
        ownershipCheckRunId = event.runId;
        ownershipCheckEvents = [
          {
            event,
            ...(seq !== undefined ? { seq } : {}),
            ...(eventTaskId ? { taskId: eventTaskId } : {}),
          },
        ];
        void fetchDesignGoal(accessTokenRef.current, taskId)
          .then(async (authoritative) => {
            if (
              cancelled ||
              activeSessionIdRef.current !== taskId ||
              ownershipCheckRunId !== event.runId
            )
              return;
            const isGoalRun = authoritative.acceptedRunId === event.runId;
            const isTaskForegroundRun =
              authoritative.task.activeRunId === event.runId;
            if (!isGoalRun && !isTaskForegroundRun) {
              ownershipCheckEvents = [];
              ownershipCheckRunId = null;
              return;
            }
            if (!isGoalRun) await reloadMessages(taskId);
            if (cancelled || activeSessionIdRef.current !== taskId) return;
            const userInput = goalUserRunIdsRef.current.get(event.runId);
            runId = event.runId;
            assistantId =
              userInput?.assistantId ??
              (isGoalRun
                ? `goal-${goal.goalId}-${event.runId}`
                : (pendingAssistantByTaskRef.current.get(taskId) ??
                  `resumed_${event.runId}`));
            if (!isGoalRun)
              foregroundRunRef.current = { taskId, runId: event.runId };
            activeRunTaskIdRef.current = taskId;
            setActiveRunId(runId);
            setStreaming(true);
            updateSessionMessages(taskId, (previous) =>
              previous.some((message) => message.id === assistantId)
                ? previous
                : [
                    ...previous,
                    {
                      id: assistantId,
                      role: "assistant" as const,
                      contentBlocks: [],
                    },
                  ],
            );
            const buffered = ownershipCheckEvents;
            ownershipCheckEvents = [];
            ownershipCheckRunId = null;
            for (const queued of buffered)
              handleGoalEvent(queued.event, queued.seq, queued.taskId);
          })
          .catch((error: unknown) => {
            ownershipCheckEvents = [];
            ownershipCheckRunId = null;
            if (!cancelled)
              setDesignGoalError(
                error instanceof Error ? error.message : "读取运行归属失败。",
              );
          });
        return;
      }
      if (event.type === "run.started" && !runId) {
        const userInput = goalUserRunIdsRef.current.get(event.runId);
        if (!userInput && !goalActive) return;
        runId = event.runId;
        assistantId = userInput?.assistantId ?? `goal-${goal.goalId}-${runId}`;
        activeRunTaskIdRef.current = taskId;
        if (userInput)
          foregroundRunRef.current = { taskId, runId: event.runId };
        setActiveRunId(runId);
        setStreaming(true);
        updateSessionMessages(taskId, (previous) => [
          ...previous,
          { id: assistantId, role: "assistant" as const, contentBlocks: [] },
        ]);
      }
      if (event.type === "run.retrying" && runId) {
        const userInput = goalUserRunIdsRef.current.get(runId);
        if (userInput) {
          goalUserRunIdsRef.current.delete(runId);
          goalUserRunIdsRef.current.set(event.runId, userInput);
          if (foregroundRunRef.current?.taskId === taskId)
            foregroundRunRef.current = { taskId, runId: event.runId };
        }
        runId = event.runId;
        assistantId =
          goalUserRunIdsRef.current.get(runId)?.assistantId ??
          `goal-${goal.goalId}-${runId}`;
        setActiveRunId(runId);
      }
      if (!runId || event.runId !== runId) return;
      applyStreamEvent(event, assistantId, taskId);
      onStreamEvent?.(event);
      if (event.type === "canvas.sync") onCanvasSync?.();
      if (
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.canceled"
      ) {
        const userInput = goalUserRunIdsRef.current.get(runId);
        goalUserRunIdsRef.current.delete(runId);
        if (userInput)
          setPendingGoalUserRuns((count) => Math.max(0, count - 1));
        if (foregroundRunRef.current?.taskId === taskId)
          foregroundRunRef.current = null;
        if (userInput?.queued)
          setQueuedGoalMessages((count) => Math.max(0, count - 1));
        runId = null;
        setActiveRunId(null);
        void Promise.all([
          fetchDesignGoal(accessTokenRef.current, taskId),
          reloadMessages(taskId),
        ])
          .then(([next]) => {
            if (cancelled || activeSessionIdRef.current !== taskId) return;
            acceptGoalResponse(next);
            if (
              next.goal &&
              (next.goal.status === "active" ||
                next.goal.status === "verifying")
            ) {
              if (next.acceptedRunId) {
                runId = next.acceptedRunId;
                assistantId =
                  goalUserRunIdsRef.current.get(runId)?.assistantId ??
                  `goal-${next.goal.goalId}-${runId}`;
                updateSessionMessages(taskId, (previous) =>
                  previous.some((message) => message.id === assistantId)
                    ? previous
                    : [
                        ...previous,
                        {
                          id: assistantId,
                          role: "assistant" as const,
                          contentBlocks: [],
                        },
                      ],
                );
              }
              setStreaming(true);
            } else if (
              next.task.activeRunId &&
              ((foregroundRunRef.current?.taskId === taskId &&
                foregroundRunRef.current.runId === next.task.activeRunId) ||
                goalUserRunIdsRef.current.has(next.task.activeRunId))
            ) {
              runId = next.task.activeRunId;
              assistantId =
                goalUserRunIdsRef.current.get(runId)?.assistantId ??
                pendingAssistantByTaskRef.current.get(taskId) ??
                `resumed_${runId}`;
              foregroundRunRef.current = { taskId, runId };
              activeRunTaskIdRef.current = taskId;
              setActiveRunId(runId);
              setStreaming(true);
            } else {
              setStreaming(false);
              activeRunTaskIdRef.current = null;
            }
          })
          .catch((error: unknown) => {
            if (!cancelled)
              setDesignGoalError(
                error instanceof Error ? error.message : "刷新目标状态失败。",
              );
          });
      }
    };
    const unsubscribe = subscribeTaskEvents(taskId, "goal", handleGoalEvent);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    acceptGoalResponse,
    accessTokenRef,
    activeSessionId,
    activeSessionIdRef,
    applyStreamEvent,
    designGoalResponse,
    onCanvasSync,
    onStreamEvent,
    reloadMessages,
    setStreaming,
    subscribeTaskEvents,
    updateSessionMessages,
  ]);

  const currentDesignApprovalError =
    designApprovalErrorTaskId === activeSessionId ? designApprovalError : null;

  // ── Collapsed state ──
  if (!open) {
    return (
      <div className="absolute right-3 top-3 z-20">
        <button
          onClick={onToggle}
          type="button"
          className="group inline-flex items-center gap-1 rounded-xl bg-card border border-border px-2.5 py-1.5 text-xs text-foreground/60 shadow-sm hover:bg-card hover:text-foreground transition-colors cursor-pointer md:px-2.5 md:py-1.5 min-h-[36px] md:min-h-0"
        >
          <svg
            className="size-4 md:size-3.5"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              fill="currentColor"
              fillOpacity={0.9}
              d="M18.25 3c2.071 0 3.946 2.16 3.946 4.23L22 15.75a3.75 3.75 0 0 1-3.75 3.75h-2.874a.25.25 0 0 0-.16.058l-2.098 1.738a1.75 1.75 0 0 1-2.24-.007l-2.065-1.73a.25.25 0 0 0-.162-.059H5.75A3.75 3.75 0 0 1 2 15.75v-9A3.75 3.75 0 0 1 5.75 3zM7.5 10q-.053 0-.104.005a1.25 1.25 0 0 0-1.14 1.117l-.006.128.007.128a1.25 1.25 0 1 0 1.37-1.371l-.02-.002A1 1 0 0 0 7.5 10m4.5 0q-.053 0-.104.005a1.25 1.25 0 0 0-1.14 1.117l-.006.128.007.128a1.25 1.25 0 1 0 1.37-1.371l-.02-.002A1 1 0 0 0 12 10m4.5 0q-.053 0-.105.005a1.25 1.25 0 0 0-1.138 1.117l-.007.128.007.128a1.25 1.25 0 1 0 1.37-1.371l-.02-.002A1 1 0 0 0 16.5 10"
            />
          </svg>
          对话
        </button>
      </div>
    );
  }

  // Shared event isolation — prevent keyboard/clipboard events from bleeding
  // into Excalidraw canvas when the sidebar has focus.
  const eventIsolationProps = {
    onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
    onKeyUp: (e: React.KeyboardEvent) => e.stopPropagation(),
    onCopy: (e: React.ClipboardEvent) => e.stopPropagation(),
    onCut: (e: React.ClipboardEvent) => e.stopPropagation(),
    onPaste: (e: React.ClipboardEvent) => e.stopPropagation(),
    onWheel: (e: React.WheelEvent) => e.stopPropagation(),
  };

  // The inner panel content is shared across all breakpoints.
  // Extracted as a variable to avoid duplicating the chat UI tree
  // between overlay (mobile/tablet) and inline (desktop) render paths.
  const panelContent = (
    <>
      {/*
        Header：对话标签页（左对齐、可关闭、可开多个）＋ 历史记录入口 ＋ 图层/文件/收起。
        点历史对话＝**新开一个标签**而不是顶掉当前这轮；关掉最后一个标签会自动开一个空白
        对话，面板永远有可用输入区。
      */}
      {/* 第一行：对话标签页——任何视图下都在（切图层/文件不会把它顶掉） */}
      <div className="flex min-h-[40px] shrink-0 items-center gap-1.5 border-b border-border pl-2 pr-2">
        {/* 标签区：横向可滚但**不显示滚动条**（标签多了滚动条会盖住标签，
                「历史记录/新建对话」也被卷进去看不见——它们改放到右侧固定区） */}
        <div
          role="tablist"
          aria-label="打开的对话"
          style={{ scrollbarWidth: "none" }}
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-1.5 [&::-webkit-scrollbar]:hidden"
        >
          {openTabs.map((tab) => {
            const active =
              tab.kind === "chat"
                ? panelTab === "chat" && tab.id === activeSessionId
                : panelTab === tab.kind;
            return (
              <div
                key={`${tab.kind}:${tab.id}`}
                className={`group flex max-w-[160px] shrink-0 items-center gap-1 rounded-md px-2 py-1 transition-colors ${
                  active
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={tab.title}
                  onClick={() => {
                    if (tab.kind === "chat") {
                      handleOpenSessionTab(tab.id);
                    } else {
                      onPanelTabChange?.(tab.kind);
                    }
                  }}
                  className="min-w-0 flex-1 truncate text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {tab.title}
                </button>
                <button
                  type="button"
                  aria-label={`关闭 ${tab.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseSessionTab(tab.id, tab.kind);
                  }}
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors ${
                    active
                      ? "text-muted-foreground hover:bg-card hover:text-foreground"
                      : "text-transparent group-hover:text-muted-foreground hover:bg-card hover:text-foreground"
                  }`}
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    className="h-3 w-3"
                    aria-hidden="true"
                  >
                    <path
                      d="M4.5 4.5l7 7M11.5 4.5l-7 7"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
        {/* 插件面板（能力 `ui`）：对话槽位——Design 模式的对话界面就是这块画布内面板 */}
        <PluginPanelButtons
          mode="design"
          accessToken={accessToken}
          slot="conversation"
          renderButton={(panel, open) => (
            <button
              key={panel.id}
              type="button"
              onClick={open}
              title={`插件 ${panel.pluginId} 提供的面板`}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <PanelsTopLeft className="h-3.5 w-3.5" />
              <span className="max-w-[96px] truncate">{panel.title}</span>
            </button>
          )}
        />
      </div>
      {/* 第二行：模式 + 历史/新建 + 视图切换（对话/图层/文件）+ 收起（间距收紧，别留空档） */}
      <div className="flex min-h-[40px] shrink-0 items-center gap-1 border-b border-border pl-3 pr-2">
        {panelTab === "chat" && activeSessionId ? (
          <ExecutionModeSelect
            accessToken={accessToken}
            threadId={activeSessionId}
          />
        ) : (
          <span className="flex-1 text-xs font-medium text-foreground">
            {panelTab === "layers" ? "图层" : "生成文件"}
          </span>
        )}
        {/* 历史记录（含新建对话）：只在对话视图出现，紧贴「模式」右侧 */}
        {panelTab === "chat" && !sessionsLoading && (
          <SessionSelector
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelect={handleOpenSessionTab}
            onNewChat={handleNewChat}
            onDelete={handleDeleteSession}
          />
        )}
        {/* 视图切换：对话 / 图层 / 生成文件（不遮标签行，点哪个切哪个视图） */}
        <div className="ml-auto flex shrink-0 items-center justify-end gap-0.5">
          <button
            type="button"
            aria-label="对话"
            aria-pressed={panelTab === "chat"}
            title="对话"
            onClick={() => onPanelTabChange?.("chat")}
            className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
              panelTab === "chat"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <PanelRightIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="图层"
            aria-pressed={panelTab === "layers"}
            title="图层"
            onClick={() => handleOpenViewTab("layers")}
            className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
              panelTab === "layers"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <LayersStackIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="生成文件"
            aria-pressed={panelTab === "files"}
            title="生成文件"
            onClick={() => handleOpenViewTab("files")}
            className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
              panelTab === "files"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <GeneratedFileIcon className="h-4 w-4" />
          </button>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0"
          title="收起面板"
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M4 3.25a.75.75 0 0 1 .75.75v16a.75.75 0 0 1-1.5 0V4A.75.75 0 0 1 4 3.25m9.47 2.22a.75.75 0 0 1 1.06 0l6 6a.75.75 0 0 1 0 1.06l-6 6a.75.75 0 1 1-1.06-1.06l4.72-4.72H8a.75.75 0 0 1 0-1.5h10.19l-4.72-4.72a.75.75 0 0 1 0-1.06"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>

      {panelTab === "chat" ? (
        <>
          {/* Disconnected banner */}
          {!ws.connected && (
            <div className="flex items-center gap-2 px-4 py-2 bg-muted border-b border-border">
              <div className="h-2 w-2 rounded-full bg-red-500 animate-[pulse_1.2s_ease-in-out_infinite]" />
              <span className="text-[11px] text-muted-foreground">重连中…</span>
            </div>
          )}

          {/* Messages */}
          <ErrorBoundary
            onError={(err) =>
              console.error("[chat-sidebar] message area render crashed:", err)
            }
          >
            <div
              ref={messagesContainerRef}
              role="log"
              className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col gap-6 px-4 py-4"
              aria-live="polite"
              aria-relevant="additions"
              onContextMenu={chatMenu.open}
            >
              {sessionsLoading || messagesLoading ? (
                <div className="flex h-full items-center justify-center">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground" />
                </div>
              ) : messages.length === 0 ? (
                <ChatSkills onSend={handleSend} />
              ) : (
                messages.map((msg) => (
                  <ChatMessage
                    key={msg.id}
                    role={msg.role}
                    contentBlocks={msg.contentBlocks}
                    isStreaming={
                      streaming &&
                      msg.role === "assistant" &&
                      msg === messages[messages.length - 1]
                    }
                  />
                ))
              )}
              {currentDesignApprovalError ? (
                <div
                  role="alert"
                  className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
                >
                  {currentDesignApprovalError}
                </div>
              ) : null}
              {currentDesignApprovals.map((interaction) => {
                if (
                  interaction.kind === "permission" &&
                  interaction.payload.kind === "permission"
                ) {
                  const payload: DesignTaskPermissionPayload =
                    interaction.payload;
                  const options = [
                    ...payload.options,
                    ...(payload.fullAccessOption
                      ? [payload.fullAccessOption]
                      : []),
                  ];
                  return (
                    <section
                      key={interaction.interactionId}
                      aria-label="工具审批"
                      className="rounded-xl border border-border bg-card p-3"
                    >
                      <div className="mb-2 text-sm font-medium">
                        {payload.toolName}
                      </div>
                      <p className="mb-3 whitespace-pre-wrap text-sm text-muted-foreground">
                        {payload.summary}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {options.map((option) => (
                          <button
                            key={option.optionId}
                            type="button"
                            disabled={resolvingInteractionId !== null}
                            onClick={() =>
                              void handleResolveDesignApproval(interaction, {
                                optionId: option.optionId,
                              })
                            }
                            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                          >
                            {resolvingInteractionId ===
                            interaction.interactionId
                              ? "提交中…"
                              : option.label}
                          </button>
                        ))}
                      </div>
                    </section>
                  );
                }
                if (!isPlanApprovalInteraction(interaction)) return null;
                const question = interaction.payload.questions?.[0];
                if (!question) return null;
                const plan = planText(interaction.payload);
                return (
                  <section
                    key={interaction.interactionId}
                    aria-label="计划审批"
                    className="rounded-xl border border-border bg-card p-3"
                  >
                    <div className="mb-2 text-sm font-medium">
                      {question.question}
                    </div>
                    {plan ? (
                      <pre className="mb-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
                        {plan}
                      </pre>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      {question.options.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          disabled={resolvingInteractionId !== null}
                          onClick={() =>
                            void handleResolveDesignApproval(interaction, {
                              action:
                                option.value === "approve"
                                  ? "accept"
                                  : "decline",
                              content: {
                                answers: { [question.question]: option.value },
                                answer_0: option.value,
                                answer: option.value,
                              },
                            })
                          }
                          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                        >
                          {resolvingInteractionId === interaction.interactionId
                            ? "提交中…"
                            : option.label}
                        </button>
                      ))}
                    </div>
                  </section>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          </ErrorBoundary>

          {/* Input */}
          <div className="relative">
            {designTaskStatus === "loading" ? (
              <div
                className="mb-2 px-1 text-xs text-muted-foreground"
                aria-live="polite"
              >
                读取任务…
              </div>
            ) : null}
            {designTaskStatus === "provisioning" ? (
              <div
                className="mb-2 px-1 text-xs text-muted-foreground"
                aria-live="polite"
              >
                准备中…
              </div>
            ) : null}
            {designTaskStatus === "unprovisioned" ? (
              <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                <span>此对话尚未准备画布任务</span>
                <button
                  type="button"
                  onClick={() => void handleProvisionDesignTask()}
                  className="shrink-0 rounded px-2 py-1 font-medium text-foreground hover:bg-muted"
                >
                  准备任务
                </button>
              </div>
            ) : null}
            {designTaskStatus === "error" && designTaskError ? (
              <div role="alert" className="mb-2 px-1 text-xs text-destructive">
                {designTaskError}
              </div>
            ) : null}
            {designTaskStatus === "ready" ? (
              <section
                aria-label="持续目标"
                className="mb-2 rounded-lg border border-border p-3"
              >
                {currentDesignGoal ? (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs font-medium">
                          {currentDesignGoal.objective}
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {designGoalStatusLabel(currentDesignGoal.status)} · 第{" "}
                          {currentDesignGoal.iteration} 轮 ·{" "}
                          {Math.round(currentDesignGoal.tokensUsed)} tokens ·{" "}
                          {Math.round(currentDesignGoal.timeUsedSeconds)} 秒
                        </div>
                      </div>
                      {currentDesignGoal.status === "active" ||
                      currentDesignGoal.status === "verifying" ? (
                        <button
                          type="button"
                          disabled={designGoalBusy}
                          onClick={() => void mutateDesignGoal("pause")}
                          className="shrink-0 rounded border border-border px-2 py-1 text-xs"
                        >
                          暂停
                        </button>
                      ) : currentDesignGoal.status === "paused" ? (
                        <button
                          type="button"
                          disabled={designGoalBusy}
                          onClick={() => void mutateDesignGoal("resume")}
                          className="shrink-0 rounded border border-border px-2 py-1 text-xs"
                        >
                          恢复
                        </button>
                      ) : null}
                    </div>
                    {currentDesignGoal.reason ||
                    currentDesignGoal.verification ? (
                      <div className="mt-2 rounded bg-muted/50 p-2 text-xs">
                        {currentDesignGoal.reason ? (
                          <div>
                            {designGoalReasonLabel(currentDesignGoal.reason)}
                          </div>
                        ) : null}
                        {currentDesignGoal.verification ? (
                          <div className="mt-1">
                            <div>
                              {currentDesignGoal.verification.passed
                                ? "验证通过"
                                : "验证未通过"}{" "}
                              · {currentDesignGoal.verification.reason}
                            </div>
                            {currentDesignGoal.verification.evidence.map(
                              (item) => (
                                <div
                                  key={item.sourceId}
                                  className="mt-1 text-muted-foreground"
                                >
                                  {item.passed ? "通过" : "未通过"} ·{" "}
                                  {item.detail ?? item.sourceId}
                                </div>
                              ),
                            )}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {currentDesignGoal.status === "active" ||
                    currentDesignGoal.status === "paused" ||
                    currentDesignGoal.status === "verifying" ? (
                      <div className="mt-2 flex gap-2">
                        <input
                          aria-label="目标 Token 预算"
                          inputMode="numeric"
                          value={designGoalBudget}
                          onChange={(event) =>
                            setDesignGoalBudgetInput(event.target.value)
                          }
                          placeholder={
                            currentDesignGoal.tokenBudget === null
                              ? "不限预算"
                              : String(currentDesignGoal.tokenBudget)
                          }
                          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
                        />
                        <button
                          type="button"
                          disabled={designGoalBusy}
                          onClick={() => void mutateDesignGoal("budget")}
                          className="rounded border border-border px-2 py-1 text-xs"
                        >
                          更新预算
                        </button>
                      </div>
                    ) : null}
                    {currentDesignGoal.status === "complete" ||
                    currentDesignGoal.status === "notSatisfied" ||
                    currentDesignGoal.status === "failed" ? (
                      <div className="mt-2">
                        <div className="mb-2 text-xs font-medium">新建目标</div>
                        <div>
                          <input
                            aria-label="新目标"
                            value={designGoalObjective}
                            onChange={(event) =>
                              setDesignGoalObjective(event.target.value)
                            }
                            placeholder="描述要完成的工作"
                            className="mb-2 w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
                          />
                          <div className="flex gap-2">
                            <input
                              aria-label="新目标 Token 预算"
                              inputMode="numeric"
                              value={designGoalBudget}
                              onChange={(event) =>
                                setDesignGoalBudgetInput(event.target.value)
                              }
                              placeholder="不限预算"
                              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
                            />
                            <button
                              type="button"
                              disabled={
                                designGoalBusy || !designGoalObjective.trim()
                              }
                              onClick={() => void mutateDesignGoal("create")}
                              className="rounded border border-border px-2 py-1 text-xs"
                            >
                              开始目标
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                    {queuedGoalMessageCount > 0 ? (
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        已排队 {queuedGoalMessageCount} 条消息
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div className="mb-2 text-xs font-medium">持续目标</div>
                    <input
                      aria-label="目标"
                      value={designGoalObjective}
                      onChange={(event) =>
                        setDesignGoalObjective(event.target.value)
                      }
                      placeholder="描述要完成的工作"
                      className="mb-2 w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
                    />
                    <div className="flex gap-2">
                      <input
                        aria-label="目标 Token 预算"
                        inputMode="numeric"
                        value={designGoalBudget}
                        onChange={(event) =>
                          setDesignGoalBudgetInput(event.target.value)
                        }
                        placeholder="不限预算"
                        className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
                      />
                      <button
                        type="button"
                        disabled={designGoalBusy || !designGoalObjective.trim()}
                        onClick={() => void mutateDesignGoal("create")}
                        className="rounded border border-border px-2 py-1 text-xs"
                      >
                        开始目标
                      </button>
                    </div>
                  </>
                )}
                {designGoalError ? (
                  <div role="alert" className="mt-2 text-xs text-destructive">
                    {designGoalError}
                  </div>
                ) : null}
              </section>
            ) : null}
            {atQuery !== null && mentionPickerItems.length > 0 && (
              <MessageMentionPicker
                items={mentionPickerItems}
                query={atQuery}
                onSelect={(item) => {
                  handleMentionSelect(item);
                  chatInputRef.current?.clearAtQuery();
                  setAtQuery(null);
                }}
                onClose={() => setAtQuery(null)}
              />
            )}
            <ChatInput
              ref={chatInputRef}
              onSend={handleSend}
              disabled={
                (streaming &&
                  currentDesignGoal?.status !== "active" &&
                  currentDesignGoal?.status !== "verifying" &&
                  pendingGoalUserRuns === 0 &&
                  pendingGoalAdmissions === 0) ||
                sessionsLoading ||
                designTaskStatus !== "ready"
              }
              // 有活跃 run 才给停止键：没有 runId 时的「停止」是假按钮（点了不生效）
              onStop={
                streaming &&
                activeRunId &&
                activeSessionId &&
                activeRunTaskIdRef.current === activeSessionId
                  ? () =>
                      ws.cancelRun(activeSessionId, activeRunId, (ack) => {
                        const payload = ack.payload as Record<string, unknown>;
                        if (payload.status === "rejected") {
                          showToast(
                            typeof payload.message === "string"
                              ? payload.message
                              : "停止任务失败。",
                            "error",
                          );
                        } else if (
                          payload.taskId !== activeSessionId ||
                          payload.runId !== activeRunId
                        ) {
                          showToast(
                            "停止确认与当前运行不匹配，请刷新任务。",
                            "error",
                          );
                        } else if (payload.status === "targetChanged") {
                          showToast("当前运行已结束，请刷新任务。", "error");
                        }
                      })
                  : undefined
              }
              attachments={imageAttachments}
              onAddFiles={addFiles}
              onRemoveAttachment={removeAttachment}
              onRetryAttachment={retryUpload}
              isUploading={isUploading}
              onAtQuery={setAtQuery}
              mentions={messageMentions}
              onRemoveMention={handleRemoveMention}
              {...(selectedCanvasElements ? { selectedCanvasElements } : {})}
              {...(accessToken ? { accessToken } : {})}
              recentMessages={voiceRecentMessages}
            />
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {panelTab === "layers" ? layersPanel : filesPanel}
        </div>
      )}
    </>
  );

  // ── Mobile / Tablet: full-screen overlay with backdrop ──
  if (isOverlay) {
    return (
      <>
        {/* Semi-transparent backdrop — click to close */}
        <div
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] animate-in fade-in duration-200"
          onClick={onToggle}
        />
        {/* Chat panel — full screen on mobile, fixed-width drawer on tablet */}
        <div
          className={
            breakpoint === "mobile"
              ? "fixed inset-0 z-50 flex flex-col bg-card animate-in slide-in-from-right duration-250"
              : "fixed inset-y-0 right-0 z-50 flex w-[400px] flex-col border-l border-border bg-card shadow-2xl animate-in slide-in-from-right duration-250"
          }
          {...eventIsolationProps}
        >
          {panelContent}
        </div>
      </>
    );
  }

  // ── Desktop: inline side-by-side with resize handle ──
  return (
    <div
      className="flex h-full shrink-0"
      style={{ width: sidebarWidth }}
      {...eventIsolationProps}
    >
      {/* Resize handle -- supports mouse, touch, and keyboard (ArrowLeft/ArrowRight) */}
      {/* biome-ignore lint/a11y/useSemanticElements: 可聚焦的 ARIA separator（带 aria-valuenow 与方向键支持），不是 <hr> 这类内容分隔线 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整对话面板宽度"
        aria-valuenow={sidebarWidth}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        tabIndex={0}
        className="w-2 shrink-0 cursor-col-resize bg-gradient-to-r from-transparent via-border to-transparent shadow-[1px_0_10px_rgba(15,23,42,0.06)] transition-all hover:via-muted-foreground/40 hover:shadow-[1px_0_14px_rgba(15,23,42,0.1)] active:via-muted-foreground/60 active:shadow-[1px_0_16px_rgba(15,23,42,0.14)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onKeyDown={handleResizeKeyDown}
      />
      <div className="flex flex-1 flex-col bg-card min-w-0">{panelContent}</div>
      <ChatContextMenu
        state={chatMenu.state}
        messages={toChatMenuMessages(messages)}
        containerRef={messagesContainerRef}
        onPasteText={(text) => chatInputRef.current?.appendText(text)}
        onNotice={(message) => showToast(message)}
        onClose={chatMenu.close}
      />
    </div>
  );
}
