import type { Metadata } from "next";
import { Geist } from "next/font/google";
import type { ReactNode } from "react";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme-bootstrap";
import { cn } from "@/lib/utils";

import { Providers } from "../components/providers";

import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "KenFutWork 工作台",
  description: "插件化 BYOK Work 平台——Code / Design 双模式 Agent 工作台",
  icons: {
    icon: "/favicon.png",
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "KenFutWork 工作台",
    description: "插件化 BYOK Work 平台——Code / Design 双模式 Agent 工作台",
    images: [{ url: "/og-image.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "KenFutWork 工作台",
    description: "插件化 BYOK Work 平台——Code / Design 双模式 Agent 工作台",
    images: ["/og-image.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={cn(geist.variable, "scroll-smooth")}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-background font-sans antialiased">
        {/* 首帧主题：先落主题类与底色，避免持久化深色实例刷新时闪白（见 lib/theme-bootstrap）。 */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: 注入的是模块内固定常量 THEME_BOOTSTRAP_SCRIPT，不含用户输入。 */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
