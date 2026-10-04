import { validateInstanceModelExtraBody } from "../../providers/request-options.js";
import type {
  ModelCatalogEntry,
  ProviderInstanceResponse,
} from "@kenfutwork/shared";
import {
  compileModelOptionMaps,
  type JsonObject,
  type JsonValue,
} from "@zcode/model-option-map";
import {
  validateModelSelectionOptions,
  type ModelSelection,
} from "@zcode/provider";
import { z } from "zod";
import { codeUiModelEntry, resolveCodeUiModelConfig } from "./model-views.js";
import { CodeUiRepositoryError } from "./repository.js";
import { codeUiApiType, isCodeChatProtocol } from "./provider-settings-rpc-config.js";

export interface CodeUiModelExecutionSnapshot {
  readonly providerId: string;
  readonly modelId: string;
  readonly configRevision: number;
  readonly useResponsesApi?: boolean;
  readonly body: JsonObject;
  readonly inputCapabilities: {
    readonly image: boolean;
    readonly pdf: boolean;
  };
}
export function assertCodeUiModelRequestOptions(body: Record<string, unknown>): void {
  try { validateInstanceModelExtraBody(body); }
  catch (error) { throw new CodeUiRepositoryError("command_conflict", error instanceof Error ? error.message : "模型选项不可执行。"); }
}

function freezeJson<T extends JsonValue>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** Internal only: original model config and native declarations supply one frozen Run request. */
export function compileCodeUiModelExecution(input: {
  instances: readonly ProviderInstanceResponse[];
  catalog: readonly ModelCatalogEntry[];
  selection: ModelSelection | null | undefined;
}): CodeUiModelExecutionSnapshot {
  const selection = input.selection;
  if (!selection)
    throw new CodeUiRepositoryError(
      "command_conflict",
      "当前运行没有明确的模型选择。",
    );
  const instance = input.instances.find(
    (entry) =>
      entry.id === selection.providerId && isCodeChatProtocol(entry.protocol),
  );
  if (!instance)
    throw new CodeUiRepositoryError("not_found", "所选 Code 供应商不存在。");
  if (!instance.enabled || !instance.hasCredential)
    throw new CodeUiRepositoryError(
      "command_conflict",
      "所选供应商未启用或没有凭证。",
    );
  const model = instance.models.find(
    (entry) => entry.id === selection.modelId && entry.capability === "chat",
  );
  if (!model || model.enabled === false)
    throw new CodeUiRepositoryError(
      "not_found",
      "所选 Code 模型不存在或已停用。",
    );
  const entry =
    input.catalog.find(
      (candidate) =>
        candidate.provider.instanceId === instance.id &&
        candidate.id === model.id,
    ) ?? codeUiModelEntry(instance, model);
  const resolved = resolveCodeUiModelConfig(instance, entry);
  if (!resolved.complete.ok || resolved.complete.config.enabled !== true)
    throw new CodeUiRepositoryError(
      "command_conflict",
      "所选模型配置不完整或已停用。",
    );
  const validation = validateModelSelectionOptions(
    { config: resolved.complete.config },
    selection,
  );
  if (!validation.ok)
    throw new CodeUiRepositoryError(
      "command_conflict",
      validation.code === "reasoning-level-missing"
        ? "请明确选择当前模型的思考档位。"
        : "所选思考档位已失效，请重新选择。",
    );
  const reasoningLevel = selection.options?.reasoningLevel;
  if (reasoningLevel === undefined)
    throw new CodeUiRepositoryError(
      "command_conflict",
      "模型执行必须固定思考档位。",
    );
  const base = z.record(z.string(), z.json()).parse(model.extraBody ?? {});
  assertCodeUiModelRequestOptions(base);
  const config = resolved.complete.config;
  const body = compileModelOptionMaps({
    reasoningLevel: config.optionSpecs.reasoningLevel,
    maxOutputTokens: config.optionSpecs.maxOutputTokens,
  }).apply(base, {
    reasoningLevel,
    maxOutputTokens: config.optionSpecs.maxOutputTokens.max,
  });
  assertCodeUiModelRequestOptions(body);
  return Object.freeze({
    providerId: instance.id,
    modelId: model.id,
    configRevision: instance.configRevision,
    ...(instance.protocol === "openai-compatible" ? { useResponsesApi: codeUiApiType(instance) === "openai-responses" } : {}),
    body: freezeJson(body),
    inputCapabilities: Object.freeze({
      image: config.properties.inputFormat.supportsImage,
      pdf: config.properties.inputFormat.supportsPdf,
    }),
  });
}
