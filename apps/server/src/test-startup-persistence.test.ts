import { expect, it } from "vitest";
import { createStartupPersistenceFixture } from "./test-startup-persistence.js";

it("startup fixture显式模拟通知订阅，关闭后不能继续投递或开启发布事务", async () => {
  const persistence = createStartupPersistenceFixture();
  const received: string[] = [];
  const subscription = await persistence.subscribeNotifications(
    "startup_events",
    (payload) => received.push(payload),
  );
  await persistence.execute("select pg_notify($1,$2)", [
    "startup_events",
    "actual-notification",
  ]);
  expect(received).toEqual(["actual-notification"]);
  await subscription.release();
  await persistence.execute("select pg_notify($1,$2)", [
    "startup_events",
    "after-close",
  ]);
  expect(received).toEqual(["actual-notification"]);
  await persistence.close();
  await expect(
    persistence.subscribeNotifications("startup_events", () => {}),
  ).rejects.toThrow("after close");
  await expect(
    persistence.withSessionTransaction(async () => {}),
  ).rejects.toThrow("after close");
});

it("startup fixture owns one Design host lock and releases only that lease", async () => {
  const persistence = createStartupPersistenceFixture();
  try {
    const instance = await persistence.queryOne<{ id: string }>(
      "insert into public.local_instances default values",
    );
    if (!instance) throw new Error("实例初始化夹具未提供真实实例身份");
    const key = `design-goals-host:${instance.id}`;
    const first = await persistence.acquireSessionLock(key);
    if (!first) throw new Error("首个宿主锁应取得租约");
    expect(first.signal.aborted).toBe(false);
    expect(await persistence.acquireSessionLock(key)).toBeNull();
    await first.release();
    expect(first.signal.aborted).toBe(true);
    const next = await persistence.acquireSessionLock(key);
    if (!next) throw new Error("释放后应可重新取得租约");
    await first.release();
    expect(next.signal.aborted).toBe(false);
    expect(await persistence.acquireSessionLock(key)).toBeNull();
    await persistence.close();
    expect(next.signal.aborted).toBe(true);
    await expect(persistence.acquireSessionLock(key)).rejects.toThrow(
      /after close/,
    );
  } finally {
    await persistence.close();
  }
});

it("startup fixture keeps Design tasks empty and rejects unsupported lock keys and writes", async () => {
  const persistence = createStartupPersistenceFixture();
  try {
    await expect(
      persistence.query(
        "select task_id from public.design_task_goals where instance_id=:instance",
      ),
    ).resolves.toEqual([]);
    await expect(
      persistence.queryOne(
        "select count(*) as count from public.project_directory_relink_operations where instance_id=:instance and phase<>'complete'",
      ),
    ).resolves.toEqual({ count: 0 });
    await expect(
      persistence.acquireSessionLock("unsupported-host"),
    ).rejects.toThrow(/未提供数据库操作/);
    await expect(
      persistence.execute("insert into public.design_task_goals values ()"),
    ).rejects.toThrow(/未提供数据库操作/);
  } finally {
    await persistence.close();
  }
});
