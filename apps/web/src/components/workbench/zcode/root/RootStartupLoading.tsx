import kenfutworkMarkUrl from "@zui/assets/kenfutwork-mark.png";
import type { ReactNode } from "react";

// vendor 编译走 vite/client 类型（图片导入是 URL 字符串），宿主编译按 Next 静态图片
// 类型解析；运行时 code-ui 由 vite 打包，这里只能用 URL 字符串本身。
const markUrl = kenfutworkMarkUrl as unknown as string;

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

export function RootStartupLoading({
  label,
  children,
  busy = true,
}: RootStartupLoadingProps) {
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-5 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      <ZCodeStartupLogoBadge />
      <ZCodeStartupSpinner />
      {/* 与 web 层连接加载屏同款动画（用户口径：只留随主题黑白 logo + 无底板 + 下方转圈；两屏完全同款
          ——logo 位置一致，切换不跳位=不闪）。旋转圈使用语义前景色。 */}
      {children}
    </div>
  );
}

/** 加载旋转圈，全站唯一形态；与 web 层 `LoadingScreen` 同尺寸。 */
export function ZCodeStartupSpinner() {
  return (
    // 与 web 层 LoadingScreen 逐字同款：暗色轨道 15% 白 + 品牌浅岚旋转弧，
    // 加载屏→启动屏切换时颜色与尺寸都不跳。
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-foreground/15 border-t-foreground/60 motion-reduce:animate-none dark:border-white/15 dark:border-t-brand" />
  );
}

/**
 * 初始化与引导共用品牌徽标：与侧栏品牌行同款（浅色黑墨迹、深色纯白剪影），
 * 加载→就绪全程 logo 颜色不变化。
 */
export function ZCodeStartupLogoBadge() {
  return (
    // biome-ignore lint/performance/noImgElement: output: "export" 未开 images.unoptimized，next/image 会构建失败
    <img
      src={markUrl}
      alt="KenFutWork"
      className="size-14 select-none brand-mark"
      draggable={false}
    />
  );
}
