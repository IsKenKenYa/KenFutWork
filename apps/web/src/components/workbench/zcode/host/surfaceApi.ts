import { throwPublicHttpError } from "@kenfutwork/shared";

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

/** 数据面请求保留状态、业务码和可读原因。 */
export async function surfaceRequest(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await surfaceFetch(path, init);
  if (!response.ok) return throwPublicHttpError(response);
  return response;
}

export async function surfaceJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  return (await (await surfaceRequest(path, init)).json()) as T;
}
