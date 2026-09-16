import { Client } from "pg";
import { loadServerEnv } from "./config/env.js";
import { hashPassword } from "./features/auth/password.js";

/**
 * 为既有账号设置自管认证口令（M1.4 切换用）。
 *
 * 存量账号（`public.accounts` 里的那些）没有我们自己的口令凭据，切到
 * `KENFUTWORK_AUTH_DRIVER=local` 后无法登录。本脚本按邮箱把口令哈希写进
 * `account_credentials`（存在则覆盖，即重置口令）。
 *
 *   pnpm --filter @kenfutwork/server auth:seed -- <邮箱>=<口令> [<邮箱>=<口令> …]
 *   pnpm --filter @kenfutwork/server auth:seed -- --all-test-accounts <口令>
 *
 * 明文口令只在命令行出现，不落日志、不进数据库（库里只有 scrypt 哈希）。
 */
const TEST_ACCOUNT_EMAILS = [
  "free@test.kenfutwork.com",
  "integration@test.kenfutwork.com",
  "pro@test.kenfutwork.com",
  "starter@test.kenfutwork.com",
  "ultra@test.kenfutwork.com",
];

async function main(): Promise<void> {
  const env = loadServerEnv();
  const databaseUrl = env.databaseUrl;
  if (!databaseUrl) {
    console.error("缺少数据库连接串（KENFUTWORK_DATABASE_URL 或 DATABASE_URL）。");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const assignments: Array<{ email: string; password: string }> = [];

  if (args[0] === "--all-test-accounts") {
    const password = args[1];
    if (!password) {
      console.error("用法：auth:seed -- --all-test-accounts <口令>");
      process.exit(1);
    }
    for (const email of TEST_ACCOUNT_EMAILS) {
      assignments.push({ email, password });
    }
  } else {
    for (const arg of args) {
      const separator = arg.indexOf("=");
      if (separator <= 0) {
        console.error(`参数格式应为 <邮箱>=<口令>，收到：${arg}`);
        process.exit(1);
      }
      assignments.push({
        email: arg.slice(0, separator),
        password: arg.slice(separator + 1),
      });
    }
  }

  if (assignments.length === 0) {
    console.error(
      "用法：auth:seed -- <邮箱>=<口令> … 或 auth:seed -- --all-test-accounts <口令>",
    );
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    for (const { email, password } of assignments) {
      const account = await client.query<{ id: string }>(
        "select id from public.accounts where lower(email::text) = lower($1)",
        [email],
      );
      const userId = account.rows[0]?.id;
      if (!userId) {
        console.warn(`跳过（账号不存在）：${email}`);
        continue;
      }

      const passwordHash = await hashPassword(password);
      await client.query(
        `insert into public.account_credentials (user_id, password_hash)
         values ($1, $2)
         on conflict (user_id)
         do update set password_hash = excluded.password_hash,
                       password_updated_at = now()`,
        [userId, passwordHash],
      );
      console.log(`已设置口令：${email}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("[auth:seed] 失败：", error);
  process.exit(1);
});
