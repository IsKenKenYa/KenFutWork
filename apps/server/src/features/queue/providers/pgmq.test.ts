import { beforeEach, expect, it, vi } from "vitest";
import { createPgmqQueue } from "./pgmq.js";

const { Pool, end, on, query } = vi.hoisted(() => {
  const query = vi.fn();
  const end = vi.fn(async () => {});
  const on = vi.fn();
  const Pool = vi.fn(function () {
    return { query, end, on };
  });
  return { Pool, end, on, query };
});

vi.mock("pg", () => ({ default: { Pool } }));

beforeEach(() => {
  query.mockReset();
  end.mockClear();
  on.mockClear();
});

it("关闭期间的长轮询以队列关闭错误结束，重复关闭只结束连接池一次", async () => {
  let resolveQuery: (value: { rows: never[] }) => void = () => {};
  query.mockImplementationOnce(
    () =>
      new Promise<{ rows: never[] }>((resolve) => {
        resolveQuery = resolve;
      }),
  );

  const queue = createPgmqQueue({ databaseUrl: "postgres://test" });
  const pendingRead = queue.readWithPoll("image_generation_jobs", 120, 1);
  await Promise.all([queue.shutdown(), queue.shutdown()]);
  resolveQuery({ rows: [] });

  await expect(pendingRead).rejects.toMatchObject({ code: "queue_closed" });
  await expect(
    queue.readWithPoll("image_generation_jobs", 120, 1),
  ).rejects.toMatchObject({ code: "queue_closed" });
  expect(query).toHaveBeenCalledOnce();
  expect(end).toHaveBeenCalledOnce();
});
