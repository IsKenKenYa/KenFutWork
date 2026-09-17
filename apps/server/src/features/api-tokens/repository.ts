import { createHash } from "node:crypto";

import type { PersistenceService } from "../persistence/types.js";

/**
 * 外部应用访问令牌的数据访问（`public.api_tokens`，R5-2「外部应用授权」）。
 *
 * 一条令牌 = 一个工作区里的一把 API 凭据：明文只在创建时回一次，库里只存 sha256；
 * 吊销是**即时**的（`revoked_at`），校验查询本身就带 `revoked_at is null`。
 */
export interface ApiTokenRecord {
  id: string;
  name: string;
  /** 明文中前 12 位（`kfw_` + 8 位），供界面辨认。 */
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** 用令牌换登录身份时需要的账号信息（与 `AuthenticatedUser` 同源）。 */
export interface ApiTokenAccount {
  userId: string;
  email: string;
  userMetaData: Record<string, unknown>;
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 明文前 12 位；不足则原样（创建时长度由服务层保证，这里只是兜底）。 */
export function apiTokenPrefix(token: string): string {
  return token.slice(0, 12);
}

export interface ApiTokenRepository {
  create(input: {
    workspaceId: string;
    userId: string;
    name: string;
    tokenHash: string;
    tokenPrefix: string;
  }): Promise<ApiTokenRecord>;
  list(workspaceId: string): Promise<ApiTokenRecord[]>;
  /** 吊销（属主/工作区校验在同一语句里；命中返回 true）。 */
  revoke(workspaceId: string, id: string): Promise<boolean>;
  /** 用令牌哈希换账号：**只认未吊销**的令牌，命中即刷新 `last_used_at`。 */
  findAccountByTokenHash(tokenHash: string): Promise<ApiTokenAccount | null>;
}

type TokenRow = {
  id: string;
  name: string;
  token_prefix: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
  revoked_at: Date | string | null;
};

function toRecord(row: TokenRow): ApiTokenRecord {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    createdAt: toIso(row.created_at),
    lastUsedAt: row.last_used_at ? toIso(row.last_used_at) : null,
    revokedAt: row.revoked_at ? toIso(row.revoked_at) : null,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const TOKEN_COLUMNS =
  "id, name, token_prefix, created_at, last_used_at, revoked_at";

export function createApiTokenRepository(
  persistence: PersistenceService,
): ApiTokenRepository {
  return {
    async create(input) {
      const row = await persistence
        .forWorkspace(input.workspaceId)
        .queryOne<TokenRow>(
          `insert into public.api_tokens
             (workspace_id, user_id, name, token_hash, token_prefix)
           values (:workspace, $1, $2, $3, $4)
           returning ${TOKEN_COLUMNS}`,
          [input.userId, input.name, input.tokenHash, input.tokenPrefix],
        );
      if (!row) throw new Error("api token insert returned no row");
      return toRecord(row);
    },

    async list(workspaceId) {
      const rows = await persistence.forWorkspace(workspaceId).query<TokenRow>(
        `select ${TOKEN_COLUMNS}
             from public.api_tokens
            where workspace_id = :workspace
            order by created_at desc`,
      );
      return rows.map(toRecord);
    },

    async revoke(workspaceId, id) {
      const affected = await persistence.forWorkspace(workspaceId).execute(
        `update public.api_tokens
              set revoked_at = now()
            where id = $1
              and workspace_id = :workspace
              and revoked_at is null`,
        [id],
      );
      return affected > 0;
    },

    async findAccountByTokenHash(tokenHash) {
      // 命中即刷新 last_used_at（与账号会话同一手法：一条语句，不额外往返）
      const row = await persistence.queryOne<{
        user_id: string;
        email: string;
        raw_user_meta_data: unknown;
      }>(
        `update public.api_tokens t
            set last_used_at = now()
           from public.accounts a
          where t.token_hash = $1
            and t.revoked_at is null
            and a.id = t.user_id
        returning a.id as user_id,
                  a.email,
                  a.raw_user_meta_data`,
        [tokenHash],
      );
      if (!row) return null;
      return {
        userId: row.user_id,
        email: row.email,
        userMetaData:
          typeof row.raw_user_meta_data === "object" &&
          row.raw_user_meta_data !== null
            ? (row.raw_user_meta_data as Record<string, unknown>)
            : {},
      };
    },
  };
}
