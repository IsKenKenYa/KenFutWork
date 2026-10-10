import type { AgentTurnBoundary } from "../features/agent-runs/types.js";
import type { TurnBoundaryCapture } from "../features/checkpoints/checkpoint-service.js";
import type { AgentContextHistory } from "./context-history.js";

export type AgentTurnBoundaryFacts = Pick<
  AgentTurnBoundary,
  "context" | "files"
>;

/** 两种捕获分别记状态；hook失败绝不能伪装为没有文件引用。 */
export async function captureAgentTurnBoundaryFacts(options: {
  contextHistory?: AgentContextHistory | undefined;
  threadId?: string | undefined;
  captureFiles?: (() => Promise<TurnBoundaryCapture | undefined>) | undefined;
}): Promise<AgentTurnBoundaryFacts> {
  let files: AgentTurnBoundary["files"] = {
    status: "unavailable",
    reason: "not_supported",
  };
  if (options.captureFiles) {
    try {
      const capture = await options.captureFiles();
      if (capture)
        files = {
          status: "captured",
          reference: capture.effective?.id ?? null,
        };
    } catch (error) {
      files = { status: "failed", reason: "capture_failed" };
      console.warn(
        "[turn-boundary] 文件边界捕获失败：",
        error instanceof Error ? error.message : "未知捕获错误",
      );
    }
  }
  let context: AgentTurnBoundary["context"] = {
    status: "unavailable",
    reason: "not_supported",
  };
  if (options.contextHistory && options.threadId) {
    try {
      context = {
        status: "captured",
        reference: await options.contextHistory.captureCurrentReference(
          options.threadId,
        ),
      };
    } catch {
      context = { status: "failed", reason: "capture_failed" };
      console.warn("[turn-boundary] 上下文边界捕获失败。");
    }
  }
  return { files, context };
}
