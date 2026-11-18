import type { ContentBlock, ToolArtifact } from "@kenfutwork/shared";

/**
 * 服务端对话历史的块组装器（ws 流事件 → `content_blocks` jsonb）。
 *
 * 为什么独立成模块：组装逻辑此前内联在 ws/handler.ts 的事件循环里——
 * `thinking.delta` 被静默丢弃、块上没有 runId 与时间戳。后果是「对话历史刷新后，
 * 轨迹时间轴全是 —、看不出每次调用属于哪轮对话」（2026-09-21 用户口径：对话流与
 * 轨迹要对齐 deepseek-harness，历史必须从 PG 完整还原）。抽出后用事件流单测锁行为。
 *
 * 持久化口径（jsonb 直存，旧行缺新字段是常态，一律可选）：
 * - `thinking.delta` → thinking 块（此前完全没落库）；
 * - `message.delta` → text 块，新段打 `at`；
 * - `tool.started` / `tool.completed` → tool 块，带 `runId` / `startedAt` / `endedAt`；
 * - **空轮次判定只看可见内容**（text/tool）——推理模型「只输出内部思考」的轮仍按
 *   空轮报失败（handler 据此给重试信号），思考块不能把空轮洗成非空。
 */

export type AssistantStreamEventLike = {
  type: "message.delta" | "thinking.delta" | "tool.started" | "tool.completed";
  delta?: string | undefined;
  toolCallId?: string | undefined;
  toolName?: string | undefined;
  input?: Record<string, unknown> | undefined;
  output?: Record<string, unknown> | undefined;
  outputSummary?: string | undefined;
  artifacts?: ToolArtifact[] | undefined;
  runId?: string | undefined;
  /** 子代理归因：带 agentCallId 的增量/工具属于子代理视图，不进主对话持久化。 */
  agentCallId?: string | undefined;
  /** ISO 时刻；缺省（测试/旧事件）就不打时间戳。 */
  timestamp?: string | undefined;
};

export interface AssistantBlockCollector {
  /** 累积中的有序块（与正文/思考/工具的真实到达顺序一致）。 */
  readonly blocks: readonly ContentBlock[];
  /** 纯正文拼接（`message.delta` 的全部增量；不含思考——思考不是结论）。 */
  readonly text: string;
  /** 是否有**可见**内容（思考块不算）。 */
  readonly hasVisibleContent: boolean;
  onEvent(event: AssistantStreamEventLike): void;
  /** 重试换 run 时清空重来（同一轮对话的持久化只落最后一次尝试）。 */
  reset(): void;
}

export function createAssistantBlockCollector(): AssistantBlockCollector {
  const blocks: ContentBlock[] = [];
  const textParts: string[] = [];

  return {
    get blocks() {
      return blocks;
    },
    get text() {
      return textParts.join("");
    },
    get hasVisibleContent() {
      return blocks.some((block) => block.type !== "thinking");
    },
    onEvent(event) {
      // 主、子会话必须先分流：正文与思考也属于派发对应的独立转录。
      if (event.agentCallId) return;
      const at = event.timestamp;
      if (event.type === "message.delta") {
        if (!event.delta) return;
        const last = blocks[blocks.length - 1];
        if (last && last.type === "text") {
          last.text += event.delta;
        } else {
          blocks.push({
            type: "text",
            text: event.delta,
            ...(at ? { at } : {}),
          });
        }
        textParts.push(event.delta);
        return;
      }
      if (event.type === "thinking.delta") {
        if (!event.delta) return;
        const last = blocks[blocks.length - 1];
        if (last && last.type === "thinking") {
          last.thinking += event.delta;
        } else {
          blocks.push({
            type: "thinking",
            thinking: event.delta,
            ...(at ? { at } : {}),
          });
        }
        return;
      }
      if (event.type === "tool.started") {
        if (!event.toolCallId) return;
        // 重连/重放同一次 tool.started：不重复入块
        const exists = blocks.some(
          (block) =>
            block.type === "tool" && block.toolCallId === event.toolCallId,
        );
        if (exists) return;
        blocks.push({
          type: "tool",
          toolCallId: event.toolCallId,
          toolName: event.toolName ?? "tool",
          status: "running",
          ...(event.input ? { input: event.input } : {}),
          ...(event.runId ? { runId: event.runId } : {}),
          ...(at ? { startedAt: at } : {}),
        });
        return;
      }
      // tool.completed
      if (!event.toolCallId) return;
      const idx = blocks.findIndex(
        (block) =>
          block.type === "tool" && block.toolCallId === event.toolCallId,
      );
      if (idx < 0) return;
      const hit = blocks[idx];
      if (hit?.type !== "tool") return;
      blocks[idx] = {
        ...hit,
        status: "completed",
        ...(event.output ? { output: event.output } : {}),
        ...(event.outputSummary ? { outputSummary: event.outputSummary } : {}),
        ...(event.artifacts ? { artifacts: event.artifacts } : {}),
        ...(event.runId && !hit.runId ? { runId: event.runId } : {}),
        ...(at ? { endedAt: at } : {}),
      };
    },
    reset() {
      blocks.length = 0;
      textParts.length = 0;
    },
  };
}
