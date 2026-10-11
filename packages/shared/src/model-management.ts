import type {
  IProviderSettingsService,
  ProviderSettingsView,
} from "@zcode/services";
import { z } from "zod";
import type { ModelDefaults } from "./model-policy.js";
import type { ProviderInstanceResponse } from "./provider-contracts.js";
import {
  providerInstanceModelSchema,
  providerInstanceResponseSchema,
  providerInstanceUpdateRequestSchema,
} from "./provider-contracts.js";

export const managedModelDraftSchema = z
  .object({
    providerId: z.uuid().toLowerCase(),
    expectedRevision: z.number().int().positive().safe(),
    originalModelId: z.string().min(1).optional(),
    model: providerInstanceModelSchema,
  })
  .strict();
export type ManagedModelDraft = z.infer<typeof managedModelDraftSchema>;

export const managedProviderPatchSchema = z
  .object({
    providerId: z.uuid().toLowerCase(),
    patch: providerInstanceUpdateRequestSchema.extend({
      expectedRevision: z.number().int().positive().safe(),
    }),
  })
  .strict();
export type ManagedProviderPatch = z.infer<typeof managedProviderPatchSchema>;

/** 同一原ProviderSettings通道的宿主扩展，不增加服务或另一配置真相。 */
export interface ModelManagementService extends IProviderSettingsService {
  saveManagedModel(input: ManagedModelDraft): Promise<ProviderSettingsView>;
  saveManagedProvider(
    input: ManagedProviderPatch,
  ): Promise<ProviderSettingsView>;
  getModelDefaults(): Promise<ModelDefaults>;
  saveModelDefaults(value: ModelDefaults): Promise<ModelDefaults>;
}

/** 原设置共同字段旁显式携带协议和模型用途；不塞入聊天配置语法。 */
export function nativeProviderDefinition(
  value: unknown,
): ProviderInstanceResponse | undefined {
  if (!value || typeof value !== "object" || !("native" in value))
    return undefined;
  return providerInstanceResponseSchema.parse(value.native);
}
