import type { TaskMessage } from "./workbench-tools";

/**
 * 轮级过程折叠（deepseek-harness ui-chat「Turn Process Folding」的同款语义）：
 * 一轮跑完（且产出了结论）后，把结论之前的推理/工具/中途正文收进一行可展开的
 * 「思考与工具」控制行——对话不至于被几十个工具行淹没，展开后又仍是逐行可见的
 * 完整记录（不是「N 次调用」式的有损聚合，这正是 dsh 折叠与旧式聚合的分界）。
 *
 * 折叠规则（对齐 dsh 的 TurnProcessSpec）：
 * - **轮**以用户消息为界：一条用户消息开启一轮，其后全部助手消息归属该轮
 *   （开头没有用户消息的助手消息防御性归入第 1 轮）。
 * - **轮关闭**才允许折叠：非最后一轮恒关闭（下一条用户消息已到）；最后一轮看任务
 *   终态（status !== "running"）。运行中永远不折——过程正在展开才是它的常态。
 * - **答案锚**：轮内最后一条助手消息的**尾部正文段**（末尾连续 text 块）。有答案
 *   才折——轮子跑完却只有工具没有结论时，折了就没有可看的东西了。
 * - 折叠区 = 轮内答案之前的全部助手内容 + 答案消息里尾部正文**之前**的块。
 *   统计出 toolCount / reasoningCount / foldedTextCount，全为 0 不折（没有过程可收）。
 */

export type TurnProcessSpec = {
  /** 1 起始的轮次序号（与轨迹视图的「第 N 轮」同口径）。 */
  turnIndex: number;
  /** 轮内第一条助手消息的下标（控制行渲染在它前面）。 */
  startIndex: number;
  /** 答案所在助手消息的下标：折叠时这条消息只渲染尾部正文。 */
  answerIndex: number;
  /** 答案尾部正文（折叠态下答案消息的可见部分）。 */
  answerTailText: string;
  toolCount: number;
  reasoningCount: number;
  /** 被折掉的中途正文段数（中途助手消息的正文 / 答案消息里 tail 之前的正文）。 */
  foldedTextCount: number;
};

/** 一条消息的尾部正文：末尾连续 text 块的拼接；旧数据（无 blocks）整条即正文。 */
function tailTextOf(message: TaskMessage): {
  text: string;
  /** 尾部正文从第几个块开始。 */
  tailStart: number;
} {
  let tailStart = message.blocks?.length ?? 0;
  const blocks = message.blocks ?? [];
  const parts: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block?.type !== "text" || !block.text) break;
    tailStart = i;
    parts.unshift(block.text);
  }
  return { text: parts.join(""), tailStart };
}

export function deriveTurnProcesses(
  messages: readonly TaskMessage[],
  taskClosed: boolean,
): TurnProcessSpec[] {
  // ── 轮边界：[start, end) 的消息下标区间；**用户消息开启新轮**（它自己属于该轮，
  // 与轨迹账本 buildTrajectory 的分轮口径一致）；开头没有用户消息的助手消息
  // 防御性归入第 1 轮。
  const turns: Array<{ index: number; start: number; end: number }> = [];
  let segmentStart = 0;
  let turnIndex = 1;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role !== "user") continue;
    if (i > segmentStart) {
      turns.push({ index: turnIndex, start: segmentStart, end: i });
      turnIndex += 1;
      segmentStart = i;
    }
  }
  turns.push({ index: turnIndex, start: segmentStart, end: messages.length });

  const specs: TurnProcessSpec[] = [];
  for (let t = 0; t < turns.length; t += 1) {
    const turn = turns[t];
    if (!turn) continue;
    const closed = t < turns.length - 1 || taskClosed;
    if (!closed) continue;

    // 轮内助手消息下标
    const assistantIdxs: number[] = [];
    for (let i = turn.start; i < turn.end; i += 1) {
      if (messages[i]?.role === "assistant") assistantIdxs.push(i);
    }
    if (assistantIdxs.length === 0) continue;
    const answerIndex = assistantIdxs[assistantIdxs.length - 1];
    if (answerIndex === undefined) continue;
    const answer = messages[answerIndex];
    if (!answer) continue;

    const tail = tailTextOf(answer);
    if (!tail.text.trim()) continue; // 没有结论：折叠了就没有可看的答案

    // 统计折叠区内的过程条目
    let toolCount = 0;
    let reasoningCount = 0;
    let foldedTextCount = 0;
    for (const idx of assistantIdxs) {
      const message = messages[idx];
      if (!message) continue;
      const isAnswer = idx === answerIndex;
      const blocks = message.blocks ?? [];
      const limit = isAnswer ? tail.tailStart : blocks.length;
      for (let b = 0; b < limit; b += 1) {
        const block = blocks[b];
        if (!block) continue;
        if (block.type === "tool") toolCount += 1;
        else if (block.type === "reasoning") reasoningCount += 1;
        else if (block.text) foldedTextCount += 1;
      }
    }
    if (toolCount + reasoningCount + foldedTextCount === 0) continue;

    specs.push({
      turnIndex: turn.index,
      startIndex: assistantIdxs[0] ?? answerIndex,
      answerIndex,
      answerTailText: tail.text,
      toolCount,
      reasoningCount,
      foldedTextCount,
    });
  }
  return specs;
}

/** 某条消息下标落在哪个折叠区内（[startIndex, answerIndex]；不在任何区内返回 null）。 */
export function specCoveringIndex(
  specs: readonly TurnProcessSpec[],
  index: number,
): TurnProcessSpec | null {
  for (const spec of specs) {
    if (index >= spec.startIndex && index <= spec.answerIndex) return spec;
  }
  return null;
}
