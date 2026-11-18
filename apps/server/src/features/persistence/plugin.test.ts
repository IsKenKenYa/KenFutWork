import { expect, it, vi } from "vitest";
import { loadServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import { createStartupPersistenceFixture } from "../../test-startup-persistence.js";
import { persistencePlugin } from "./plugin.js";

it("内核关闭等待数据库释放ACK，关闭失败可重试而不谎报完成", async () => {
  const persistence = createStartupPersistenceFixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const failure = new Error("连接池关闭失败");
  const close = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockImplementationOnce(() => pending);
  const kernel = composePlugins(
    loadServerEnv(
      {
        databaseUrl: "postgres://fixture",
        port: 0,
        webOrigin: "http://localhost",
      },
      {},
    ),
    [persistencePlugin],
    {
      overrides: { persistence: { ...persistence, close } },
    },
  );
  try {
    await expect(kernel.dispose()).rejects.toBe(failure);
    let completed = false;
    const disposing = kernel.dispose().then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(2);
    expect(completed).toBe(false);
    release();
    await disposing;
    expect(completed).toBe(true);
    await kernel.dispose();
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await persistence.close();
  }
});
