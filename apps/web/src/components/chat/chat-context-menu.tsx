"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildConversationText,
  CHAT_MENU_ITEMS,
  type ChatMenuItem,
  type ChatMenuMessage,
  clampMenuPosition,
  copyTextToClipboard,
  getSelectedText,
  readClipboardText,
  selectAllTextIn,
} from "@/lib/chat-menu";

export interface ChatContextMenuState {
  x: number;
  y: number;
}

/**
 * 对话区右键菜单（Code 模式工作台 / Design 模式画布助手侧栏共用）。
 *
 * 为什么自绘：应用内浏览器不弹原生右键菜单，对话区此前右键「没反应」。
 * 风格与画布右键菜单对齐：不透明卡片 + 细边框 + 阴影、条目左文右快捷键、
 * 悬停高亮、Esc/点击外部/滚动即关。
 */
export function ChatContextMenu({
  state,
  messages,
  containerRef,
  onPasteText,
  onNotice,
  onClose,
}: {
  /** 非空即显示（坐标为视口坐标）。 */
  state: ChatContextMenuState | null;
  messages: ChatMenuMessage[];
  /** 对话内容容器（「全选对话」用）。 */
  containerRef: React.RefObject<HTMLElement | null>;
  /** 粘贴回填到输入框。 */
  onPasteText: (text: string) => void;
  /** 操作反馈（成功/失败提示）。 */
  onNotice?: (message: string) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ChatContextMenuState | null>(null);

  // 落点收敛：越界向内收（尺寸要等渲染后才知道）
  useEffect(() => {
    if (!state) {
      setPosition(null);
      return;
    }
    const rect = menuRef.current?.getBoundingClientRect();
    setPosition(
      clampMenuPosition(
        state,
        {
          width: rect?.width ?? 180,
          height: rect?.height ?? 150,
        },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [state]);

  // Esc / 点击外部 / 滚动 → 关闭
  useEffect(() => {
    if (!state) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [state, onClose]);

  const run = useCallback(
    async (item: ChatMenuItem) => {
      switch (item.id) {
        case "copy": {
          const selected = getSelectedText();
          if (!selected) {
            onNotice?.("先在对话里选中要复制的文字。");
            return;
          }
          const ok = await copyTextToClipboard(selected);
          onNotice?.(ok ? "已复制选中内容。" : "复制失败，请用 Ctrl+C。");
          return;
        }
        case "paste": {
          // 输入区仍聚焦时，直接走原生粘贴更自然（带格式/光标位置）
          const text = await readClipboardText();
          if (text === null) {
            onNotice?.("读取剪贴板被拒绝，请在输入框里按 Ctrl+V 粘贴。");
            return;
          }
          if (!text) {
            onNotice?.("剪贴板没有文本。");
            return;
          }
          onPasteText(text);
          onNotice?.("已粘贴到输入框。");
          return;
        }
        case "select-all": {
          const ok = selectAllTextIn(containerRef.current ?? null);
          onNotice?.(ok ? "已全选本轮对话内容。" : "没有可全选的内容。");
          return;
        }
        case "copy-conversation": {
          const text = buildConversationText(messages);
          if (!text) {
            onNotice?.("本轮对话还没有可复制的内容。");
            return;
          }
          const ok = await copyTextToClipboard(text);
          onNotice?.(ok ? "已复制本轮对话。" : "复制失败，请重试。");
          return;
        }
      }
    },
    [containerRef, messages, onNotice, onPasteText],
  );

  if (!state) {
    return null;
  }

  const point = position ?? state;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="对话菜单"
      style={{ left: point.x, top: point.y }}
      className="fixed z-[3000] min-w-[180px] overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg"
      onContextMenu={(event) => event.preventDefault()}
    >
      {CHAT_MENU_ITEMS.map((item, index) => (
        <div key={item.id}>
          {index === 3 ? <div className="my-1 h-px bg-border" /> : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              void run(item);
            }}
            className="group flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-primary hover:text-primary-foreground"
          >
            <span>{item.label}</span>
            {item.shortcut ? (
              <span className="text-[11px] text-muted-foreground group-hover:text-primary-foreground/75">
                {item.shortcut}
              </span>
            ) : null}
          </button>
        </div>
      ))}
    </div>
  );
}

/** 便捷 hook：维护菜单开合与坐标。 */
export function useChatContextMenu() {
  const [state, setState] = useState<ChatContextMenuState | null>(null);
  const open = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setState({ x: event.clientX, y: event.clientY });
  }, []);
  const close = useCallback(() => setState(null), []);
  return { state, open, close };
}
