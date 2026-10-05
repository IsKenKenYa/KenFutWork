import { randomUUID } from "node:crypto";
import type {
  InstanceContext,
  ProviderInstanceCreateRequest,
  ProviderInstanceModel,
  ProviderInstanceResponse,
  ProviderInstanceUpdateRequest,
  ProviderPreset,
  ProviderProbeResult,
  ProviderProtocol,
} from "@kenfutwork/shared";
import { providerInstanceModelSchema } from "@kenfutwork/shared";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import {
  createLocalCredentialStore,
  type LocalCredentialStore,
} from "./local-credential-store.js";
import {
  type ModelConnectivityInput,
  type ModelConnectivityOptions,
  type ModelConnectivityResult,
  testInstanceModelConnectivity,
} from "./model-connectivity.js";
import { loadBundledModelsDevSnapshot } from "./models-dev-bundled.js";
import { listProviderPresets } from "./models-dev-snapshot.js";
import { type ProbeFetch, type ProbeTarget, probeInstance } from "./probe.js";
import type {
  ModelProviderRepository,
  ProviderInstancePatch,
  ProviderInstanceRecord,
} from "./repository.js";

/**
 * modelProviders 缝（DEC-7 / DEC-20）：本地实例供应商 CRUD + 凭据解析。
 * 元数据唯一保存在 Postgres，Key 由实例数据目录的 LocalCredentialStore 持有。
 * 普通响应不含 Key；授权设置通过 readCredential 按需读取。
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
    | "instance_revision_conflict"
    | "instance_model_unavailable"
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

/** 实例运行时凭据供适配器使用；普通目录与持久事件不携带 Key。 */
export interface ResolvedInstanceCredentials {
  instanceId: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl?: string;
  apiKey: string;
  useResponsesApi?: boolean;
  responsesApi?: boolean;
  compat?: Record<string, unknown>;
  /** 自定义请求头（原值，含占位符）：调用方按会话上下文渲染后再交给适配器。 */
  headers?: Record<string, string>;
  models: ProviderInstanceModel[];
  /** 实例配置修订号：异步任务落盘修订与当前不一致即拒（跨修订防护）。 */
  configRevision: number;
}

function mapModels(row: ProviderInstanceRecord) {
  return (row.models ?? []).map((model) =>
    providerInstanceModelSchema.parse(model),
  );
}

function toResponse(row: ProviderInstanceRecord): ProviderInstanceResponse {
  return {
    id: row.id,
    scope: "local",
    name: row.name,
    protocol: row.protocol as ProviderProtocol,
    ...(row.base_url !== null ? { baseUrl: row.base_url } : {}),
    hasCredential: Boolean(row.api_key_ref),
    configRevision: Number(row.config_revision),
    models: mapModels(row),
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
    ...(row.compat?.chatApi === "responses"
      ? { useResponsesApi: true }
      : row.compat?.chatApi === "completions"
        ? { useResponsesApi: false }
        : {}),
    ...(row.compat ? { compat: row.compat } : {}),
    ...(row.headers ? { headers: row.headers } : {}),
    models: mapModels(row),
    configRevision: Number(row.config_revision),
    // 已声明的格式走精确 native API，未声明格式由能力探测辅助。
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
  if (input.protocol !== undefined) patch.protocol = input.protocol;
  if (input.baseUrl !== undefined) patch.base_url = input.baseUrl;
  if (input.models !== undefined) patch.models = input.models;
  if (input.compat !== undefined) patch.compat = input.compat;
  // 自定义头整体覆盖：显式 `{}` 即清空。
  if (input.headers !== undefined) patch.headers = input.headers;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  return patch;
}

export interface ModelProviderService {
  testModelConnectivity(
    actor: LocalActor,
    input: ModelConnectivityInput,
    options: ModelConnectivityOptions,
  ): Promise<ModelConnectivityResult>;
  listInstances(actor: LocalActor): Promise<ProviderInstanceResponse[]>;
  createInstance(
    actor: LocalActor,
    input: ProviderInstanceCreateRequest,
  ): Promise<ProviderInstanceResponse>;
  updateInstance(
    actor: LocalActor,
    providerId: string,
    input: ProviderInstanceUpdateRequest,
  ): Promise<ProviderInstanceResponse>;
  deleteInstance(actor: LocalActor, providerId: string): Promise<void>;
  /** 授权设置按需读取明文；未配置返回 null，磁盘与格式故障照常上抛。 */
  readCredential(actor: LocalActor, providerId: string): Promise<string | null>;
  resolveCredentials(
    actor: LocalActor,
    providerId: string,
  ): Promise<ResolvedInstanceCredentials>;
  /** 后台路径也限定当前本地实例，不依赖接入客户端或访问令牌。 */
  resolveCredentialsById(
    providerId: string,
  ): Promise<ResolvedInstanceCredentials>;
  probeInstance(
    actor: LocalActor,
    providerId: string,
    fetchFn?: ProbeFetch,
  ): Promise<ProviderProbeResult>;
  listProviderPresets(): ProviderPreset[];
}

export function createModelProviderService(options: {
  repository: ModelProviderRepository;
  localInstance: LocalInstanceService;
}): ModelProviderService {
  const { repository, localInstance } = options;
  const stores = new Map<string, LocalCredentialStore>();

  function credentials(context: InstanceContext): LocalCredentialStore {
    let store = stores.get(context.dataDir);
    if (!store) {
      store = createLocalCredentialStore(context.dataDir);
      stores.set(context.dataDir, store);
    }
    return store;
  }

  async function findProvider(
    context: InstanceContext,
    providerId: string,
  ): Promise<ProviderInstanceRecord> {
    const row = await repository.findInstance(context.instanceId, providerId);
    if (!row) {
      throw new ModelProviderServiceError(
        "instance_not_found",
        "找不到该供应商实例。",
        404,
      );
    }
    return row;
  }

  async function readKey(
    context: InstanceContext,
    row: ProviderInstanceRecord,
  ): Promise<string | null> {
    return row.api_key_ref === null
      ? null
      : credentials(context).get(row.api_key_ref);
  }

  async function resolveRow(
    context: InstanceContext,
    row: ProviderInstanceRecord,
  ): Promise<ResolvedInstanceCredentials> {
    if (!row.enabled) {
      throw new ModelProviderServiceError(
        "credential_unavailable",
        `供应商实例 ${row.name} 已停用。`,
        409,
      );
    }
    const apiKey = await readKey(context, row);
    if (apiKey === null) {
      throw new ModelProviderServiceError(
        "credential_unavailable",
        "该供应商尚未配置 API Key，请先在供应商设置中配置。",
        409,
      );
    }
    return toCredentials(row, apiKey);
  }

  function validateKey(
    key: string | null | undefined,
    code: "instance_create_failed" | "instance_update_failed",
  ): void {
    if (key === "") {
      throw new ModelProviderServiceError(
        code,
        "API Key 不能为空字符串；清除凭据请使用 null。",
        400,
      );
    }
  }

  async function updateMetadata(
    context: InstanceContext,
    providerId: string,
    patch: ProviderInstancePatch,
    expectedRevision: number | undefined,
  ): Promise<ProviderInstanceRecord> {
    const row = await repository.updateInstance(
      context.instanceId,
      providerId,
      patch,
      expectedRevision,
    );
    if (row) return row;
    if (
      expectedRevision !== undefined &&
      (await repository.findInstance(context.instanceId, providerId))
    ) {
      throw new ModelProviderServiceError(
        "instance_revision_conflict",
        "供应商配置已发生变化，请刷新后重新保存。",
        409,
      );
    }
    throw new ModelProviderServiceError(
      "instance_not_found",
      "找不到该供应商实例。",
      404,
    );
  }

  const service: ModelProviderService = {
    async testModelConnectivity(actor, input, options) {
      return testInstanceModelConnectivity(
        () => service.resolveCredentials(actor, input.instanceId),
        input,
        options,
      );
    },

    async listInstances(actor) {
      const context = await localInstance.resolve(actor);
      return (await repository.listInstances(context.instanceId)).map(
        toResponse,
      );
    },

    async createInstance(actor, input) {
      const context = await localInstance.resolve(actor);
      validateKey(input.apiKey, "instance_create_failed");
      const providerId = randomUUID();
      const key = input.apiKey ?? null;
      const row = await credentials(context).change(
        providerId,
        key,
        async () => {
          const created = await repository.insertInstance({
            id: providerId,
            instanceId: context.instanceId,
            ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
            ...(input.compat !== undefined ? { compat: input.compat } : {}),
            ...(input.headers !== undefined ? { headers: input.headers } : {}),
            apiKeyRef: key === null ? null : providerId,
            enabled: input.enabled ?? true,
            models: input.models,
            name: input.name,
            protocol: input.protocol,
          });
          if (!created) {
            throw new ModelProviderServiceError(
              "instance_create_failed",
              "无法创建供应商实例。",
            );
          }
          return created;
        },
      );
      return toResponse(row);
    },

    async updateInstance(actor, providerId, input) {
      const context = await localInstance.resolve(actor);
      validateKey(input.apiKey, "instance_update_failed");
      const patch = toPatch(input);
      if (input.apiKey !== undefined) {
        patch.api_key_ref = input.apiKey === null ? null : providerId;
      }
      if (Object.keys(patch).length === 0) {
        throw new ModelProviderServiceError(
          "instance_update_failed",
          "没有要更新的字段。",
          400,
        );
      }
      const commit = (credentialChanged = false) =>
        updateMetadata(
          context,
          providerId,
          { ...patch, credential_changed: credentialChanged },
          input.expectedRevision,
        );
      const row =
        input.apiKey === undefined
          ? await commit()
          : await credentials(context).change(providerId, input.apiKey, commit);
      return toResponse(row);
    },

    async deleteInstance(actor, providerId) {
      const context = await localInstance.resolve(actor);
      const row = await repository.findInstance(context.instanceId, providerId);
      if (!row) return;
      await credentials(context).change(
        row.api_key_ref ?? providerId,
        null,
        () => repository.deleteInstance(context.instanceId, providerId),
      );
    },

    async readCredential(actor, providerId) {
      const context = await localInstance.resolve(actor);
      return readKey(context, await findProvider(context, providerId));
    },

    async resolveCredentials(actor, providerId) {
      const context = await localInstance.resolve(actor);
      return resolveRow(context, await findProvider(context, providerId));
    },

    async resolveCredentialsById(providerId) {
      const context = await localInstance.getContext();
      return resolveRow(context, await findProvider(context, providerId));
    },

    listProviderPresets() {
      return listProviderPresets(loadBundledModelsDevSnapshot() ?? {});
    },

    async probeInstance(actor, providerId, fetchFn) {
      const context = await localInstance.resolve(actor);
      const row = await findProvider(context, providerId);
      const resolved = await resolveRow(context, row);
      const chatModel = resolved.models.find(
        (model) => model.capability === "chat" && model.enabled !== false,
      )?.id;
      if (
        !chatModel &&
        (resolved.protocol === "openai-compatible" ||
          resolved.protocol === "anthropic")
      ) {
        throw new ModelProviderServiceError(
          "instance_model_unavailable",
          "该供应商尚未声明启用的聊天模型，无法探测。",
          409,
        );
      }
      const baseUrl =
        resolved.baseUrl ??
        (resolved.protocol === "anthropic"
          ? "https://api.anthropic.com/v1"
          : null);
      if (!baseUrl) {
        throw new ModelProviderServiceError(
          "instance_probe_failed",
          "该实例未声明 baseUrl，无法探测（openai-compatible 协议必须显式配置）。",
        );
      }
      const target: ProbeTarget = {
        protocol: resolved.protocol,
        baseUrl,
        apiKey: resolved.apiKey,
        ...(chatModel ? { model: chatModel } : {}),
      };
      const result = await probeInstance(fetchFn ?? fetch, target);
      await repository.setProbeResult(context.instanceId, providerId, result);
      return result;
    },
  };
  return service;
}
