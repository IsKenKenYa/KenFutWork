"use client";

import type { MessageMention } from "@kenfutwork/shared";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ImageAttachmentState } from "../hooks/use-image-attachments";
import { useImageModelPreference } from "../hooks/use-image-model-preference";
import { useVideoModelPreference } from "../hooks/use-video-model-preference";
import { AgentModelSelector } from "./agent-model-selector";
import type { CanvasSelectedElement } from "./canvas-editor";
import {
  ComposerContextMenu,
  useComposerContextMenu,
} from "./chat/composer-context-menu";
import { RunStopButton } from "./chat/run-stop-button";
import { useComposerVoice } from "./composer-voice";
import { ImageAttachmentBar } from "./image-attachment-bar";
import { ImageModelPreferencePopover } from "./image-model-preference";

type ChatInputProps = {
  onSend: (message: string) => void;
  disabled?: boolean;
  /** 本轮正在跑时的停止回调；提供时发送键位换成「停止本轮」。 */
  onStop?: (() => void) | undefined;
  attachments?: ImageAttachmentState[];
  onAddFiles?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  onRetryAttachment?: (id: string) => void;
  isUploading?: boolean;
  onAtQuery?: (query: string | null) => void;
  mentions?: MessageMention[];
  onRemoveMention?: (mention: MessageMention) => void;
  selectedCanvasElements?: CanvasSelectedElement[];
  /** 语音输入所需（缺省 = 不接线：按住说话退化为普通点击）。 */
  accessToken?: string | undefined;
};

export type ChatInputHandle = {
  /** Remove the @query text from input after picker selection */
  clearAtQuery: () => void;
  /** 追加文本并聚焦（对话区右键「粘贴」回填用）。 */
  appendText: (text: string) => void;
};

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  function ChatInput(
    {
      onSend,
      disabled,
      onStop,
      attachments,
      onAddFiles,
      onRemoveAttachment,
      onRetryAttachment,
      isUploading,
      onAtQuery,
      mentions,
      onRemoveMention,
      selectedCanvasElements,
      accessToken,
    },
    ref,
  ) {
    const [value, setValue] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { preference } = useImageModelPreference();
    const { preference: videoPreference } = useVideoModelPreference();
    const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
    const modelBtnRef = useRef<HTMLButtonElement>(null);

    // 输入框右键菜单（撤销/重做/剪切/复制/粘贴/删除/全选）
    const composerMenu = useComposerContextMenu({
      value,
      setValue,
      textareaRef,
    });

    /**
     * 语音输入（按住说话）：写回必须走 `setValue`——输入框是受控的，而撤销历史
     * （composerMenu 的 historyRef）挂在 value 变化上；直接改 DOM 会让
     * 撤销栈与 React state 脱钩。
     */
    const voice = useComposerVoice({
      accessToken,
      onTranscript: (text) => {
        setValue((prev) => (prev ? `${prev}${text}` : text));
        requestAnimationFrame(() => textareaRef.current?.focus());
      },
    });

    useImperativeHandle(ref, () => ({
      clearAtQuery() {
        setValue((prev) => {
          const lastAtIdx = prev.lastIndexOf("@");
          if (lastAtIdx === -1) return prev;
          return prev.slice(0, lastAtIdx);
        });
      },
      appendText(text: string) {
        if (!text) return;
        setValue((prev) => (prev ? `${prev}${text}` : text));
        // 聚焦并把光标放到末尾（用户可直接继续编辑）
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          if (!textarea) return;
          textarea.focus();
          const end = textarea.value.length;
          textarea.setSelectionRange(end, end);
        });
      },
    }));

    const handleSubmit = useCallback(() => {
      const trimmed = value.trim();
      if (
        (!trimmed && (!attachments || attachments.length === 0)) ||
        disabled ||
        isUploading
      )
        return;
      onSend(trimmed);
      setValue("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    }, [value, disabled, isUploading, onSend, attachments]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        // Ignore Enter during IME composition (e.g. Chinese input confirming a candidate)
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          handleSubmit();
        }
      },
      [handleSubmit],
    );

    // Auto-resize textarea when value changes
    // biome-ignore lint/correctness/useExhaustiveDependencies: value 只当触发器（高度按 DOM 现量，不读值）；去掉后输入不再自动长高
    useEffect(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.style.height = "auto";
      const maxH = 240; // max-h-60
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxH)}px`;
      textarea.style.overflowY =
        textarea.scrollHeight > maxH ? "auto" : "hidden";
    }, [value]);

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newValue = e.target.value;
        setValue(newValue);

        if (!onAtQuery) return;

        // Find last @ in text to detect mention mode
        const lastAtIdx = newValue.lastIndexOf("@");
        if (lastAtIdx === -1) {
          onAtQuery(null); // close picker
          return;
        }

        // Only trigger if @ is at start or preceded by whitespace
        const charBefore = lastAtIdx > 0 ? newValue[lastAtIdx - 1] : " ";
        if (charBefore !== " " && charBefore !== "\n" && lastAtIdx !== 0) {
          onAtQuery(null);
          return;
        }

        // Extract query after @
        const query = newValue.slice(lastAtIdx + 1);
        // Close if user typed a space after query (finished mentioning)
        if (query.includes(" ") || query.includes("\n")) {
          onAtQuery(null);
          return;
        }

        onAtQuery(query);
      },
      [onAtQuery],
    );

    const handleFileChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (files && files.length > 0 && onAddFiles) {
          onAddFiles(Array.from(files));
        }
        e.target.value = "";
      },
      [onAddFiles],
    );

    const handleDrop = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();
        if (!onAddFiles) return;
        const files = Array.from(e.dataTransfer.files).filter((f) =>
          f.type.startsWith("image/"),
        );
        if (files.length > 0) {
          onAddFiles(files);
        }
      },
      [onAddFiles],
    );

    const handleDragOver = useCallback((e: React.DragEvent) => {
      e.preventDefault();
    }, []);

    const handlePaste = useCallback(
      (e: React.ClipboardEvent) => {
        if (!onAddFiles) return;
        const files = Array.from(e.clipboardData.items)
          .filter((item) => item.type.startsWith("image/"))
          .map((item) => item.getAsFile())
          .filter((f): f is File => f !== null);
        if (files.length > 0) {
          e.preventDefault();
          onAddFiles(files);
        }
      },
      [onAddFiles],
    );

    const hasContent =
      value.trim().length > 0 || (attachments && attachments.length > 0);

    // Memoize canvas selection summary -- selectedCanvasElements changes on every
    // canvas interaction, but the counts only change when the selection actually differs
    const selectionSummary = useMemo(() => {
      const imageCount =
        selectedCanvasElements?.filter((el) => el.type === "image").length ?? 0;
      const totalCount = selectedCanvasElements?.length ?? 0;
      return {
        selectionImageCount: imageCount,
        selectionShapeCount: totalCount - imageCount,
        hasSelection: totalCount > 0,
      };
    }, [selectedCanvasElements]);
    const { selectionImageCount, selectionShapeCount, hasSelection } =
      selectionSummary;

    return (
      <div className="px-2 pb-2">
        <ComposerContextMenu
          state={composerMenu.state}
          items={composerMenu.items}
          onRun={(item) => void composerMenu.run(item)}
          onClose={composerMenu.close}
        />
        <div
          role="none"
          className="flex min-h-[120px] flex-col justify-between gap-2 rounded-xl border-[0.5px] border-border bg-card p-2 transition-[border] focus-within:border-border"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onPointerDown={voice.onPointerDown}
          style={voice.lockSelection ? { userSelect: "none" } : undefined}
        >
          {hasSelection && (
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground bg-muted/50 rounded-lg">
              <div className="flex items-center gap-1.5 min-w-0">
                {selectionImageCount > 0 && (
                  <span className="flex items-center gap-1">
                    <svg
                      aria-hidden="true"
                      className="h-3 w-3 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <path d="m21 15-5-5L5 21" />
                    </svg>
                    {selectionImageCount} 张图片
                  </span>
                )}
                {selectionImageCount > 0 && selectionShapeCount > 0 && (
                  <span className="text-muted-foreground/40">&middot;</span>
                )}
                {selectionShapeCount > 0 && (
                  <span className="flex items-center gap-1">
                    <svg
                      aria-hidden="true"
                      className="h-3 w-3 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                    </svg>
                    {selectionShapeCount} 个图形
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground/60">
                  已在画布中选中
                </span>
              </div>
            </div>
          )}
          {attachments && onRemoveAttachment && (
            <ImageAttachmentBar
              attachments={attachments}
              onRemove={onRemoveAttachment}
              {...(onRetryAttachment ? { onRetry: onRetryAttachment } : {})}
            />
          )}
          {mentions && mentions.length > 0 && onRemoveMention && (
            <div className="flex flex-wrap items-center gap-1 px-2 py-1">
              {mentions.map((mention) => (
                <button
                  key={`${mention.mentionType}:${mention.id}`}
                  type="button"
                  onClick={() => onRemoveMention(mention)}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-muted/80"
                  title="移除引用"
                >
                  <span className="text-muted-foreground">@</span>
                  <span className="max-w-[180px] truncate">
                    {mention.label}
                  </span>
                  <svg
                    aria-hidden="true"
                    className="h-3 w-3 text-muted-foreground"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            data-chat-input
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onContextMenu={composerMenu.open}
            placeholder='输入你的想法，或输入 "@" 引用技能'
            aria-label="输入消息"
            rows={1}
            style={{ scrollbarWidth: "none" }}
            className="min-h-[48px] max-h-60 resize-none bg-transparent px-1 text-sm leading-[1.8] text-foreground placeholder:text-muted-foreground focus:outline-none [&::-webkit-scrollbar]:hidden"
          />
          {voice.status}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              {onAddFiles && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    multiple
                    className="hidden"
                    onChange={handleFileChange}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex h-8 w-8 items-center justify-center rounded-full border-[0.5px] border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    title="添加图片"
                  >
                    <svg
                      aria-hidden="true"
                      className="h-[14px] w-[14px]"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path d="M16 1.1A4.9 4.9 0 0 1 20.9 6a4.9 4.9 0 0 1-1.429 3.457h.001l-8.414 8.587-.007.006a2.9 2.9 0 0 1-3.887.193l-.213-.192a2.9 2.9 0 0 1-.007-4.095l8.414-8.586a.9.9 0 0 1 1.286 1.26L8.23 15.216l-.007.006a1.1 1.1 0 0 0 1.556 1.555l8.407-8.579.007-.007a3.1 3.1 0 0 0 .105-4.271l-.105-.112a3.1 3.1 0 0 0-4.384 0L5.4 12.387l-.007.006a5.1 5.1 0 0 0 7.214 7.213l7.749-7.934a.9.9 0 0 1 1.288 1.256l-7.753 7.938q-.005.007-.012.014a6.9 6.9 0 0 1-9.758-9.76l8.408-8.578.007-.007A4.9 4.9 0 0 1 16 1.1" />
                    </svg>
                  </button>
                </>
              )}
              {/* Agent model selector */}
              <AgentModelSelector compact />
              {/* Model preference button */}
              <div className="relative">
                <button
                  ref={modelBtnRef}
                  type="button"
                  onClick={() => setModelPopoverOpen((prev) => !prev)}
                  title="图像模型"
                  className={`flex h-8 w-8 items-center justify-center rounded-full border-[0.5px] transition-colors ${
                    preference.mode === "manual" ||
                    videoPreference.mode === "manual"
                      ? "border-accent bg-accent/20 text-accent-foreground"
                      : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {/* 线性「图片」图标（用户口径：不要实心的，要贴合工具条） */}
                  <svg
                    aria-hidden="true"
                    className="h-[14px] w-[14px]"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                    <path d="m3.3 7 8.7 5 8.7-5" />
                    <path d="M12 22V12" />
                  </svg>
                </button>
                <ImageModelPreferencePopover
                  open={modelPopoverOpen}
                  onClose={() => setModelPopoverOpen(false)}
                  anchorRef={modelBtnRef}
                />
              </div>
            </div>
            {/* 本轮正在跑：发送键位换成「停止本轮」（与 Code 工作台同一个组件）；
                没有 onStop（如未拿到 runId）时退回禁用态发送键，不给假按钮。 */}
            {onStop ? (
              <RunStopButton onStop={onStop} className="h-8 w-8 p-0" />
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={disabled || !hasContent || isUploading}
                className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/80 active:bg-primary/90 disabled:opacity-20 disabled:cursor-not-allowed"
              >
                <svg
                  aria-hidden="true"
                  className="h-[14px] w-[14px]"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                >
                  <path d="M7 11.5V2.5" />
                  <path d="M3 6.5L7 2.5L11 6.5" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    );
  },
);
