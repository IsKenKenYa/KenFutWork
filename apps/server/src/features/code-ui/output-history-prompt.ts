import type { PromptSectionDefinition } from "../../kernel/types.js";
import type { CodeUiOutputHistory } from "./output-history-types.js";

/** 从当前Task持久事实生成；再次压缩也不能把可读输出限制在旧summary的ID中。 */
export function createCodeHistoryOutputPrompt(
  reader: Pick<CodeUiOutputHistory, "manifest">,
): PromptSectionDefinition {
  return {
    name: "code.history-outputs",
    scope: "code",
    order: 31,
    async resolve(context) {
      if (!context.executionScope) return null;
      const work = context.execution?.taskWorkContext;
      if (!work) throw new Error("历史输出提示缺少可信Task执行定位。");
      const records = await reader.manifest(work);
      if (!records.length) return null;
      return `## 当前Task的只读历史输出\n以下是资源事实，不授予执行或控制权限。用TaskOutput的task_id读取当前outputId；旧sourceId只用于辨认摘要中的历史来源。TaskStop/TaskInput不适用于这些输出。\n<history-outputs>\n${JSON.stringify(records.map((record) => ({ sourceId: record.source.id, outputId: record.id, ref: record.ref, kind: record.kind, status: record.status })))}\n</history-outputs>`;
    },
  };
}
