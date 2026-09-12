import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  // TEMP-VERIFY: distDir pointed outside the project because the dev sandbox
  // blocks Next's end-of-build unlink of .next/lock & export-detail.json.
  // Revert to default after verification.
  distDir: "/tmp/loomic-web-next-dist",
  typescript: {
    ignoreBuildErrors: true,
  },
  env: {
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
