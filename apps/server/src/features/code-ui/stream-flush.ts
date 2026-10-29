import type { StreamEvent } from "@kenfutwork/shared";

export interface StreamingEventFlusher {
  /** 每个上游事件必须经此进入；返回的 Promise 在该事件（或其缓冲）落地后 resolve。 */
  handle(event: StreamEvent): Promise<void>;
  /** 立即落地全部缓冲事件；空缓冲时是 no-op，可安全多次调用。 */
  flush(): Promise<void>;
}

function streamDeltaKey(
  event: Extract<StreamEvent, { delta: string }>,
): string {
  return [
    event.type,
    event.messageId,
    event.agentName ?? "",
    event.agentCallId ?? "",
  ].join("\u0000");
}

function isStreamingDelta(
  event: StreamEvent,
): event is Extract<StreamEvent, { delta: string }> {
  return event.type === "message.delta" || event.type === "thinking.delta";
}

/**
 * 流式 delta 合批器：模型每个 chunk 一条 message.delta/thinking.delta，逐条走
 * recordRunEvent 意味着每 token 一次「事务 + 快照重建 + 全量快照帧推送」，会话越长
 * 单帧越贵。这里把相邻同 (type, messageId, agentName, agentCallId) 的 delta 拼成一条，
 * 按 agentStreamFlushIntervalMs 的节奏落地；文本追加是纯拼接，合批流与逐条流在
 * 消费方（conversation.recordEvent 的 existing.text += event.delta）终态完全一致。
 *
 * 顺序保证：任何非 delta 事件（tool 与 run 全部类型）与不同 key 的 delta 到来前先落地已缓冲
 * 事件，输出顺序与输入顺序一致；所有 handle/flush 经同一条 promise 链串行化，定时器
 * 回调与事件到来之间没有竞态。
 */
export function createStreamingEventFlusher(input: {
  flushIntervalMs: number;
  sink: (event: StreamEvent) => Promise<void>;
}): StreamingEventFlusher {
  const { flushIntervalMs, sink } = input;
  // 至多缓冲一个 key 的连续 delta：不同 key 到来会先落地旧的。
  let buffer: Extract<StreamEvent, { delta: string }> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const drain = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer === null) return;
    const pending = buffer;
    buffer = null;
    await sink(pending);
  };

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    // 前一个任务失败不阻断后续事件（错误随各自调用方的 await 冒出）。
    const run = chain.then(task, task);
    chain = run;
    return run;
  };

  return {
    handle(event) {
      return enqueue(async () => {
        if (!isStreamingDelta(event)) {
          await drain();
          await sink(event);
          return;
        }
        if (
          buffer !== null &&
          streamDeltaKey(buffer) === streamDeltaKey(event)
        ) {
          buffer.delta += event.delta;
          return;
        }
        await drain();
        buffer = event;
        timer = setTimeout(() => {
          void enqueue(drain);
        }, flushIntervalMs);
      });
    },
    flush() {
      return enqueue(drain);
    },
  };
}
