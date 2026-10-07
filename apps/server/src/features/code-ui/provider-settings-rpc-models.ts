import type {
  ProviderInstanceResponse,
  ProviderInstanceUpdateRequest,
} from "@kenfutwork/shared";
import {
  type ModelConfigObject,
  manualModelConfigSchema,
  parseModelConfig,
} from "@zcode/provider";
import { modelConfigDataSchema } from "@zcode/shared/model-config";
import { z } from "zod";
import type { LocalActor } from "../local-instance/types.js";
import {
  codeUiNativeModel,
  codeUiProviderMetadata,
} from "./provider-settings-rpc-config.js";
import { CodeUiRepositoryError } from "./repository.js";

export interface ProviderModelMutationContext {
  load(
    actor: LocalActor,
    providerId: string,
  ): Promise<ProviderInstanceResponse>;
  save(
    actor: LocalActor,
    instance: ProviderInstanceResponse,
    patch: ProviderInstanceUpdateRequest,
  ): Promise<void>;
  revision(actor: LocalActor): Promise<number>;
}
const id = z.string().trim().min(1);
const providerId = z.uuid();
const methods = new Set([
  "addPersonalModel",
  "renamePersonalModel",
  "deletePersonalModel",
  "savePersonalModelDraft",
  "setPersonalModelEnabled",
  "reorderPersonalModels",
]);

function requireModel(instance: ProviderInstanceResponse, modelId: string) {
  const model = instance.models.find(
    (entry) => entry.id === modelId && entry.capability === "chat",
  );
  if (!model)
    throw new CodeUiRepositoryError(
      "not_found",
      "Code 模型不存在或不属于该供应商。",
    );
  return model;
}
function validateConfig(
  value: unknown,
  recommended: boolean,
): ModelConfigObject {
  const parsed = parseModelConfig(value).toJSON();
  if (!recommended) manualModelConfigSchema.parse(parsed);
  return parsed;
}
function replaceModel(
  instance: ProviderInstanceResponse,
  modelId: string,
  nextId: string,
  config: ModelConfigObject,
  recommended: boolean,
) {
  const current = requireModel(instance, modelId);
  if (
    nextId !== modelId &&
    instance.models.some((entry) => entry.id === nextId)
  )
    throw new CodeUiRepositoryError("command_conflict", "目标模型 ID 已存在。");
  const metadata = codeUiProviderMetadata(instance);
  const models = { ...metadata.models };
  delete models[modelId];
  return {
    models: instance.models.map((entry) =>
      entry.id === modelId ? codeUiNativeModel(nextId, config, current) : entry,
    ),
    compat: {
      ...instance.compat,
      codeUi: {
        ...metadata,
        models: {
          ...models,
          [nextId]: { config, useRecommendedConfig: recommended },
        },
        ...(metadata.modelOrder
          ? {
              modelOrder: metadata.modelOrder.map((entry) =>
                entry === modelId ? nextId : entry,
              ),
            }
          : {}),
      },
    },
  };
}

async function saveDraft(
  context: ProviderModelMutationContext,
  actor: LocalActor,
  value: unknown,
) {
  const params = z
    .object({
      providerId,
      originalModelId: id,
      nextModelId: id,
      personalConfig: modelConfigDataSchema,
      useRecommendedConfig: z.boolean().optional(),
      basedOnRevision: z.number().int().nonnegative(),
    })
    .strict()
    .parse(value);
  // 先捕获实例 CAS 修订，再核 UI 草稿修订；两读之间的外部更新不能借新修订覆盖旧草稿。
  const instance = await context.load(actor, params.providerId);
  if (params.basedOnRevision !== (await context.revision(actor)))
    throw new CodeUiRepositoryError(
      "revision_conflict",
      "模型配置已变化，请刷新草稿后重试。",
    );
  const recommended =
    params.useRecommendedConfig ??
    codeUiProviderMetadata(instance).models?.[params.originalModelId]
      ?.useRecommendedConfig ??
    true;
  const config = validateConfig(params.personalConfig, recommended);
  await context.save(
    actor,
    instance,
    replaceModel(
      instance,
      params.originalModelId,
      params.nextModelId,
      config,
      recommended,
    ),
  );
}
async function addModel(
  context: ProviderModelMutationContext,
  actor: LocalActor,
  args: unknown[],
) {
  const [owner, modelId, value, recommended] = z
    .tuple([providerId, id, modelConfigDataSchema, z.boolean().optional()])
    .parse([args[0], args[1], args[2], args[3]]);
  const instance = await context.load(actor, owner);
  if (instance.models.some((entry) => entry.id === modelId))
    throw new CodeUiRepositoryError("command_conflict", "模型 ID 已存在。");
  const config = validateConfig(value, recommended ?? true);
  const metadata = codeUiProviderMetadata(instance);
  await context.save(actor, instance, {
    models: [...instance.models, codeUiNativeModel(modelId, config)],
    compat: {
      ...instance.compat,
      codeUi: {
        ...metadata,
        models: {
          ...metadata.models,
          [modelId]: { config, useRecommendedConfig: recommended ?? true },
        },
      },
    },
  });
}
async function renameModel(
  context: ProviderModelMutationContext,
  actor: LocalActor,
  args: unknown[],
) {
  const [owner, modelId, nextId] = z.tuple([providerId, id, id]).parse(args);
  const instance = await context.load(actor, owner);
  const saved = codeUiProviderMetadata(instance).models?.[modelId];
  await context.save(
    actor,
    instance,
    replaceModel(
      instance,
      modelId,
      nextId,
      saved?.config ?? {},
      saved?.useRecommendedConfig ?? true,
    ),
  );
}
async function deleteModel(
  context: ProviderModelMutationContext,
  actor: LocalActor,
  args: unknown[],
) {
  const [owner, modelId] = z.tuple([providerId, id]).parse(args);
  const instance = await context.load(actor, owner);
  requireModel(instance, modelId);
  const metadata = codeUiProviderMetadata(instance);
  const models = { ...metadata.models };
  delete models[modelId];
  await context.save(actor, instance, {
    models: instance.models.filter((entry) => entry.id !== modelId),
    compat: {
      ...instance.compat,
      codeUi: {
        ...metadata,
        models,
        ...(metadata.modelOrder
          ? {
              modelOrder: metadata.modelOrder.filter(
                (entry) => entry !== modelId,
              ),
            }
          : {}),
      },
    },
  });
}
async function toggleModel(
  context: ProviderModelMutationContext,
  actor: LocalActor,
  args: unknown[],
) {
  const [owner, modelId, enabled] = z
    .tuple([providerId, id, z.boolean()])
    .parse(args);
  const instance = await context.load(actor, owner);
  requireModel(instance, modelId);
  const metadata = codeUiProviderMetadata(instance);
  const saved = metadata.models?.[modelId];
  await context.save(actor, instance, {
    models: instance.models.map((entry) =>
      entry.id === modelId ? { ...entry, enabled } : entry,
    ),
    compat: {
      ...instance.compat,
      codeUi: {
        ...metadata,
        models: {
          ...metadata.models,
          [modelId]: {
            config: { ...saved?.config, enabled },
            useRecommendedConfig: saved?.useRecommendedConfig ?? true,
          },
        },
      },
    },
  });
}
async function reorderModels(
  context: ProviderModelMutationContext,
  actor: LocalActor,
  args: unknown[],
) {
  const [owner, requested] = z.tuple([providerId, z.array(id)]).parse(args);
  const instance = await context.load(actor, owner);
  const models = instance.models.filter((entry) => entry.capability === "chat");
  if (
    requested.length !== models.length ||
    new Set(requested).size !== requested.length ||
    requested.some((modelId) => !models.some((entry) => entry.id === modelId))
  )
    throw new CodeUiRepositoryError(
      "revision_conflict",
      "模型成员已变化，请刷新后重新排序。",
    );
  const metadata = codeUiProviderMetadata(instance);
  await context.save(actor, instance, {
    models: [
      ...requested.map((modelId) => requireModel(instance, modelId)),
      ...instance.models.filter((entry) => entry.capability !== "chat"),
    ],
    compat: {
      ...instance.compat,
      codeUi: { ...metadata, modelOrder: requested },
    },
  });
}

export function createProviderModelMutations(
  context: ProviderModelMutationContext,
) {
  const handlers: Record<
    string,
    (actor: LocalActor, args: unknown[]) => Promise<void>
  > = {
    addPersonalModel: (actor, args) => addModel(context, actor, args),
    renamePersonalModel: (actor, args) => renameModel(context, actor, args),
    deletePersonalModel: (actor, args) => deleteModel(context, actor, args),
    savePersonalModelDraft: (actor, args) => saveDraft(context, actor, args[0]),
    setPersonalModelEnabled: (actor, args) => toggleModel(context, actor, args),
    reorderPersonalModels: (actor, args) => reorderModels(context, actor, args),
  };
  return {
    supports: (method: string) => methods.has(method),
    call: async (actor: LocalActor, method: string, args: unknown[]) => {
      const handler = handlers[method];
      if (!handler)
        throw new CodeUiRepositoryError("not_found", "未知模型设置操作。");
      await handler(actor, args);
    },
  };
}
