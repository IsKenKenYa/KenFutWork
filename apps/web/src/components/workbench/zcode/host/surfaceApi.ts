/**
 * 壳内嵌面（Design/Flow 主区视图）的服务端访问缝。
 *
 * code-ui 是独立静态应用，不与 web 应用共享模块；内嵌面需要的项目 / flow 数据面
 * 直接走本机服务端（cookie 会话，与宿主 httpChannelClient 同一鉴权口径）。
 * apiBase 由 host/main.tsx 启动时按 bootstrap 注入一次。
 */
let apiBase = "";

export function setSurfaceApiBase(base: string): void {
  apiBase = base.replace(/\/$/, "");
}

export function getSurfaceApiBase(): string {
  return apiBase || window.location.origin;
}

export async function surfaceFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${getSurfaceApiBase()}${path}`, {
    credentials: "include",
    ...init,
  });
}

/** 数据面请求：非 2xx 时抛出服务端给的可读原因（error.message）。 */
export async function surfaceRequest(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await surfaceFetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  }
  return response;
}

export async function surfaceJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  return (await (await surfaceRequest(path, init)).json()) as T;
}
