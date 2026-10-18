import { once } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { PipeOutputRelay } from "./pipe-output.js";
import type { ProcessOutputStream } from "./types.js";

interface Frame {
  sequence: number;
  data: string;
  offset: number;
  nextOffset: number;
  stream: ProcessOutputStream;
}

function fixture(stream: ProcessOutputStream = "stdout") {
  const input = new PassThrough();
  const captured: Buffer[] = [];
  const frames: Frame[] = [];
  const relay = new PipeOutputRelay(
    input,
    stream,
    (_stream, chunk) => captured.push(Buffer.from(chunk)),
    (sequence, data, offset, nextOffset, source) => {
      frames.push({ sequence, data, offset, nextOffset, stream: source });
    },
  );
  return { input, relay, captured, frames, stream };
}

/** 模拟Node child退出时flushStdio重新resume；以resume事件而非延时确定状态。 */
async function externalResume(input: PassThrough) {
  if (!input.isPaused()) return;
  const resumed = once(input, "resume");
  input.resume();
  await resumed;
}

async function forceChunk(input: PassThrough, chunk: Buffer | string) {
  await externalResume(input);
  const received = once(input, "data");
  expect(() => input.write(chunk)).not.toThrow();
  await received;
}

function drainProtocol(f: ReturnType<typeof fixture>) {
  for (let index = 0; index < f.frames.length; index++) {
    const frame = f.frames[index];
    if (!frame) throw new Error("协议帧缺失");
    const before = f.frames.length;
    f.relay.acknowledge(frame.sequence);
    expect(f.frames.length).toBeLessThanOrEqual(before + 1);
    const after = f.frames.length;
    f.relay.acknowledge(frame.sequence);
    expect(f.frames).toHaveLength(after);
  }
}

function expectOffsets(f: ReturnType<typeof fixture>) {
  let offset = 0;
  for (const [index, frame] of f.frames.entries()) {
    expect(frame).toMatchObject({
      sequence: index + 1,
      offset,
      nextOffset: offset + Buffer.byteLength(frame.data),
      stream: f.stream,
    });
    offset = frame.nextOffset;
  }
}

test.each(["stdout", "stderr"] as const)(
  "%s首帧待ACK时被外部resume，后续数据不抛错、不覆盖也不提前发送",
  async (stream) => {
    const f = fixture(stream);
    try {
      await forceChunk(f.input, "A");
      expect(f.frames.map((frame) => frame.data)).toEqual(["A"]);
      await forceChunk(f.input, "B");
      await forceChunk(f.input, "C");
      expect(f.frames.map((frame) => frame.data)).toEqual(["A"]);
      expect(Buffer.concat(f.captured).toString()).toBe("ABC");
      let futureAck: unknown;
      try {
        f.relay.acknowledge(2);
      } catch (error) {
        futureAck = error;
      }
      expect(futureAck).toMatchObject({ code: "invalid_process_request" });
      expect(f.frames.map((frame) => frame.data)).toEqual(["A"]);
      f.relay.acknowledge(1);
      expect(f.frames).toHaveLength(2);
      const afterFirstAck = f.frames.length;
      f.relay.acknowledge(1);
      expect(f.frames).toHaveLength(afterFirstAck);
      drainProtocol(f);
      expect(f.frames.map((frame) => frame.data).join("")).toBe("ABC");
      expectOffsets(f);
    } finally {
      f.input.destroy();
    }
  },
);

test("待ACK队列保留跨chunk UTF8和decoder EOF尾部，按传输字节游标完整交付", async () => {
  const f = fixture();
  try {
    await forceChunk(f.input, "A");
    await forceChunk(f.input, Buffer.from([0xe4, 0xb8]));
    await forceChunk(f.input, Buffer.from([0xad, 0xf0, 0x9f]));
    await forceChunk(f.input, Buffer.from([0x98, 0x80, 0xe4]));
    const ended = once(f.input, "end");
    await externalResume(f.input);
    f.input.end();
    await ended;
    expect(f.frames.map((frame) => frame.data)).toEqual(["A"]);
    expect(Buffer.concat(f.captured)).toEqual(
      Buffer.from([0x41, 0xe4, 0xb8, 0xad, 0xf0, 0x9f, 0x98, 0x80, 0xe4]),
    );
    drainProtocol(f);
    // 最后一个不完整UTF8字符由StringDecoder在EOF生成替换字符，不能丢尾部。
    expect(f.frames.map((frame) => frame.data).join("")).toBe("A中😀�");
    expectOffsets(f);
  } finally {
    f.input.destroy();
  }
});

test("close撤销尚未交付的协议排队，迟到ACK不重放，原始历史采集仍读尽", async () => {
  const f = fixture("stderr");
  try {
    await forceChunk(f.input, "A");
    await forceChunk(f.input, "B");
    expect(f.frames.map((frame) => frame.data)).toEqual(["A"]);
    const ended = once(f.input, "end");
    f.relay.close();
    f.relay.acknowledge(1);
    f.relay.acknowledge(1);
    f.input.end("CD");
    await ended;
    expect(f.frames.map((frame) => frame.data)).toEqual(["A"]);
    expect(Buffer.concat(f.captured).toString()).toBe("ABCD");
    expectOffsets(f);
  } finally {
    f.input.destroy();
  }
});
