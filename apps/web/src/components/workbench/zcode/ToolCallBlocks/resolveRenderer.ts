/**
 * zcode 照搬：`@/ToolCallBlocks/resolveRenderer.ts`（references/zcode/packages/ui/src/ToolCallBlocks/resolveRenderer.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：本仓 P2 只迁移了 13 个 renderer（edit / agent / changes-group / explore /
 * execute / execute-group / fallback / read / search / skill / task-stop / todo / ask-question，
 * 外加 cua-group 直接依赖链带入的 cua）。上游注册表里其余 renderer（workflow 家族、goal、
 * node-repl、mcp、plan-guidance、read-session-context、respond-to-coordinator、send-message、
 * submit-result、switch-mode、task-output、escalate 等）尚未迁移，对应分流分支移除，
 * 这些工具名统一落到 FallbackToolCallBlock（raw JSON 兜底卡）；上游对应分支的注释保留在
 * 各分支原位以便后续迁移时恢复。其余逐字照搬，仅 import 路径映射（手册 §2.1）。
 */
// ============================================================
// 工具卡 renderer 注册表：tool identity → 具体 renderer 组件
// ============================================================
// 从 ToolCallBlocks.tsx 拆出：这张表随工具种类线性增长，和 renderContext 装配叠在一处后
// ToolCallBlocks.tsx 越过 oxlint max-lines(400)（rows.ts → toolDisplay.ts 是同一先例）。
// 本文件只做纯分流，不含 JSX、不碰 context 装配，ToolCallBlocks.tsx 单向依赖它。

import { resolveToolCallIdentity } from "@zui/lib/toolIdentity";
import { AgentToolCallBlock } from "@zui/ToolCallBlocks/renderers/agent";
import { AskQuestionToolCallBlock } from "@zui/ToolCallBlocks/renderers/ask-question";
import { ChangesGroupToolCallBlock } from "@zui/ToolCallBlocks/renderers/changes-group";
import {
  CuaToolCallBlock,
  isCuaToolCall,
} from "@zui/ToolCallBlocks/renderers/cua";
import { CuaGroupToolCallBlock } from "@zui/ToolCallBlocks/renderers/cua-group";
import { EditToolCallBlock } from "@zui/ToolCallBlocks/renderers/edit";
import { ExecuteToolCallBlock } from "@zui/ToolCallBlocks/renderers/execute";
import { ExecuteGroupToolCallBlock } from "@zui/ToolCallBlocks/renderers/execute-group";
import { ExploreToolCallBlock } from "@zui/ToolCallBlocks/renderers/explore";
import { FallbackToolCallBlock } from "@zui/ToolCallBlocks/renderers/fallback";
import { ReadToolCallBlock } from "@zui/ToolCallBlocks/renderers/read";
import { SearchToolCallBlock } from "@zui/ToolCallBlocks/renderers/search";
import { SkillToolCallBlock } from "@zui/ToolCallBlocks/renderers/skill";
import { TaskStopToolCallBlock } from "@zui/ToolCallBlocks/renderers/task-stop";
import { TodoToolCallBlock } from "@zui/ToolCallBlocks/renderers/todo";
import type { ToolCallBlockRenderContext } from "@zui/ToolCallBlocks/shared";

export function resolveToolCallRenderer(context: ToolCallBlockRenderContext) {
  if (context.toolCallNode.toolCall.kind === "changesGroup") {
    return ChangesGroupToolCallBlock;
  }
  if (context.toolCallNode.toolCall.kind === "executeGroup") {
    return ExecuteGroupToolCallBlock;
  }
  if (context.toolCallNode.toolCall.kind === "cuaGroup") {
    return CuaGroupToolCallBlock;
  }
  if (isCuaToolCall(context.toolCallNode.toolCall)) {
    return CuaToolCallBlock;
  }

  const identity = resolveToolCallIdentity(context.toolCallNode.toolCall);

  // 上游按**工具名**先分流可复用工作流的两个工具（save_workflow / list_saved_workflows）及
  // 观察类工作流三工具、Resume、模型目录、升级问答等——对应 renderer 本仓尚未迁移，
  // 这些分支移除后统一落到文末 FallbackToolCallBlock（raw JSON 兜底卡），迁移时按上游
  // resolveRenderer.ts 原分支恢复。

  // 上游此处还有 node-repl / 通用 MCP 两条按 presentation 分流的分支，对应 renderer
  // 本仓尚未迁移，同样落到 FallbackToolCallBlock。

  // 当前工具名已经是固定集合。继续用正则扫 kind/title 的话，
  // 会把 TodoWrite 里的 Write 当成文件写入。这里先解析固定 tool identity，再按 family 分流；
  // ZCode 历史投影的工具形态由 identity resolver 统一处理。
  switch (identity.family) {
    // 上游 case "plan-guidance" / "goal" / "session-context" / "workflow" /
    // "switch-mode" / "message"（SendMessage / RespondToCoordinator）/ "task-control"
    // 的 TaskOutput 分支对应 renderer 未迁移；这些 family 落到 default 兜底卡。
    case "agent":
      return AgentToolCallBlock;
    case "todo":
      return TodoToolCallBlock;
    case "ask-user-question":
      return AskQuestionToolCallBlock;
    case "task-control":
      // 上游同款 family 内按工具名分派；TaskOutput renderer 未迁移，落兜底卡。
      return identity.toolName === "TaskOutput"
        ? FallbackToolCallBlock
        : TaskStopToolCallBlock;
    case "skill":
      return SkillToolCallBlock;
    case "file-read":
      return ReadToolCallBlock;
    case "file-write":
      return EditToolCallBlock;
    case "explore":
      return ExploreToolCallBlock;
    case "search":
      return SearchToolCallBlock;
    case "shell":
      return ExecuteToolCallBlock;
    default:
      return FallbackToolCallBlock;
  }
}
