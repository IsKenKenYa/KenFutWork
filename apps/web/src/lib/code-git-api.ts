import { getServerBaseUrl } from "./env";
import { ApiApplicationError, ApiAuthError } from "./server-api";

// ── Helpers（与本目录其它 *-api 一致：各自持有，不走共享导出） ──

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function authJsonHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
}

async function handleErrorResponse(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new ApiAuthError();
  }
  const body = await response.json().catch(() => null);
  throw new ApiApplicationError(
    body?.error?.code ?? "application_error",
    body?.error?.message ?? "请求失败，请重试。",
  );
}

/**
 * Code 模式 git 分支视图（工作目录=项目）。
 *
 * 作用域是**画布**（服务端据此算沙箱目录），故调用方传的是项目主画布 id——
 * 与 run 的 `canvasId` 同一口径，保证看到的仓库就是 agent 读写的那一个。
 */
export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  branches: GitBranch[];
  dirty: boolean;
  source: "system" | "bundled" | "unavailable";
}

export async function fetchGitStatus(
  accessToken: string,
  canvasId: string,
): Promise<GitStatus> {
  const query = new URLSearchParams({ canvasId });
  const response = await fetch(
    `${getServerBaseUrl()}/api/code/git?${query.toString()}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { git: GitStatus };
  return payload.git;
}

export async function checkoutGitBranch(
  accessToken: string,
  canvasId: string,
  branch: string,
): Promise<GitStatus> {
  const response = await fetch(`${getServerBaseUrl()}/api/code/git/checkout`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ branch, canvasId }),
  });
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { git: GitStatus };
  return payload.git;
}
