import type { PromptSectionDefinition } from "../../kernel/types.js";

/** 每模型边界由共同prompt registry重算，文本不签发目录或审批权限。 */
export const executionScopePromptSection: PromptSectionDefinition = {
  name: "code.execution-scope",
  scope: "code",
  order: 25,
  resolve(context) {
    const scope = context.executionScope;
    if (!scope) return null;
    const roots = [
      {
        path: scope.rootDirectory,
        access: scope.sandboxMode === "read-only" ? "read-only" : "read-write",
      },
      ...scope.additionalDirectories,
    ];
    const planning = context.planEnabled
      ? "规划状态：开启；先只读调查并形成方案，不修改文件或执行有副作用的命令。"
      : "规划状态：关闭。";
    return `## 当前执行工作域\nTask：${scope.taskId}\n角色：${context.executionRole ?? "main"}\nTask 审批模式：${context.approvalMode ?? "unknown"}；派发时权限上限：${context.approvalCeiling ?? "unknown"}\n${planning}\n授权代际：${scope.generation}；文件模式：${scope.sandboxMode}\n相对路径起点：${scope.rootDirectory}\n授权目录：\n${roots.map((root) => `- ${root.path}：${scope.sandboxMode === "read-only" ? "read-only" : root.access}`).join("\n")}\n只读角色和派发上限不能通过人审扩大。build 的变更与执行需要逐调用批准；edit 仅自动允许受控文件 Write/Edit/ApplyPatch；plan 只读，可信只读无网 Bash 仍需人审；yolo 自动执行仍受目录与派发上限约束。`;
  },
};
