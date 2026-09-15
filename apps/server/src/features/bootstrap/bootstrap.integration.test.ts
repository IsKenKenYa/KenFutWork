import { describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../auth/types.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createViewerService } from "./ensure-user-foundation.js";
import { createViewerRepository } from "./repository.js";

/**
 * viewer 引导（profile + 个人工作区 + owner 成员）真实库集成测试。
 * 默认 skipped：需要 DATABASE_URL。
 *
 * 目的：`/api/viewer` 与 `/api/workspaces/skills` 的 500 之所以能躲过 53 项集成测试，
 * 是因为没有任何用例真的跑过引导写路径（原 `public.bootstrap_viewer` RPC 依赖
 * 被删的 `private.bootstrap_user_foundation`，PL/pgSQL 运行期才报错）。
 * 这里用真库把该路径锁死：SQL 与真 schema 不匹配、引导后的读取口径不对，
 * `ensureViewer` 都会抛 BootstrapError 而失败。
 *
 * 运行：DATABASE_URL=postgres://... pnpm --filter @kenfutwork/server exec vitest run bootstrap.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("viewer 引导真实库集成", () => {
  it("首次引导建 profile + 个人工作区 + owner 成员，重复引导幂等且并发安全", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `bootstrap-${suffix}@integration.test`;
    let userId: string | undefined;

    try {
      const account = await persistence.queryOne<{ id: string }>(
        `insert into public.accounts (id, email, raw_user_meta_data)
         values (extensions.gen_random_uuid(), $1, jsonb_build_object('display_name', $2::text))
         returning id`,
        [email, `引导用户 ${suffix}`],
      );
      userId = account?.id;
      expect(userId).toBeTruthy();

      const user: AuthenticatedUser = {
        accessToken: "integration-token",
        email,
        id: userId as string,
        userMetadata: { display_name: `引导用户 ${suffix}` },
      };
      const service = createViewerService({
        repository: createViewerRepository(persistence),
      });

      const first = await service.ensureViewer(user);
      expect(first.workspace.type).toBe("personal");
      expect(first.profile.email).toBe(email);
      expect(first.membership.role).toBe("owner");

      // 并发重放：唯一索引 + on conflict 保证仍只有一个个人工作区
      const concurrent = await Promise.all([
        service.ensureViewer(user),
        service.ensureViewer(user),
      ]);
      expect(concurrent.map((viewer) => viewer.workspace.id)).toEqual([
        first.workspace.id,
        first.workspace.id,
      ]);

      const workspaces = await persistence.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [userId],
      );
      expect(workspaces).toHaveLength(1);

      const memberships = await persistence.query<{ count: string }>(
        "select count(*)::text as count from public.workspace_members where user_id = $1",
        [userId],
      );
      expect(memberships[0]?.count).toBe("1");
    } finally {
      if (userId) {
        // profiles/workspaces/workspace_members 均 ON DELETE CASCADE 到 accounts
        await persistence.execute("delete from public.accounts where id = $1", [
          userId,
        ]);
      }
      await persistence.close();
    }
  });
});
