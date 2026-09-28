"use client";

import { memo, useMemo } from "react";
import { type Components, Streamdown } from "streamdown";

import { canOpenInBrowserPanel, requestBrowserOpen } from "@/lib/browser-panel";

/**
 * zcode 对话正文渲染管线（references/zcode packages/ui message.tsx 的 MessageResponse
 * 照搬，剥离了工作区文件引用/编辑器联动这些宿主能力）：streamdown 流式安全 markdown +
 * zcode 同款排版（text-ui-base、1.75 行高、行内 code 底、链接 dotted 下划线）。
 *
 * 与 zcode 的差异只有两条，均为宿主能力缺失而非视觉分歧：
 * 1. 链接不做工作区文件解析（我们没有 workspacePath 语义），http/https 外链走
 *    右栏浏览器面板（沿用原 MarkdownRenderer 的接管逻辑），其余协议不可点；
 * 2. 代码块用 streamdown 内建渲染器（shiki 高亮 + header 语言名/复制），流式期间
 *    与 zcode 同口径：complete 才启用高亮，避免 async highlighter 与流式更新打架。
 */

const responseClassName =
  "size-full text-ui-base leading-[1.75] tracking-wide [&>*:first-child]:mt-0 [&>*:last-child]:mb-0";

/** zcode messageLinkClassName 同款：品牌蓝 medium、dotted 下划线 hover 实线。 */
const messageLinkClassName =
  "wrap-anywhere font-medium text-brand no-underline decoration-dotted underline-offset-4 hover:underline";

function isExternalWebHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function MessageResponseImpl({
  text,
  className,
  streaming = false,
}: {
  text: string;
  className?: string;
  streaming?: boolean;
}) {
  const mode = streaming ? ("streaming" as const) : ("static" as const);
  const shikiTheme = useMemo(
    () => ["github-light", "github-dark"] as const,
    [],
  );

  const components = useMemo<Components>(
    () => ({
      a: ({ href, children, className }) => {
        const resolved = typeof href === "string" ? href : "";
        if (isExternalWebHref(resolved)) {
          return (
            <a
              className={`${messageLinkClassName} ${className ?? ""}`}
              href={resolved}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                // 右栏浏览器接管（沿用原 MarkdownRenderer 的口径）：普通左键点开面板，
                // 修饰键仍走系统新标签；系统浏览器偏好/无面板时不拦。
                if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                if (!canOpenInBrowserPanel()) return;
                if (requestBrowserOpen(resolved)) event.preventDefault();
              }}
            >
              {children}
            </a>
          );
        }
        return (
          <span
            className={`${messageLinkClassName} ${className ?? ""}`}
            title={resolved || undefined}
          >
            {children}
          </span>
        );
      },
      strong: ({ children, className }) => (
        <strong className={`font-medium ${className ?? ""}`}>{children}</strong>
      ),
    }),
    [],
  );

  return (
    <div className={`${responseClassName} ${className ?? ""}`}>
      <Streamdown
        mode={mode}
        parseIncompleteMarkdown={streaming}
        // 完成态/历史消息重挂载频繁，流式淡入会让历史文本整段重新闪烁（zcode 同款关闭）
        animated={false}
        isAnimating={false}
        shikiTheme={shikiTheme as unknown as [string, string]}
        components={components}
      >
        {text}
      </Streamdown>
    </div>
  );
}

export const MessageResponse = memo(MessageResponseImpl);
