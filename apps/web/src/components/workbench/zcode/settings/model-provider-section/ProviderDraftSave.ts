import { providerInstanceHeadersSchema } from "@kenfutwork/shared";
import { isApiKeyAccess, type ProviderApiType } from "@zcode/provider";
import {
  getProviderFormLabel,
  type ProviderSettingsFormProvider,
} from "@zui/lib/providerSettingsFormTypes.js";

export interface ProviderDraftValues {
  nameValue: string;
  apiFormat: ProviderApiType;
  baseUrlValue: string;
  apiKeyValue: string;
  /** 未编辑时缺省；空白保留现值，显式 {} 清空。 */
  headersValue?: string;
}

function normalizeConfiguredBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) return "";

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return normalized;
    const marker = `${parsed.protocol}//${parsed.host}`;
    const duplicateIndex = normalized.indexOf(marker, marker.length);
    if (duplicateIndex < 0) return normalized;
    const firstUrl = normalized.slice(0, duplicateIndex).replace(/\/+$/, "");
    const secondUrl = normalized.slice(duplicateIndex).replace(/\/+$/, "");
    // 旧设置页曾把完整 Base URL 再作为 path 拼接；仅折叠两段完全相同的安全形态。
    return firstUrl === secondUrl ? firstUrl : normalized;
  } catch {
    return normalized;
  }
}

function parseHeadersDraft(raw: string | undefined): Record<string, string> | undefined {
  if (!raw?.trim()) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("请求头需为合法 JSON 对象，请检查输入。"); }
  const result = providerInstanceHeadersSchema.safeParse(value);
  if (!result.success) throw new Error("请求头配置无效，请检查字段与文本值。");
  return result.data;
}

export function resolvePendingProviderDraftSave({
  provider,
  draft,
  readOnlyEndpoints,
  nameConfirmed = false,
  clearApiKey = false,
}: {
  provider: ProviderSettingsFormProvider;
  draft: ProviderDraftValues;
  readOnlyEndpoints?: boolean;
  nameConfirmed?: boolean;
  clearApiKey?: boolean;
  now: () => number;
}): ProviderSettingsFormProvider | null {
  const label = draft.nameValue.trim();
  const baseURL = normalizeConfiguredBaseUrl(draft.baseUrlValue);
  // ID 和默认协议只用于空配置的表单展示，不是用户覆盖；脏检查与表单初始化必须同源。
  // 名称只在 Enter/失焦确认；连接的闲时保存、测试和卸载不能夹带未确认的名称。
  const labelChanged = nameConfirmed && label !== getProviderFormLabel(provider);
  const typeChanged =
    !readOnlyEndpoints && draft.apiFormat !== (provider.config.api?.type ?? "anthropic-messages");
  const urlChanged = !readOnlyEndpoints && baseURL !== (provider.config.api?.baseUrl ?? "");
  const keyChanged =
    isApiKeyAccess(provider.config.access) &&
    (clearApiKey || draft.apiKeyValue !== (provider.config.access.apiKey ?? ""));
  const nextKey = clearApiKey ? null : draft.apiKeyValue;
  const headers = parseHeadersDraft(draft.headersValue);
  const headersChanged = headers !== undefined && (JSON.stringify(headers) !== JSON.stringify(provider.config.api?.headers ?? {}) || Boolean(provider.native?.headerKeys.length));
  if (!labelChanged && !typeChanged && !urlChanged && !keyChanged && !headersChanged) return null;

  // 表单只覆盖已编辑的名称、连接、Key与请求头；重建整个api会删除隐藏字段，
  // 保存 Effective 对象又会把继承字段物化。分别在各自基线上只应用修改过的叶子。
  const apiChanges = {
    ...(typeChanged || (urlChanged && !provider.config.api?.type) ? { type: draft.apiFormat } : {}),
    ...(urlChanged ? { baseUrl: baseURL || undefined } : {}),
    ...(headersChanged ? { headers } : {}),
  };
  const api =
    typeChanged || urlChanged || headersChanged ? { ...provider.config.api, ...apiChanges } : provider.config.api;
  const access =
    keyChanged && isApiKeyAccess(provider.config.access)
      ? { ...provider.config.access, apiKey: nextKey }
      : provider.config.access;
  const config = {
    ...provider.config,
    access,
    api,
  };

  const personalConfig = {
    ...provider.personalConfig,
    ...(keyChanged && isApiKeyAccess(provider.config.access)
      ? {
          access: {
            ...provider.personalConfig.access,
            type: provider.config.access.type,
            apiKey: nextKey,
          },
        }
      : {}),
    ...(typeChanged || urlChanged || headersChanged
      ? { api: { ...provider.personalConfig.api, ...apiChanges } }
      : {}),
  };

  if (!labelChanged && !headersChanged && JSON.stringify(config) === JSON.stringify(provider.config)) {
    return null;
  }
  return {
    ...provider,
    ...(labelChanged ? { providerName: label || null, providerNameUpdate: label || null } : {}),
    config,
    personalConfig,
  };
}
