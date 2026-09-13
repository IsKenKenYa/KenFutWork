/**
 * 队列缝的 Service Definition（§4.2 / M3.2）。
 *
 * 生成类任务（图/视频）经这里投递与消费。形态：
 * - `pgmq`（服务端/自托管默认）：Postgres 扩展 PGMQ，跨进程、可多 worker 并发消费；
 * - `in-process`（桌面）：进程内队列——**桌面拿不到 PGMQ**（Windows 无预编译扩展，
 *   FORM-2），且桌面是单进程（server + worker 同进程），不需要跨进程投递。
 *
 * 方法名刻意保持协议中立（`setVisibilityTimeout` 而非 `setVt`）：换实现时消费方不动。
 * 语义上与 PGMQ 对齐：读走**可见性超时**（vt）——消息被读出后在 vt 秒内对其他消费者
 * 不可见，处理失败可 `setVisibilityTimeout` 续期、成功 `delete`、放弃 `archive`。
 */

export type QueueMessage<T = Record<string, unknown>> = {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  /** 可见性超时（ISO 时间）：此之前该消息对其它消费者不可见。 */
  vt: string;
  message: T;
};

export interface QueueClient {
  /** 投递消息，返回消息 id。`delaySeconds` 为首次可见前的延迟。 */
  send(
    queue: string,
    payload: Record<string, unknown>,
    delaySeconds?: number,
  ): Promise<number>;
  /** 立即读（不阻塞）；无消息返回空数组。 */
  read<T = Record<string, unknown>>(
    queue: string,
    visibilityTimeoutSeconds: number,
    quantity: number,
  ): Promise<QueueMessage<T>[]>;
  /**
   * 长轮询读：最多阻塞 `maxPollSeconds`，减少空闲轮询量。
   * 桌面形态同样实现（靠内部条件变量唤醒，不是忙等）。
   */
  readWithPoll<T = Record<string, unknown>>(
    queue: string,
    visibilityTimeoutSeconds: number,
    quantity: number,
    maxPollSeconds?: number,
    pollIntervalMs?: number,
  ): Promise<QueueMessage<T>[]>;
  /** 处理成功：删除消息。 */
  deleteMessage(queue: string, msgId: number): Promise<boolean>;
  /** 放弃处理：归档（保留审计，不再投递）。 */
  archive(queue: string, msgId: number): Promise<boolean>;
  /** 续期可见性超时（心跳）。 */
  setVisibilityTimeout(
    queue: string,
    msgId: number,
    visibilityTimeoutSeconds: number,
  ): Promise<void>;
  /** 释放资源（连接池 / 定时器）。 */
  shutdown(): Promise<void>;
}
