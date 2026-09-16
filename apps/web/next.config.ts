import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { NextConfig } from "next";

/**
 * 读取仓库根 `.env.local`（server 用 `--env-file` 读同一个文件）。
 *
 * 为什么要在 web 侧也读：Next 默认只看 `apps/web/.env*` 与 shell 环境，于是
 * 「改一个文件配好前后端」做不到——`NEXT_PUBLIC_SERVER_BASE_URL`（请求 baseUrl）
 * 写在根文件里对 web 无效。这里在配置期显式加载一次：**已存在的环境变量优先**
 * （shell/CI 注入的不会被覆盖），只补缺的键。
 *
 * 解析刻意不用正则：按换行切、`trim()` 收掉行尾 CR，全程普通字符串。
 */
function loadRootEnvLocal(): void {
  const file = path.resolve(process.cwd(), "..", "..", ".env.local");
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const first = value.slice(0, 1);
    const last = value.slice(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadRootEnvLocal();

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
