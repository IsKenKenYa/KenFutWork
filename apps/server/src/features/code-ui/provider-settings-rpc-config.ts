import {
  type CodeUiProviderMetadata,
  codeUiProviderMetadataSchema,
  type ProviderInstanceModel,
  type ProviderInstanceResponse,
  type ProviderPreset,
  type ProviderProtocol,
} from "@kenfutwork/shared";
import {
  type ModelConfigObject,
  type ModelInputFormatConfigInput,
  type ProviderApiType,
  type ProviderConfigObject,
  parseModelConfig,
} from "@zcode/provider";

/** These are the native SDK defaults, exposed so the original endpoint editor stays explicit. */
const defaultBaseUrls = {
  "openai-compatible": "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
} as const;
export type CodeChatProtocol = keyof typeof defaultBaseUrls;

export function isCodeChatProtocol(
  protocol: ProviderProtocol,
): protocol is CodeChatProtocol {
  return (
    protocol === "openai-compatible" ||
    protocol === "anthropic" ||
    protocol === "gemini"
  );
}
export function codeUiProviderMetadata(
  instance: ProviderInstanceResponse,
): CodeUiProviderMetadata {
  return codeUiProviderMetadataSchema.parse(instance.compat?.codeUi ?? {});
}
export function codeUiApiType(
  instance: ProviderInstanceResponse,
): ProviderApiType {
  if (instance.protocol === "gemini") return "google-generative-language";
  if (instance.protocol === "anthropic") return "anthropic-messages";
  return instance.compat?.chatApi === "responses"
    ? "openai-responses"
    : "openai-chat-completions";
}
export function codeUiNativeProtocol(
  apiType: ProviderApiType,
): CodeChatProtocol {
  if (apiType === "google-generative-language") return "gemini";
  if (apiType === "anthropic-messages") return "anthropic";
  return "openai-compatible";
}
export function codeUiPublicProviderConfig(
  instance: ProviderInstanceResponse,
): ProviderConfigObject {
  if (!isCodeChatProtocol(instance.protocol))
    throw new Error("该供应商不是 Code 聊天协议。");
  const metadata = codeUiProviderMetadata(instance);
  return {
    group: metadata.group ?? "standard-personal",
    ...(metadata.logo ? { logo: metadata.logo } : {}),
    access: { type: "api-key" },
    api: {
      type: codeUiApiType(instance),
      baseUrl: instance.baseUrl ?? defaultBaseUrls[instance.protocol],
    },
    personalModelIds: instance.models
      .filter((model) => model.capability === "chat")
      .map((model) => model.id),
    ...(metadata.modelOrder ? { modelOrder: metadata.modelOrder } : {}),
    visibility: instance.enabled ? "visible" : "hidden",
  };
}

export function codeUiTemplateConfig(
  preset: ProviderPreset,
): ProviderConfigObject {
  const protocol: CodeChatProtocol =
    preset.id === "google"
      ? "gemini"
      : preset.id === "anthropic"
        ? "anthropic"
        : "openai-compatible";
  const apiType: ProviderApiType =
    protocol === "gemini"
      ? "google-generative-language"
      : protocol === "anthropic"
        ? "anthropic-messages"
        : "openai-chat-completions";
  return {
    group: "standard-personal",
    access: { type: "api-key" },
    api: { type: apiType, baseUrl: preset.api ?? defaultBaseUrls[protocol] },
    personalModelIds: preset.models
      .filter((model) => model.capability === "chat")
      .map((model) => model.id),
  };
}

/** Persist the original editor's declared model properties in the native model definition. */
export function codeUiNativeModel(
  id: string,
  config: ModelConfigObject,
  previous?: ProviderInstanceModel,
): ProviderInstanceModel {
  const parsed = parseModelConfig(config).toJSON();
  const model: ProviderInstanceModel = {
    ...previous,
    id,
    name:
      previous?.name === previous?.id || !previous?.name ? id : previous.name,
    capability: "chat",
  };
  if (parsed.enabled !== undefined) model.enabled = parsed.enabled ?? true;
  const properties = parsed.properties;
  if (properties?.contextWindow !== undefined) {
    if (properties.contextWindow === null) delete model.contextWindow;
    else model.contextWindow = properties.contextWindow;
  }
  const flags = {
    supportsJsonSchemaOutput: "structuredOutput",
    supportsNativeWebSearch: "nativeWebSearch",
    supportsMidConversationSystem: "systemMessage",
  } as const;
  for (const [property, key] of Object.entries(flags)) {
    const value = properties?.[property as keyof typeof flags];
    if (value === null) delete model[key];
    else if (typeof value === "boolean") model[key] = value;
  }
  applyInputFormat(model, properties?.inputFormat);
  const maximum = parsed.optionSpecs?.maxOutputTokens?.max;
  if (maximum === null) delete model.maxOutputTokens;
  else if (maximum !== undefined) model.maxOutputTokens = maximum;
  const reasoning = parsed.optionSpecs?.reasoningLevel?.values;
  if (reasoning === null) delete model.reasoningEfforts;
  else if (reasoning !== undefined) model.reasoningEfforts = [...reasoning];
  return model;
}

function applyInputFormat(
  model: ProviderInstanceModel,
  input: ModelInputFormatConfigInput | null | undefined,
) {
  if (!input) return;
  const formats = {
    supportsText: "text",
    supportsImage: "image",
    supportsVideo: "video",
    supportsAudio: "audio",
    supportsPdf: "pdf",
  } as const;
  const modalities = new Set(model.inputModalities ?? ["text"]);
  let changed = false;
  for (const [key, modality] of Object.entries(formats)) {
    const value = input[key as keyof typeof formats];
    if (typeof value !== "boolean") continue;
    changed = true;
    if (value) modalities.add(modality);
    else modalities.delete(modality);
    if (key === "supportsImage") model.vision = value;
  }
  if (changed) model.inputModalities = [...modalities];
}
