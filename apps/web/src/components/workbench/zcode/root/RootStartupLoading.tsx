import kenfutworkMarkUrl from "@zui/assets/kenfutwork-mark.png";
import type { ReactNode } from "react";
import { cn } from "@zui/components/lib/utils.js";

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

export function RootStartupLoading({ label, children, busy = true }: RootStartupLoadingProps) {
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      <ZCodeStartupLogoBadge />
      {children}
    </div>
  );
}

/**
 * 初始化与引导共用品牌徽标：KenFutWork 标志（vite 内联资产，随首帧即绘，
 * 不再出现原 Z 标 SVG 延迟绘制造成的黑块），底色描边圆角口径保持一致。
 */
export function ZCodeStartupLogoBadge() {
  return (
    <div className="relative flex size-24 items-center justify-center rounded-3xl bg-[linear-gradient(180deg,#000000_0%,#151718_100%)] shadow-xl/20 before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:border before:border-[rgba(255,255,255,0.1)] before:content-['']">
      {/* biome-ignore lint/performance/noImgElement: output: "export" 未开 images.unoptimized，next/image 会构建失败 */}
      <img src={kenfutworkMarkUrl} alt="" className="size-14 select-none" draggable={false} />
    </div>
  );
}
