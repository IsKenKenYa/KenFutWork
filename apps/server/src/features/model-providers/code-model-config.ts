import type { ProviderInstanceModel } from "@kenfutwork/shared";
import {
  isStructurallyEmpty,
  ModelConfig,
  type ModelConfigObject,
  ModelConfigRules,
  type ProviderConfigObject,
  parseModelConfig,
  parseZCodeBuiltinModelConfigRules,
} from "@zcode/provider";
import modelRules from "./zcode-model-config-rules.json" with { type: "json" };

/** 原精确规则是该模型可编辑配置的唯一存储；标准运行字段从它推导。 */
export interface ProviderCodeModelConfig {
  personalConfig?: ModelConfigObject;
  useRecommendedConfig: boolean;
}
export interface ProviderInstanceStoredModel {
  id: string;
  name: string;
  capability: string;
  enabled?: boolean;
  vision?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningEfforts?: string[];
  extraBody?: Record<string, unknown>;
  codeConfig?: ProviderCodeModelConfig;
}

const builtinRules = parseZCodeBuiltinModelConfigRules(modelRules);

export function createProviderCodeModelConfig(
  providerId: string,
  modelId: string,
  personalConfig: ModelConfigObject,
  useRecommendedConfig = true,
): ProviderCodeModelConfig {
  const config = parseModelConfig(personalConfig);
  if (useRecommendedConfig && isStructurallyEmpty(config.toJSON()))
    return { useRecommendedConfig };
  const rules = ModelConfigRules.empty().setExact(
    providerId,
    modelId,
    config,
    useRecommendedConfig,
  );
  return {
    personalConfig: rules.getExact(providerId, modelId)!.toJSON(),
    useRecommendedConfig,
  };
}

export function resolveProviderCodeModel(
  providerId: string,
  providerConfig: ProviderConfigObject,
  modelId: string,
  personal?: ProviderCodeModelConfig,
  templateId?: string | null,
) {
  const identity = {
    providerId,
    modelId,
    ...(templateId === undefined ? {} : { templateId }),
    ...(providerConfig.api?.type === undefined
      ? {}
      : { apiType: providerConfig.api.type }),
    ...(providerConfig.api?.baseUrl === undefined
      ? {}
      : { baseUrl: providerConfig.api.baseUrl }),
  };
  const inherited = builtinRules.resolve(identity);
  const personalRules =
    personal?.personalConfig !== undefined
      ? ModelConfigRules.empty().setExact(
          providerId,
          modelId,
          parseModelConfig(personal.personalConfig),
          personal.useRecommendedConfig,
        )
      : ModelConfigRules.empty();
  const effective = ModelConfigRules.composeEffective(
    builtinRules,
    personalRules,
  ).resolve(identity);
  const issues = effective.validateComplete([
    "providers",
    providerId,
    "models",
    modelId,
  ]);
  return { inherited, effective, issues };
}

export function describeProviderCodeModel(
  providerId: string,
  providerConfig: ProviderConfigObject,
  model: ProviderInstanceStoredModel,
  templateId?: string | null,
): ProviderInstanceModel {
  const { effective, issues } = resolveProviderCodeModel(
    providerId,
    providerConfig,
    model.id,
    model.codeConfig,
    templateId,
  );
  const properties = effective.properties;
  const maximum = effective.optionSpecs?.maxOutputTokens?.max;
  return {
    id: model.id,
    name: model.name,
    capability: "chat",
    enabled: effective.enabled === true && issues.length === 0,
    ...(properties?.contextWindow == null
      ? {}
      : { contextWindow: properties.contextWindow }),
    ...(maximum == null ? {} : { maxOutputTokens: maximum }),
    ...(properties?.inputFormat?.supportsImage == null
      ? {}
      : { vision: properties.inputFormat.supportsImage }),
    ...(properties?.supportsJsonSchemaOutput == null
      ? {}
      : { structuredOutput: properties.supportsJsonSchemaOutput }),
    ...(properties?.supportsNativeWebSearch == null
      ? {}
      : { nativeWebSearch: properties.supportsNativeWebSearch }),
    ...(properties?.supportsMidConversationSystem == null
      ? {}
      : { systemMessage: properties.supportsMidConversationSystem }),
    ...(effective.optionSpecs?.reasoningLevel?.values == null
      ? {}
      : { reasoningEfforts: [...effective.optionSpecs.reasoningLevel.values] }),
  };
}

export function enabledProviderCodeModelConfig(
  personalConfig: ModelConfigObject,
) {
  return parseModelConfig(personalConfig)
    .overlay(new ModelConfig({ enabled: true }))
    .toJSON();
}
