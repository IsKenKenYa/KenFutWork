import { managedModelDraftSchema } from "@kenfutwork/shared";
import type { LocalActor } from "../local-instance/types.js";
import type { ModelProviderService } from "./model-provider-service.js";
import { ModelProviderServiceError } from "./model-provider-service.js";

/** 原编辑器生成叶子与REST共同写入原生模型定义，修订由统一供应商服务裁决。 */
export async function saveManagedModel(
  registry: Pick<ModelProviderService, "listInstances" | "updateInstance">,
  actor: LocalActor,
  value: unknown,
) {
  const input = managedModelDraftSchema.parse(value);
  const instance = (await registry.listInstances(actor)).find(
    (entry) => entry.id === input.providerId,
  );
  if (!instance)
    throw new ModelProviderServiceError(
      "instance_not_found",
      "供应商已删除，请刷新模型设置。",
      404,
    );
  if (instance.protocol === "dify-engine")
    throw new ModelProviderServiceError(
      "instance_model_unavailable",
      "Flow 连接不能配置本机模型。",
      400,
    );
  const originalId = input.originalModelId;
  const index =
    originalId === undefined
      ? -1
      : instance.models.findIndex((model) => model.id === originalId);
  if (originalId !== undefined && index < 0)
    throw new ModelProviderServiceError(
      "instance_not_found",
      "模型已删除，请刷新模型设置。",
      404,
    );
  if (
    originalId !== input.model.id &&
    instance.models.some((model) => model.id === input.model.id)
  )
    throw new ModelProviderServiceError(
      "instance_model_unavailable",
      "模型 ID 已存在，请修改后保存。",
      400,
    );
  const models = [...instance.models];
  if (index < 0) models.push(input.model);
  else models[index] = input.model;
  return registry.updateInstance(actor, instance.id, {
    models,
    expectedRevision: input.expectedRevision,
  });
}
