import type { SqlClient } from "../persistence/types.js";
import type { LocalAccessClientRecord, LocalAccessStore } from "./types.js";

type ClientRow = {
  id: string;
  instance_id: string;
  kind: LocalAccessClientRecord["kind"];
  label: string;
  created_at: Date | string;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
};

const COLUMNS =
  "id, instance_id, kind, label, created_at, expires_at, revoked_at";

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function fromRow(row: ClientRow): LocalAccessClientRecord {
  return {
    id: row.id,
    instanceId: row.instance_id,
    kind: row.kind,
    label: row.label,
    createdAt: timestamp(row.created_at),
    expiresAt: row.expires_at === null ? null : timestamp(row.expires_at),
    revokedAt: row.revoked_at === null ? null : timestamp(row.revoked_at),
  };
}

/** 身份建立前的入口查询按实例及凭据哈希精确匹配，不使用尚未建立的 actor。 */
export function createLocalAccessStore(sql: SqlClient): LocalAccessStore {
  return {
    async ensureDesktop(input) {
      const row = await sql.queryOne<ClientRow>(
        `insert into public.local_access_clients
           (id, instance_id, kind, label, token_hash, created_at, expires_at)
         values ($1, $2, 'desktop', $3, $4, $5, null)
         on conflict (token_hash) do update set token_hash = excluded.token_hash
         where local_access_clients.instance_id = excluded.instance_id
           and local_access_clients.kind = 'desktop'
           and local_access_clients.revoked_at is null
           and local_access_clients.expires_at is null
         returning ${COLUMNS}`,
        [
          input.id,
          input.instanceId,
          input.label,
          input.tokenHash,
          input.createdAt,
        ],
      );
      if (!row) throw new Error("本机桌面凭据归属无效或已撤销。");
      return fromRow(row);
    },

    async findActiveByTokenHash(input) {
      const row = await sql.queryOne<ClientRow>(
        `select ${COLUMNS} from public.local_access_clients
          where instance_id = $1 and token_hash = $2 and revoked_at is null
            and (expires_at is null or expires_at > $3)`,
        [input.instanceId, input.tokenHash, input.now],
      );
      return row ? fromRow(row) : null;
    },

    async createAuthorized({ authorizerId, client, now }) {
      const row = await sql.queryOne<ClientRow>(
        `with authorizer as materialized (
           select id from public.local_access_clients
            where instance_id = $1 and id = $2
              and kind in ('desktop', 'browser') and revoked_at is null
              and (expires_at is null or expires_at > $3)
            for update
         )
         insert into public.local_access_clients
           (id, instance_id, kind, label, token_hash, created_at, expires_at)
         select $4, $1, $5, $6, $7, $8, $9 from authorizer
         returning ${COLUMNS}`,
        [
          client.instanceId,
          authorizerId,
          now,
          client.id,
          client.kind,
          client.label,
          client.tokenHash,
          client.createdAt,
          client.expiresAt,
        ],
      );
      return row ? fromRow(row) : null;
    },

    async listAuthorized(input) {
      const rows = await sql.query<ClientRow>(
        `select ${COLUMNS.split(", ")
          .map((column) => `client.${column}`)
          .join(", ")}
           from public.local_access_clients client
           join public.local_access_clients authorizer
             on authorizer.instance_id = client.instance_id
          where client.instance_id = $1 and authorizer.id = $2
            and authorizer.kind in ('desktop', 'browser')
            and authorizer.revoked_at is null
            and (authorizer.expires_at is null or authorizer.expires_at > $3)
          order by client.created_at, client.id`,
        [input.instanceId, input.authorizerId, input.now],
      );
      // 已授权客户端自身也在结果中，因此空结果表示管理授权已失效。
      return rows.length === 0 ? null : rows.map(fromRow);
    },

    async revokeAuthorized(input) {
      const row = await sql.queryOne<{
        status: "revoked" | "missing" | "unauthorized" | "desktop";
      }>(
        `with locked as materialized (
           select id, kind, expires_at, revoked_at from public.local_access_clients
            where instance_id = $1 and id in ($2, $3)
            order by id for update
         ), authorizer as (
           select id from locked where id = $2
             and kind in ('desktop', 'browser') and revoked_at is null
             and (expires_at is null or expires_at > $4)
         ), revoked as (
           update public.local_access_clients
              set revoked_at = coalesce(revoked_at, $4)
            where instance_id = $1 and id = $3 and kind <> 'desktop'
              and exists (select 1 from authorizer)
           returning id
         )
         select case
           when not exists (select 1 from authorizer) then 'unauthorized'
           when exists (select 1 from locked where id = $3 and kind = 'desktop')
             then 'desktop'
           when exists (select 1 from revoked) then 'revoked'
           else 'missing' end as status`,
        [input.instanceId, input.authorizerId, input.clientId, input.now],
      );
      if (!row) throw new Error("撤销本机接入凭据未返回结果。");
      return row.status;
    },
  };
}
