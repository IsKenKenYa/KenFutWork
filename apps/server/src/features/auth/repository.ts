import { createHash } from "node:crypto";

import type { PersistenceService } from "../persistence/types.js";

/**
 * 自管认证的数据访问（`auth.users` + `account_credentials` + `account_sessions`）。
 *
 * **为什么不用 `:user`/`:workspace` 谓词**：登录、会话校验发生在**身份建立之前**
 * （此时还不知道用户是谁），谓词无从施加。归属由行自身携带（`user_id`），越权面由
 * 「令牌不可猜 + 只按令牌哈希精确匹配 + 按邮箱精确取一行」控制——**没有任何列表扫描**，
 * 故不存在「读到别人数据」的查询形态。这是 `FORM-9` 的例外，理由记录于此与 §4.13。
 */

export type AccountRecord = {
  display_name: string | null;
  email: string;
  password_hash: string;
  user_id: string;
};

export type SessionAccount = {
  email: string;
  expires_at: string;
  raw_user_meta_data: Record<string, unknown> | null;
  user_id: string;
};

export class EmailTakenError extends Error {
  constructor() {
    super("该邮箱已被注册。");
    this.name = "EmailTakenError";
  }
}

/** 会话默认有效期：30 天（桌面/自托管单用户场景，长会话更合适）。 */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface AccountRepository {
  /** 按邮箱取账号（含口令哈希）；不存在返回 null。邮箱比较不区分大小写。 */
  findAccountByEmail(email: string): Promise<AccountRecord | null>;
  /** 建账号（`auth.users` + 凭据，同一事务）；邮箱已存在抛 `EmailTakenError`。 */
  createAccount(input: {
    displayName: string | null;
    email: string;
    passwordHash: string;
  }): Promise<string>;
  /** 覆盖口令哈希（如种子脚本重置测试账号）。 */
  setPasswordHash(userId: string, passwordHash: string): Promise<number>;
  /** 建会话；tokenHash 是明文令牌的 SHA-256。 */
  createSession(input: {
    expiresAt: Date;
    tokenHash: string;
    userId: string;
  }): Promise<string>;
  /** 按令牌哈希取会话 + 账号（未过期）；同时刷新 last_used_at。 */
  findSessionByTokenHash(tokenHash: string): Promise<SessionAccount | null>;
  /** 删除会话（登出）；返回受影响行数。 */
  deleteSession(tokenHash: string): Promise<number>;
  /** 清理过期会话；返回清理条数。 */
  deleteExpiredSessions(now: Date): Promise<number>;
}

export function createAccountRepository(
  persistence: PersistenceService,
): AccountRepository {
  return {
    async findAccountByEmail(email) {
      const row = await persistence.queryOne<AccountRecord>(
        `select u.id as user_id,
                u.email,
                u.raw_user_meta_data -> 'display_name' as display_name,
                c.password_hash
           from auth.users u
           join public.account_credentials c on c.user_id = u.id
          where lower(u.email::text) = lower($1)`,
        [email],
      );
      return row ?? null;
    },

    async createAccount(input) {
      return persistence.transaction(async (tx) => {
        const existing = await tx.queryOne<{ id: string }>(
          "select id from auth.users where lower(email::text) = lower($1)",
          [input.email],
        );
        if (existing) {
          throw new EmailTakenError();
        }

        // `id` 显式取值：Supabase 供给的 auth.users 里 id **没有列默认值**（实测
        // `null value in column "id"`），只有供给前导物化的那张才有。显式生成在两种
        // 形态下都成立，不依赖列默认。
        const created = await tx.queryOne<{ id: string }>(
          `insert into auth.users (id, email, raw_user_meta_data)
           values (extensions.gen_random_uuid(), $1,
                   jsonb_build_object('display_name', $2::text))
           returning id`,
          [input.email, input.displayName],
        );
        if (!created) {
          throw new Error("建账号未返回行。");
        }

        await tx.query(
          `insert into public.account_credentials (user_id, password_hash)
           values ($1, $2)`,
          [created.id, input.passwordHash],
        );

        return created.id;
      });
    },

    async setPasswordHash(userId, passwordHash) {
      return persistence.execute(
        `insert into public.account_credentials (user_id, password_hash, password_updated_at)
         values ($1, $2, now())
         on conflict (user_id)
         do update set password_hash = excluded.password_hash,
                       password_updated_at = now()`,
        [userId, passwordHash],
      );
    },

    async createSession(input) {
      const row = await persistence.queryOne<{ id: string }>(
        `insert into public.account_sessions (user_id, token_hash, expires_at)
         values ($1, $2, $3)
         returning id`,
        [input.userId, input.tokenHash, input.expiresAt],
      );
      if (!row) {
        throw new Error("建会话未返回行。");
      }
      return row.id;
    },

    async findSessionByTokenHash(tokenHash) {
      // 命中即刷新 last_used_at（同一语句，避免多一次往返）
      const row = await persistence.queryOne<SessionAccount>(
        `update public.account_sessions s
            set last_used_at = now()
           from auth.users u
          where s.token_hash = $1
            and s.expires_at > now()
            and u.id = s.user_id
        returning u.id as user_id,
                  u.email,
                  u.raw_user_meta_data,
                  s.expires_at`,
        [tokenHash],
      );
      return row ?? null;
    },

    async deleteSession(tokenHash) {
      return persistence.execute(
        "delete from public.account_sessions where token_hash = $1",
        [tokenHash],
      );
    },

    async deleteExpiredSessions(now) {
      return persistence.execute(
        "delete from public.account_sessions where expires_at <= $1",
        [now],
      );
    },
  };
}
