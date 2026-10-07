import { StringDecoder } from "node:string_decoder";
import type { ProcessOutputStream } from "./types.js";
import { ProcessSandboxError } from "./types.js";

/** Native 一帧 raw ACK + helper 一帧 UTF8 ACK；历史 capture 不参与协议限额。 */
export class WindowsLiveOutput {
  private readonly decoder = new StringDecoder("utf8");
  private sequence = 0;
  private offset = 0;
  private pending: { sequence: number; native: number | null } | undefined;
  private closed = false;
  private reader = false;
  private nativeExited = false;
  private ended = false;

  constructor(
    private readonly stream: ProcessOutputStream | undefined,
    private readonly nativeAck: (sequence: number) => Promise<unknown>,
    private readonly nativeReader: (active: boolean) => Promise<unknown>,
    private readonly failed: (error: unknown) => void,
    private readonly send: (
      sequence: number,
      data: string,
      offset: number,
      nextOffset: number,
      stream?: ProcessOutputStream,
    ) => void,
  ) {}

  receive(sequence: number, bytes: Buffer): void {
    if (!Number.isSafeInteger(sequence) || sequence < 1)
      throw new ProcessSandboxError(
        "output_failed",
        "Windows native 输出序号无效。",
      );
    const data = this.decoder.write(bytes);
    if (this.closed || !data) {
      void this.nativeAck(sequence).catch(this.failed);
      return;
    }
    this.publish(data, sequence);
  }

  end(): void {
    this.ended = true;
    const tail = this.decoder.end();
    if (!this.closed && tail) this.publish(tail, null);
  }

  private publish(data: string, native: number | null): void {
    if (this.pending)
      throw new ProcessSandboxError(
        "output_failed",
        "Windows 流上一帧未 ACK。",
      );
    const sequence = ++this.sequence;
    const offset = this.offset;
    this.offset += Buffer.byteLength(data);
    this.pending = { sequence, native };
    this.send(sequence, data, offset, this.offset, this.stream);
  }

  async acknowledge(sequence: number): Promise<void> {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      sequence > this.sequence
    )
      throw new ProcessSandboxError(
        "invalid_process_request",
        "Windows 输出 ACK 无效。",
      );
    if (this.pending?.sequence !== sequence) return;
    const native = this.pending.native;
    this.pending = undefined;
    if (native !== null) await this.nativeAck(native);
  }

  async setReader(active: boolean): Promise<void> {
    this.reader = active;
    if (!active && this.nativeExited && this.stream === undefined)
      this.closed = true;
    if (!this.ended) await this.nativeReader(active);
  }

  exited(): void {
    this.nativeExited = true;
    if (!this.reader && this.stream === undefined) this.closed = true;
  }

  close(): void {
    this.closed = true;
  }
}
