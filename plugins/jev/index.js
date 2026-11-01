/**
 * Jev 判决插件。
 *
 * 这枚插件本身**不训练模型、也不内置判决逻辑**：Jev 是 TypeSafe 的云侧决策模型，
 * ZCode 的做法是把社区 `jev-mcp` 当标准 MCP server 挂给 agent。本插件做的是同一件事
 * 的宿主侧落地——把服务登记进「MCP 服务器 → 精选目录」的一键添加项（见服务端
 * `features/mcp/curated-catalog.ts` 的 `jev` 条目），装好插件即可在设置里点一下接上。
 *
 * 为什么不在这里直接 spawn MCP 进程：MCP 连接的生命周期归宿主 MCP 服务管（要按 Task
 * 作用域隔离、要审批、要错误可见）。插件自己再起一份子进程会绕过这层边界，出现
 * 「工具在不在」取决于谁先连上的双重真相。
 */

export const name = "kenfutwork-jev";

/** 只要 `ui` 面（侧栏/市场的说明入口）；MCP 连接由宿主服务提供，不由插件持子进程。 */
export const inject = [];

export function apply() {
  // 能力全部经宿主登记：精选目录条目 + 市场卡片图标由清单声明。
}
