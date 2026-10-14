import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useOpenDesignEntry } from "./openDesignHost.js";

/**
 * OpenDesign 面板（Code 模式右侧栏的联动画布，与浏览器面板同位互斥）。
 *
 * 入口显隐由启动卡按「插件安装态 + 宿主就绪」门控（见 `openDesignHost`）；这里再解析一次
 * 是为了拿 `frontendUrl`——tab 不带地址，避免把探针结果冻进持久侧栏状态。
 * 未就绪时不摆空壳，直接说明原因（fail loud）。
 */
export function OpenDesignPane() {
  const entry = useOpenDesignEntry();
  const [frameLoaded, setFrameLoaded] = useState(false);

  if (entry === null) {
    return (
      <div
        data-testid="open-design-pane"
        className="flex h-full items-center justify-center gap-2 bg-background text-xs text-foreground-subtle"
      >
        <Loader2 className="size-3.5 animate-spin" />
        <span>正在连接 OpenDesign…</span>
      </div>
    );
  }

  if (!entry.available) {
    return (
      <div
        data-testid="open-design-pane"
        className="flex h-full items-center justify-center bg-background px-6 text-center text-xs text-foreground-subtle"
      >
        {entry.reason}
      </div>
    );
  }

  return (
    <div data-testid="open-design-pane" className="h-full w-full bg-background">
      <iframe
        src={entry.frontendUrl}
        title="OpenDesign"
        className={`h-full w-full border-0 transition-opacity duration-300 ${
          frameLoaded ? "opacity-100" : "opacity-0"
        }`}
        onLoad={() => setFrameLoaded(true)}
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    </div>
  );
}
