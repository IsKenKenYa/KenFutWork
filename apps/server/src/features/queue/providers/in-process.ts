import type { QueueClient, QueueMessage } from "../types.js";

/**
 * 队列缝的**桌面 Provider**：进程内队列（FORM-2）。
 *
 * 桌面拿不到 PGMQ（Windows 无预编译扩展），且 server 与 worker **同进程**——投递与消费
 * 在同一进程内，不需要 Postgres 队列。故这里用内存实现，语义与 PGMQ 对齐：
 *
 * - **可见性超时（vt）**：`read` 把消息标记为「直到 now+vt 之前不可见」，处理失败可
 *   `setVisibilityTimeout` 续期（心跳），成功 `deleteMessage`，放弃 `archive`。
 *   **`read_ct` 会累加**——这是消费方的重试判据（超过 max_attempts 即死信）。
 * - **长轮询**：`readWithPoll` 靠等待者通知唤醒，不忙等；超时后返回空数组。
 * - **不持久**：进程退出即丢。桌面形态下未完成的任务本就需要「重跑」而非「恢复」，
 *   与 PGMQ 的持久语义差异记录在 §4.13。
 *
 * 单消费者假设：桌面单进程、单 worker；即便如此也按 vt 语义实现，避免消费方出现
 * 「换个形态就双消费」的行为分叉。
 */

type QueuedMessage = {
  archivedAt: string | null;
  enqueuedAt: number;
  message: Record<string, unknown>;
  msgId: number;
  readCount: number;
  visibleAt: number;
};

export function createInProcessQueue(
  options: {
    /** 注入时钟，便于测试 vt/延迟；默认 `Date.now`。 */
    now?: () => number;
  } = {},
): QueueClient {
  const now = options.now ?? (() => Date.now());
  const queues = new Map<string, QueuedMessage[]>();
  const waiters = new Map<string, Array<() => void>>();
  let nextMsgId = 1;
  let closed = false;

  const queueOf = (name: string): QueuedMessage[] => {
    let queue = queues.get(name);
    if (!queue) {
      queue = [];
      queues.set(name, queue);
    }
    return queue;
  };

  const wake = (name: string): void => {
    const pending = waiters.get(name);
    if (!pending?.length) return;
    waiters.delete(name);
    for (const resolve of pending) resolve();
  };

  const takeVisible = <T>(
    name: string,
    visibilityTimeoutSeconds: number,
    quantity: number,
  ): QueueMessage<T>[] => {
    const queue = queueOf(name);
    const current = now();
    const taken: QueueMessage<T>[] = [];

    for (const entry of queue) {
      if (taken.length >= quantity) break;
      if (entry.archivedAt || entry.visibleAt > current) continue;

      entry.readCount += 1;
      entry.visibleAt = current + visibilityTimeoutSeconds * 1000;
      taken.push({
        enqueued_at: new Date(entry.enqueuedAt).toISOString(),
        message: entry.message as T,
        msg_id: entry.msgId,
        read_ct: entry.readCount,
        vt: new Date(entry.visibleAt).toISOString(),
      });
    }

    return taken;
  };

  const find = (name: string, msgId: number): QueuedMessage | undefined =>
    queueOf(name).find((entry) => entry.msgId === msgId);

  return {
    async send(queue, payload, delaySeconds = 0) {
      if (closed) {
        throw new Error("队列已关闭，无法投递。");
      }
      const entry: QueuedMessage = {
        archivedAt: null,
        enqueuedAt: now(),
        message: payload,
        msgId: nextMsgId,
        readCount: 0,
        visibleAt: now() + delaySeconds * 1000,
      };
      nextMsgId += 1;
      queueOf(queue).push(entry);
      wake(queue);
      return entry.msgId;
    },

    async read<T>(
      queue: string,
      visibilityTimeoutSeconds: number,
      quantity: number,
    ) {
      return takeVisible<T>(queue, visibilityTimeoutSeconds, quantity);
    },

    async readWithPoll<T>(
      queue: string,
      visibilityTimeoutSeconds: number,
      quantity: number,
      maxPollSeconds = 5,
      pollIntervalMs = 500,
    ) {
      const immediate = takeVisible<T>(
        queue,
        visibilityTimeoutSeconds,
        quantity,
      );
      if (immediate.length > 0) {
        return immediate;
      }

      const deadline = now() + maxPollSeconds * 1000;
      while (!closed) {
        const remainingMs = deadline - now();
        if (remainingMs <= 0) {
          return [];
        }

        // 等待投递通知或超时（不忙等）
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            resolve,
            Math.min(remainingMs, pollIntervalMs),
          );
          const pending = waiters.get(queue) ?? [];
          pending.push(() => {
            clearTimeout(timer);
            resolve();
          });
          waiters.set(queue, pending);
        });

        const taken = takeVisible<T>(queue, visibilityTimeoutSeconds, quantity);
        if (taken.length > 0) {
          return taken;
        }
      }
      return [];
    },

    async deleteMessage(queue, msgId) {
      const queueEntries = queueOf(queue);
      const index = queueEntries.findIndex((entry) => entry.msgId === msgId);
      if (index === -1) {
        return false;
      }
      queueEntries.splice(index, 1);
      return true;
    },

    async archive(queue, msgId) {
      const entry = find(queue, msgId);
      if (!entry) {
        return false;
      }
      // 归档保留在列表里（不再可见），便于诊断；进程退出即随之消失
      entry.archivedAt = new Date(now()).toISOString();
      return true;
    },

    async setVisibilityTimeout(queue, msgId, visibilityTimeoutSeconds) {
      const entry = find(queue, msgId);
      if (!entry) {
        return;
      }
      entry.visibleAt = now() + visibilityTimeoutSeconds * 1000;
    },

    async shutdown() {
      closed = true;
      for (const name of queues.keys()) {
        wake(name);
      }
      queues.clear();
      waiters.clear();
    },
  };
}
