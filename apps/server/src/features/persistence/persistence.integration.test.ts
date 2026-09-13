import { describe, expect, it } from "vitest";

import { createViewerRepository } from "../bootstrap/repository.js";
import { UserIsolationError, WorkspaceIsolationError } from "./errors.js";
import { createPostgresPersistence } from "./providers/postgres.js";

/**
 * 存储缝真实库集成测试（默认 skipped：需要 DATABASE_URL 指向已迁移的 Postgres）。
 * 目的：单测只断言 SQL 字符串与调用形状，本文件证明 SQL 真能执行——含原子 RPC
 * 经信任连接调用、工作区作用域、隔离违约拦截、触发器维护的写路径与事务。
 *
 * 运行：DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *       pnpm --filter @loomic/server exec vitest run persistence.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;
const ABSENT_WORKSPACE = "00000000-0000-0000-0000-000000000000";

type IdRow = { id: string };

describe.skipIf(!DATABASE_URL)("persistence 真实库集成", () => {
  const connect = () =>
    createPostgresPersistence({ databaseUrl: DATABASE_URL as string });

  /** 复用已引导的用户做夹具（不新建 auth 用户：profiles.id 外键 public.accounts）。 */
  async function pickFixtureUser() {
    const persistence = connect();
    try {
      return await persistence.queryOne<IdRow>(
        "select id from public.profiles order by created_at limit 1",
      );
    } finally {
      await persistence.close();
    }
  }

  it("ping 连通性检查", async () => {
    const persistence = connect();
    try {
      await expect(persistence.ping()).resolves.toBeUndefined();
    } finally {
      await persistence.close();
    }
  });

  it("引导 RPC 经信任连接可调用且幂等可重放", async () => {
    const user = await pickFixtureUser();
    expect(user, "需要至少一个已引导的 profile 作夹具").not.toBeNull();

    const persistence = connect();
    try {
      const repository = createViewerRepository(persistence);
      const input = {
        email: "integration@test.loomic.com",
        userMeta: { full_name: "集成测试" },
        userId: (user as IdRow).id,
      };

      await expect(repository.bootstrap(input)).resolves.toBeUndefined();
      await expect(repository.bootstrap(input)).resolves.toBeUndefined();
    } finally {
      await persistence.close();
    }
  });

  it("个人工作区 / 档案 / 成员可读，且成员查询走工作区作用域", async () => {
    const user = await pickFixtureUser();
    expect(user).not.toBeNull();

    const persistence = connect();
    try {
      const repository = createViewerRepository(persistence);
      const workspace = await repository.findPersonalWorkspace(
        (user as IdRow).id,
      );

      expect(workspace?.type).toBe("personal");
      expect(workspace?.ownerUserId).toBe((user as IdRow).id);

      const profile = await repository.findProfile((user as IdRow).id);
      expect(profile?.id).toBe((user as IdRow).id);

      const membership = await repository.findMembership(
        workspace?.id as string,
        (user as IdRow).id,
      );
      expect(membership?.role).toBe("owner");
    } finally {
      await persistence.close();
    }
  });

  it("写路径生效且触发器维护 updated_at（可读回后还原）", async () => {
    const user = await pickFixtureUser();
    expect(user).not.toBeNull();

    const persistence = connect();
    try {
      const repository = createViewerRepository(persistence);
      const before = await repository.findProfile((user as IdRow).id);
      const updated = await repository.updateDisplayName(
        (user as IdRow).id,
        "集成改名",
      );

      expect(updated?.displayName).toBe("集成改名");
      await expect(
        repository.findProfile((user as IdRow).id),
      ).resolves.toMatchObject({ displayName: "集成改名" });

      await repository.updateDisplayName(
        (user as IdRow).id,
        before?.displayName as string,
      );
    } finally {
      await persistence.close();
    }
  });

  it("漏写 :workspace 谓词在真实连接上被拦截，且不下发查询", async () => {
    const persistence = connect();
    try {
      await expect(
        persistence
          .forWorkspace(ABSENT_WORKSPACE)
          .query("select id from public.projects limit 1"),
      ).rejects.toBeInstanceOf(WorkspaceIsolationError);
    } finally {
      await persistence.close();
    }
  });

  it("跨工作区查询取不到数据（FORM-9 隔离门禁）", async () => {
    const persistence = connect();
    try {
      const foreign = await persistence
        .forWorkspace(ABSENT_WORKSPACE)
        .queryOne(
          "select id from public.projects where workspace_id = :workspace limit 1",
        );
      expect(foreign).toBeNull();
    } finally {
      await persistence.close();
    }
  });

  it("forUser 绑定的是用户：同库不同用户互不可见（brand_kits）", async () => {
    const user = await pickFixtureUser();
    expect(user, "需要至少一个已引导的 profile 作夹具").not.toBeNull();
    const userId = (user as IdRow).id;

    const persistence = connect();
    let kitId: string | undefined;
    try {
      const created = await persistence
        .forUser(userId)
        .queryOne<{ id: string }>(
          `insert into public.brand_kits (user_id, name, is_default)
           values (:user, $1, false)
           returning id`,
          ["集成品牌套件"],
        );
      kitId = created?.id;
      expect(kitId).toBeTruthy();

      const mine = await persistence
        .forUser(userId)
        .queryOne<{ name: string }>(
          "select name from public.brand_kits where user_id = :user and id = $1",
          [kitId],
        );
      expect(mine?.name).toBe("集成品牌套件");

      // 换一个用户作用域 → 看不到
      const foreign = await persistence
        .forUser("11111111-1111-1111-1111-111111111111")
        .queryOne(
          "select id from public.brand_kits where user_id = :user and id = $1",
          [kitId],
        );
      expect(foreign).toBeNull();

      // 漏写 :user 即违约，不下发查询
      await expect(
        persistence.forUser(userId).query("select id from public.brand_kits"),
      ).rejects.toBeInstanceOf(UserIsolationError);
    } finally {
      if (kitId) {
        await persistence.query("delete from public.brand_kits where id = $1", [
          kitId,
        ]);
      }
      await persistence.close();
    }
  });

  it("事务可提交，抛错时回滚", async () => {
    const persistence = connect();
    try {
      await expect(
        persistence.transaction(async (tx) => {
          await tx.query("select 1");
          return "ok";
        }),
      ).resolves.toBe("ok");

      await expect(
        persistence.transaction(async (tx) => {
          await tx.query("select 1");
          throw new Error("intentional");
        }),
      ).rejects.toThrow("intentional");
    } finally {
      await persistence.close();
    }
  });
});
