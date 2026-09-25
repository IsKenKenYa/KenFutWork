"use client";

import type {
  ContentBlock,
  ImageArtifact,
  ImageGenerationPreference,
  MessageMention,
  StreamEvent,
  VideoArtifact,
} from "@kenfutwork/shared";
import { PanelRight as PanelRightIcon, PanelsTopLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toChatMenuMessages } from "@/lib/chat-menu";
import { PluginPanelButtons } from "@/lib/plugin-panels";
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
import { claimDailyCredits } from "../lib/credits-api";
import {
  fetchImageModels,
  fetchWorkspaceSkills,
  saveMessage,
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
import { CreditInsufficientDialog } from "./credits/credit-insufficient-dialog";
import { useTierLimitToast } from "./credits/tier-limit-toast";
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

type ChatSidebarProps = {
  accessToken: string;
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
    accessTokenRef,
  } = useChatSessions({
    canvasId,
    accessToken,
    initialSessionId,
    onSessionChange,
  });

  // ── Stream event handler (extracted hook, shared between send & reconnect) ──
  const { applyStreamEvent } = useChatStream(updateSessionMessages);

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
  const [creditDialog, setCreditDialog] = useState<{
    open: boolean;
    currentBalance: number;
    requiredAmount: number;
    plan: string;
    dailyClaimed: boolean;
  } | null>(null);
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

  const { showTierLimit } = useTierLimitToast();
  const { toast: showToast } = useToast();

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
    if (!accessToken) return;
    let cancelled = false;

    fetchWorkspaceSkills(accessToken)
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

  // ── Send message ──
  const handleSend = useCallback(
    async (
      text: string,
      attachmentsOverride?: ReadyAttachment[],
      imageGenerationPreferenceOverride?: ImageGenerationPreference,
      mentionsOverride?: MessageMention[],
    ) => {
      const currentSessionId = activeSessionIdRef.current;
      if (streaming || !currentSessionId) return;

      // Merge explicitly-attached images with auto-sensed canvas selection images
      let currentAttachments = attachmentsOverride ?? readyAttachments;
      const selectedEls = selectedCanvasElementsRef.current ?? [];
      const selectedImageEls = selectedEls.filter(
        (el) =>
          el.type === "image" && el.fileId && (el.storageUrl || el.dataUrl),
      );
      if (selectedImageEls.length > 0 && !attachmentsOverride) {
        const existingIds = new Set(currentAttachments.map((a) => a.assetId));
        const selectionAttachments: ReadyAttachment[] = selectedImageEls
          .filter((el) => !existingIds.has(el.id))
          .map((el) => ({
            assetId: el.id,
            url: el.storageUrl ?? el.dataUrl ?? "",
            mimeType: "image/png",
            source: "canvas-ref" as const,
            name: `Canvas selection ${el.id.slice(0, 6)}`,
          }));
        if (selectionAttachments.length > 0) {
          currentAttachments = [...currentAttachments, ...selectionAttachments];
        }
      }
      const currentImageGenerationPreference =
        imageGenerationPreferenceOverride ??
        activeImageGenerationPreferenceRef.current;
      const currentVideoGenerationPreference =
        activeVideoGenerationPreferenceRef.current;
      const currentMentions = mentionsOverride ?? messageMentionsRef.current;

      // Add user message locally
      const imageBlocks: ContentBlock[] = currentAttachments.map((a) => ({
        type: "image" as const,
        assetId: a.assetId,
        url: a.url,
        mimeType: a.mimeType,
        source: a.source,
        ...(a.name ? { name: a.name } : {}),
      }));
      const mentionBlocks: ContentBlock[] = currentMentions.map((mention) => {
        if (mention.mentionType === "image-model") {
          return {
            type: "mention" as const,
            mentionType: "image-model" as const,
            id: mention.id,
            label: mention.label,
          };
        }
        if (mention.mentionType === "brand-kit-asset") {
          return {
            type: "mention" as const,
            mentionType: "brand-kit-asset" as const,
            id: mention.id,
            label: mention.label,
            assetType: mention.assetType,
            ...(mention.textContent !== undefined &&
            mention.textContent !== null
              ? { textContent: mention.textContent }
              : {}),
            ...(mention.fileUrl !== undefined && mention.fileUrl !== null
              ? { fileUrl: mention.fileUrl }
              : {}),
          };
        }
        return {
          type: "mention" as const,
          mentionType: "skill" as const,
          id: mention.id,
          label: mention.label,
          slug: mention.slug,
        };
      });
      const userMsg = {
        id: `user-${Date.now()}`,
        role: "user" as const,
        contentBlocks: [
          { type: "text" as const, text },
          ...mentionBlocks,
          ...imageBlocks,
        ],
      };
      updateSessionMessages(currentSessionId, (prev) => [...prev, userMsg]);

      // Persist user message (fire-and-forget)
      saveMessage(accessTokenRef.current, currentSessionId, {
        role: "user",
        content: text,
        contentBlocks: [
          { type: "text" as const, text },
          ...mentionBlocks,
          ...imageBlocks,
        ],
      }).catch((err) =>
        console.error("[chat] Failed to save user message:", err),
      );

      // Auto-title from first user message
      autoTitleSession(text);

      // Create assistant placeholder
      const assistantId = `assistant-${Date.now()}`;
      updateSessionMessages(currentSessionId, (prev) => [
        ...prev,
        { id: assistantId, role: "assistant" as const, contentBlocks: [] },
      ]);
      setStreaming(true);
      abortRef.current = false;

      try {
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
        const runIdRef = { current: "" };

        const cleanup = ws.onEvent((event) => {
          // 重试会换一个新 runId（服务端 run.retrying 带着新 id）：先认领再过滤，
          // 否则这一轮后续事件（含终态）全被丢掉，助手永远停在「正在生成」。
          if (event.type === "run.retrying" && runIdRef.current) {
            runIdRef.current = event.runId;
            setActiveRunId(event.runId);
          }
          if (!runIdRef.current || event.runId !== runIdRef.current) return;
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

          // Billing error: route to appropriate UI, run.canceled will follow
          if (event.type === "billing.error") {
            if (event.code === "insufficient_credits") {
              setCreditDialog({
                open: true,
                currentBalance: event.currentBalance ?? 0,
                requiredAmount: event.requiredAmount ?? 0,
                plan: event.plan ?? "free",
                dailyClaimed: event.dailyClaimed ?? false,
              });
            } else {
              // model_not_accessible, resolution_not_allowed, concurrency_limit
              showTierLimit({ code: event.code, message: event.message });
            }
          }

          // Apply event to messages (single source of truth — shared with reconnect)
          applyStreamEvent(event, assistantId, currentSessionId);

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
            resolveStream();
          }
        });

        // Start run via WebSocket
        await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("WebSocket ack timeout — connection may be down"));
          }, 10_000);

          ws.startRun(
            {
              sessionId: currentSessionId,
              conversationId: canvasId,
              prompt: text,
              canvasId,
              accessToken: accessTokenRef.current,
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
              const id = ack.payload.runId as string;
              runIdRef.current = id;
              setActiveRunId(id);
              resolve(id);
            },
          );
        });
        clearAttachments();
        setMessageMentions([]);

        await streamDone;
        cleanup();
      } catch {
        updateSessionMessages(currentSessionId, (prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m;
            const hasText = m.contentBlocks.some((b) => b.type === "text");
            if (hasText) return m;
            return {
              ...m,
              contentBlocks: [
                ...m.contentBlocks,
                { type: "text" as const, text: "没有收到回复，请重试。" },
              ],
            };
          }),
        );
      } finally {
        setStreaming(false);
        setActiveRunId(null);
      }
    },
    [
      streaming,
      canvasId,
      applyStreamEvent,
      setStreaming,
      showTierLimit,
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
    ],
  );

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
    handleSend,
    activeSessionIdRef,
  ]);

  // ── Reconnection: resume canvas binding + reload messages ──
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

    void (async () => {
      // Reload messages from DB (server may have persisted while disconnected)
      await reloadMessages(sessionId);

      // Resume canvas binding (after DB messages are set)
      ws.resumeCanvas(canvasId, (ack) => {
        const activeRunId = (ack.payload as Record<string, unknown>)
          .activeRunId;
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
          return;
        }
        {
          setStreaming(true);
          // 断线重连接上的这一轮同样要能停（否则重连后按钮消失，只能干等）
          setActiveRunId(activeRunId);

          const assistantId = `resumed_${activeRunId}`;
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
          const unsub = ws.onEvent((evt) => {
            if (evt.runId !== activeRunId) return;

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
              setStreaming(false);
              setActiveRunId(null);
              unsub();
            }
          });
        }
      });
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
    reloadMessages,
    updateSessionMessages,
    setStreaming,
    initialPrompt,
  ]);

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
        {panelTab === "chat" && activeSessionId && accessToken ? (
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
              <span className="text-[11px] text-muted-foreground">
                连接已断开，正在重连...
              </span>
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
              <div ref={messagesEndRef} />
            </div>
          </ErrorBoundary>

          {/* Input */}
          <div className="relative">
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
              disabled={streaming || sessionsLoading}
              // 有活跃 run 才给停止键：没有 runId 时的「停止」是假按钮（点了不生效）
              onStop={
                streaming && activeRunId
                  ? () => ws.cancelRun(activeRunId)
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

  const creditDialogEl = creditDialog && (
    <CreditInsufficientDialog
      open={creditDialog.open}
      onClose={() => setCreditDialog(null)}
      currentBalance={creditDialog.currentBalance}
      requiredAmount={creditDialog.requiredAmount}
      plan={creditDialog.plan}
      dailyClaimed={creditDialog.dailyClaimed}
      onClaimDaily={async () => {
        await claimDailyCredits(accessTokenRef.current);
      }}
    />
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
        {creditDialogEl}
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
      {creditDialogEl}
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
