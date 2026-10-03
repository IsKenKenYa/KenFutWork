import type {
  ModelCatalogEntry,
  ProviderInstanceResponse,
} from "@kenfutwork/shared";
import {
  completeNewModelSelection,
  createRegistryModelConfig,
  ModelConfig,
  type ModelSelection,
  type ModelSelectionView,
  type ProviderConfigObject,
  type ProviderSettingsView,
  parseProviderConfig,
  parseZCodeBuiltinModelConfigRules,
  requiredFieldIssue,
  serializeRegistryModelConfig,
} from "@zcode/provider";
import {
  type ProviderCodeModelConfig,
  resolveProviderCodeModel,
} from "../model-providers/code-model-config.js";
import {
  type ProviderCodeSettings,
  readProviderCodeModel,
} from "../model-providers/code-provider-config.js";
import modelRules from "../model-providers/zcode-model-config-rules.json" with {
  type: "json",
};

const rules = parseZCodeBuiltinModelConfigRules(modelRules);

function publicConfig(
  instance: ProviderInstanceResponse,
): ProviderConfigObject {
  if (
    instance.protocol !== "openai-compatible" &&
    instance.protocol !== "anthropic"
  ) {
    throw new Error(
      `供应商协议 ${instance.protocol} 的 Code UI 配置适配尚未接通`,
    );
  }
  return {
    group: "standard-personal",
    access: { type: "api-key" },
    api: {
      type:
        instance.protocol === "anthropic"
          ? "anthropic-messages"
          : "openai-chat-completions",
      ...(instance.baseUrl ? { baseUrl: instance.baseUrl } : {}),
    },
    personalModelIds: instance.models
      .filter((model) => model.capability === "chat")
      .map((model) => model.id),
    visibility: "visible",
  };
}

function modelView(
  instance: ProviderInstanceResponse,
  entry: ModelCatalogEntry,
  config: ProviderConfigObject,
  providerExecutable: boolean,
  personal?: ProviderCodeModelConfig,
  templateId?: string | null,
) {
  if (personal) {
    const resolved = resolveProviderCodeModel(
      instance.id,
      config,
      entry.id,
      personal,
      templateId,
    );
    const enabled = resolved.effective.enabled === true;
    const executable =
      providerExecutable && enabled && resolved.issues.length === 0;
    return {
      modelId: entry.id,
      builtin: false as const,
      kind: "candidate" as const,
      effectiveBuiltinConfig: resolved.inherited.toJSON(),
      effectiveConfig: resolved.effective.toJSON(),
      ...(personal.personalConfig === undefined
        ? {}
        : { personalExactConfig: personal.personalConfig }),
      useRecommendedConfig: personal.useRecommendedConfig,
      enabled,
      executable,
      selectable: executable && config.visibility !== "hidden",
      issues: resolved.issues,
    };
  }
  const enabled = entry.model.enabled !== false;
  const executable = providerExecutable && enabled;
  const builtin = rules.resolve({
    providerId: instance.id,
    modelId: entry.id,
    ...(config.api?.type ? { apiType: config.api.type } : {}),
    ...(instance.baseUrl ? { baseUrl: instance.baseUrl } : {}),
  });
  const contextWindow = entry.model.contextWindow ?? entry.hints?.contextWindow;
  const image = entry.model.vision ?? entry.hints?.imageInput;
  const maximumOutput =
    entry.model.maxOutputTokens ?? entry.hints?.maxOutputTokens;
  const effective = builtin.overlay(
    ModelConfig.fromData({
      enabled,
      properties: {
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(image === undefined
          ? {}
          : { inputFormat: { supportsImage: image } }),
        ...(entry.hints?.toolCall === undefined
          ? {}
          : { supportsToolCall: entry.hints.toolCall }),
      },
      ...(maximumOutput === undefined
        ? {}
        : { optionSpecs: { maxOutputTokens: { max: maximumOutput } } }),
    }),
  );
  const complete = createRegistryModelConfig(effective);
  if (!complete.ok)
    throw new Error(
      `模型 ${entry.id} 的原推荐配置不完整：${JSON.stringify(complete.issues)}`,
    );
  return {
    modelId: entry.id,
    builtin: false as const,
    kind: "candidate" as const,
    effectiveBuiltinConfig: builtin.toJSON(),
    effectiveConfig: serializeRegistryModelConfig(complete.config),
    enabled,
    executable,
    selectable: executable,
    issues: [],
  };
}

/** 安全 view：执行资格来自后端，原推荐数据负责模型元信息，凭证永不回传。 */
export function buildCodeUiModelViews(input: {
  instances: ProviderInstanceResponse[];
  catalog: ModelCatalogEntry[];
  defaultSpecifier?: string;
  selection?: ModelSelection | null;
  revision?: number;
  providerSettings?: Record<string, ProviderCodeSettings>;
}): { settings: ProviderSettingsView; selection: ModelSelectionView } {
  const revision = input.revision ?? 0;
  const providers = input.instances
    .filter(
      (instance) =>
        instance.protocol === "openai-compatible" ||
        instance.protocol === "anthropic" ||
        instance.protocol === "gemini",
    )
    .map((instance) => {
      const source = input.providerSettings?.[instance.id];
      const config = source?.config ?? publicConfig(instance);
      const parsed = parseProviderConfig(config);
      const issues = [
        ...(parsed.api?.validateComplete(["provider", "api"]) ?? [
          requiredFieldIssue(["provider"], "api"),
        ]),
        ...(!instance.hasCredential
          ? [requiredFieldIssue(["provider", "access"], "apiKey")]
          : []),
      ];
      const executable =
        instance.enabled && instance.hasCredential && issues.length === 0;
      return {
        providerId: instance.id,
        providerName: instance.name,
        enabled: instance.enabled,
        executable,
        credentialConfigured:
          source?.credentialConfigured ?? instance.hasCredential,
        ...(source?.templateId == null
          ? {}
          : { templateId: source.templateId }),
        effectiveConfig: config,
        personalConfig: config,
        issues,
        models: input.catalog
          .filter(
            (entry) =>
              entry.capability === "chat" &&
              entry.provider.instanceId === instance.id,
          )
          .map((entry) =>
            modelView(
              instance,
              entry,
              config,
              executable,
              source ? readProviderCodeModel(source, entry.id) : undefined,
              source?.templateId,
            ),
          ),
      };
    });
  const settings: ProviderSettingsView = {
    revision,
    providerTemplates: [],
    providerOrder: providers.map((provider) => provider.providerId),
    providers,
  };
  const selectionProviders = providers
    .filter((provider) => provider.executable)
    .map((provider) => ({
      providerId: provider.providerId,
      providerName: provider.providerName,
      config: provider.effectiveConfig,
      models: provider.models.flatMap((model) => {
        if (!model.executable) return [];
        const complete = createRegistryModelConfig(
          ModelConfig.fromData(model.effectiveConfig),
        );
        if (!complete.ok)
          throw new Error(
            `可执行模型配置不完整：${provider.providerId}/${model.modelId}`,
          );
        return [
          {
            modelId: model.modelId,
            config: serializeRegistryModelConfig(complete.config),
          },
        ];
      }),
    }));
  const view = { providers: selectionProviders };
  const separator = input.defaultSpecifier?.indexOf(":") ?? -1;
  const configured =
    separator > 0
      ? {
          providerId: input.defaultSpecifier!.slice(0, separator),
          modelId: input.defaultSpecifier!.slice(separator + 1),
        }
      : undefined;
  const first = selectionProviders[0];
  const firstModel = first?.models[0];
  const preferred =
    (configured && completeNewModelSelection(view, configured)) ??
    (first && firstModel
      ? completeNewModelSelection(view, {
          providerId: first.providerId,
          modelId: firstModel.modelId,
        })
      : undefined);
  const requested = input.selection ?? preferred;
  const effective = requested
    ? completeNewModelSelection(view, requested)
    : undefined;
  return {
    settings,
    selection: {
      revision,
      providers: selectionProviders,
      ...(preferred ? { preferredSelection: preferred } : {}),
      effectiveSelection: effective
        ? {
            ...effective,
            ...(requested?.options ? { options: requested.options } : {}),
          }
        : null,
      ...(!effective && requested
        ? { selectionIssue: "model-not-found" as const }
        : {}),
    },
  };
}
