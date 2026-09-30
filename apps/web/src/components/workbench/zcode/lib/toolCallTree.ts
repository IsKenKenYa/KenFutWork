/**
 * zcode 照搬：`@/lib/toolCallTree.ts`（references/zcode/packages/ui/src/lib/toolCallTree.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */
import type { TaskChatToolCall } from "@zui/lib/taskChatMessageTypes";

export interface TaskChatToolCallTreeNode {
  toolCall: TaskChatToolCall;
  childToolCalls: TaskChatToolCallTreeNode[];
}
