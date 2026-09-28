"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import { Brain, ChevronRight } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

/**
 * zcode 思考行（references/zcode packages/ui ai-elements/reasoning.tsx 照搬，
 * 剥离滚动遮罩系统）：默认收起（流式也收起，只留运行态流光文案）；
 * 触发器 = BrainIcon + 「思考」/「思考中」+ 完成态「· N 秒」+ hover chevron；
 * 展开体 = ml-2 border-l pl-3.5 max-h-60 纯文本（whitespace-pre-wrap，
 * 不走 markdown——长思考流式追加时 markdown 重解析会卡，zcode 同款决策）。
 */

const ReasoningImpl = memo(function Reasoning({
  text,
  streaming = false,
  durationSeconds,
}: {
  text: string;
  /** 该轮是否仍在流式：流式时文案走扫光。 */
  streaming?: boolean;
  /** 思考耗时（秒，完成态显示）。 */
  durationSeconds?: number;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [shouldRenderContent, setShouldRenderContent] = useState(false);
  const contentUnmountDelayRef = useRef<number | null>(null);

  useEffect(() => {
    if (isOpen) {
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
        contentUnmountDelayRef.current = null;
      }
      setShouldRenderContent(true);
      return;
    }
    if (!shouldRenderContent) return;
    contentUnmountDelayRef.current = window.setTimeout(() => {
      setShouldRenderContent(false);
      contentUnmountDelayRef.current = null;
    }, 300);
    return () => {
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
        contentUnmountDelayRef.current = null;
      }
    };
  }, [isOpen, shouldRenderContent]);

  if (streaming && text.length === 0) return null;

  return (
    <Collapsible.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (open) setShouldRenderContent(true);
        setIsOpen(open);
      }}
      className="flex w-full flex-col"
    >
      <Collapsible.Trigger
        aria-label={isOpen ? "收起思考" : "展开思考"}
        className="group/reasoning inline-flex min-w-0 max-w-full items-center gap-2 self-start text-ui-base transition-colors"
      >
        <Brain
          aria-hidden
          className="size-4 shrink-0 text-foreground-subtlest"
        />
        <span className="shrink-0 whitespace-nowrap">
          {streaming && !isOpen ? (
            <span className="animated-gradient-text font-medium">思考中</span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <span className="font-medium text-foreground-subtlest">思考</span>
              <span className="font-normal text-foreground-subtlest">·</span>
              <span className="font-normal text-foreground-subtlest">
                {durationSeconds === undefined
                  ? "持续了几秒"
                  : `持续了 ${durationSeconds} 秒`}
              </span>
            </span>
          )}
        </span>
        <ChevronRight
          aria-hidden
          className={`size-4 shrink-0 text-foreground-subtlest transition-[opacity,transform] ${
            isOpen
              ? "rotate-90 opacity-100"
              : "rotate-0 opacity-0 group-hover/reasoning:opacity-100"
          }`}
        />
      </Collapsible.Trigger>
      <Collapsible.Panel>
        {shouldRenderContent ? (
          <div className="pt-3">
            <div className="ml-2 max-h-60 space-y-2 overflow-auto border-border border-l pl-3.5 text-ui-base text-foreground-subtlest">
              <div className="min-w-0 whitespace-pre-wrap break-words text-foreground-subtlest">
                {text}
              </div>
            </div>
          </div>
        ) : null}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
});

export const Reasoning = ReasoningImpl;
