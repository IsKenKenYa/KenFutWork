import { basename } from "node:path";
import type { PromptSectionDefinition } from "../../kernel/types.js";
import { resolveWindowsShell } from "../process-sandbox/windows-broker.js";

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
    // 命令面按宿主外壳方言执行：不写清外壳，模型会照 Bash 习惯写单引号与 $()，
    // 在 Windows 上得到的是 cmd/PowerShell 的解析错误（见 §222 的真机取证）。
    const windowsShell =
      process.platform === "win32" ? resolveWindowsShell() : undefined;
    const shellNote = windowsShell
      ? `执行外壳：${basename(windowsShell)}；命令按该外壳的语法与引号书写。\n`
      : "";
    return `## 当前执行工作域\nTask：${scope.taskId}\n角色：${context.executionRole ?? "main"}\nTask 审批模式：${context.approvalMode ?? "unknown"}；派发时权限上限：${context.approvalCeiling ?? "unknown"}\n${planning}\n授权代际：${scope.generation}；文件模式：${scope.sandboxMode}\n相对路径起点：${scope.rootDirectory}\n${shellNote}授权目录：\n${roots.map((root) => `- ${root.path}：${scope.sandboxMode === "read-only" ? "read-only" : root.access}`).join("\n")}\n只读角色和派发上限不能通过人审扩大。build 的变更与执行需要逐调用批准；edit 仅自动允许受控文件 Write/Edit/ApplyPatch；plan 档文件工具只读，Bash 属执行访问需逐调用人审、批准后按目录授权真执行；yolo 自动执行仍受目录与派发上限约束。`;
  },
};
