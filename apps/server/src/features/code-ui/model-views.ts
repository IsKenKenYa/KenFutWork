import type {
  ModelCatalogEntry,
  ProviderInstanceModel,
  ProviderInstanceResponse,
} from "@kenfutwork/shared";
import {
  clearManualModelConfig,
  completeNewModelSelection,
  createRegistryModelConfig,
  ModelConfig,
  type ModelConfigObject,
  type ModelSelection,
  type ModelSelectionView,
  normalizeModelSelection,
  type ProviderSettingsModelView,
  type ProviderSettingsView,
  parseZCodeBuiltinModelConfigRules,
  serializeRegistryModelConfig,
} from "@zcode/provider";
import modelRules from "../model-providers/zcode-model-config-rules.json" with {
  type: "json",
};
import {
  codeUiProviderIssues,
  codeUiProviderMetadata,
  codeUiPublicProviderConfig,
  isCodeChatProtocol,
} from "./provider-settings-rpc-config.js";

const rules = parseZCodeBuiltinModelConfigRules(modelRules);

function inheritedModelConfig(
  instance: ProviderInstanceResponse,
  entry: ModelCatalogEntry,
) {
  const config = codeUiPublicProviderConfig(instance);
  const metadata = codeUiProviderMetadata(instance);
  const builtin = rules.resolve({
    providerId: instance.id,
    ...(metadata.templateId ? { templateId: metadata.templateId } : {}),
    modelId: entry.id,
    ...(config.api?.type ? { apiType: config.api.type } : {}),
    ...(instance.baseUrl ? { baseUrl: instance.baseUrl } : {}),
  });
  const contextWindow = entry.model.contextWindow ?? entry.hints?.contextWindow;
  const image =
    entry.model.vision ??
    (entry.model.inputModalities
      ? entry.model.inputModalities.includes("image")
      : entry.hints?.imageInput);
  const pdf = entry.model.inputModalities
    ? entry.model.inputModalities.includes("pdf")
    : undefined;
  const maximumOutput =
    entry.model.maxOutputTokens ?? entry.hints?.maxOutputTokens;
  return builtin.overlay(
    ModelConfig.fromData({
      enabled: entry.model.enabled !== false,
      properties: {
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(image === undefined && pdf === undefined
          ? {}
          : {
              inputFormat: {
                ...(image !== undefined ? { supportsImage: image } : {}),
                ...(pdf !== undefined ? { supportsPdf: pdf } : {}),
              },
            }),
        ...(entry.hints?.toolCall === undefined
          ? {}
          : { supportsToolCall: entry.hints.toolCall }),
      },
      ...(maximumOutput === undefined
        ? {}
        : { optionSpecs: { maxOutputTokens: { max: maximumOutput } } }),
    }),
  );
}

export function resolveCodeUiModelConfig(
  instance: ProviderInstanceResponse,
  entry: ModelCatalogEntry,
  override?: { config: ModelConfigObject; useRecommendedConfig: boolean },
) {
  const inherited = inheritedModelConfig(instance, entry);
  const metadata = codeUiProviderMetadata(instance);
  const saved =
    metadata.models && Object.hasOwn(metadata.models, entry.id)
      ? metadata.models[entry.id]
      : undefined;
  const personal = override ?? saved;
  let effective =
    personal?.useRecommendedConfig === false
      ? ModelConfig.fromData(
          clearManualModelConfig(inherited.toJSON()),
        ).overlay(ModelConfig.fromData(personal.config))
      : inherited.overlay(ModelConfig.fromData(personal?.config ?? {}));
  if (!override)
    effective = effective.overlay(nativeModelDeclarations(entry.model));
  const google = resolveGeminiReasoning(
    instance,
    entry,
    effective,
    personal?.config,
  );
  effective = google.config;
  const modelComplete = google.issue
    ? { ok: false as const, issues: [google.issue] }
    : createRegistryModelConfig(effective);
  const issues = [
    ...codeUiProviderIssues(instance),
    ...(modelComplete.ok ? [] : modelComplete.issues),
  ];
  const complete = issues.length
    ? { ok: false as const, issues }
    : modelComplete;
  return { inherited, effective, complete, personal };
}

function resolveGeminiReasoning(
  instance: ProviderInstanceResponse,
  entry: ModelCatalogEntry,
  config: ModelConfig,
  personal?: ModelConfigObject,
) {
  if (
    instance.protocol !== "gemini" ||
    personal?.optionSpecs?.reasoningLevel?.map
  )
    return { config };
  const levels = config.optionSpecs?.reasoningLevel?.values;
  if (!levels || levels.every((level) => level === "default"))
    return { config };
  // Google documents thinkingLevel for Gemini 3+, not earlier budget-based models.
  const supportsLevels =
    /^gemini-(?:[3-9](?:[.\-/]|$)|[1-9]\d(?:[.\-/]|$))/i.test(entry.id);
  const publicLevels = new Set(["minimal", "low", "medium", "high"]);
  if (
    entry.model.reasoningEfforts?.length &&
    supportsLevels &&
    levels.every((level) => publicLevels.has(level))
  ) {
    return {
      config: config.overlay(
        ModelConfig.fromData({
          optionSpecs: {
            reasoningLevel: {
              map: '{"generationConfig": {"thinkingConfig": {"thinkingLevel": reasoningLevel}}}',
            },
          },
        }),
      ),
    };
  }
  return {
    config,
    issue: {
      code: "required-field-missing" as const,
      path: ["model", "optionSpecs", "reasoningLevel", "map"],
      message:
        "此 Gemini 模型的思考档位需要明确的原生参数映射；不能由通用规则推测预算。",
    },
  };
}

/** Explicit native declarations take precedence when another client changes the same instance. */
function nativeModelDeclarations(model: ProviderInstanceModel): ModelConfig {
  const modalities = model.inputModalities;
  const image =
    model.vision ?? (modalities ? modalities.includes("image") : undefined);
  return ModelConfig.fromData({
    enabled: model.enabled !== false,
    properties: {
      ...(model.contextWindow === undefined
        ? {}
        : { contextWindow: model.contextWindow }),
      ...(image === undefined && modalities === undefined
        ? {}
        : {
            inputFormat: {
              ...(image === undefined ? {} : { supportsImage: image }),
              ...(modalities
                ? {
                    supportsVideo: modalities.includes("video"),
                    supportsPdf: modalities.includes("pdf"),
                    supportsAudio: modalities.includes("audio"),
                    supportsText: modalities.includes("text"),
                  }
                : {}),
            },
          }),
      ...(model.structuredOutput === undefined
        ? {}
        : { supportsJsonSchemaOutput: model.structuredOutput }),
      ...(model.nativeWebSearch === undefined
        ? {}
        : { supportsNativeWebSearch: model.nativeWebSearch }),
      ...(model.systemMessage === undefined
        ? {}
        : { supportsMidConversationSystem: model.systemMessage }),
    },
    optionSpecs: {
      ...(model.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: { max: model.maxOutputTokens } }),
      ...(model.reasoningEfforts?.length
        ? { reasoningLevel: { values: model.reasoningEfforts } }
        : {}),
    },
  });
}

function modelView(
  instance: ProviderInstanceResponse,
  entry: ModelCatalogEntry,
): ProviderSettingsModelView {
  const { inherited, effective, complete, personal } = resolveCodeUiModelConfig(
    instance,
    entry,
  );
  const enabled = entry.model.enabled !== false && effective.enabled === true;
  const executable =
    instance.enabled && instance.hasCredential && enabled && complete.ok;
  return {
    modelId: entry.id,
    builtin: false as const,
    kind: "candidate" as const,
    effectiveBuiltinConfig: inherited.toJSON(),
    ...(personal ? { personalExactConfig: personal.config } : {}),
    useRecommendedConfig: personal?.useRecommendedConfig ?? true,
    effectiveConfig: complete.ok
      ? serializeRegistryModelConfig(complete.config)
      : effective.toJSON(),
    enabled,
    executable,
    selectable: executable,
    issues: complete.ok ? [] : complete.issues,
  };
}

export function codeUiModelEntry(
  instance: ProviderInstanceResponse,
  model: ProviderInstanceModel,
): ModelCatalogEntry {
  return {
    id: model.id,
    name: model.name,
    capability: model.capability,
    model,
    provider: {
      instanceId: instance.id,
      name: instance.name,
      protocol: instance.protocol,
      scope: instance.scope,
    },
  };
}

/** 安全 view：执行资格来自后端，原推荐数据负责模型元信息，凭证永不回传。 */
export function buildCodeUiModelViews(input: {
  instances: ProviderInstanceResponse[];
  catalog: ModelCatalogEntry[];
  defaultSpecifier?: string;
  selection?: ModelSelection | null;
  revision?: number;
  providerOrder?: readonly string[];
  providerTemplates?: ProviderSettingsView["providerTemplates"];
}): { settings: ProviderSettingsView; selection: ModelSelectionView } {
  const revision = input.revision ?? 0;
  const providers = input.instances
    .filter((instance) => isCodeChatProtocol(instance.protocol))
    .map((instance) => {
      const issues = codeUiProviderIssues(instance);
      return {
        providerId: instance.id,
        providerName: instance.name,
        enabled: instance.enabled,
        executable:
          instance.enabled && instance.hasCredential && issues.length === 0,
        credentialConfigured: instance.hasCredential,
        configRevision: instance.configRevision,
        ...(codeUiProviderMetadata(instance).templateId
          ? { templateId: codeUiProviderMetadata(instance).templateId }
          : {}),
        effectiveConfig: codeUiPublicProviderConfig(instance),
        personalConfig: codeUiPublicProviderConfig(instance),
        issues,
        models: instance.models
          .filter((model) => model.capability === "chat")
          .map((model) =>
            modelView(
              instance,
              input.catalog.find(
                (entry) =>
                  entry.provider.instanceId === instance.id &&
                  entry.id === model.id,
              ) ?? codeUiModelEntry(instance, model),
            ),
          ),
      };
    });
  const order = new Map(
    (
      input.providerOrder ?? providers.map((provider) => provider.providerId)
    ).map((id, index) => [id, index]),
  );
  providers.sort(
    (left, right) =>
      (order.get(left.providerId) ?? order.size) -
      (order.get(right.providerId) ?? order.size),
  );
  const settings: ProviderSettingsView = {
    revision,
    providerTemplates: input.providerTemplates ?? [],
    providerOrder: providers.map((provider) => provider.providerId),
    providers,
  };
  const selectionProviders = providers
    .filter((provider) => provider.executable)
    .map((provider) => ({
      providerId: provider.providerId,
      providerName: provider.providerName,
      config: provider.effectiveConfig,
      models: provider.models
        .filter((model) => model.executable)
        .map((model) => {
          const complete = createRegistryModelConfig(
            ModelConfig.fromData(model.effectiveConfig),
          );
          if (!complete.ok) throw new Error("已发布模型的配置不完整。");
          return {
            modelId: model.modelId,
            config: serializeRegistryModelConfig(complete.config),
          };
        }),
    }));
  const view = { providers: selectionProviders };
  const defaultSpecifier = input.defaultSpecifier;
  const separator = defaultSpecifier?.indexOf(":") ?? -1;
  const configured =
    defaultSpecifier !== undefined && separator > 0
      ? {
          providerId: defaultSpecifier.slice(0, separator),
          modelId: defaultSpecifier.slice(separator + 1),
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
  const requested = input.selection === undefined ? preferred : input.selection;
  const effective = requested
    ? normalizeModelSelection(view, requested)
    : undefined;
  return {
    settings,
    selection: {
      revision,
      providers: selectionProviders,
      ...(preferred ? { preferredSelection: preferred } : {}),
      effectiveSelection: effective ?? null,
      ...(!effective && requested
        ? { selectionIssue: "model-not-found" as const }
        : {}),
      ...(requested === null
        ? { selectionIssue: "selection-missing" as const }
        : {}),
      ...(effective && effective.options?.reasoningLevel === undefined
        ? {
            selectionIssue:
              requested?.options?.reasoningLevel === undefined
                ? ("reasoning-level-missing" as const)
                : ("reasoning-level-not-supported" as const),
          }
        : {}),
    },
  };
}
