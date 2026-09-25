/**
 * 流式期间的任务持久化节流器（leading + trailing）。
 *
 * 背景：`message.delta`/`thinking.delta` 每个 token 触发一次任务状态更新，而每次
 * 更新都要把整份任务列表（上限 100 条）`JSON.stringify` 回写 localStorage——实测
 * 长回答时这成为流式卡顿的大头。节流规则：
 * - **一串快速写入的第一次立即落盘**（burst 开始不丢内容）；
 * - 之后的写入合并，静默 `delayMs` 后补写最新一份（trailing）；
 * - `flush()` 强制立即落盘（终态事件 / 追问提交前用，防止节流窗口内的内容滞留）。
 */
export type TaskSaver = {
  save(mode: string, list: unknown): void;
  /** 立即落盘指定 mode（缺省全部）的待写内容。 */
  flush(mode?: string): void;
};

export function createTaskSaver(
  save: (mode: string, list: unknown) => void,
  options?: { delayMs?: number },
): TaskSaver {
  const delayMs = options?.delayMs ?? 400;
  /** 每个 mode 的待写状态：timer 存活期间到达的写入合并进 pendingList。 */
  const pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; list: unknown }
  >();

  const writeNow = (mode: string, list: unknown) => {
    pending.delete(mode);
    save(mode, list);
  };

  return {
    save(mode, list) {
      const existing = pending.get(mode);
      if (existing) {
        // 已经在节流窗口内：只更新待写内容，到点统一落盘
        existing.list = list;
        return;
      }
      // 窗口外：立即写（leading），同时开一个窗口兜住紧随其后的尾巴
      save(mode, list);
      const timer = setTimeout(() => {
        const entry = pending.get(mode);
        if (entry && entry.list !== undefined) {
          writeNow(mode, entry.list);
          return;
        }
        pending.delete(mode);
      }, delayMs);
      pending.set(mode, { timer, list: undefined });
    },
    flush(mode) {
      if (mode === undefined) {
        for (const key of [...pending.keys()]) this.flush(key);
        return;
      }
      const entry = pending.get(mode);
      if (!entry) return;
      clearTimeout(entry.timer);
      if (entry.list !== undefined) {
        writeNow(mode, entry.list);
        return;
      }
      pending.delete(mode);
    },
  };
}
