/**
 * zcode 宿主适配 stub：`@/v4/useConversationProjection.ts` 的恒空等价。
 * 来源：references/zcode/packages/ui/src/v4/useConversationProjection.ts
 * 许可证：Apache-2.0（zcode）。
 *
 * 原实现经 useSyncExternalStore 订阅 per-session projection store。本仓无会话数据层，
 * 恒返回 closed 态（snapshot 恒 null）——消费方走 zcode 自身的空态降级
 * （SubagentDirectorySidePane 的 running/ended 目录恒空并自动隐藏）。
 * 消费方：app-shell/SubagentDirectorySidePane。
 */
import type { RunningSubagentSummary } from "@zui/lib/zcode-shared/zcode-protocol-v4";
import type { SessionLease } from "@zui/v4/sessionDataLayer";

/** 投影 snapshot 的消费切片（仅保留本仓消费方触达的 subagents 目录摘要）。 */
export interface ConversationProjectionSnapshotSlice {
  subagents?: {
    revision: number;
    running: readonly RunningSubagentSummary[];
    endedTotal: number;
  };
}

export interface ConversationProjectionStateSlice {
  status: "closed";
  snapshot: ConversationProjectionSnapshotSlice | null;
}

const CLOSED_STATE: ConversationProjectionStateSlice = {
  status: "closed",
  snapshot: null,
};

/** 订阅 per-session projection store；本仓恒为 closed 空态（数据层 stub）。 */
export function useConversationProjection(
  _lease: SessionLease | null,
): ConversationProjectionStateSlice {
  return CLOSED_STATE;
}
