import type { CSSProperties } from "react";

/**
 * KenFutWork 品牌 logo（2026-09-15 换版：GPT 生成图定稿）。
 * 源图：docs/design/logo/GPT生成.png；桌面应用图标（apps/desktop/src-tauri/icons/）
 * 与 web 端同源。权威说明与变更登记：docs/design/logo/品牌Logo说明.md。
 * 应用内一律用 **裁掉透明边的纯标记**（public/logo-mark.png）：自带留白的贴片图会让
 * 「图标与字标」之间看着有空隙、图标也显小（用户 2026-09-19 两次反馈）。
 * 带白底圆角贴片的那份（public/logo.png）给「需要像应用图标」的地方用。
 * 默认 aria-hidden（调用处旁边必有「KenFutWork」字标）；需要独立可访问名的调用方
 * 自行传 alt 覆盖。
 *
 * @example
 * <KenFutWorkLogo className="size-7" />
 */
export function KenFutWorkLogo({
  className,
  style,
  alt = "",
}: {
  className?: string;
  style?: CSSProperties;
  alt?: string;
}) {
  return (
    // opacity-90：用户口径「软件里的图标加一点透明度」——纯色标记配白底贴片时，
    // 全不透明在浅色侧栏里偏「贴上去」；留一点透更贴合界面
    // biome-ignore lint/performance/noImgElement: output: "export" 未开 images.unoptimized，next/image 会构建失败（loading-screen 同款豁免）
    <img
      src="/logo-mark.png"
      alt={alt}
      aria-hidden={alt === ""}
      className={`opacity-90 ${className ?? ""}`}
      style={style}
    />
  );
}
