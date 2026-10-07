import type { TaskChatToolCall } from "@zui/lib/taskChatMessageTypes.js";

export interface TaskChatToolCallTreeNode {
  toolCall: TaskChatToolCall;
  childToolCalls: TaskChatToolCallTreeNode[];
}
