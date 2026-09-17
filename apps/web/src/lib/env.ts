const defaultServerBaseUrl = "http://localhost:3001";

export function getServerBaseUrl() {
  // Must access process.env.NEXT_PUBLIC_* directly — webpack DefinePlugin
  // only replaces direct references, not indirect access via a variable.
  const configuredUrl = process.env.NEXT_PUBLIC_SERVER_BASE_URL?.trim();
  return configuredUrl ?? defaultServerBaseUrl;
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
