import type { ZCodePluginInfo } from "../../../../../../../packages/zcode-shared/dist/index.js";

// 原组件的电脑控制开关绑定宿主唯一库存，不另造插件安装态。
export * from "../../../../../../../packages/zcode-shared/dist/index.js";

/** 安装来源决定库存 id；产品名称与服务端 Computer Use 门控使用同一值。 */
export function resolveComputerUsePlugin(plugins: readonly ZCodePluginInfo[]) {
  return plugins.find((plugin) => plugin.name === "kenfutwork-computer-use");
}
