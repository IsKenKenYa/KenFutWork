"use client";

/**
 * 全站唯一加载动画：黑色 logo（无底板）+ 下方旋转圈。
 * 尺寸与 zcode 壳启动屏（`@zui/root/RootStartupLoading`）逐一对齐——`h-14` logo + `gap-5` + `h-6 w-6` 圈，
 * 加载链路各屏切换不跳位、不闪。
 */
export function LoadingScreen({ label }: { label?: string } = {}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-background"
    >
      {/* biome-ignore lint/performance/noImgElement: output: "export" 未开 images.unoptimized，next/image 会构建失败 */}
      <img
        src="/logo-mark.png"
        alt=""
        className="h-14 w-auto select-none brightness-0"
        draggable={false}
      />
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground/70" />
    </div>
  );
}
