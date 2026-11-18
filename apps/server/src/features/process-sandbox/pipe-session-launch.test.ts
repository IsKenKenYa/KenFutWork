import { ChildProcess } from "node:child_process";
import { Duplex } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { PipeSessionLaunch } from "./pipe-session-launch.js";

const native = vi.hoisted(() => ({ adopt: vi.fn(), stop: vi.fn() }));
vi.mock("./pty-session-range.js", () => ({
  PtySessionRange: { adopt: native.adopt },
}));
const channels: Duplex[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) channel.destroy();
  vi.clearAllMocks();
});

function fixture() {
  const writes: Buffer[] = [];
  const channel = new Duplex({
    read() {},
    write(chunk) {
      writes.push(Buffer.from(chunk));
      // 故意不调用 callback：停止的 wrapper 可能使私有通道背压。
    },
  });
  channel.on("error", () => {});
  channels.push(channel);
  const child = Object.assign(new ChildProcess(), {
    pid: 12345,
    stdio: [null, null, null, channel],
  });
  return { child, channel, writes };
}

test.each(["abort", "deadline"] as const)(
  "放行写回调挂住时 %s 仍能结算启动，并保留已签发范围供停止",
  async (kind) => {
    const f = fixture();
    const range = { stop: native.stop };
    native.adopt.mockResolvedValue(range);
    const controller = new AbortController();
    const launch = new PipeSessionLaunch(
      f.child,
      "trusted-inspector",
      {},
      {
        maxOutputBytes: 65536,
        previewMaxChars: 8000,
        yieldMs: 1,
        killGraceMs: kind === "deadline" ? 30 : 1000,
      },
      { signal: controller.signal },
    );
    const result = launch.ready.then(
      () => ({ success: true }),
      (error: unknown) => ({ error }),
    );
    f.channel.push(
      Buffer.from('{"sessionId":12345,"startSec":100,"startUsec":1}\n'),
    );
    await expect.poll(() => f.writes.length).toBe(1);
    if (kind === "abort")
      controller.abort(new Error("cancel during private write"));
    const guard = new AbortController();
    try {
      await expect(
        Promise.race([
          result,
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ stuck: true }), 150);
            guard.signal.addEventListener("abort", () => clearTimeout(timer), {
              once: true,
            });
          }),
        ]),
      ).resolves.toHaveProperty("error");
      expect(await launch.ownership).toBe(range);
    } finally {
      guard.abort();
      launch.cancel();
    }
  },
);

test.each([
  [
    "其它 PID",
    Buffer.from('{"sessionId":54321,"startSec":100,"startUsec":1}\n'),
  ],
  [
    "额外字段",
    Buffer.from(
      '{"sessionId":12345,"startSec":100,"startUsec":1,"extra":true}\n',
    ),
  ],
  ["非 UTF8", Buffer.from([0xc0, 0xaf, 10])],
  ["非 JSON", Buffer.from("not-json\n")],
  ["超长", Buffer.alloc(1025, 65)],
])("%s 身份帧拒绝启动，不签发范围或写 R", async (_name, frame) => {
  const f = fixture();
  const launch = new PipeSessionLaunch(
    f.child,
    "trusted-inspector",
    {},
    {
      maxOutputBytes: 65536,
      previewMaxChars: 8000,
      yieldMs: 1,
      killGraceMs: 1000,
    },
    {},
  );
  const rejected = expect(launch.ready).rejects.toMatchObject({
    code: "spawn_failed",
  });
  f.channel.push(frame);
  await rejected;
  expect(await launch.ownership).toBeUndefined();
  expect(native.adopt).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
});
