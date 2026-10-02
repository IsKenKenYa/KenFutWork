import type {
  ModelCapability,
  ProviderInstanceCreateRequest,
  ProviderInstanceResponse,
  ProviderInstanceUpdateRequest,
  ProviderPreset,
  ProviderProbeResult,
  ProviderProtocol,
  ProviderScope,
} from "@kenfutwork/shared";

import type { AuthenticatedUser } from "../auth/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import { loadBundledModelsDevSnapshot } from "./models-dev-bundled.js";
import { listProviderPresets } from "./models-dev-snapshot.js";
import { type ProbeFetch, type ProbeTarget, probeInstance } from "./probe.js";
import type {
  ModelProviderRepository,
  ProviderInstancePatch,
  ProviderInstanceRecord,
} from "./repository.js";
import { decryptSecret, encryptSecret } from "./secret-store.js";

/**
 * modelProviders 缝（§4.8）：用户供应商实例 CRUD + 凭证解析。
 * 职责边界：不持有协议适配器实现（那是 providers/<protocol>/ + generation 注册表），
 * 不推导目录（那是 modelCatalog）。
 * 凭证红线（DEC-7）：明文 Key 只在 encryptSecret/decryptSecret 边界短暂出现，
 * 任何响应都不含 key；工作区实例按鉴权用户解析的工作区隔离（`FORM-9`），
 * 平台池实例（`scope='system'`）是系统级数据、按 scope 限定。
 */

export class ModelProviderServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "instance_not_found"
    | "instance_create_failed"
    | "instance_update_failed"
    | "instance_delete_failed"
    | "instance_query_failed"
    | "instance_probe_failed"
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
  /** 自定义请求头（原值，含占位符）：调用方按会话上下文渲染后再交给适配器。 */
  headers?: Record<string, string>;
  models: Array<{
    id: string;
    name: string;
    capability: ModelCapability;
    enabled?: boolean;
    reasoningEfforts?: string[];
    extraBody?: Record<string, unknown>;
  }>;
  /** 实例配置修订号：异步任务落盘修订与当前不一致即拒（跨修订防护）。 */
  configRevision: number;
}

type InstanceModel = {
  id: string;
  name: string;
  capability: string;
  enabled?: boolean;
  vision?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningEfforts?: string[];
  extraBody?: Record<string, unknown>;
};

function mapModels(models: InstanceModel[] | null) {
  return (models ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    capability: m.capability as ModelCapability,
    ...(m.enabled === false ? { enabled: false } : {}),
    ...(m.vision ? { vision: true } : {}),
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}),
    ...(m.reasoningEfforts ? { reasoningEfforts: m.reasoningEfforts } : {}),
    ...(m.extraBody ? { extraBody: m.extraBody } : {}),
  }));
}

function toResponse(row: ProviderInstanceRecord): ProviderInstanceResponse {
  return {
    id: row.id,
    scope: row.scope === "system" ? "system" : "workspace",
    name: row.name,
    protocol: row.protocol as ProviderProtocol,
    ...(row.base_url ? { baseUrl: row.base_url } : {}),
    hasCredential: Boolean(row.encrypted_api_key),
    models: mapModels(row.models),
    ...(row.compat ? { compat: row.compat } : {}),
    // 自定义头只回键名，值不回显（与 MCP env/envKeys 同口径）。
    headerKeys: Object.keys(row.headers ?? {}),
    enabled: row.enabled,
    ...(row.probe_result
      ? { probe: row.probe_result as ProviderProbeResult }
      : {}),
  };
}

function toCredentials(row: ProviderInstanceRecord, apiKey: string) {
  return {
    instanceId: row.id,
    name: row.name,
    protocol: row.protocol as ProviderProtocol,
    ...(row.base_url ? { baseUrl: row.base_url } : {}),
    apiKey,
    ...(row.compat ? { compat: row.compat } : {}),
    ...(row.headers ? { headers: row.headers } : {}),
    models: mapModels(row.models),
    configRevision: Number(row.config_revision),
    // 探测纠偏消费面：仅 true 带出（false/缺席=未支持或不详，默认 completions）
    ...((row.probe_result as { responsesApi?: boolean } | null)
      ?.responsesApi === true
      ? { responsesApi: true }
      : {}),
  };
}

/** 请求体 → 列补丁（仅含显式给出的字段）。 */
function toPatch(input: ProviderInstanceUpdateRequest) {
  const patch: ProviderInstancePatch = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.baseUrl !== undefined) patch.base_url = input.baseUrl;
  if (input.models !== undefined) patch.models = input.models;
  if (input.compat !== undefined) patch.compat = input.compat;
  // 自定义头整体覆盖：显式 `{}` 即清空。
  if (input.headers !== undefined) patch.headers = input.headers;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  return patch;
}

export interface ModelProviderService {
  getWorkspaceRevision(user: AuthenticatedUser): Promise<number>;
  createDraftInstance(
    user: AuthenticatedUser,
    input: { name: string; protocol: ProviderProtocol; baseUrl?: string },
  ): Promise<ProviderInstanceResponse>;
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
   * worker 路径：按实例 id 直接解析。
   * 任务 executor 无用户 access token，故不做工作区限定（系统级取数）。
   */
  resolveCredentialsById(
    instanceId: string,
  ): Promise<ResolvedInstanceCredentials>;
  /**
   * 实例能力探测（阶段 E）：连通性 + 中转方言四探测项，结果缓存到实例。
   * 仅限用户自己的工作区实例；每次探测都会覆盖上一次结果。
   */
  probeInstance(
    user: AuthenticatedUser,
    instanceId: string,
    fetchFn?: ProbeFetch,
  ): Promise<ProviderProbeResult>;
  /** models.dev 供应商预设清单（供应商设置的「从预设选择」）。 */
  listProviderPresets(): ProviderPreset[];
  /**
   * 平台池（scope='system'）：管理员配置一份 Key，分发给全体用户使用。
   */
  listSystemInstances(): Promise<ProviderInstanceResponse[]>;
  createSystemInstance(
    input: ProviderInstanceCreateRequest,
    /** 创建者（管理员用户 id）：provider_instances.created_by 仍是非空外键。 */
    createdByUserId: string,
  ): Promise<ProviderInstanceResponse>;
  updateSystemInstance(
    instanceId: string,
    input: ProviderInstanceUpdateRequest,
  ): Promise<ProviderInstanceResponse>;
  deleteSystemInstance(instanceId: string): Promise<void>;
  /** 实例作用域（平台池计费归属用）；实例不存在返回 null。 */
  getInstanceScope(instanceId: string): Promise<ProviderScope | null>;
}

export function createModelProviderService(options: {
  credentialEnv: { credentialSecret?: string };
  repository: ModelProviderRepository;
  /**
   * 工作区实例路径需要它；worker 进程只走平台池/按 id 解析路径，可缺省。
   * 缺省时工作区方法**立即 fail loud**（不是静默降级）。
   */
  viewerService?: ViewerService | undefined;
}): ModelProviderService {
  const { credentialEnv, repository, viewerService } = options;

  function requireViewer(): ViewerService {
    if (!viewerService) {
      throw new ModelProviderServiceError(
        "instance_query_failed",
        "工作区级供应商实例操作需要 ViewerService（worker 进程不提供）。",
        500,
      );
    }
    return viewerService;
  }

  function requireCredentialSecret(): string {
    if (!credentialEnv.credentialSecret) {
      throw new ModelProviderServiceError(
        "credential_unavailable",
        "KENFUTWORK_CREDENTIAL_SECRET 未配置，无法写入用户凭证（fail loud）。",
        500,
      );
    }
    return credentialEnv.credentialSecret;
  }

  /** 工作区 id 一律由服务端从鉴权用户解析（`FORM-9`）。 */
  async function requireWorkspaceId(
    user: AuthenticatedUser,
    errorCode: ModelProviderServiceError["code"],
  ): Promise<string> {
    const workspace = await requireViewer()
      .resolveWorkspace(user)
      .catch(() => null);

    if (!workspace) {
      throw new ModelProviderServiceError(
        errorCode,
        "Unable to resolve workspace for provider instance.",
      );
    }

    return workspace.id;
  }

  /** 解密实例凭证；停用即 409，解密失败即 fail loud。 */
  function decryptRow(row: ProviderInstanceRecord) {
    if (!row.encrypted_api_key)
      throw new ModelProviderServiceError(
        "credential_unavailable",
        "Provider credential is not configured.",
        409,
      );
    if (!row.enabled) {
      throw new ModelProviderServiceError(
        "credential_unavailable",
        `Provider instance ${row.name} is disabled.`,
        409,
      );
    }

    try {
      return toCredentials(
        row,
        decryptSecret(credentialEnv, row.encrypted_api_key),
      );
    } catch (error) {
      if (error instanceof ModelProviderServiceError) throw error;
      throw new ModelProviderServiceError(
        "credential_unavailable",
        "Unable to decrypt provider credentials (fail loud).",
      );
    }
  }

  return {
    async getWorkspaceRevision(user) {
      return repository.getWorkspaceRevision(
        await requireWorkspaceId(user, "instance_query_failed"),
      );
    },
    async createDraftInstance(user, input) {
      const workspaceId = await requireWorkspaceId(
        user,
        "instance_create_failed",
      );
      const row = await repository.insertWorkspaceInstance({
        name: input.name,
        protocol: input.protocol,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        workspaceId,
        createdBy: user.id,
        encryptedApiKey: null,
        models: [],
        enabled: true,
      });
      if (!row)
        throw new ModelProviderServiceError(
          "instance_create_failed",
          "Unable to create provider draft.",
        );
      return toResponse(row);
    },
    async listInstances(user) {
      const workspaceId = await requireWorkspaceId(
        user,
        "instance_query_failed",
      );

      const rows = await repository
        .listWorkspaceInstances(workspaceId)
        .catch(() => {
          throw new ModelProviderServiceError(
            "instance_query_failed",
            "Unable to load provider instances.",
          );
        });

      return rows.map(toResponse);
    },

    async createInstance(user, input) {
      const secret = requireCredentialSecret();
      const workspaceId = await requireWorkspaceId(
        user,
        "instance_create_failed",
      );

      const row = await repository
        .insertWorkspaceInstance({
          ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
          ...(input.compat ? { compat: input.compat } : {}),
          ...(input.headers ? { headers: input.headers } : {}),
          createdBy: user.id,
          encryptedApiKey: encryptSecret(
            { credentialSecret: secret },
            input.apiKey,
          ),
          enabled: input.enabled ?? true,
          models: input.models,
          name: input.name,
          protocol: input.protocol,
          workspaceId,
        })
        .catch(() => {
          throw new ModelProviderServiceError(
            "instance_create_failed",
            "Unable to create provider instance.",
          );
        });

      if (!row) {
        throw new ModelProviderServiceError(
          "instance_create_failed",
          "Unable to create provider instance.",
        );
      }

      return toResponse(row);
    },

    async updateInstance(user, instanceId, input) {
      const patch = toPatch(input);
      if (input.apiKey !== undefined) {
        const secret = requireCredentialSecret();
        patch.encrypted_api_key = encryptSecret(
          { credentialSecret: secret },
          input.apiKey,
        );
      }
      if (Object.keys(patch).length === 0) {
        throw new ModelProviderServiceError(
          "instance_update_failed",
          "No fields to update.",
          400,
        );
      }

      const workspaceId = await requireWorkspaceId(
        user,
        "instance_update_failed",
      );

      const row = await repository
        .updateWorkspaceInstance(workspaceId, instanceId, patch)
        .catch(() => {
          throw new ModelProviderServiceError(
            "instance_update_failed",
            "Unable to update provider instance.",
          );
        });

      if (!row) {
        throw new ModelProviderServiceError(
          "instance_not_found",
          "Provider instance not found.",
          404,
        );
      }

      return toResponse(row);
    },

    async deleteInstance(user, instanceId) {
      const workspaceId = await requireWorkspaceId(
        user,
        "instance_delete_failed",
      );

      // 未命中不报错：删除是幂等操作（重复删除返回成功）。
      await repository
        .deleteWorkspaceInstance(workspaceId, instanceId)
        .catch(() => {
          throw new ModelProviderServiceError(
            "instance_delete_failed",
            "Unable to delete provider instance.",
          );
        });
    },

    async resolveCredentials(user, instanceId) {
      const workspaceId = await requireWorkspaceId(
        user,
        "instance_query_failed",
      );

      const row = await repository
        .findWorkspaceInstance(workspaceId, instanceId)
        .catch(() => {
          throw new ModelProviderServiceError(
            "instance_query_failed",
            "Unable to load provider instance.",
          );
        });

      if (row) {
        return decryptRow(row);
      }

      // 回退到**平台池**（`scope='system'`，FORM-10）：管理员配一份 Key 分发全体用户，
      // 模型目录里就包含这些实例，故凭证解析必须覆盖它们——否则选中平台池模型必然 404。
      // **只接受 system 作用域**：工作区实例拿不到别人的（隔离性不因此放宽）。
      const systemRow = await repository.findById(instanceId).catch(() => null);
      if (systemRow?.scope !== "system") {
        throw new ModelProviderServiceError(
          "instance_not_found",
          "Provider instance not found.",
          404,
        );
      }

      return decryptRow(systemRow);
    },

    listProviderPresets() {
      return listProviderPresets(loadBundledModelsDevSnapshot() ?? {});
    },

    async probeInstance(user, instanceId, fetchFn) {
      const workspaceId = await requireWorkspaceId(
        user,
        "instance_probe_failed",
      );

      const rows = await repository
        .listWorkspaceInstances(workspaceId)
        .catch(() => {
          throw new ModelProviderServiceError(
            "instance_probe_failed",
            "Unable to load provider instances.",
          );
        });
      const row = rows.find((candidate) => candidate.id === instanceId);
      if (!row) {
        throw new ModelProviderServiceError(
          "instance_not_found",
          "Provider instance not found.",
          404,
        );
      }
      const credentials = decryptRow(row);

      const chatModel = credentials.models.find(
        (m) => m.capability === "chat",
      )?.id;
      const baseUrl =
        credentials.baseUrl ??
        (credentials.protocol === "anthropic"
          ? "https://api.anthropic.com/v1"
          : null);
      if (!baseUrl) {
        throw new ModelProviderServiceError(
          "instance_probe_failed",
          "该实例未声明 baseUrl，无法探测（openai-compatible 协议必须显式配置）",
        );
      }
      const target: ProbeTarget = {
        protocol: credentials.protocol,
        baseUrl,
        apiKey: credentials.apiKey,
        ...(chatModel ? { model: chatModel } : {}),
      };
      const result = await probeInstance(fetchFn ?? fetch, target);
      await repository.setProbeResult(workspaceId, instanceId, result);
      return result;
    },

    async resolveCredentialsById(instanceId) {
      const row = await repository.findById(instanceId).catch(() => {
        throw new ModelProviderServiceError(
          "instance_query_failed",
          "Unable to load provider instance.",
        );
      });

      if (!row) {
        throw new ModelProviderServiceError(
          "instance_not_found",
          "Provider instance not found.",
          404,
        );
      }

      return decryptRow(row);
    },

    // ── 平台池（scope='system'）：管理员配置、分发给用户 ──
    async listSystemInstances() {
      const rows = await repository.listSystemInstances().catch(() => {
        throw new ModelProviderServiceError(
          "instance_query_failed",
          "Unable to load system provider instances.",
        );
      });
      return rows.map(toResponse);
    },

    async createSystemInstance(input, createdByUserId) {
      const secret = requireCredentialSecret();

      const row = await repository
        .insertSystemInstance({
          ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
          ...(input.compat ? { compat: input.compat } : {}),
          ...(input.headers ? { headers: input.headers } : {}),
          createdBy: createdByUserId,
          encryptedApiKey: encryptSecret(
            { credentialSecret: secret },
            input.apiKey,
          ),
          enabled: input.enabled ?? true,
          models: input.models,
          name: input.name,
          protocol: input.protocol,
        })
        .catch(() => {
          throw new ModelProviderServiceError(
            "instance_create_failed",
            "Unable to create system provider instance.",
          );
        });

      if (!row) {
        throw new ModelProviderServiceError(
          "instance_create_failed",
          "Unable to create system provider instance.",
        );
      }

      return toResponse(row);
    },

    async updateSystemInstance(instanceId, input) {
      const patch = toPatch(input);
      if (input.apiKey !== undefined) {
        const secret = requireCredentialSecret();
        patch.encrypted_api_key = encryptSecret(
          { credentialSecret: secret },
          input.apiKey,
        );
      }
      if (Object.keys(patch).length === 0) {
        throw new ModelProviderServiceError(
          "instance_update_failed",
          "No fields to update.",
          400,
        );
      }

      const row = await repository
        .updateSystemInstance(instanceId, patch)
        .catch(() => {
          throw new ModelProviderServiceError(
            "instance_update_failed",
            "Unable to update system provider instance.",
          );
        });

      if (!row) {
        throw new ModelProviderServiceError(
          "instance_not_found",
          "System provider instance not found.",
          404,
        );
      }

      return toResponse(row);
    },

    async deleteSystemInstance(instanceId) {
      // 未命中不报错：删除是幂等操作。
      await repository.deleteSystemInstance(instanceId).catch(() => {
        throw new ModelProviderServiceError(
          "instance_delete_failed",
          "Unable to delete system provider instance.",
        );
      });
    },

    async getInstanceScope(instanceId) {
      const row = await repository.findById(instanceId).catch(() => null);
      if (!row) {
        return null;
      }
      return row.scope === "system" ? "system" : "workspace";
    },
  };
}
