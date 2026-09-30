/**
 * zcode 宿主适配 stub：`@zcode/provider` 的最小类型等价（只收录照搬组件实际消费的切片）。
 * 来源：references/zcode/packages/provider/src/{config-overlay,account-provider-state,
 * config/provider-data-schema,config/provider-config,config/model-config,facades,
 * model-selection-config}（shared 侧 config/model-config schema 见
 * references/zcode/packages/shared/src/model-config.ts）。
 *
 * 本仓没有 zcode Provider Registry / Overlay 配置服务层（Provider 走本仓 BYOK 供应商缝），
 * 故只保留照搬件以类型位与纯函数消费的符号面；运行时没有任何 Registry 实现注入，
 * isApiKeyAccess / completeNewModelSelection 为纯函数照搬，可直接使用。
 * 适配注记：类型按上游 schema 逐字段对齐；optionMap 的编译期校验（compileModelOptionMap）
 * 不照搬——本仓无解析路径，仅保留数据形状。
 */
import type {
  EffectiveModelSelectionResult,
  ModelSelection,
} from "@zui/lib/zcode-shared";

/* ---------- config-overlay.ts（照搬类型声明） ---------- */

export interface ConfigValidationIssue {
  readonly code:
    | "required-field-missing"
    | "duplicate-key"
    | "duplicate-model"
    | "invalid-option-spec"
    | "invalid-config"
    | "invalid-reasoning-mapping"
    | "invalid-pattern"
    | "invalid-url"
    | "missing-template";
  readonly path: readonly string[];
  readonly message: string;
}

/* ---------- account-provider-state.ts（照搬类型声明） ---------- */

export type AccountProviderUnavailableReason =
  | "not-authenticated"
  | "not-connected"
  | "credential-failed"
  | "not-entitled";

/**
 * 账号实时事实，不是配置 Overlay，也不写入用户设置。
 * current 表示匹配当前账号访问上下文：Start 可与当前付费套餐同时为 true；Off-Peak 不定义。
 */
export interface AccountProviderState {
  readonly availability: "available" | "pending" | "unavailable" | "unknown";
  readonly entitled: boolean;
  /** 仅在 availability === "unavailable" 时有意义；unknown 表示本轮无法判定原因。 */
  readonly unavailableReason?: AccountProviderUnavailableReason;
  readonly current?: boolean;
  /** 同一快照的账号/连接身份，仅供状态变化隔离；不持久化、不包含凭据。 */
  readonly connectionKey?: string;
  /** Unix 秒；与 billing effective_at 的单位一致。 */
  readonly effectiveAt?: number;
}

/* ---------- config/provider-data-schema.ts（照搬类型声明） ----------
 * 上游为 zod schema 的 z.infer；此处按同一形状写成接口（sparse = 可选）。
 */

export type ProviderApiType =
  | "anthropic-messages"
  | "openai-chat-completions"
  | "openai-responses";
export type ProviderGroup =
  | "standard-personal"
  | "zai-family"
  | "bigmodel-family";
export type ZhipuAccountMode =
  | "start-plan"
  | "individual-coding-plan"
  | "team-coding-plan"
  | "off-peak";
export type ProviderVisibility = "visible" | "hidden";

export interface ProviderLogoRef {
  type: "builtin";
  key: string;
}

/** 手动 Key / 套餐 Key 的稀疏形状。 */
export interface ApiKeyAccessConfigObject {
  type: "api-key" | "zhipu-coding-plan-api-key";
  apiKey?: string | null | undefined;
  apiKeyManagementUrl?: string | null | undefined;
}

/** 智谱账号（Start / 团队套餐）访问的稀疏形状。 */
export interface ZhipuAccountAccessConfigObject {
  type: "zhipu-account";
  accountType?: "zai" | "bigmodel" | null | undefined;
  mode?: ZhipuAccountMode | null | undefined;
  entitled?: boolean | null | undefined;
}

export type ProviderAccessConfigObject =
  | ApiKeyAccessConfigObject
  | ZhipuAccountAccessConfigObject;

export interface ProviderApiConfigObject {
  type?: ProviderApiType | null | undefined;
  baseUrl?: string | null | undefined;
  headers?: Readonly<Record<string, string>> | null | undefined;
}

export interface ModelInputFormatConfigObject {
  supportsText?: boolean | null | undefined;
  supportsImage?: boolean | null | undefined;
  supportsVideo?: boolean | null | undefined;
  supportsAudio?: boolean | null | undefined;
  supportsPdf?: boolean | null | undefined;
}

export interface ModelOutputFormatConfigObject {
  supportsText?: boolean | null | undefined;
}

export interface ModelPropertiesConfigObject {
  requiresMfjsToolSchema?: boolean | null | undefined;
  contextWindow?: number | null | undefined;
  inputFormat?: ModelInputFormatConfigObject | null | undefined;
  outputFormat?: ModelOutputFormatConfigObject | null | undefined;
  supportsToolCall?: boolean | null | undefined;
  supportsJsonSchemaOutput?: boolean | null | undefined;
  supportsNativeWebSearch?: boolean | null | undefined;
  supportsMidConversationSystem?: boolean | null | undefined;
}

export interface EnumOptionSpecConfigObject {
  /** 按语义强度从低到高排列；首项是辅助调用可选的最低公开档位。 */
  values?: readonly string[];
  map?: string | null | undefined;
}

export interface LimitOptionSpecConfigObject {
  max?: number | null | undefined;
  map?: string | null | undefined;
}

export interface ModelOptionSpecsConfigObject {
  reasoningLevel?: EnumOptionSpecConfigObject | null | undefined;
  maxOutputTokens?: LimitOptionSpecConfigObject | null | undefined;
}

/** 模型稀疏配置（personal overlay 与展示投影同型）。 */
export interface ModelConfigObject {
  enabled?: boolean | null | undefined;
  properties?: ModelPropertiesConfigObject | null | undefined;
  optionSpecs?: ModelOptionSpecsConfigObject | null | undefined;
}

/** Provider 稀疏配置（personal overlay 与展示投影同型）。 */
export interface ProviderConfigObject {
  group?: ProviderGroup | null | undefined;
  logo?: ProviderLogoRef | null | undefined;
  access?: ProviderAccessConfigObject | null | undefined;
  api?: ProviderApiConfigObject | null | undefined;
  builtinModelIds?: readonly string[] | null | undefined;
  personalModelIds?: readonly string[] | null | undefined;
  modelOrder?: readonly string[] | null | undefined;
  visibility?: ProviderVisibility | null | undefined;
}

/* ---------- config/provider-config.ts（照搬纯函数） ---------- */

/** 手动 Key 的编辑/保存共用能力判断，不把套餐 Key 误写成普通 API Key。 */
export function isApiKeyAccess<T extends { readonly type: string }>(
  access: T | null | undefined,
): access is Extract<T, { readonly type: ApiKeyAccessConfigObject["type"] }> {
  return (
    access?.type === "api-key" || access?.type === "zhipu-coding-plan-api-key"
  );
}

/* ---------- config/ids.ts（照搬类型别名） ---------- */

export type ProviderId = string;
export type ModelId = string;
export type ProviderTemplateId = string;

/* ---------- facades.ts（照搬类型声明；Registry 完整变体字段为必填） ---------- */

export interface ProviderConfigRuleNameSlice {
  templateId?: ProviderTemplateId | null | undefined;
  providerName?: string | null | undefined;
}

export interface ProviderSettingsModelCandidateView {
  readonly kind: "candidate";
  readonly modelId: ModelId;
  readonly builtin: boolean;
  readonly effectiveBuiltinConfig: ModelConfigObject;
  readonly personalExactConfig?: ModelConfigObject | undefined;
  readonly useRecommendedConfig?: boolean | undefined;
  readonly effectiveConfig: ModelConfigObject;
  readonly enabled: boolean;
  readonly executable: boolean;
  readonly selectable: boolean;
  readonly issues: readonly ConfigValidationIssue[];
}

export type ProviderSettingsModelView = ProviderSettingsModelCandidateView;

/** Provider Settings 页在一次编辑会话中看到的单 Provider 投影。 */
export interface ProviderSettingsProviderView
  extends ProviderConfigRuleNameSlice {
  readonly enabled: boolean;
  readonly accountState?: AccountProviderState | undefined;
  readonly providerId: ProviderId;
  /** 当前 Effective Config 是否已经进入 Registry，可用于模型选择和创建。 */
  readonly executable: boolean;
  readonly effectiveBuiltinConfig?: ProviderConfigObject | undefined;
  readonly personalConfig?: ProviderConfigObject | undefined;
  readonly effectiveConfig: ProviderConfigObject;
  readonly issues: readonly ConfigValidationIssue[];
  readonly models: readonly ProviderSettingsModelView[];
}

export interface ProviderSettingsTemplateView {
  readonly templateId: ProviderTemplateId;
  readonly config: ProviderConfigObject;
}

export interface ProviderSettingsView {
  readonly revision: number;
  readonly providerTemplates: readonly ProviderSettingsTemplateView[];
  readonly providerOrder: readonly ProviderId[];
  readonly providers: readonly ProviderSettingsProviderView[];
}

/** Registry 完整变体的模型配置（required 字段，模型选择补全按非可选读取）。 */
export interface RegistryModelConfigObject {
  readonly enabled: boolean;
  readonly properties: {
    readonly requiresMfjsToolSchema: boolean;
    readonly contextWindow: number;
    readonly inputFormat: {
      readonly supportsText: boolean;
      readonly supportsImage: boolean;
      readonly supportsVideo: boolean;
      readonly supportsAudio: boolean;
      readonly supportsPdf: boolean;
    };
    readonly outputFormat: { readonly supportsText: boolean };
    readonly supportsToolCall: boolean;
    readonly supportsJsonSchemaOutput: boolean;
    readonly supportsNativeWebSearch: boolean;
    readonly supportsMidConversationSystem: boolean;
  };
  readonly optionSpecs: {
    readonly reasoningLevel: {
      readonly values: readonly string[];
      readonly map: string;
    };
    readonly maxOutputTokens: { readonly max: number; readonly map: string };
  };
}

export interface ModelSelectionModelView {
  readonly modelId: ModelId;
  readonly config: RegistryModelConfigObject;
}

export interface ModelSelectionProviderView
  extends ProviderConfigRuleNameSlice {
  readonly providerId: ProviderId;
  readonly config: ProviderConfigObject;
  readonly models: readonly ModelSelectionModelView[];
}

export interface ModelSelectionViewInput {
  readonly selection: ModelSelection | null;
}

/** 模型选择页读取的 Registry View（公共解析结果字段可缺省：页面可展示不完整选择）。 */
export interface ModelSelectionView
  extends Partial<EffectiveModelSelectionResult> {
  readonly revision: number;
  readonly providers: readonly ModelSelectionProviderView[];
  readonly preferredSelection?: ModelSelection | undefined;
}

/* ---------- model-selection-config.ts（照搬纯函数） ---------- */

interface ModelSelectionCompletionView {
  readonly providers: readonly {
    readonly providerId: string;
    readonly models: readonly {
      readonly modelId: string;
      readonly config: {
        readonly optionSpecs: {
          readonly reasoningLevel: { readonly values: readonly string[] };
        };
      };
    }[];
  }[];
}

/** 仅在用户主动选模型或全新初始化时构造最高档；不能用于恢复/重解析已有选择。 */
export function completeNewModelSelection(
  registry: ModelSelectionCompletionView,
  selection: ModelSelection,
): ModelSelection | undefined {
  const model = registry.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
  const reasoningLevel = model?.config.optionSpecs.reasoningLevel.values.at(-1);
  if (!reasoningLevel) return undefined;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    options: { reasoningLevel },
  };
}
