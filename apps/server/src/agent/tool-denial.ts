/**
 * 工具拒绝跟踪器：让「被工具门拦下的调用」对客户端可见、并且**有界**。
 *
 * 背景（两条实测得出的缺陷，2026-09-15）：
 * 1. 工具门（执行模式 solo/plan、权限档）在 `wrapToolCall` 里直接返回 ToolMessage，
 *    不经过任何工具执行——客户端因此**看不到**任何 `tool.*` 事件，界面上完全没有
 *    「谁被拦了、为什么」的记录，只有模型自己的话术；
 * 2. 模型反复重调同一个被拒工具时**没有步数上限**（替身实测 180 秒重调 2971 次，
 *    run 既不失败也不结束；空闲看门狗只管「没输出」，管不了「一直有输出但空转」）。
 *
 * 本模块只做「记账」：谁被拒了几次、是否触达上限、有哪些待下发的记录。合成事件与
 * 中止 run 由运行时负责（它才拿得到 runId/时间戳/abort 控制器）。
 */

/** 同一工具**连续**被拒多少次即中止本轮（放行一次即清零）。 */
export const MAX_CONSECUTIVE_TOOL_DENIALS = 3;

export interface ToolDenialRecord {
  toolCallId: string;
  toolName: string;
  reason: string;
  input?: Record<string, unknown>;
  /** 该工具连续被拒的第几次（1 起） */
  count: number;
}

export interface ToolDenialTracker {
  recordDenied(input: {
    toolCallId: string;
    toolName: string;
    reason: string;
    input?: Record<string, unknown> | undefined;
  }): void;
  /** 放行时清零该工具的连续计数（「连续」而不是「累计」）。 */
  recordAllowed(toolName: string): void;
  /** 取走待下发的拒绝记录（合成事件用；取走后清空）。 */
  drain(): ToolDenialRecord[];
  /** 触达上限时的可读原因；未触达返回 null。 */
  fatalReason(): string | null;
}

export function createToolDenialTracker(
  options: { limit?: number } = {},
): ToolDenialTracker {
  const limit = Math.max(1, options.limit ?? MAX_CONSECUTIVE_TOOL_DENIALS);
  const counts = new Map<string, number>();
  const pending: ToolDenialRecord[] = [];
  let fatal: string | null = null;

  return {
    recordDenied({ toolCallId, toolName, reason, input }) {
      const count = (counts.get(toolName) ?? 0) + 1;
      counts.set(toolName, count);
      pending.push({
        count,
        reason,
        toolCallId,
        toolName,
        ...(input ? { input } : {}),
      });
      if (count >= limit && fatal === null) {
        fatal = `同一工具 ${toolName} 连续被拒绝 ${count} 次，已中止本轮以免空转（最近原因：${reason}）。`;
      }
    },

    recordAllowed(toolName) {
      counts.delete(toolName);
    },

    drain() {
      const out = [...pending];
      pending.length = 0;
      return out;
    },

    fatalReason() {
      return fatal;
    },
  };
}
