"use client";

/**
 * 全站唯一加载动画：随主题黑白 logo（无底板）+ 下方旋转圈。
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
        className="h-14 w-auto select-none brand-mark"
        draggable={false}
      />
      {/* logo 随主题黑白（深色纯白，见 .dark .brand-mark）；旋转圈浅色用中性前景，
          暗色整圈一律取白（轨道 25% 白 + 纯白旋转弧），与 Work 编辑器启动壳同款；
          尊重系统的「减少动态效果」偏好。 */}
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground/70 motion-reduce:animate-none dark:border-white/25 dark:border-t-white" />
    </div>
  );
}
