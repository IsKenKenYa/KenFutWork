"use client";

import { parseVizSpec, VizBlock, type VizSpec } from "@kenfutwork/ui";
import {
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { isConversationVisualsEnabled } from "@/lib/conversation-visuals";

/**
 * 对话流里的**动态 UI 块**（Design 侧渲染）：` ```mermaid ` 与 ` ```viz `。
 *
 * 契约（与 Code 侧同一份，见 `@zcode/ui` 的 message.tsx 分支与提示段）：
 * - `mermaid` → 流程图 / 架构图 / 时序图（懒加载 mermaid，`securityLevel: "strict"`）；
 * - `viz` → 数据图表（JSON spec：`{type: bar|line|pie, title?, unit?, data:[{label,value}]}`），
 *   由 `@kenfutwork/ui` 的共享组件画（Design 与 Code 同一份实现，避免两处图表各写一遍）。
 *
 * 三条降级口径（对话不能因为一段块炸掉整条消息）：
 * - **流式中只显示代码**：半截围栏解析必然失败，且每个 delta 触发一次 mermaid 渲染
 *   会把主线程拖垮（Code 侧踩过 React #185 的坑）——流式结束再升级成图；
 * - **解析/渲染失败回落代码块**：坏 JSON、mermaid 语法错误都原样保留代码，不吞内容；
 * - 不做任意 HTML/JS：没有 iframe、没有脚本执行面。
 */

/** 流式态由 MarkdownRenderer 提供（模块级 components 表不能按实例重建）。 */
export const MarkdownStreamingContext = createContext(false);

export type FencedLanguage = "mermaid" | "viz";

export interface FencedBlock {
  language: FencedLanguage;
  code: string;
}

/** 从 `language-xxx` 类名认我们的块（其余语言原样交给默认渲染）。 */
export function parseFencedLanguage(
  className: string | undefined,
): FencedLanguage | null {
  const match = /language-(mermaid|viz)\b/.exec(className ?? "");
  const language = match?.[1];
  return language === "mermaid" || language === "viz" ? language : null;
}

/** React 子树取纯文本（围栏代码在 react-markdown 里是纯字符串 child）。 */
function toText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(toText).join("");
  if (isValidElement(node)) {
    return toText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/** 从 `<pre>` 的 children 里认出我们的块（`<code class="language-…">`）。 */
export function extractFencedBlock(
  children: ReactNode,
): FencedBlock | null {
  const element = Array.isArray(children) ? children[0] : children;
  if (!isValidElement(element)) return null;
  const props = element.props as {
    className?: string;
    children?: ReactNode;
  };
  const language = parseFencedLanguage(props.className);
  if (!language) return null;
  return { language, code: toText(props.children).replace(/\n$/, "") };
}

/** mermaid 单例初始化（同一页只 initialize 一次；主题跟随当前配色）。 */
let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid(): Promise<typeof import("mermaid").default> {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((module) => {
      const mermaid = module.default;
      const dark =
        typeof document !== "undefined" &&
        document.documentElement.classList.contains("dark");
      mermaid.initialize({
        startOnLoad: false,
        // 严格模式：图表文本里的 HTML 不执行（对话内容是不可信输入）
        securityLevel: "strict",
        theme: dark ? "dark" : "default",
      });
      return mermaid;
    });
  }
  return mermaidReady;
}

let mermaidSeq = 0;

function MermaidDiagram({
  code,
  fallback,
}: {
  code: string;
  fallback: ReactNode;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setSvg(null);
    setFailed(false);
    void loadMermaid()
      .then((mermaid) => mermaid.render(`kfw-viz-${mermaidSeq++}`, code))
      .then((result) => {
        if (alive) setSvg(result.svg);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [code]);

  // 语法错/渲染失败：原样回落代码块（内容不吞）
  if (failed) return <>{fallback}</>;
  if (!svg) {
    return (
      <div className="my-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        渲染图表…
      </div>
    );
  }
  return (
    <div
      className="my-3 flex justify-center overflow-x-auto rounded-lg border border-border bg-card p-3 [&_svg]:max-w-full"
      // mermaid 的 SVG 输出：securityLevel=strict 下不含脚本与事件处理器
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * 渲染一块 fenced 可视化；不能渲染时**原样回落 `fallback`**（默认的 `<pre><code>`）——
 * 内容不吞、坏 spec 不炸消息。
 */
export function FencedVisualization({
  block,
  fallback,
}: {
  block: FencedBlock;
  fallback: ReactNode;
}) {
  const streaming = useContext(MarkdownStreamingContext);
  const parsed: VizSpec | null = useMemo(
    () => (block.language === "viz" ? parseVizSpec(block.code) : null),
    [block.language, block.code],
  );
  // 设置 → 通用 →「对话流」关掉时只显示代码（本机显示偏好，见 lib/conversation-visuals）；
  // 流式中也不升级成图：半截围栏必然失败，且每个 delta 重渲染 mermaid 会拖垮主线程
  if (streaming || !isConversationVisualsEnabled()) return <>{fallback}</>;
  if (block.language === "viz") {
    return parsed ? <VizBlock spec={parsed} /> : <>{fallback}</>;
  }
  return <MermaidDiagram code={block.code} fallback={fallback} />;
}
