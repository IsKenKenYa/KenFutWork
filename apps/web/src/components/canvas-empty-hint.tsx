"use client";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Palette } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type CanvasEmptyHintProps = {
  excalidrawApi: ExcalidrawImperativeAPI | null;
  onOpenChat: () => void;
};

/**
 * Floating overlay hint shown when the Excalidraw canvas has no visible
 * elements. Pressing the `C` key opens the chat sidebar and focuses the
 * chat input textarea.
 */
export function CanvasEmptyHint({
  excalidrawApi,
  onOpenChat,
}: CanvasEmptyHintProps) {
  const [hasElements, setHasElements] = useState(false);
  const onOpenChatRef = useRef(onOpenChat);
  onOpenChatRef.current = onOpenChat;

  // Poll the Excalidraw API every 500ms to determine if the canvas contains
  // any non-deleted elements.
  useEffect(() => {
    function check() {
      if (!excalidrawApi) {
        setHasElements(false);
        return;
      }
      const elements = excalidrawApi.getSceneElements?.() ?? [];
      setHasElements(elements.some((el) => !el.isDeleted));
    }

    check();
    const id = setInterval(check, 500);
    return () => clearInterval(id);
  }, [excalidrawApi]);

  // Global keydown listener for the `C` shortcut.
  useEffect(() => {
    if (hasElements) return;

    function handleKeyDown(e: KeyboardEvent) {
      // Ignore when the user is typing in an input or textarea.
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      // Also ignore if contentEditable
      if ((e.target as HTMLElement)?.isContentEditable) return;

      if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        onOpenChatRef.current();

        // The textarea may not be in the DOM yet (sidebar was closed), so
        // retry focus with a short delay.
        requestAnimationFrame(() => {
          const textarea = document.querySelector<HTMLTextAreaElement>(
            "textarea[data-chat-input]",
          );
          if (textarea) {
            textarea.focus();
          } else {
            // Sidebar might animate open; retry once more.
            setTimeout(() => {
              document
                .querySelector<HTMLTextAreaElement>("textarea[data-chat-input]")
                ?.focus();
            }, 100);
          }
        });
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasElements]);

  if (hasElements) return null;

  return (
    <div
      // z-[3]：夹在 Excalidraw 的层之间——画布 z=1/2，右键菜单弹层 z=10，
      // 这样提示浮在画布之上、又被菜单正常盖住（不靠隐藏提示来躲遮挡）
      className="canvas-empty-hint pointer-events-none absolute inset-0 z-[3] flex flex-col items-center justify-center gap-2"
    >
      {/* Design 模式的问候语画在**画布上**（不是 Code 那种居中编排器）。
          排版对齐 Code 问候语（图标 + 大号粗体），只把颜色压成 muted；
          图标用「画板」而不是 Code 的 `</>`。 */}
      <div className="flex items-center gap-3 text-muted-foreground/50">
        <Palette className="h-8 w-8" strokeWidth={3} />
        <h1 className="font-wordmark text-4xl tracking-tight">
          Design with KenFutWork
        </h1>
      </div>
      <p className="text-base text-muted-foreground/50">
        {"输入你的想法开始创作"}
      </p>
    </div>
  );
}
