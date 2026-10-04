import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ProcessOutputStream } from "./types.js";
import { ProcessSandboxError } from "./types.js";

/** 完整协议流与有界历史分开；每 stream 一帧 ACK，UTF8 未完成字符由 decoder 保留。 */
export class PipeOutputRelay {
  private readonly decoder = new StringDecoder("utf8");
  private sequence = 0;
  private offset = 0;
  private pending: number | null = null;
  private tail = "";
  private closed = false;

  constructor(
    private readonly input: Readable,
    private readonly stream: ProcessOutputStream,
    append: (stream: ProcessOutputStream, data: Buffer) => void,
    private readonly send: (
      sequence: number,
      data: string,
      offset: number,
      nextOffset: number,
      stream: ProcessOutputStream,
    ) => void,
  ) {
    input.on("data", (chunk: Buffer) => {
      append(stream, chunk);
      this.publish(this.decoder.write(chunk));
    });
    input.on("end", () => {
      const tail = this.decoder.end();
      if (this.pending !== null) this.tail = tail;
      else this.publish(tail);
    });
  }

  private publish(data: string): void {
    if (!data || this.closed) return;
    if (this.pending !== null)
      throw new ProcessSandboxError(
        "output_failed",
        "stdio 上一帧未 ACK，不能覆盖协议输出。",
      );
    this.input.pause();
    this.pending = ++this.sequence;
    const offset = this.offset;
    this.offset += Buffer.byteLength(data);
    this.send(this.sequence, data, offset, this.offset, this.stream);
  }

  acknowledge(sequence: number): void {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      sequence > this.sequence
    )
      throw new ProcessSandboxError(
        "invalid_process_request",
        "stdio 输出 ACK 序号无效。",
      );
    if (sequence !== this.pending) return;
    this.pending = null;
    if (this.tail) {
      const tail = this.tail;
      this.tail = "";
      this.publish(tail);
    } else if (!this.closed) this.input.resume();
  }

  close(): void {
    this.closed = true;
    this.input.resume();
  }
}
