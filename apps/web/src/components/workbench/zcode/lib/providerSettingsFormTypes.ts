/**
 * zcode 照搬：`@/lib/providerSettingsFormTypes.ts`（references/zcode/packages/ui/src/lib/providerSettingsFormTypes.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */

import type {
  AccountProviderState,
  ConfigValidationIssue,
  ModelConfigObject,
  ProviderConfigObject,
  ProviderSettingsProviderView,
} from "@zui/lib/zcode-provider";
import { isApiKeyAccess } from "@zui/lib/zcode-provider";

/** 设置页面在一次编辑会话中使用的 Provider 状态。 */
export interface ProviderSettingsFormProvider
  extends Pick<ProviderSettingsProviderView, "providerName" | "templateId"> {
  providerId: string;
  /** 仅本次显式改名的补丁；其他编辑不得把继承名称物化成个人配置。 */
  providerNameUpdate?: string | null;
  /** 仅本次显式开关的外层补丁；普通字段编辑不复制继承启停值。 */
  enabledUpdate?: boolean;
  enabled: boolean;
  /** Registry 根据当前 Official、Personal 与 Account Facts 得出的状态。 */
  executable: boolean;
  accountState?: AccountProviderState;
  issues?: readonly ConfigValidationIssue[];
  hasPersonalConfig: boolean;
  /** Renderer 只修改并提交这一份稀疏 Personal Overlay。 */
  personalConfig: ProviderConfigObject;
  /** 只读继承基线与即时表单展示值，不直接持久化。 */
  config: ProviderConfigObject;
  models: ProviderSettingsFormModel[];
}

/** 设置页面在一次编辑会话中使用的 Model 状态。 */
export interface ProviderSettingsFormModel {
  kind: "candidate";
  modelId: string;
  builtin: boolean;
  /** Personal Rule 叠加前的 Built-in Rule 解析结果，用于编辑器表达继承与稀疏覆盖。 */
  inheritedConfig?: ModelConfigObject;
  personalConfig: ModelConfigObject;
  /** 缺省或 true 表示跟随 Built-in 推荐配置；false 表示固定个人配置。 */
  useRecommendedConfig?: boolean;
  config: ModelConfigObject;
  hasPersonalConfig: boolean;
  executable: boolean;
  selectable: boolean;
  issues?: readonly ConfigValidationIssue[];
}

export function getProviderFormLabel(
  provider: Pick<ProviderSettingsFormProvider, "providerId" | "providerName">,
): string {
  return provider.providerName?.trim() || provider.providerId;
}

export function getProviderFormApiKey(
  provider: Pick<ProviderSettingsFormProvider, "config">,
): string {
  return isApiKeyAccess(provider.config.access)
    ? (provider.config.access.apiKey ?? "")
    : "";
}

export function getProviderFormApiKeyManagementUrl(
  provider: Pick<ProviderSettingsFormProvider, "config">,
): string | undefined {
  return isApiKeyAccess(provider.config.access)
    ? (provider.config.access.apiKeyManagementUrl ?? undefined)
    : undefined;
}
