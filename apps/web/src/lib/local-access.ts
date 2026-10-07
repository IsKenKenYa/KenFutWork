import {
  type InstanceContext,
  instanceResponseSchema,
} from "@kenfutwork/shared";
import { dedupeRequest } from "./dedupe-request";
import { getServerBaseUrl } from "./env";

export const LOCAL_ACCESS_LOST_EVENT = "kenfutwork:local-access-lost";

export class LocalAccessError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LocalAccessError";
  }
}

export function bearerHeaders(token?: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 本机浏览器凭据由 HttpOnly cookie 持有，应用代码不读写令牌。 */
export async function serverFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  const response = await fetch(input, { ...init, credentials: "include" });
  if (response.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new Event(LOCAL_ACCESS_LOST_EVENT));
  }
  return response;
}

async function assertConnected(response: Response) {
  if (response.ok) return;
  const payload = await response.json().catch(() => null);
  throw new LocalAccessError(
    response.status,
    payload?.error?.message ?? `本机服务请求失败（HTTP ${response.status}）。`,
  );
}

export function loadLocalInstance(): Promise<InstanceContext> {
  return dedupeRequest("local-instance-bootstrap", connectLocalInstance);
}

async function connectLocalInstance(): Promise<InstanceContext> {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const ticket = fragment.get("connect");
  if (ticket) {
    const response = await fetch(
      `${getServerBaseUrl()}/api/local-access/connect`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket }),
      },
    );
    await assertConnected(response);
    fragment.delete("connect");
    const hash = fragment.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ""}`,
    );
  }
  const response = await fetch(`${getServerBaseUrl()}/api/instance`, {
    credentials: "include",
  });
  await assertConnected(response);
  return instanceResponseSchema.parse(await response.json());
}
