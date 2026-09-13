import { describe, expect, it } from "vitest";

import { createPostgresPersistence } from "./providers/postgres.js";

/**
 * Schema 中性化不变量（M2.1）真实库集成测试。默认 skipped：需要 DATABASE_URL。
 *
 * 为什么需要它：迁移文件不可改（immutable），文件计数式的棘轮口径永远只能看到历史
 * 残留（auth.uid() 78 处、auth.users 外键 15 表…… 都在历史迁移里）。**权威口径是
 * 「迁移序列执行完后的库内状态」**——这里把它写成断言，中性化一旦被回退就立刻红灯。
 *
 * 运行：DATABASE_URL=postgres://... pnpm --filter @loomic/server exec vitest run schema-neutralization.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;

type CountRow = { count: string };

describe.skipIf(!DATABASE_URL)("schema 中性化不变量", () => {
  it("策略、RLS、auth/private 函数、auth.users 外键、库内云 URL 全部归零", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const count = async (sql: string, params?: readonly unknown[]) => {
        const row = await persistence.queryOne<CountRow>(sql, params);
        return Number(row?.count ?? "-1");
      };

      // 1. 策略：public/storage 下一条不留
      expect(
        await count(
          "select count(*)::text as count from pg_policies where schemaname in ('public', 'storage')",
        ),
      ).toBe(0);

      // 2. RLS：表上还开着 RLS 但没有策略 = 非 owner 角色读 0 行（静默故障），
      //    所以中性化必须同时关掉 RLS，不能只删策略。
      expect(
        await count(
          `select count(*)::text as count
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ('public', 'storage', 'langgraph')
              and c.relkind = 'r'
              and c.relrowsecurity`,
        ),
      ).toBe(0);

      // 3. auth 与 private schema 的自有函数清零（auth schema 由供给前导建出）
      expect(
        await count(
          `select count(*)::text as count
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('auth', 'private')`,
        ),
      ).toBe(0);

      // 4. 外键指向自管账号表，不再指向 auth.users
      expect(
        await count(
          `select count(*)::text as count
             from pg_constraint
            where contype = 'f' and confrelid = to_regclass('auth.users')`,
        ),
      ).toBe(0);
      expect(
        await count(
          `select count(*)::text as count
             from pg_constraint
            where contype = 'f' and confrelid = to_regclass('public.accounts')`,
        ),
      ).toBeGreaterThan(0);

      // 5. auth.users 已是 public.accounts 之上的兼容视图（可自动更新，故不会两表漂移）
      const usersKind = await persistence.queryOne<{ kind: string }>(
        `select relkind::text as kind from pg_class where oid = to_regclass('auth.users')`,
      );
      expect(usersKind?.kind).toBe("v");

      // 6. 库内数据不再含云端 URL（惰性残留会随自托管部署被带到用户机器上）
      const residual = await persistence.query<{
        column_name: string;
        table_name: string;
      }>(
        `select c.table_name, c.column_name
           from information_schema.columns c
           join information_schema.tables t
             on t.table_schema = c.table_schema and t.table_name = c.table_name
          where c.table_schema = 'public'
            and t.table_type = 'BASE TABLE'
            and c.data_type in ('text', 'character varying', 'jsonb', 'json')
          order by c.table_name, c.column_name`,
      );

      const offenders: string[] = [];
      for (const column of residual) {
        const table = `public."${column.table_name}"`;
        const col = `"${column.column_name}"`;
        const hits = await count(
          `select count(*)::text as count from ${table} where ${col}::text like '%supabase.co%'`,
        );
        if (hits > 0) {
          offenders.push(`${column.table_name}.${column.column_name}=${hits}`);
        }
      }
      expect(offenders).toEqual([]);
    } finally {
      await persistence.close();
    }
  });
});
