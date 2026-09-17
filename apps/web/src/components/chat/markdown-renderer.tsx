"use client";

import React, { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  canOpenInBrowserPanel,
  getBrowserOpenTarget,
  requestBrowserOpen,
} from "@/lib/browser-panel";
import { ChatImage } from "./image-lightbox";
import { isImageUrl } from "./utils";

/**
 * Pre-built markdown component overrides.
 *
 * Defined as a module-level constant so every MarkdownRenderer instance
 * shares the same reference — avoids re-creating the components map on
 * every render, which would force ReactMarkdown to remount its tree.
 */
const markdownComponents: Components = {
  a({ href, children }) {
    if (href && isImageUrl(href)) {
      return (
        <ChatImage
          src={href}
          alt={typeof children === "string" ? children : "Image"}
          className="my-2 max-w-[280px] rounded-lg border border-border"
        />
      );
    }
    return (
      /* 颜色交给 `.markdown-content a`（品牌色）：在这里再写一个颜色类会变成两处真相 */
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline break-all"
        onClick={(event) => {
          // 右栏浏览器（R3-1「浏览器」标签）：有面板时接管左键点击——
          // 用户在对话里点链接的意图通常是「看看这个」，不是「开一堆系统标签页」。
          // Ctrl/Cmd+点击仍走系统新标签（保留逃逸口）；没有面板时不拦截。
          if (!href || event.metaKey || event.ctrlKey || event.shiftKey) return;
          // 设置 → 浏览器 → 通用：默认在「系统浏览器」打开时不抢链接
          if (getBrowserOpenTarget() === "system") return;
          if (!canOpenInBrowserPanel()) return;
          if (!/^https?:/i.test(href)) return;
          if (requestBrowserOpen(href)) event.preventDefault();
        }}
      >
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    return (
      <ChatImage
        src={typeof src === "string" ? src : ""}
        alt={alt ?? "Image"}
        className="my-2 max-w-[280px] rounded-lg border border-border"
      />
    );
  },
};

/** Stable remarkPlugins array to prevent ReactMarkdown remount */
const remarkPlugins = [remarkGfm];

type MarkdownRendererProps = {
  /** Raw markdown text to render */
  text: string;
  /** Whether to show the streaming cursor after this block */
  showCursor?: boolean;
};

/**
 * Memoized markdown renderer for chat messages.
 *
 * Performance notes:
 * - remarkPlugins and components are module-level constants (no re-creation)
 * - React.memo prevents re-render when text hasn't changed
 * - During streaming, text changes every delta — the memo check is O(1) string comparison
 */
export const MarkdownRenderer = React.memo(function MarkdownRenderer({
  text,
  showCursor,
}: MarkdownRendererProps) {
  // Guard against empty/whitespace-only text producing empty markdown output
  const safeText = text || "";

  return (
    <div className="markdown-content text-sm leading-[1.6] text-foreground">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={markdownComponents}
      >
        {safeText}
      </ReactMarkdown>
      {showCursor && (
        <span className="inline-block w-[2px] h-[14px] ml-0.5 -mb-[2px] bg-foreground animate-pulse rounded-full" />
      )}
    </div>
  );
});
