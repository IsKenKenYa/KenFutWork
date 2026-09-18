const defaultServerBaseUrl = "http://localhost:3001";

/**
 * 浏览器侧 API base 的解析顺序（改造计划 §D3「构建期烘焙值改为运行时注入」的第一步）。
 *
 * 1. `NEXT_PUBLIC_SERVER_BASE_URL` **已设置**（含显式空串）→ 用它：空串即「同源相对路径」
 *    （dev 下 `/api/*` 走 next 的 rewrite 代理到 3001，是既有约定，有回归测试锁着）；
 * 2. 未设置 → **同源**：页面由本服务托管时（打包的桌面端、自托管单进程形态）永远正确。
 *    这里以前硬编码 `http://localhost:3001` 兜底：桌面壳一旦换端口（3001 被别人的服务占着）
 *    整页 API 全打偏，Design 模式的画布因此空白（2026-09-17 真机）。
 * 3. 非 http(s) 页面（如壳自带的 `tauri://localhost`）→ 回到 `http://localhost:3001` 兜底。
 */
export function getServerBaseUrl() {
  // Must access process.env.NEXT_PUBLIC_* directly — webpack DefinePlugin
  // only replaces direct references, not indirect access via a variable.
  const configuredUrl = process.env.NEXT_PUBLIC_SERVER_BASE_URL;
  if (configuredUrl !== undefined) return configuredUrl.trim();
  if (typeof window !== "undefined") {
    const { protocol, origin } = window.location;
    if ((protocol === "http:" || protocol === "https:") && origin)
      return origin;
  }
  return defaultServerBaseUrl;
}

export type WebEnv = {
  serverBaseUrl: string;
};

/**
 * 读取浏览器侧配置。Supabase 两键已随 M1.5 删除（前端不再直连任何外部服务，
 * 认证/存储都经本服务）。
 */
export function loadWebEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    serverBaseUrl: overrides.serverBaseUrl ?? getServerBaseUrl(),
  };
}
