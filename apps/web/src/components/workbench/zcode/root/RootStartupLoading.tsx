import kenfutworkMarkUrl from "@zui/assets/kenfutwork-mark.png";
import type { ReactNode } from "react";

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
      {/* 与 web 层连接加载屏同款动画（用户口径：logo 黑白 + 加载动画；两屏完全同款
          ——logo 位置一致，切换不跳位=不闪）。色值内联：本主题无 muted 系 token。 */}
      <div
        className="h-6 w-6 animate-spin rounded-full border-2"
        style={{
          borderColor: "rgba(13, 13, 13, 0.15)",
          borderTopColor: "rgba(13, 13, 13, 0.6)",
        }}
      />
      {children}
    </div>
  );
}

/**
 * 初始化与引导共用品牌徽标：裸黑标（与侧栏品牌行同款——黑墨迹、正常背景），
 * 加载→就绪全程 logo 颜色不变化（用户口径：logo 只要黑白、加载时不变色）。
 */
export function ZCodeStartupLogoBadge() {
  return (
    // biome-ignore lint/performance/noImgElement: output: "export" 未开 images.unoptimized，next/image 会构建失败
    <img
      src={kenfutworkMarkUrl}
      alt="KenFutWork"
      className="size-14 select-none brightness-0"
      draggable={false}
    />
  );
}
