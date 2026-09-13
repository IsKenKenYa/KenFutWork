import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  typescript: {
    ignoreBuildErrors: true,
  },
  env: {
    // 显式 env 白名单（webpack DefinePlugin 的唯一来源）：新增 NEXT_PUBLIC_* 必须列在这里，
    // 漏了就只会在浏览器里是 undefined（实测踩到过「登录成功但上下文显示未登录」）。
    NEXT_PUBLIC_SERVER_BASE_URL: process.env.NEXT_PUBLIC_SERVER_BASE_URL,
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
