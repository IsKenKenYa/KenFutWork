"use client";

/**
 * KenFutWork 品牌加载屏（logo 浮动 + 三点呼吸）：登录/注册/画布/flow 内嵌帧共用同一份，
 * 不做第二套加载动画（内嵌位置用 `variant="inline"`，见 flow 画布帧的加载层）。
 * - K square: gentle float + breathing
 * - Loading dots below
 */
export function LoadingScreen({
  variant = "screen",
}: {
  /** `screen` = 整屏（登录/画布页）；`inline` = 容器内绝对定位（如 flow 内嵌帧加载层）。 */
  variant?: "screen" | "inline";
} = {}) {
  return (
    <div
      className={`flex items-center justify-center ${
        variant === "screen"
          ? "fixed inset-0 z-50 bg-background"
          : "absolute inset-0 bg-card"
      }`}
    >
      <div className="flex flex-col items-center gap-5">
        <div className="animate-logo-float">
          {/* biome-ignore lint/performance/noImgElement: output: "export" 未开 images.unoptimized，next/image 会构建失败 */}
          <img src="/logo-mark.png" alt="KenFutWork" className="h-24 w-auto" />
        </div>
        <div className="flex items-center gap-1">
          <span className="h-1 w-1 rounded-full bg-foreground/30 animate-loading-dot [animation-delay:0ms]" />
          <span className="h-1 w-1 rounded-full bg-foreground/30 animate-loading-dot [animation-delay:160ms]" />
          <span className="h-1 w-1 rounded-full bg-foreground/30 animate-loading-dot [animation-delay:320ms]" />
        </div>
      </div>
    </div>
  );
}
