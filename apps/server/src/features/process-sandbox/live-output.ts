import type { HelperOutputFrame } from "./protocol.js";
import type { TerminalOutputListener } from "./types.js";
import { ProcessSandboxError } from "./types.js";

/** 同 helper 的单帧 ACK 回压：没有 reader 时只保留一帧，PTY 在 helper 侧暂停。 */
export class LiveOutputConsumer {
  private readonly listeners = new Set<TerminalOutputListener>();
  private pending: HelperOutputFrame | undefined;
  private delivering = false;
  private delivery: Promise<void> = Promise.resolve();
  private failure: unknown;
  private readerReady: Promise<void> = Promise.resolve();

  constructor(
    private readonly acknowledge: (sequence: number) => Promise<unknown>,
    private readonly failed: () => Promise<unknown>,
    private readonly readerChanged: (active: boolean) => Promise<unknown>,
  ) {}

  receive(frame: HelperOutputFrame): void {
    if (this.pending)
      throw new ProcessSandboxError(
        "output_failed",
        "协议输出未获 ACK 又发送了下一帧。",
      );
    this.pending = frame;
    this.deliver();
  }

  onOutput(listener: TerminalOutputListener): () => void {
    const first = this.listeners.size === 0;
    this.listeners.add(listener);
    if (first)
      this.readerReady = this.readerChanged(true).then(
        () => {},
        (error: unknown) => {
          this.failure = error;
        },
      );
    this.deliver();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        void this.readerChanged(false).catch(() => {});
        void this.consumeCaptured().catch(() => {});
      }
    };
  }

  async consumeCaptured(): Promise<void> {
    if (this.listeners.size > 0 || this.delivering || !this.pending) return;
    const frame = this.pending;
    this.pending = undefined;
    await this.acknowledge(frame.sequence);
  }

  /** 活跃 reader 的最后回执；无人订阅的 pending 保留给稍后激活，不伪造已交付。 */
  async drain(): Promise<void> {
    while (this.listeners.size > 0 && (this.delivering || this.pending)) {
      this.deliver();
      await this.delivery;
    }
    if (this.failure)
      throw new ProcessSandboxError(
        "output_failed",
        "终端输出消费失败，退出回执尚未完成交付。",
      );
  }

  private deliver(): void {
    if (this.delivering || this.listeners.size === 0 || !this.pending) return;
    const frame = this.pending;
    this.pending = undefined;
    this.delivering = true;
    this.delivery = (async () => {
      await this.readerReady;
      if (this.failure) throw this.failure;
      await Promise.all(
        [...this.listeners].map(async (listener) =>
          listener(frame.data, {
            sequence: frame.sequence,
            offset: frame.offset,
            nextOffset: frame.nextOffset,
          }),
        ),
      );
      await this.acknowledge(frame.sequence);
    })()
      .catch(async (error: unknown) => {
        this.failure = error;
        await this.failed();
      })
      .finally(() => {
        this.delivering = false;
        this.deliver();
      });
    void this.delivery.catch(() => {});
  }
}
