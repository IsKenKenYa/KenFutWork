import {
  type ProviderProtocol,
  providerInstanceHeadersSchema,
} from "@kenfutwork/shared";
import {
  ApiKeyAccessConfig,
  isApiKeyAccess,
  ProviderApiConfig,
  ProviderConfig,
  type ProviderConfigObject,
  parseProviderConfig,
} from "@zcode/provider";
import type { ProviderCodeModelConfig } from "./code-model-config.js";
import type {
  ProviderInstancePatch,
  ProviderInstanceRecord,
} from "./repository.js";
import { encryptSecret } from "./secret-store.js";

/** 凭证、endpoint、模型成员不重复持久化到原配置扩展字段。 */
export interface ProviderCodeConfigRecord {
  config?: ProviderConfigObject;
  templateId?: string | null;
}
export interface ProviderCodeSettings {
  config: ProviderConfigObject;
  credentialConfigured: boolean;
  templateId?: string | null;
  models: Record<string, ProviderCodeModelConfig>;
}
export interface ProviderCodeMetadata {
  providerName?: string | null | undefined;
  enabled?: boolean | undefined;
  templateId?: string | null | undefined;
}

export function readProviderCodeModel(
  settings: ProviderCodeSettings,
  modelId: string,
) {
  return Object.hasOwn(settings.models, modelId)
    ? settings.models[modelId]
    : undefined;
}

export function readProviderCodeSettings(
  row: ProviderInstanceRecord,
): ProviderCodeSettings {
  const baseline = new ProviderConfig({
    group: "standard-personal",
    visibility: "visible",
    access: new ApiKeyAccessConfig(),
    api: new ProviderApiConfig({
      ...(row.protocol === "anthropic"
        ? { type: "anthropic-messages" as const }
        : row.protocol === "openai-compatible"
          ? { type: "openai-chat-completions" as const }
          : {}),
      ...(row.base_url ? { baseUrl: row.base_url } : {}),
    }),
    personalModelIds: (row.models ?? [])
      .filter((model) => model.capability === "chat")
      .map((model) => model.id),
  });
  const combined = baseline
    .overlay(parseProviderConfig(row.code_ui_config?.config ?? {}))
    .toJSON();
  const access = isApiKeyAccess(combined.access)
    ? omitKey(combined.access)
    : combined.access;
  const api = combined.api ? omitHeaders(combined.api) : combined.api;
  return {
    config: {
      ...combined,
      ...(access === undefined ? {} : { access }),
      ...(api === undefined ? {} : { api }),
    },
    credentialConfigured: Boolean(row.encrypted_api_key),
    models: Object.fromEntries(
      (row.models ?? []).flatMap((model) =>
        model.codeConfig ? [[model.id, model.codeConfig]] : [],
      ),
    ),
    ...(row.code_ui_config?.templateId === undefined
      ? {}
      : { templateId: row.code_ui_config.templateId }),
  };
}

function omitKey(
  access: Extract<
    ProviderConfigObject["access"],
    { type: "api-key" | "zhipu-coding-plan-api-key" }
  >,
) {
  const { apiKey: _key, ...publicAccess } = access;
  return publicAccess;
}
function omitHeaders(api: NonNullable<ProviderConfigObject["api"]>) {
  const { headers: _headers, ...publicApi } = api;
  return publicApi;
}

function persistedLeaves(combined: ProviderConfigObject): ProviderConfigObject {
  const {
    api: _api,
    access: _access,
    personalModelIds: _members,
    builtinModelIds: _builtin,
    modelOrder: _order,
    ...leaves
  } = combined;
  const {
    baseUrl: _endpoint,
    headers: _headers,
    ...apiLeaves
  } = combined.api ?? {};
  return {
    ...leaves,
    group: combined.group ?? "standard-personal",
    ...(combined.api === null
      ? { api: null }
      : combined.api
        ? { api: apiLeaves }
        : {}),
    ...(combined.access === null
      ? { access: null }
      : isApiKeyAccess(combined.access)
        ? { access: omitKey(combined.access) }
        : {}),
  };
}

function endpointPatch(
  api: ProviderConfigObject["api"],
): ProviderInstancePatch {
  if (api === null) return { base_url: null, headers: null };
  if (!api) return {};
  return {
    ...(api.baseUrl === undefined ? {} : { base_url: api.baseUrl }),
    ...(api.headers === undefined
      ? {}
      : {
          headers:
            api.headers === null
              ? null
              : providerInstanceHeadersSchema.parse(api.headers),
        }),
    ...(api.type === undefined
      ? {}
      : {
          protocol: (api.type === "anthropic-messages"
            ? "anthropic"
            : "openai-compatible") satisfies ProviderProtocol,
        }),
  };
}

function credentialPatch(
  access: ProviderConfigObject["access"],
  credentialSecret: string | undefined,
): ProviderInstancePatch {
  if (access === null) return { encrypted_api_key: null };
  if (!isApiKeyAccess(access) || access.apiKey === undefined) return {};
  const key = access.apiKey;
  if (key === null) return { encrypted_api_key: null };
  if (!key.trim()) throw new Error("凭证不能为空；移除凭证请明确传 null");
  if (!credentialSecret)
    throw new Error("KENFUTWORK_CREDENTIAL_SECRET 未配置，无法写入用户凭证");
  return {
    encrypted_api_key: encryptSecret({ credentialSecret }, key),
  };
}

export function buildProviderCodePatch(
  row: ProviderInstanceRecord,
  input: ProviderConfigObject,
  metadata: ProviderCodeMetadata,
  credentialSecret: string | undefined,
): ProviderInstancePatch {
  const next = parseProviderConfig(input).toJSON();
  if (next.access && !isApiKeyAccess(next.access))
    throw new Error("当前宿主未提供云账户凭证能力");
  const combined = parseProviderConfig(readProviderCodeSettings(row).config)
    .overlay(parseProviderConfig(next))
    .toJSON();
  const templateId =
    metadata.templateId === undefined
      ? row.code_ui_config?.templateId
      : metadata.templateId;
  return {
    code_ui_config: {
      config: persistedLeaves(combined),
      ...(templateId === undefined ? {} : { templateId }),
    },
    ...(metadata.providerName === undefined
      ? {}
      : { name: metadata.providerName?.trim() || row.id }),
    ...(metadata.enabled === undefined ? {} : { enabled: metadata.enabled }),
    ...endpointPatch(next.api),
    ...credentialPatch(next.access, credentialSecret),
  };
}
