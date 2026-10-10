import type { ModelCatalogEntry, ModelDefaults } from "@kenfutwork/shared";

/** 配置与执行共用真实模型身份；Flow 连接不作为本机候选。 */
export function validateModelDefaults(
  defaults: ModelDefaults,
  entries: readonly ModelCatalogEntry[],
): void {
  const selections = [
    {
      label: "聊天",
      capabilities: ["chat"],
      models: defaults.chat ? [defaults.chat] : [],
    },
    {
      label: "图像",
      capabilities: ["image", "image-edit"],
      models: defaults.image.mode === "manual" ? defaults.image.models : [],
    },
    {
      label: "视频",
      capabilities: ["video"],
      models: defaults.video.mode === "manual" ? defaults.video.models : [],
    },
  ];
  for (const selection of selections) {
    for (const reference of selection.models) {
      const valid = entries.some(
        (entry) =>
          entry.provider.protocol !== "dify-engine" &&
          entry.provider.instanceId === reference.providerId &&
          entry.id === reference.modelId &&
          selection.capabilities.includes(entry.capability),
      );
      if (!valid)
        throw new Error(`所选${selection.label}模型不可用，请重新选择。`);
    }
  }
}
