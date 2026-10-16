/**
 * OpenDesign 插件：OpenDesign 设计联动画布的**产品入口条目**。
 *
 * 分工（同 flow 插件）：
 * - 本插件 = 产品入口：安装态决定 Code 模式右侧栏是否出现 OpenDesign 面板
 *   （前端按 `GET /api/plugins` 里的 `kenfutwork-open-design` 门控，配合
 *   `GET /api/open-design/host/status`）；
 * - `apps/server/src/features/open-design/` = 宿主适配层基础设施（探活与路由）。
 *
 * 因此本模块不声明任何能力（inject 为空、apply 为空）：它承载的是
 * 「用户装没装这个功能」的产品决策，不是一段要执行的代码。
 */

export const name = "kenfutwork-open-design";

export const inject = [];

export function apply() {}
