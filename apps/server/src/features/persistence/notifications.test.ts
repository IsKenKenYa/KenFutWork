import { expect, it, vi } from "vitest";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
  type PostgresSessionConnection,
} from "./providers/postgres.js";

function fixture(supportsNotifications = true) {
  let notification: ((channel: string, payload: string) => void) | undefined;
  let loss: ((cause: unknown) => void) | undefined;
  const release = vi.fn(async () => {});
  const query = vi.fn(async (_sql: string, _values: unknown[]) => ({
    rowCount: 1,
    rows: [],
  }));
  const connection: PostgresSessionConnection = {
    query,
    release,
    onLost: (listener) => {
      loss = listener;
      return () => {
        loss = undefined;
      };
    },
    ...(supportsNotifications
      ? {
          onNotification: (
            listener: (channel: string, payload: string) => void,
          ) => {
            notification = listener;
            return () => {
              notification = undefined;
            };
          },
        }
      : {}),
  };
  const runner: PostgresQueryRunner = {
    query,
    acquire: async () => {
      throw new Error("不得占用普通查询池");
    },
    acquireSession: async () => connection,
    end: vi.fn(async () => {}),
  };
  return {
    service: createPersistenceFromRunner(runner),
    release,
    query,
    notify: (channel: string, payload: string) =>
      notification?.(channel, payload),
    lose: () => loss?.(new Error("连接丢失")),
  };
}

it("数据库通知按通道分发，断链后禁止继续投递并释放同一独占连接", async () => {
  const f = fixture();
  const received: string[] = [];
  const subscription = await f.service.subscribeNotifications(
    "canvas_events",
    (payload) => received.push(payload),
  );
  f.notify("other_channel", "foreign");
  f.notify("canvas_events", "actual-job");
  expect(received).toEqual(["actual-job"]);
  expect(f.query).toHaveBeenCalledWith('listen "canvas_events"', []);
  f.lose();
  expect(subscription.signal.aborted).toBe(true);
  f.notify("canvas_events", "late");
  expect(received).toEqual(["actual-job"]);
  await subscription.release();
  await subscription.release();
  await f.service.close();
  expect(f.release).toHaveBeenCalledTimes(1);
});

it("提供方没有通知支持或通道无效时明确拒绝，不返回假订阅", async () => {
  const f = fixture(false);
  await expect(
    f.service.subscribeNotifications("canvas_events", () => {}),
  ).rejects.toThrow("不支持数据库通知");
  expect(f.release).toHaveBeenCalledTimes(1);
  await expect(
    f.service.subscribeNotifications('bad"channel', () => {}),
  ).rejects.toThrow("名称无效");
  await f.service.close();
});

it("专用发布事务使用同连接，断链时回滚而不提交，不占普通pool", async () => {
  const f = fixture();
  await expect(
    f.service.withSessionTransaction(async (tx, signal) => {
      await tx.query("select 1");
      f.lose();
      signal.throwIfAborted();
    }),
  ).rejects.toThrow();
  expect(f.query.mock.calls.map((call) => call[0])).toContain("rollback");
  expect(f.query.mock.calls.map((call) => call[0])).not.toContain("commit");
  expect(f.release).toHaveBeenCalledTimes(1);
  await f.service.close();
});
