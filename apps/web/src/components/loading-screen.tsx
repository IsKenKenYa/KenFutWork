"use client";

/**
 * Full-screen loading screen with animated KenFutWork mark.
 * - K square: gentle float + breathing
 * - Loading dots below
 */
export function LoadingScreen() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
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
