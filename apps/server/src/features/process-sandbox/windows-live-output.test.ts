import { expect, test } from "vitest";
import type { ProcessOutputStream } from "./types.js";
import { WindowsLiveOutput } from "./windows-live-output.js";

function fixture(stream?: ProcessOutputStream) {
  const frames: Array<{
    sequence: number;
    data: string;
    offset: number;
    nextOffset: number;
    stream?: ProcessOutputStream;
  }> = [];
  const acks: number[] = [];
  const readers: boolean[] = [];
  const errors: unknown[] = [];
  const output = new WindowsLiveOutput(
    stream,
    async (sequence) => {
      acks.push(sequence);
    },
    async (active) => {
      readers.push(active);
    },
    (error) => {
      errors.push(error);
    },
    (sequence, data, offset, nextOffset, stream) => {
      frames.push({
        sequence,
        data,
        offset,
        nextOffset,
        ...(stream ? { stream } : {}),
      });
    },
  );
  return { output, frames, acks, readers, errors };
}

test("native UTF8空分片先ACK，完整文本等待helper ACK，游标按完整字节", async () => {
  const { output, frames, acks } = fixture("stdout");
  output.receive(1, Buffer.from([0xe4, 0xb8]));
  expect(acks).toEqual([1]);
  expect(frames).toEqual([]);
  output.receive(2, Buffer.from([0xad, 0x0a]));
  expect(frames).toEqual([
    { sequence: 1, data: "中\n", offset: 0, nextOffset: 4, stream: "stdout" },
  ]);
  expect(acks).toEqual([1]);
  await expect(output.acknowledge(2)).rejects.toMatchObject({
    code: "invalid_process_request",
  });
  await output.acknowledge(1);
  await output.acknowledge(1);
  expect(acks).toEqual([1, 2]);
  output.receive(3, Buffer.from("tail"));
  expect(frames[1]).toMatchObject({ sequence: 2, offset: 4, nextOffset: 8 });
});

test("stdout/stderr游标与ACK独立，不能跨流推进", async () => {
  const out = fixture("stdout"),
    err = fixture("stderr");
  out.output.receive(1, Buffer.from("out"));
  err.output.receive(1, Buffer.from("err"));
  await out.output.acknowledge(1);
  expect(out.acks).toEqual([1]);
  expect(err.acks).toEqual([]);
  expect(err.frames[0]).toMatchObject({
    offset: 0,
    nextOffset: 3,
    stream: "stderr",
  });
  expect(() => err.output.receive(2, Buffer.from("lost"))).toThrow(
    "上一帧未 ACK",
  );
  await err.output.acknowledge(1);
  expect(err.acks).toEqual([1]);
});

test("活跃PTY reader保留ANSI尾部；取消reader后的native尾部只进capture", async () => {
  const active = fixture();
  await active.output.setReader(true);
  active.output.receive(1, Buffer.from("ready"));
  await active.output.acknowledge(1);
  active.output.exited();
  active.output.receive(2, Buffer.from("\x1b[31mtail\x1b[0m"));
  expect(active.frames.map((frame) => frame.data).join("")).toBe(
    "ready\x1b[31mtail\x1b[0m",
  );
  expect(active.acks).toEqual([1]);
  const cancelled = fixture();
  cancelled.output.receive(1, Buffer.from("first"));
  cancelled.output.exited();
  cancelled.output.receive(2, Buffer.from("captured"));
  expect(cancelled.frames.map((frame) => frame.data)).toEqual(["first"]);
  expect(cancelled.acks).toEqual([2]);
  await cancelled.output.acknowledge(1);
  expect(cancelled.acks).toEqual([2, 1]);
});

test("EOF刷新不完整UTF8，迟到reader与尾部ACK无需访问已退出controller", async () => {
  const { output, frames, acks, readers } = fixture("stderr");
  output.receive(1, Buffer.from([0xe4]));
  output.end();
  await output.setReader(true);
  expect(frames.map((frame) => frame.data)).toEqual(["�"]);
  await output.acknowledge(1);
  expect(acks).toEqual([1]);
  expect(readers).toEqual([]);
});
