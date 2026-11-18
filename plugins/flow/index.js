/**
 * flow 插件（FORM-11）：Flow 工作流模式的**产品入口条目**。
 *
 * 分工（《flow 集成方案》§3.5）：
 * - 本插件 = 产品入口：安装态决定工作台是否出现 Flow 模式（前端按
 *   `GET /api/plugins` 里的 `kenfutwork-flow` 门控，配合 `GET /api/flow/host/status`）；
 * - `apps/server/src/features/flow/` = 宿主适配层基础设施（flow 网关回调本仓）；
 * - 引擎托管（engineRuntime 双 Provider + 按需下载）按计划在 P6 落到本插件上。
 *
 * 因此 P2 阶段本模块不声明任何能力（inject 为空、apply 为空）：
 * 它承载的是「用户装没装这个功能」的产品决策，不是一段要执行的代码。
 */

export const name = "kenfutwork-flow";

export const inject = [];

export function apply() {}
