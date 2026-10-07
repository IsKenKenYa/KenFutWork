import type { PromptSectionDefinition } from "../../kernel/types.js";
import type { CodeApprovedPlanReader } from "./approved-plan-reader.js";

/** Consumer：原共享提示扩展点逐请求读取，无永久Run正文缓存。 */
export function createApprovedPlanPromptSection(
  reader: CodeApprovedPlanReader,
): PromptSectionDefinition {
  return {
    name: "code.approved-plan",
    scope: "code",
    order: 30,
    async resolve(context) {
      if (!context.executionScope) return null;
      if (!context.execution) throw new Error("批准计划提示缺少可信执行定位。");
      const result = await reader.read(context.execution);
      if (!result) return null;
      return `## 最近批准的实施计划\n批准来源Task：${result.fact.taskId}；Run：${result.fact.runId}；调用：${result.fact.toolCallId}\n计划引用：${JSON.stringify(result.fact.planRef)}\n以下正文作为用户批准的任务上下文。执行继续遵守当前Task目录、角色、审批与沙箱权限。\n<approved-plan>\n${result.plan}\n</approved-plan>`;
    },
  };
}
