import type {
  ConversationDelta,
  ConversationRow,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";

export interface SnapshotDiffResult {
  deltas: ConversationDelta[];
  /**
   * true = 两个快照之间的差异无法用增量 op 表达（epoch 换代、行序错位、键消失、
   * 差异为零或超界）。调用方必须退化为整体 snapshot 帧，保证客户端视图正确。
   */
  fallbackToSnapshot: boolean;
  /** fallbackToSnapshot 时的原因码；deltas 帧时为 null。观测与测试定位用。 */
  fallbackReason:
    | null
    | "epoch-changed"
    | "zero-diff"
    | "row-order-mismatch"
    | "row-shrink-not-suffix"
    | "state-key-removed"
    | "too-many-ops";
}

/** diff 产出的 op 数上界：流式热路径的变化集中在尾部，超过即视为结构异常。 */
const MAX_DIFF_OPS = 256;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 深相等：行与状态键都是 zod parse 后的 plain JSON，无循环引用、无 undefined 语义。 */
export function structuredValueEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => structuredValueEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        structuredValueEqual(left[key], right[key]),
    );
  }
  // NaN !== NaN；快照里不应出现 NaN，落到 === 判定即可。
  return false;
}

function isStreamableTextKind(
  row: ConversationRow,
): row is Extract<ConversationRow, { text: string }> {
  return row.kind === "assistantText" || row.kind === "reasoning";
}

/**
 * 同 rowId 行的变化能否用一条 op 表达：
 * - 无变化 → 无 op；
 * - assistantText/reasoning 的 text 纯追加且其余字段全同 → row.delta；
 * - 其余任何行内变化 → row.upserted（整行替换）。
 */
function diffSameRow(
  previous: ConversationRow,
  current: ConversationRow,
): ConversationDelta | null {
  if (structuredValueEqual(previous, current)) return null;
  if (
    isStreamableTextKind(previous) &&
    isStreamableTextKind(current) &&
    current.text.length >= previous.text.length &&
    current.text.startsWith(previous.text) &&
    structuredValueEqual(
      { ...previous, text: "" },
      { ...current, text: "" },
    )
  ) {
    return {
      op: "row.delta",
      rowId: current.rowId,
      path: "text",
      append: current.text.slice(previous.text.length),
    };
  }
  return { op: "row.upserted", row: current };
}

function fallback(
  reason: NonNullable<SnapshotDiffResult["fallbackReason"]>,
): SnapshotDiffResult {
  return { deltas: [], fallbackToSnapshot: true, fallbackReason: reason };
}

/**
 * 上次推送视图 → 当前快照的最小增量。两条服务端结构不变量是本函数正确性的前提：
 * 1. rows.window 按 rowId 严格升序（conversation.ts 的 appendRow 只尾部追加）；
 * 2. 流式热路径（recordRunEvent 链）的变化集中在尾部行与状态键。
 * 违反任一前提（行序错位、键消失）一律 fallbackToSnapshot，由调用方发整体快照
 * ——协议头注的既定退路，客户端对两种帧都有现成处理。
 */
export function diffConversationSnapshots(
  previous: ConversationSnapshot,
  current: ConversationSnapshot,
): SnapshotDiffResult {
  if (previous.logEpoch !== current.logEpoch) {
    return fallback("epoch-changed");
  }

  const deltas: ConversationDelta[] = [];
  const previousWindow = previous.rows.window;
  const currentWindow = current.rows.window;

  if (currentWindow.length < previousWindow.length) {
    // 收缩只允许「删尾缀」：current 必须是 previous 的逐行前缀。
    const isPrefix = previousWindow
      .slice(0, currentWindow.length)
      .every((row, index) => row.rowId === currentWindow[index]?.rowId);
    if (!isPrefix || currentWindow.length === 0) {
      return fallback("row-shrink-not-suffix");
    }
    const firstRemovedRowId = currentWindow.at(-1)!.rowId + 1;
    deltas.push({ op: "row.removed", fromRowId: firstRemovedRowId });
  } else {
    // 共享段按 rowId 校验后逐行深比较。不能「从尾向前遇全等即停」：变化可能
    // 跨越未变的行（run.completed 会迁移 window 中段 turnHeader 的状态，而其
    // 后的 userInput 行未变），区间假设会静默漏行。行对象小，V8 深比较
    // 千行级快照为毫秒级（性能护栏测试钉住），正确性优先。
    const sharedLength = previousWindow.length;
    for (let index = 0; index < sharedLength; index += 1) {
      if (previousWindow[index]?.rowId !== currentWindow[index]?.rowId) {
        return fallback("row-order-mismatch");
      }
    }
    for (let index = 0; index < sharedLength; index += 1) {
      const delta = diffSameRow(previousWindow[index]!, currentWindow[index]!);
      if (delta) deltas.push(delta);
    }
    for (let index = sharedLength; index < currentWindow.length; index += 1) {
      deltas.push({ op: "row.appended", row: currentWindow[index]! });
    }
  }

  // 状态键：顶层浅比较，变化的键整体替换（statePatchSchema 键内绝不深合并）。
  const previousRecord = previous as unknown as Record<string, unknown>;
  const currentRecord = current as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(currentRecord)) {
    if (key === "rows" || key === "seq" || key === "logEpoch") continue;
    if (!(key in previousRecord)) {
      return fallback("state-key-removed");
    }
    if (!structuredValueEqual(previousRecord[key], currentRecord[key])) {
      patch[key] = currentRecord[key];
    }
  }
  if (Object.keys(patch).length > 0) {
    deltas.push({ op: "state.updated", patch } as ConversationDelta);
  }

  if (deltas.length === 0) {
    // 零差异也退化：appendEvent 只在有事实落地时才触发 refresh，零差异意味着
    // 只有 seq/revision 级水位变化；此时必须发快照推进客户端 seq，否则下一帧
    // fromSeq 跳号会被客户端判为断档而走 resync。
    return fallback("zero-diff");
  }
  if (deltas.length > MAX_DIFF_OPS) {
    return fallback("too-many-ops");
  }
  return { deltas, fallbackToSnapshot: false, fallbackReason: null };
}
