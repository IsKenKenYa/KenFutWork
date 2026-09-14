"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copyTextToClipboard, readClipboardText } from "@/lib/chat-menu";
import {
  COMPOSER_MENU_ITEMS,
  type ComposerMenuItem,
  deleteRange,
  EMPTY_TEXT_HISTORY,
  rangeText,
  recordHistory,
  redoHistory,
  replaceRange,
  selectAllRange,
  type TextHistory,
  undoHistory,
} from "@/lib/composer-edit";

export interface ComposerMenuState {
  x: number;
  y: number;
}

/**
 * 输入框右键菜单：撤销 / 重做 / 剪切 / 复制 / 粘贴 / 删除 / 全选。
 *
 * 为什么自绘：应用内浏览器不弹原生编辑菜单（用户实测右键无反应），
 * 而输入框里这些操作是刚需。撤销/重做走**自管历史**（受控组件下原生 undo
 * 只改 DOM 不改 React state，会界面与状态不一致）。
 */
export function useComposerContextMenu(options: {
  value: string;
  setValue: (next: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onNotice?: (message: string) => void;
}) {
  const { value, setValue, textareaRef, onNotice } = options;
  const [state, setState] = useState<ComposerMenuState | null>(null);
  const historyRef = useRef<TextHistory>(EMPTY_TEXT_HISTORY);
  const previousValueRef = useRef(value);

  // 记录历史：每次值变化把「变化前的值」按打字批次合并进历史
  useEffect(() => {
    if (value === previousValueRef.current) {
      return;
    }
    historyRef.current = recordHistory(
      historyRef.current,
      previousValueRef.current,
      Date.now(),
    );
    previousValueRef.current = value;
  }, [value]);

  const open = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      // 右键不应改变已有选区：聚焦但保留选区（浏览器默认右键会保留）
      textareaRef.current?.focus();
      setState({ x: event.clientX, y: event.clientY });
    },
    [textareaRef],
  );

  const close = useCallback(() => setState(null), []);

  /** 应用新值并恢复光标（受控组件的光标要手动放回）。 */
  const applyValue = useCallback(
    (next: string, caret: number) => {
      setValue(next);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
      });
    },
    [setValue, textareaRef],
  );

  const selection = useCallback(() => {
    const textarea = textareaRef.current;
    return {
      start: textarea?.selectionStart ?? 0,
      end: textarea?.selectionEnd ?? 0,
    };
  }, [textareaRef]);

  const run = useCallback(
    async (item: ComposerMenuItem) => {
      switch (item.id) {
        case "undo": {
          const result = undoHistory(historyRef.current, value);
          if (!result) {
            onNotice?.("没有可撤销的操作。");
            return;
          }
          historyRef.current = result.history;
          previousValueRef.current = result.value;
          applyValue(result.value, result.value.length);
          return;
        }
        case "redo": {
          const result = redoHistory(historyRef.current, value);
          if (!result) {
            onNotice?.("没有可重做的操作。");
            return;
          }
          historyRef.current = result.history;
          previousValueRef.current = result.value;
          applyValue(result.value, result.value.length);
          return;
        }
        case "cut": {
          const text = rangeText(value, selection());
          if (!text) {
            onNotice?.("先选中要剪切的文字。");
            return;
          }
          const ok = await copyTextToClipboard(text);
          const result = deleteRange(value, selection());
          applyValue(result.value, result.caret);
          onNotice?.(ok ? "已剪切。" : "已删除（复制到剪贴板失败）。");
          return;
        }
        case "copy": {
          const text = rangeText(value, selection());
          if (!text) {
            onNotice?.("先选中要复制的文字。");
            return;
          }
          const ok = await copyTextToClipboard(text);
          onNotice?.(ok ? "已复制。" : "复制失败，请用 Ctrl+C。");
          return;
        }
        case "paste": {
          const text = await readClipboardText();
          if (text === null) {
            onNotice?.("读取剪贴板被拒绝，请按 Ctrl+V 粘贴。");
            return;
          }
          if (!text) {
            onNotice?.("剪贴板没有文本。");
            return;
          }
          const result = replaceRange(value, selection(), text);
          applyValue(result.value, result.caret);
          onNotice?.("已粘贴。");
          return;
        }
        case "delete": {
          const text = rangeText(value, selection());
          if (!text) {
            onNotice?.("先选中要删除的文字。");
            return;
          }
          const result = deleteRange(value, selection());
          applyValue(result.value, result.caret);
          return;
        }
        case "select-all": {
          const range = selectAllRange(value);
          const textarea = textareaRef.current;
          textarea?.focus();
          textarea?.setSelectionRange(range.start, range.end);
          return;
        }
      }
    },
    [applyValue, onNotice, selection, textareaRef, value],
  );

  return { state, open, close, run, items: COMPOSER_MENU_ITEMS };
}

/** 菜单视图（受控：state 为空即不渲染）。 */
export function ComposerContextMenu({
  state,
  items,
  onRun,
  onClose,
}: {
  state: ComposerMenuState | null;
  items: readonly ComposerMenuItem[];
  onRun: (item: ComposerMenuItem) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ComposerMenuState | null>(null);

  useEffect(() => {
    if (!state) {
      setPosition(null);
      return;
    }
    const rect = menuRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 180;
    const height = rect?.height ?? 220;
    const margin = 8;
    setPosition({
      x: Math.min(
        Math.max(state.x, margin),
        Math.max(margin, window.innerWidth - width - margin),
      ),
      y: Math.min(
        Math.max(state.y, margin),
        Math.max(margin, window.innerHeight - height - margin),
      ),
    });
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [state, onClose]);

  if (!state) {
    return null;
  }
  const point = position ?? state;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="输入框菜单"
      style={{ left: point.x, top: point.y }}
      className="fixed z-[3000] min-w-[180px] overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg"
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => (
        <div key={item.id}>
          {index === 2 || index === 5 ? (
            <div className="my-1 h-px bg-border" />
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              onRun(item);
            }}
            className="flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-muted"
          >
            <span>{item.label}</span>
            {item.shortcut ? (
              <span className="text-[11px] text-muted-foreground">
                {item.shortcut}
              </span>
            ) : null}
          </button>
        </div>
      ))}
    </div>
  );
}
