import type {
  ModelCapability,
  ProviderInstanceCreateRequest,
  ProviderInstanceResponse,
  ProviderInstanceUpdateRequest,
  ProviderProtocol,
} from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import { decryptSecret, encryptSecret } from "./secret-store.js";

/**
 * modelProviders 缝（§4.8）：用户供应商实例 CRUD + 凭证解析。
 * 职责边界：不持有协议适配器实现（那是 providers/<protocol>/ + generation 注册表），
 * 不推导目录（那是 modelCatalog）。
 * 凭证红线（DEC-7）：明文 Key 只在 encryptSecret/decryptSecret 边界短暂出现，
 * 任何响应都不含 key；RLS 按工作区隔离，服务端按个人工作区解析。
 */

export class ModelProviderServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "instance_not_found"
    | "instance_create_failed"
    | "instance_update_failed"
    | "instance_delete_failed"
    | "instance_query_failed"
    | "credential_unavailable";

  constructor(
    code: ModelProviderServiceError["code"],
    message: string,
    statusCode = 500,
  ) {
    super(message);
    this.name = "ModelProviderServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** 解密后的实例运行时凭证——只允许进入协议适配器，禁止序列化/日志/响应。 */
export interface ResolvedInstanceCredentials {
  instanceId: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl?: string;
  apiKey: string;
  compat?: Record<string, unknown>;
  models: Array<{ id: string; name: string; capability: ModelCapability }>;
}

interface ProviderInstanceRow {
  id: string;
  workspace_id: string;
  name: string;
  protocol: string;
  base_url: string | null;
  encrypted_api_key: string;
  models: Array<{ id: string; name: string; capability: string }> | null;
  compat: Record<string, unknown> | null;
  enabled: boolean;
}

/** provider_instances 未纳入 supabase 生成类型，走宽松访问（同 skills 路由）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const untypedFrom = (client: unknown, table: string): any =>
  (client as any).from(table);

function toResponse(row: ProviderInstanceRow): ProviderInstanceResponse {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol as ProviderProtocol,
    ...(row.base_url ? { baseUrl: row.base_url } : {}),
    hasCredential: true,
    models: (row.models ?? []).map(
      (m: {
        id: string;
        name: string;
        capability: string;
        vision?: boolean;
        contextWindow?: number;
      }) => ({
        id: m.id,
        name: m.name,
        capability: m.capability as ModelCapability,
        ...(m.vision ? { vision: true } : {}),
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      }),
    ),
    ...(row.compat ? { compat: row.compat } : {}),
    enabled: row.enabled,
  };
}

export interface ModelProviderService {
  listInstances(user: AuthenticatedUser): Promise<ProviderInstanceResponse[]>;
  createInstance(
    user: AuthenticatedUser,
    input: ProviderInstanceCreateRequest,
  ): Promise<ProviderInstanceResponse>;
  updateInstance(
    user: AuthenticatedUser,
    instanceId: string,
    input: ProviderInstanceUpdateRequest,
  ): Promise<ProviderInstanceResponse>;
  deleteInstance(user: AuthenticatedUser, instanceId: string): Promise<void>;
  /** 内部凭证解析：明文 Key 只在此处解密，供协议适配器实例化（DEC-7）。 */
  resolveCredentials(
    user: AuthenticatedUser,
    instanceId: string,
  ): Promise<ResolvedInstanceCredentials>;
  /**
   * worker 路径：按实例 id 直接解析（服务角色，绕 RLS）。
   * 任务 executor 无用户 access token，只能走 admin 客户端。
   */
  resolveCredentialsById(
    instanceId: string,
  ): Promise<ResolvedInstanceCredentials>;
}

export function createModelProviderService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient?: () => AdminSupabaseClient;
  credentialEnv: { credentialSecret?: string };
}): ModelProviderService {
  const { createUserClient, credentialEnv } = options;
  const getAdminClient = options.getAdminClient;

  function requireCredentialSecret(): string {
    if (!credentialEnv.credentialSecret) {
      throw new ModelProviderServiceError(
        "credential_unavailable",
        "LOOMIC_CREDENTIAL_SECRET 未配置，无法写入用户凭证（fail loud）。",
        500,
      );
    }
    return credentialEnv.credentialSecret;
  }

  async function resolveWorkspace(
    client: UserSupabaseClient,
    userId: string,
    errorCode: ModelProviderServiceError["code"],
  ): Promise<string> {
    const { data, error } = await client
      .from("workspaces")
      .select("id")
      .eq("owner_user_id", userId)
      .eq("type", "personal")
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      throw new ModelProviderServiceError(
        errorCode,
        "Unable to resolve workspace for provider instance.",
      );
    }
    return (data as { id: string }).id;
  }

  return {
    async listInstances(user) {
      try {
        const client = createUserClient(user.accessToken);
        const { data, error } = await untypedFrom(client, "provider_instances")
          .select("*")
          .order("created_at", { ascending: true });
        if (error) {
          throw new ModelProviderServiceError(
            "instance_query_failed",
            "Unable to load provider instances.",
          );
        }
        return ((data ?? []) as ProviderInstanceRow[]).map(toResponse);
      } catch (error) {
        if (error instanceof ModelProviderServiceError) throw error;
        throw new ModelProviderServiceError(
          "instance_query_failed",
          "Unable to load provider instances.",
        );
      }
    },

    async createInstance(user, input) {
      requireCredentialSecret();
      try {
        const client = createUserClient(user.accessToken);
        const workspaceId = await resolveWorkspace(
          client,
          user.id,
          "instance_create_failed",
        );
        const { data, error } = await untypedFrom(client, "provider_instances")
          .insert({
            workspace_id: workspaceId,
            name: input.name,
            protocol: input.protocol,
            ...(input.baseUrl ? { base_url: input.baseUrl } : {}),
            encrypted_api_key: encryptSecret(credentialEnv, input.apiKey),
            models: input.models,
            ...(input.compat ? { compat: input.compat } : {}),
            enabled: input.enabled ?? true,
            created_by: user.id,
          })
          .select("*")
          .single();
        if (error || !data) {
          throw new ModelProviderServiceError(
            "instance_create_failed",
            "Unable to create provider instance.",
          );
        }
        return toResponse(data as ProviderInstanceRow);
      } catch (error) {
        if (error instanceof ModelProviderServiceError) throw error;
        throw new ModelProviderServiceError(
          "instance_create_failed",
          "Unable to create provider instance.",
        );
      }
    },

    async updateInstance(user, instanceId, input) {
      try {
        const client = createUserClient(user.accessToken);
        const updates: Record<string, unknown> = {};
        if (input.name !== undefined) updates.name = input.name;
        if (input.baseUrl !== undefined) updates.base_url = input.baseUrl;
        if (input.apiKey !== undefined) {
          updates.encrypted_api_key = encryptSecret(
            credentialEnv,
            input.apiKey,
          );
        }
        if (input.models !== undefined) updates.models = input.models;
        if (input.compat !== undefined) updates.compat = input.compat;
        if (input.enabled !== undefined) updates.enabled = input.enabled;
        if (Object.keys(updates).length === 0) {
          throw new ModelProviderServiceError(
            "instance_update_failed",
            "No fields to update.",
            400,
          );
        }
        const { data, error } = await untypedFrom(client, "provider_instances")
          .update(updates)
          .eq("id", instanceId)
          .select("*")
          .single();
        if (error || !data) {
          throw new ModelProviderServiceError(
            "instance_not_found",
            "Provider instance not found.",
            404,
          );
        }
        return toResponse(data as ProviderInstanceRow);
      } catch (error) {
        if (error instanceof ModelProviderServiceError) throw error;
        throw new ModelProviderServiceError(
          "instance_update_failed",
          "Unable to update provider instance.",
        );
      }
    },

    async deleteInstance(user, instanceId) {
      try {
        const client = createUserClient(user.accessToken);
        const { error } = await untypedFrom(client, "provider_instances")
          .delete()
          .eq("id", instanceId);
        if (error) {
          throw new ModelProviderServiceError(
            "instance_delete_failed",
            "Unable to delete provider instance.",
          );
        }
      } catch (error) {
        if (error instanceof ModelProviderServiceError) throw error;
        throw new ModelProviderServiceError(
          "instance_delete_failed",
          "Unable to delete provider instance.",
        );
      }
    },

    async resolveCredentials(user, instanceId) {
      let row: ProviderInstanceRow | undefined;
      try {
        const client = createUserClient(user.accessToken);
        const { data, error } = await untypedFrom(client, "provider_instances")
          .select("*")
          .eq("id", instanceId)
          .maybeSingle();
        if (error || !data) {
          throw new ModelProviderServiceError(
            "instance_not_found",
            "Provider instance not found.",
            404,
          );
        }
        row = data as ProviderInstanceRow;
      } catch (error) {
        if (error instanceof ModelProviderServiceError) throw error;
        throw new ModelProviderServiceError(
          "instance_query_failed",
          "Unable to load provider instance.",
        );
      }
      if (!row.enabled) {
        throw new ModelProviderServiceError(
          "credential_unavailable",
          `Provider instance ${row.name} is disabled.`,
          409,
        );
      }
      try {
        const apiKey = decryptSecret(credentialEnv, row.encrypted_api_key);
        return {
          instanceId: row.id,
          name: row.name,
          protocol: row.protocol as ProviderProtocol,
          ...(row.base_url ? { baseUrl: row.base_url } : {}),
          apiKey,
          ...(row.compat ? { compat: row.compat } : {}),
          models: (row.models ?? []).map(
            (m: {
              id: string;
              name: string;
              capability: string;
              vision?: boolean;
              contextWindow?: number;
            }) => ({
              id: m.id,
              name: m.name,
              capability: m.capability as ModelCapability,
              ...(m.vision ? { vision: true } : {}),
              ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
            }),
          ),
        };
      } catch (error) {
        if (error instanceof ModelProviderServiceError) throw error;
        throw new ModelProviderServiceError(
          "credential_unavailable",
          "Unable to decrypt provider credentials (fail loud).",
        );
      }
    },

    async resolveCredentialsById(instanceId) {
      if (!getAdminClient) {
        throw new ModelProviderServiceError(
          "credential_unavailable",
          "resolveCredentialsById 需要注入 getAdminClient（fail loud）。",
        );
      }
      const admin = getAdminClient();
      const { data, error } = await untypedFrom(admin, "provider_instances")
        .select("*")
        .eq("id", instanceId)
        .maybeSingle();
      if (error || !data) {
        throw new ModelProviderServiceError(
          "instance_not_found",
          "Provider instance not found.",
          404,
        );
      }
      const row = data as ProviderInstanceRow;
      if (!row.enabled) {
        throw new ModelProviderServiceError(
          "credential_unavailable",
          `Provider instance ${row.name} is disabled.`,
          409,
        );
      }
      const apiKey = decryptSecret(credentialEnv, row.encrypted_api_key);
      return {
        instanceId: row.id,
        name: row.name,
        protocol: row.protocol as ProviderProtocol,
        ...(row.base_url ? { baseUrl: row.base_url } : {}),
        apiKey,
        ...(row.compat ? { compat: row.compat } : {}),
        models: (row.models ?? []).map(
          (m: {
            id: string;
            name: string;
            capability: string;
            vision?: boolean;
            contextWindow?: number;
          }) => ({
            id: m.id,
            name: m.name,
            capability: m.capability as ModelCapability,
            ...(m.vision ? { vision: true } : {}),
            ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          }),
        ),
      };
    },
  };
}
