/**
 * 置顶提示段（M3，规划 §2.4 第 2 层）：order -50 / scope always。
 * 排在 base(-100) 之后、模式段(0/75)、skills(200)、规则与插件(300) 之前。
 * 未安装/停用时 resolve 返回 null（本 run 不出现）；装/卸下一轮即生效。
 */

import type { PromptSectionDefinition } from "../../kernel/types.js";
import type { KnowledgeSettingsReader } from "./settings.js";
import type { KnowledgeService } from "./types.js";

export function createKnowledgePromptSection(deps: {
  knowledge: KnowledgeService;
  readSettings: KnowledgeSettingsReader;
}): PromptSectionDefinition {
  return {
    name: "knowledge.preflight",
    order: -50,
    scope: "always",
    async resolve(ctx) {
      const gate = await deps.knowledge.isActive();
      if (!gate.ok) return null;
      const settings = await deps.readSettings(ctx.instanceId);
      const lines = [
        "## 本地知识库（SAG2）",
        settings.autoInject
          ? "宿主已在每轮输入前自动检索本地知识库：输入末尾的 <knowledge_evidence> 块是检索证据，回答时优先引用并标注路径与行号；<knowledge_status> 块说明本轮检索状态（未检索/未命中/失败），不要把它当作已检索。"
          : "本地知识库的每轮自动检索已关闭；需要项目事实时主动调用 knowledge_search。",
        "证据不足用 knowledge_search 深挖，knowledge_read 按行号取原文，knowledge_status 查看就绪状态。",
      ];
      if (settings.localMatch) {
        lines.push("当前检索为本地匹配（-F），非 SAG2 语义检索。");
      }
      return lines.join("\n");
    },
  };
}
