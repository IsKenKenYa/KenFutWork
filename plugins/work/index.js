/**
 * work 插件（FORM-11）：Work 办公创作模式的**产品入口条目**。
 *
 * 分工（《work 模式集成规划》，同 flow 插件口径）：
 * - 本插件 = 产品入口：安装态决定工作台是否出现 Work 模式（前端按
 *   `GET /api/plugins` 的 `kenfutwork-work` + `GET /api/work/host/status` 共同门控）；
 * - `apps/server/src/features/work/` = 宿主适配层基础设施（编辑器扩展包注册表
 *   与数据目录事实）；
 * - 编辑器按需下载（W2）与 agent 驱动（W4）按计划落到本插件与适配层上。
 *
 * 因此 W1 阶段本模块不声明任何能力（inject 为空、apply 为空）：
 * 它承载的是「用户装没装这个功能」的产品决策，不是一段要执行的代码。
 */

export const name = "kenfutwork-work";

export const inject = [];

export function apply() {}
