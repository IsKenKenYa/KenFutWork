import type { TerminalShellId } from "@kenfutwork/shared";
import { bearerHeaders, serverFetch } from "@/lib/local-access";

import { handleErrorResponse } from "./api-error";
import { getServerBaseUrl } from "./env";

function authHeaders(accessToken: string | null): Record<string, string> {
  // 本机实例无 JS 令牌：**没令牌就不能发 `Bearer null`**——请求本身带 cookie，
  // 而服务端的本机接入门把「cookie + 冲突 Authorization」判为无效凭据（401），
  // 一次 401 会让前端整树切到「本机连接已失效」（真机验收踩到）。
  return bearerHeaders(accessToken);
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
