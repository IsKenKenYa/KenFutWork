import type { TerminalShellId } from "@kenfutwork/shared";
import { bearerHeaders, serverFetch } from "@/lib/local-access";

import { getServerBaseUrl } from "./env";
import { ApiAccessError, ApiApplicationError } from "./server-api";

// ── Helpers（与本目录其它 *-api 一致：各自持有，不走共享导出） ──

function authHeaders(accessToken: string | null): Record<string, string> {
  // 本机实例无 JS 令牌：**没令牌就不能发 `Bearer null`**——请求本身带 cookie，
  // 而服务端的本机接入门把「cookie + 冲突 Authorization」判为无效凭据（401），
  // 一次 401 会让前端整树切到「本机连接已失效」（真机验收踩到）。
  return bearerHeaders(accessToken);
}

async function handleErrorResponse(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new ApiAccessError();
  }
  const body = await response.json().catch(() => null);
  throw new ApiApplicationError(
    body?.error?.code ?? "application_error",
    body?.error?.message ?? "请求失败，请重试。",
  );
}

export interface TerminalShellOption {
  id: TerminalShellId;
  label: string;
  executable: string;
}

export async function fetchTerminalShells(accessToken: string | null): Promise<{
  shells: TerminalShellOption[];
  defaultShell: TerminalShellId;
  /** 默认值是 `auto` 时，这台机器上实际会用的那个（界面据此说清「auto → cmd」）。 */
  resolvedShell: TerminalShellId;
}> {
  const response = await serverFetch(`${getServerBaseUrl()}/api/code/shells`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as {
    shells: TerminalShellOption[];
    defaultShell: TerminalShellId;
    resolvedShell: TerminalShellId;
  };
}
