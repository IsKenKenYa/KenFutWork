/**
 * zcode 照搬：`@/ToolCallBlocks/renderers/ExecuteOutput.tsx`（references/zcode/packages/ui/src/ToolCallBlocks/renderers/ExecuteOutput.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */

import { ScrollFadeViewport } from "@zui/components/ui/scroll-fade-viewport";
import { logger } from "@zui/logger";
import { useLayoutEffect, useRef, useState } from "react";

export function ExecuteOutput({
  text,
  running,
}: {
  text: string;
  running: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const previousTop = useRef(0);
  const hasStreamed = useRef(running);
  const [frozen, setFrozen] = useState<string | null>(null);
  const following = frozen === null;
  const display = frozen ?? text;

  useLayoutEffect(() => {
    if (running) hasStreamed.current = true;
    if (!hasStreamed.current || !following || !scroll.current) return;
    scroll.current.scrollTop = scroll.current.scrollHeight;
    // 程序吸底后记录浏览器实际位置，避免尾窗变短时把程序滚动误判为上滚。
    previousTop.current = scroll.current.scrollTop;
  }, [display, following, running]);

  return (
    <ScrollFadeViewport
      ref={scroll}
      data-testid="bash-output-scroll"
      data-following={following}
      // 原预览与结果的高度上限不同且不吸底；共用五行上限，短内容自适应，结束时保留阅读状态。
      className="min-w-0 max-w-full max-h-[5lh] flex-none overflow-auto leading-5"
      tabIndex={0}
      onScroll={(event) => {
        const el = event.currentTarget;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
        if (
          hasStreamed.current &&
          following &&
          el.scrollTop < previousTop.current &&
          !atBottom
        ) {
          setFrozen(display);
          logger.debug("Bash output following changed", { following: false });
        } else if (!following && atBottom) {
          setFrozen(null);
          logger.debug("Bash output following changed", { following: true });
        }
        previousTop.current = el.scrollTop;
      }}
    >
      <pre
        data-testid={
          running ? "bash-output-preview-full" : "bash-result-output"
        }
        className="whitespace-pre-wrap break-words font-mono text-ui-base leading-5 text-foreground-subtle"
      >
        {display}
      </pre>
    </ScrollFadeViewport>
  );
}
