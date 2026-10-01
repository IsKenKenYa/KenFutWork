/**
 * computer-use 插件：Computer Use 的**产品入口条目**（FORM-11 flow 同款分层）。
 *
 * 分工（docs/方案设计/ComputerUse集成设计.md）：
 * - 本插件 = 产品入口：安装态决定能力是否可用（服务端 features/computer-use
 *   在工具调用时查询 `GET /api/plugins` 里的 kenfutwork-computer-use）；
 * - `apps/server/src/features/computer-use/` = 能力实现（ctx.tools 注册
 *   mcp__computer-use__<action>，scope: code）。
 *
 * 本模块不声明任何能力（inject 为空、apply 为空）：它承载的是
 * 「用户装没装这个功能」的产品决策，不是一段要执行的代码。
 */

export const name = "kenfutwork-computer-use";

export const inject = [];

export function apply() {}
