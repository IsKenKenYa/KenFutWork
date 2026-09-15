import type {
  AdminMeResponse,
  AdminPlatformUsageResponse,
  AdminSystemInstanceListResponse,
  AdminUserListResponse,
  ProviderInstanceCreateRequest,
  ProviderInstanceResponse,
  SubscriptionPlan,
} from "@kenfutwork/shared";
import { getServerBaseUrl } from "./env";
import { ApiAuthError } from "./server-api";

/** 平台管理后台 API（FORM-10）。所有端点由服务端强制管理员权限（403）。 */

async function request<T>(
  path: string,
  accessToken: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(`${getServerBaseUrl()}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });

  if (response.status === 401) {
    throw new ApiAuthError();
  }
  if (response.status === 403) {
    throw new Error("需要平台管理员权限。");
  }
  if (!response.ok) {
    // 服务端错误契约为 { error: { code, message } }，尽量透出可读信息
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(
      payload?.error?.message ?? `请求失败（${response.status}）`,
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function fetchAdminMe(accessToken: string): Promise<AdminMeResponse> {
  return request<AdminMeResponse>("/api/admin/me", accessToken);
}

export function fetchAdminUsers(
  accessToken: string,
): Promise<AdminUserListResponse> {
  return request<AdminUserListResponse>("/api/admin/users", accessToken);
}

export function fetchAdminUsage(
  accessToken: string,
): Promise<AdminPlatformUsageResponse> {
  return request<AdminPlatformUsageResponse>("/api/admin/usage", accessToken);
}

export function fetchAdminProviders(
  accessToken: string,
): Promise<AdminSystemInstanceListResponse> {
  return request<AdminSystemInstanceListResponse>(
    "/api/admin/providers",
    accessToken,
  );
}

export function createAdminProvider(
  accessToken: string,
  input: ProviderInstanceCreateRequest,
): Promise<ProviderInstanceResponse> {
  return request<ProviderInstanceResponse>(
    "/api/admin/providers",
    accessToken,
    {
      method: "POST",
      body: input,
    },
  );
}

export function updateAdminProvider(
  accessToken: string,
  instanceId: string,
  input: Partial<ProviderInstanceCreateRequest>,
): Promise<ProviderInstanceResponse> {
  return request<ProviderInstanceResponse>(
    `/api/admin/providers/${instanceId}`,
    accessToken,
    { method: "PATCH", body: input },
  );
}

export function deleteAdminProvider(
  accessToken: string,
  instanceId: string,
): Promise<void> {
  return request<void>(`/api/admin/providers/${instanceId}`, accessToken, {
    method: "DELETE",
  });
}

export function grantAdminCredits(
  accessToken: string,
  userId: string,
  amount: number,
  description?: string,
): Promise<AdminUserListResponse> {
  return request<AdminUserListResponse>(
    `/api/admin/users/${userId}/credits`,
    accessToken,
    {
      method: "POST",
      body: {
        amount,
        ...(description ? { description } : {}),
      },
    },
  );
}

export function setAdminUserPlan(
  accessToken: string,
  userId: string,
  plan: SubscriptionPlan,
): Promise<AdminUserListResponse> {
  return request<AdminUserListResponse>(
    `/api/admin/users/${userId}/plan`,
    accessToken,
    { method: "POST", body: { plan } },
  );
}

export function setAdminUserRole(
  accessToken: string,
  userId: string,
  role: "user" | "admin",
): Promise<AdminUserListResponse> {
  return request<AdminUserListResponse>(
    `/api/admin/users/${userId}/role`,
    accessToken,
    { method: "POST", body: { role } },
  );
}
