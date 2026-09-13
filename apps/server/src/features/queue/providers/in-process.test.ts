import { describe, expect, it } from "vitest";

import { createInProcessQueue } from "./in-process.js";

const QUEUE = "image_generation_jobs";

/** 可控时钟：vt/延迟都按毫秒推进，避免测试里真的 sleep。 */
function createClock(start = 1_000_000) {
  let current = start;
  return {
    advance: (ms: number) => {
      current += ms;
    },
    now: () => current,
  };
}

describe("进程内队列（桌面 Provider）", () => {
  it("send 返回自增 msg_id；read 按 FIFO 取可见消息并带 vt/read_ct", async () => {
    const clock = createClock();
    const queue = createInProcessQueue({ now: clock.now });

    const first = await queue.send(QUEUE, { job_id: "a" });
    const second = await queue.send(QUEUE, { job_id: "b" });
    expect([first, second]).toEqual([1, 2]);

    const messages = await queue.read<{ job_id: string }>(QUEUE, 60, 10);

    expect(messages.map((m) => m.message.job_id)).toEqual(["a", "b"]);
    expect(messages[0]?.read_ct).toBe(1);
    expect(messages[0]?.msg_id).toBe(1);
    // enqueued_at / vt 是 ISO 串（与 PGMQ 返回形状一致）
    expect(messages[0]?.enqueued_at).toBe(new Date(clock.now()).toISOString());
    expect(messages[0]?.vt).toBe(new Date(clock.now() + 60_000).toISOString());
  });

  it("可见性超时：vt 内不再被读到，到点后重新可见且 read_ct 累加", async () => {
    const clock = createClock();
    const queue = createInProcessQueue({ now: clock.now });
    await queue.send(QUEUE, { job_id: "a" });

    const first = await queue.read(QUEUE, 30, 10);
    expect(first).toHaveLength(1);

    // vt 未到：不可见
    clock.advance(29_000);
    await expect(queue.read(QUEUE, 30, 10)).resolves.toEqual([]);

    // vt 到点：重新可见，read_ct 变 2（消费方据此判重试上限）
    clock.advance(2_000);
    const second = await queue.read(QUEUE, 30, 10);
    expect(second).toHaveLength(1);
    expect(second[0]?.read_ct).toBe(2);
  });

  it("deleteMessage 后不再可见；archive 同样移出可见集（但保留用于诊断）", async () => {
    const clock = createClock();
    const queue = createInProcessQueue({ now: clock.now });
    const deleted = await queue.send(QUEUE, { job_id: "delete-me" });
    const archived = await queue.send(QUEUE, { job_id: "archive-me" });
    const kept = await queue.send(QUEUE, { job_id: "keep" });

    await queue.read(QUEUE, 1, 10);
    expect(await queue.deleteMessage(QUEUE, deleted)).toBe(true);
    expect(await queue.archive(QUEUE, archived)).toBe(true);

    clock.advance(2_000);
    const remaining = await queue.read<{ job_id: string }>(QUEUE, 30, 10);
    expect(remaining.map((m) => m.message.job_id)).toEqual(["keep"]);
    expect(kept).toBeGreaterThan(archived);
  });

  it("deleteMessage / archive / setVisibilityTimeout 对不存在的消息是安全的 no-op", async () => {
    const queue = createInProcessQueue();

    await expect(queue.deleteMessage(QUEUE, 999)).resolves.toBe(false);
    await expect(queue.archive(QUEUE, 999)).resolves.toBe(false);
    await expect(
      queue.setVisibilityTimeout(QUEUE, 999, 10),
    ).resolves.toBeUndefined();
  });

  it("setVisibilityTimeout 续期（心跳）：把 vt 往后推，期间不被重复投递", async () => {
    const clock = createClock();
    const queue = createInProcessQueue({ now: clock.now });
    const msgId = await queue.send(QUEUE, { job_id: "long-task" });
    await queue.read(QUEUE, 10, 1);

    clock.advance(9_000);
    await queue.setVisibilityTimeout(QUEUE, msgId, 30);

    clock.advance(25_000); // 距续期 25s < 30s：仍不可见
    await expect(queue.read(QUEUE, 30, 1)).resolves.toEqual([]);

    clock.advance(6_000); // 累计 31s：到点重新可见
    await expect(queue.read(QUEUE, 30, 1)).resolves.toHaveLength(1);
  });

  it("delaySeconds 让消息先不可见，到点才可读", async () => {
    const clock = createClock();
    const queue = createInProcessQueue({ now: clock.now });
    await queue.send(QUEUE, { job_id: "delayed" }, 60);

    await expect(queue.read(QUEUE, 30, 10)).resolves.toEqual([]);

    clock.advance(60_000);
    await expect(queue.read(QUEUE, 30, 10)).resolves.toHaveLength(1);
  });

  it("readWithPoll：有消息立即返回；无消息等到超时返回空（不抛错）", async () => {
    const queue = createInProcessQueue();

    // 短超时，避免测试真的等 5 秒
    await expect(queue.readWithPoll(QUEUE, 30, 10, 0.1, 5)).resolves.toEqual(
      [],
    );

    await queue.send(QUEUE, { job_id: "now" });
    const immediate = await queue.readWithPoll<{ job_id: string }>(
      QUEUE,
      30,
      5,
      0.1,
      5,
    );
    expect(immediate.map((m) => m.message.job_id)).toEqual(["now"]);
  });

  it("readWithPoll：等待中被投递即被唤醒（不是忙等到超时）", async () => {
    const queue = createInProcessQueue();
    const startedAt = Date.now();

    // 200ms 超时；30ms 后投递 → 应在远小于超时的时间内返回
    const pending = queue.readWithPoll<{ job_id: string }>(QUEUE, 30, 1, 5, 10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await queue.send(QUEUE, { job_id: "woken" });

    const messages = await pending;
    expect(messages.map((m) => m.message.job_id)).toEqual(["woken"]);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("quantity 限制一次取出的条数（并发上限由消费方给定）", async () => {
    const queue = createInProcessQueue();
    for (let i = 0; i < 5; i += 1) {
      await queue.send(QUEUE, { job_id: `job-${i}` });
    }

    const batch = await queue.read(QUEUE, 30, 2);
    expect(batch).toHaveLength(2);

    const rest = await queue.read(QUEUE, 30, 10);
    expect(rest).toHaveLength(3);
  });

  it("不同队列互不干扰", async () => {
    const queue = createInProcessQueue();
    await queue.send("image_generation_jobs", { job_id: "img" });
    await queue.send("video_generation_jobs", { job_id: "vid" });

    const videos = await queue.read<{ job_id: string }>(
      "video_generation_jobs",
      30,
      10,
    );
    expect(videos.map((m) => m.message.job_id)).toEqual(["vid"]);
    await expect(queue.read("code_execution_jobs", 30, 10)).resolves.toEqual(
      [],
    );
  });

  it("shutdown 后投递被拒、等待中的 readWithPoll 立即返回（不吊住进程）", async () => {
    const queue = createInProcessQueue();

    const pending = queue.readWithPoll(QUEUE, 30, 1, 30, 10);
    await queue.shutdown();

    await expect(pending).resolves.toEqual([]);
    await expect(queue.send(QUEUE, { job_id: "after-close" })).rejects.toThrow(
      /已关闭/,
    );
  });
});
