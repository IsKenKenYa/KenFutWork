import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { createLocalInstanceRepository } from "../local-instance/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import type { SqlClient } from "../persistence/types.js";
import { generateLocalAccessToken } from "./desktop-token.js";
import { hashLocalAccessToken } from "./service.js";
import { createLocalAccessStore } from "./store.js";
import type { LocalAccessClientInput } from "./types.js";

// 仅显式指定独占测试库时执行；不借用开发或生产 DATABASE_URL。
const databaseUrl = process.env.LOCAL_ACCESS_INTEGRATION_DATABASE_URL;

async function waitForBlockedMint(sql: SqlClient) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const row = await sql.queryOne<{ blocked: boolean }>(
      `select exists (
         select 1 from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query like '%with authorizer as materialized%'
       ) as blocked`,
    );
    if (row?.blocked) return;
    await setTimeout(10);
  }
  throw new Error("未观察到等待授权客户端行锁的签发操作。");
}

describe.skipIf(!databaseUrl)("本机接入真实Postgres存储", () => {
  it("幂等桌面、实例隔离、撤销、行锁first-wins及双向撤销均成立", async () => {
    if (!databaseUrl) throw new Error("需要独占本机接入测试数据库。");
    const sql = createPostgresPersistence({ databaseUrl });
    const blocker = new Client({ connectionString: databaseUrl });
    const ownedIds: string[] = [];
    let instanceId = "";
    const store = createLocalAccessStore(sql);
    const input = (
      kind: LocalAccessClientInput["kind"],
    ): LocalAccessClientInput => {
      const id = randomUUID();
      ownedIds.push(id);
      return {
        id,
        instanceId,
        kind,
        label: `接入测试-${id}`,
        tokenHash: hashLocalAccessToken(generateLocalAccessToken()),
        createdAt: new Date(),
        expiresAt: null,
      };
    };
    let inTransaction = false;
    try {
      instanceId = await createLocalInstanceRepository(sql).ensure();
      const desktopInput = input("desktop");
      const desktop = await store.ensureDesktop(desktopInput);
      expect(
        await store.ensureDesktop({ ...desktopInput, id: randomUUID() }),
      ).toEqual(desktop);
      const browserInput = input("browser");
      const browser = await store.createAuthorized({
        authorizerId: desktop.id,
        client: browserInput,
        now: new Date(),
      });
      if (!browser) throw new Error("浏览器签发失败");
      const apiInput = input("api");
      const api = await store.createAuthorized({
        authorizerId: browser.id,
        client: apiInput,
        now: new Date(),
      });
      if (!api) throw new Error("脚本签发失败");
      expect(
        (
          await store.findActiveByTokenHash({
            instanceId,
            tokenHash: apiInput.tokenHash,
            now: new Date(),
          })
        )?.id,
      ).toBe(api.id);
      const wrongInstance = randomUUID();
      expect(
        await store.findActiveByTokenHash({
          instanceId: wrongInstance,
          tokenHash: apiInput.tokenHash,
          now: new Date(),
        }),
      ).toBeNull();
      expect(
        await store.createAuthorized({
          authorizerId: desktop.id,
          client: { ...input("api"), instanceId: wrongInstance },
          now: new Date(),
        }),
      ).toBeNull();
      expect(
        await store.listAuthorized({
          instanceId: wrongInstance,
          authorizerId: desktop.id,
          now: new Date(),
        }),
      ).toBeNull();
      expect(
        await store.listAuthorized({
          instanceId,
          authorizerId: api.id,
          now: new Date(),
        }),
      ).toBeNull();
      expect(
        await store.revokeAuthorized({
          instanceId,
          authorizerId: desktop.id,
          clientId: desktop.id,
          now: new Date(),
        }),
      ).toBe("desktop");
      expect(
        await store.revokeAuthorized({
          instanceId,
          authorizerId: desktop.id,
          clientId: api.id,
          now: new Date(),
        }),
      ).toBe("revoked");
      expect(
        await store.findActiveByTokenHash({
          instanceId,
          tokenHash: apiInput.tokenHash,
          now: new Date(),
        }),
      ).toBeNull();

      // 尚未提交的撤权持有行锁；等待它的签发必须读取提交后的撤权状态。
      await blocker.connect();
      await blocker.query("begin");
      inTransaction = true;
      await blocker.query(
        "update public.local_access_clients set revoked_at = now() where instance_id = $1 and id = $2",
        [instanceId, browser.id],
      );
      const delayedInput = input("api");
      const pending = store.createAuthorized({
        authorizerId: browser.id,
        client: delayedInput,
        now: new Date(),
      });
      // 先挂上拒绝处理，确保后续测试异常时不会留下unhandled rejection。
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await waitForBlockedMint(sql);
      await blocker.query("commit");
      inTransaction = false;
      expect(await outcome).toEqual({ value: null });
      expect(
        await store.findActiveByTokenHash({
          instanceId,
          tokenHash: delayedInput.tokenHash,
          now: new Date(),
        }),
      ).toBeNull();

      const first = await store.createAuthorized({
        authorizerId: desktop.id,
        client: input("browser"),
        now: new Date(),
      });
      const second = await store.createAuthorized({
        authorizerId: desktop.id,
        client: input("browser"),
        now: new Date(),
      });
      if (!first || !second) throw new Error("并发撤销夹具创建失败");
      const reversed = await Promise.all([
        store.revokeAuthorized({
          instanceId,
          authorizerId: first.id,
          clientId: second.id,
          now: new Date(),
        }),
        store.revokeAuthorized({
          instanceId,
          authorizerId: second.id,
          clientId: first.id,
          now: new Date(),
        }),
      ]);
      expect(reversed.sort()).toEqual(["revoked", "unauthorized"]);
    } finally {
      if (inTransaction) await blocker.query("rollback");
      await blocker.end();
      try {
        if (instanceId) {
          await sql.execute(
            "delete from public.local_access_clients where instance_id = $1 and id = any($2::uuid[])",
            [instanceId, ownedIds],
          );
        }
      } finally {
        await sql.close();
      }
    }
  });
});
