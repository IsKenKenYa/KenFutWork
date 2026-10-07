import {
  localAccessClientCreateResponseSchema,
  localAccessClientListResponseSchema,
} from "@kenfutwork/shared";
import { getServerBaseUrl } from "./env";
import { serverFetch } from "./local-access";

async function clientsRequest(path = "", init?: RequestInit) {
  const response = await serverFetch(
    `${getServerBaseUrl()}/api/local-access/clients${path}`,
    init,
  );
  if (response.status === 204) return undefined;
  const payload = await response.json();
  if (!response.ok)
    throw new Error(payload?.error?.message ?? "本机接入管理失败。");
  return payload;
}

export async function fetchLocalAccessClients() {
  return localAccessClientListResponseSchema.parse(await clientsRequest());
}

export async function createLocalAccessClient(label: string) {
  return localAccessClientCreateResponseSchema.parse(
    await clientsRequest("", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    }),
  );
}

export async function revokeLocalAccessClient(id: string) {
  await clientsRequest(`/${encodeURIComponent(id)}`, { method: "DELETE" });
}
