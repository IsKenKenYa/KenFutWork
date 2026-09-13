import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  typescript: {
    ignoreBuildErrors: true,
  },
  env: {
    // 认证形态：`local`（自管）/ 不设（Supabase 过渡期）。**必须列在这里**——
    // 本项目用显式 `env` 白名单而非默认内联，漏了就只会在浏览器里是 undefined，
    // 表现为「登录成功但上下文显示未登录」（实测踩到）。
    NEXT_PUBLIC_AUTH_DRIVER: process.env.NEXT_PUBLIC_AUTH_DRIVER,
    NEXT_PUBLIC_SERVER_BASE_URL: process.env.NEXT_PUBLIC_SERVER_BASE_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
};

// 开发期同源代理：NEXT_PUBLIC_SERVER_BASE_URL 留空时，/api/* 经 dev server
// 代理到本地 API（3001），避免跨域。静态导出（production build）不受影响。
if (
  process.env.NODE_ENV !== "production" &&
  !process.env.NEXT_PUBLIC_SERVER_BASE_URL
) {
  nextConfig.rewrites = async () => ({
    beforeFiles: [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:3001/api/:path*",
      },
    ],
  });
}

export default nextConfig;
