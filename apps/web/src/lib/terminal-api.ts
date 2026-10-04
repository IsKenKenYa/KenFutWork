import type { TerminalShellId } from "@kenfutwork/shared";

import { getServerBaseUrl } from "./env";
import { ApiApplicationError, ApiAuthError } from "./server-api";

// ── Helpers（与本目录其它 *-api 一致：各自持有，不走共享导出） ──

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
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

export interface TerminalShellOption {
  id: TerminalShellId;
  label: string;
  executable: string;
}

export async function fetchTerminalShells(accessToken: string): Promise<{
  shells: TerminalShellOption[];
  defaultShell: TerminalShellId;
  /** 默认值是 `auto` 时，这台机器上实际会用的那个（界面据此说清「auto → cmd」）。 */
  resolvedShell: TerminalShellId;
}> {
  const response = await fetch(`${getServerBaseUrl()}/api/code/shells`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as {
    shells: TerminalShellOption[];
    defaultShell: TerminalShellId;
    resolvedShell: TerminalShellId;
  };
}
