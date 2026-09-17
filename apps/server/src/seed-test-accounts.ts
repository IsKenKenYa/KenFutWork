import { loadServerEnv } from "./config/env.js";
import { hashPassword } from "./features/auth/password.js";
import { createAccountRepository } from "./features/auth/repository.js";
import type { AuthenticatedUser } from "./features/auth/types.js";
import { createViewerService } from "./features/bootstrap/ensure-user-foundation.js";
import { createViewerRepository } from "./features/bootstrap/repository.js";
import { createPostgresPersistence } from "./features/persistence/providers/postgres.js";

/**
 * 灌测试账号（自管 Postgres）。
 *
 * 取代原先基于 Supabase SDK 的 `scripts/seed-test-accounts.mjs`——去 Supabase 后
 * 那个脚本所需的 `SUPABASE_*` 变量已不存在，`pnpm seed` 实际是坏的，README 里
 * 承诺的账号在库里也不存在。
 *
 *   pnpm seed                       # 用内置品牌账号表
 *   pnpm seed -- <邮箱>=<口令> …     # 指定账号（同样补齐工作区/额度）
 *
 * 幂等：账号已存在则**重置口令**，不重复建；工作区/额度存在即跳过。
 * 口令只以 scrypt 哈希落库，明文只在命令行出现，不进日志。
 *
 * 品牌口径：账号域名与口令都随当前品牌（KenFutWork），不再沿用 KenFutWork。
 * 若需改动品牌，改这一处即可（README 的账号表与之一致）。
 */
/**
 * 测试账号口令：可用 `KENFUTWORK_TEST_ACCOUNT_PASSWORD` 覆盖（云端部署应显式设置，
 * 不要沿用公开的缺省值）。
 */
export const TEST_PASSWORD =
  process.env.KENFUTWORK_TEST_ACCOUNT_PASSWORD?.trim() || "kenfutwork";
export const TEST_ACCOUNT_DOMAIN = "test.kenfutwork.com";

/**
 * 管理员账号：云端的第一个管理员由环境变量给出，不写死在代码/文档里。
 *
 * - `KENFUTWORK_ADMIN_EMAIL`（缺省 `admin@kenfutwork.local`）
 * - `KENFUTWORK_ADMIN_PASSWORD`：**给了才会创建/提升该账号为 admin**（幂等：已存在则重置口令 + 置角色）
 *
 * 不给口令就跳过——本地开发沿用既有账号即可，不会凭空多出一个公开口令的管理员。
 */
export function readAdminSeed(env: NodeJS.ProcessEnv = process.env): {
  email: string;
  password: string;
} | null {
  const password = env.KENFUTWORK_ADMIN_PASSWORD?.trim();
  if (!password) return null;
  const email = env.KENFUTWORK_ADMIN_EMAIL?.trim() || "admin@kenfutwork.local";
  return { email, password };
}

const TEST_ACCOUNTS: Array<{ credits: number; email: string; plan: string }> = [
  { email: `free@${TEST_ACCOUNT_DOMAIN}`, plan: "free", credits: 50 },
  { email: `starter@${TEST_ACCOUNT_DOMAIN}`, plan: "starter", credits: 1_200 },
  { email: `pro@${TEST_ACCOUNT_DOMAIN}`, plan: "pro", credits: 5_000 },
  { email: `ultra@${TEST_ACCOUNT_DOMAIN}`, plan: "ultra", credits: 15_000 },
];

function parseAssignments(args: string[]): Array<{
  credits: number;
  email: string;
  plan: string;
}> {
  if (args.length === 0) {
    return TEST_ACCOUNTS;
  }
  return args.map((arg) => {
    const separator = arg.indexOf("=");
    if (separator <= 0) {
      console.error(`参数格式应为 <邮箱>=<口令>，收到：${arg}`);
      process.exit(1);
    }
    return {
      credits: 0,
      email: arg.slice(0, separator),
      plan: "free",
    };
  });
}

function parsePasswords(args: string[]): Map<string, string> {
  const passwords = new Map<string, string>();
  for (const arg of args) {
    const separator = arg.indexOf("=");
    if (separator <= 0) continue;
    passwords.set(
      arg.slice(0, separator).toLowerCase(),
      arg.slice(separator + 1),
    );
  }
  return passwords;
}

async function main(): Promise<void> {
  const env = loadServerEnv();
  const databaseUrl = env.databaseUrl;
  if (!databaseUrl) {
    console.error(
      "缺少数据库连接串（KENFUTWORK_DATABASE_URL 或 DATABASE_URL）。",
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const accounts = parseAssignments(args);
  const passwords = parsePasswords(args);

  const persistence = createPostgresPersistence({ databaseUrl });
  const accountRepository = createAccountRepository(persistence);
  const viewerService = createViewerService({
    repository: createViewerRepository(persistence),
  });

  // 管理员账号（云端首次部署用）：`KENFUTWORK_ADMIN_PASSWORD` 给了才做，幂等
  const adminSeed = readAdminSeed();
  if (
    adminSeed &&
    !accounts.some(
      (account) =>
        account.email.toLowerCase() === adminSeed.email.toLowerCase(),
    )
  ) {
    accounts.push({ credits: 0, email: adminSeed.email, plan: "ultra" });
    passwords.set(adminSeed.email.toLowerCase(), adminSeed.password);
  }

  for (const account of accounts) {
    const password =
      passwords.get(account.email.toLowerCase()) ?? TEST_PASSWORD;
    const passwordHash = await hashPassword(password);

    let user: AuthenticatedUser | null = null;
    try {
      const userId = await accountRepository.createAccount({
        displayName: null,
        email: account.email,
        passwordHash,
      });
      user = {
        accessToken: "",
        email: account.email,
        id: userId,
        userMetadata: {},
      };
      console.log(`已创建账号：${account.email}`);
    } catch {
      // 已存在：重置口令（幂等重跑/改口令都走这里）
      const existing = await accountRepository.findAccountByEmail(
        account.email,
      );
      if (!existing) {
        console.error(`账号既建不出来也读不到，跳过：${account.email}`);
        continue;
      }
      user = {
        accessToken: "",
        email: account.email,
        id: existing.user_id,
        userMetadata: {},
      };
      await persistence.query(
        `insert into public.account_credentials (user_id, password_hash)
         values ($1, $2)
         on conflict (user_id)
         do update set password_hash = excluded.password_hash,
                       password_updated_at = now()`,
        [existing.user_id, passwordHash],
      );
      console.log(`已存在，重置口令：${account.email}`);
    }

    // 工作区/个人资料走与线上同一条供给路径（不复制一遍 provisioning 逻辑）
    const viewer = await viewerService.ensureViewer(user);
    const workspaceId = viewer.workspace.id;

    if (account.credits > 0) {
      await persistence.query(
        `insert into public.credit_balances (workspace_id, balance)
         values ($1, $2)
         on conflict (workspace_id) do nothing`,
        [workspaceId, account.credits],
      );
    }
    await persistence.query(
      `insert into public.subscriptions (workspace_id, plan)
       values ($1, $2::subscription_plan)
       on conflict (workspace_id)
       do update set plan = excluded.plan, updated_at = now()`,
      [workspaceId, account.plan],
    );

    // 管理员：由环境变量指定的那个账号提升为平台管理员（幂等）
    if (
      adminSeed &&
      account.email.toLowerCase() === adminSeed.email.toLowerCase()
    ) {
      await persistence.query(
        `update public.profiles set role = 'admin' where id = $1`,
        [user.id],
      );
      console.log(`已置为平台管理员：${account.email}`);
    }
    console.log(
      `  工作区 ${workspaceId}｜套餐 ${account.plan}｜额度 ${account.credits}`,
    );
  }

  console.log(
    `\n完成。内置口令：${TEST_PASSWORD}（账号域名 ${TEST_ACCOUNT_DOMAIN}）`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("[seed:accounts] 失败：", error);
    process.exit(1);
  });
