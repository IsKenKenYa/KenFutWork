"use client";

import { Pause } from "lucide-react";

/**
 * 「停止本轮」按钮（暂停图标，不再是一枚突兀的文字按钮）。
 *
 * **为什么抽成共享组件**：Code 工作台的追问输入框与 Design 画布助手面板都要它——
 * 此前只有 Code 侧有停止入口，Design 侧流式期间发送键被禁用、没有任何停的办法，
 * 只能等整轮跑完。两处各写一份按钮会立刻漂移（图标/文案/无障碍标签），故收一处。
 *
 * 语义是「取消本轮 run」（`ws.cancelRun`），不是可恢复的暂停——图标借用暂停字形，
 * 无障碍标签写「停止本轮」以免读屏用户误解。
 */
export function RunStopButton({
  onStop,
  className,
}: {
  onStop: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label="停止本轮"
      title="停止本轮"
      onClick={onStop}
      className={`rounded-lg border p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${
        className ?? ""
      }`}
    >
      <Pause className="h-4 w-4" />
    </button>
  );
}
