import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";
import type { ModelManagementService } from "@kenfutwork/shared";
import type { ProviderSettingsFormProvider } from "@zui/lib/providerSettingsFormTypes.js";

/**
 * 保存设置页明确维护的稀疏 Personal Overlay。
 */
export async function persistPersonalProvider(params: {
  provider: ProviderSettingsFormProvider;
  providerSettingsService: Pick<IProviderSettingsService, "savePersonalProviderOverlay">;
}): Promise<ProviderSettingsView> {
  const {
    builtinModelIds: _builtinModelIds,
    personalModelIds: _modelIds,
    ...providerFields
  } = params.provider.personalConfig;
  if (params.provider.nativeProtocolUpdate) {
    if (params.provider.configRevision === undefined) throw new Error("供应商配置已变化，请刷新后重试。");
    return (params.providerSettingsService as ModelManagementService).saveManagedProvider({
      providerId: params.provider.providerId,
      patch: { protocol: params.provider.nativeProtocolUpdate, expectedRevision: params.provider.configRevision },
    });
  }
  if (params.provider.nativeModelUpdate) {
    if (params.provider.configRevision === undefined) throw new Error("模型配置已变化，请刷新后重试。");
    return (params.providerSettingsService as ModelManagementService).saveManagedModel({
      providerId: params.provider.providerId,
      expectedRevision: params.provider.configRevision,
      ...params.provider.nativeModelUpdate,
    });
  }
  return params.providerSettingsService.savePersonalProviderOverlay(
    params.provider.providerId,
    structuredClone(providerFields),
    params.provider.providerNameUpdate === undefined && params.provider.enabledUpdate === undefined && params.provider.configRevision === undefined
      ? undefined
      : {
          ...(params.provider.configRevision === undefined ? {} : { expectedRevision: params.provider.configRevision }),
          ...(params.provider.providerNameUpdate === undefined
            ? {}
            : { providerName: params.provider.providerNameUpdate }),
          ...(params.provider.enabledUpdate === undefined
            ? {}
            : { enabled: params.provider.enabledUpdate }),
        },
  );
}
