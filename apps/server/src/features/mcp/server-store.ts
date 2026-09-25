import type { PersistenceService } from "../persistence/types.js";

/**
 * MCP server 配置存储（`mcp_servers` 单表，实例级）。
 *
 * 与 BYOK 同口径的密钥纪律：`env` 可能含密钥，**只写不读**——
 * 仓储层提供 `list()`（含值，仅供运行时连接使用）与 `listPublic()`
 * （仅键名，供 HTTP 下发），路由绝不能把前者直接返回给客户端。
 */

export interface StoredMcpServer {
  id: string;
  name: string;
  /** 传输类型：stdio = 本地子进程；http = 远程 Streamable HTTP/SSE。 */
  kind: "stdio" | "http";
  command: string;
  args: string[];
  /** http 类型的远程端点 URL（stdio 为空）。 */
  url: string | null;
  env: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 可下发形态：env 只给键名。 */
export interface PublicMcpServer {
  id: string;
  name: string;
  kind: "stdio" | "http";
  command: string;
  args: string[];
  url: string | null;
  envKeys: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerUpsertInput {
  name: string;
  /** 传输类型：stdio = 本地子进程，http = 远程端点。缺省 stdio。 */
  kind?: "stdio" | "http";
  /** stdio 的本地命令（http 类型为空串，由归一化层写入）。 */
  command?: string;
  args: string[];
  /** http 类型的远程端点 URL（stdio 为 null）。 */
  url: string | null;
  env: Record<string, string>;
  enabled: boolean;
}

/**
 * HTTP 层原始输入：zod `.optional()` 解析结果的属性可能显式为 `undefined`，
 * exactOptionalPropertyTypes 下与 UpsertInput（可选但不可 undefined）分型。
 */
export type McpServerCreateRaw = {
  name: string;
  kind?: "stdio" | "http" | undefined;
  command?: string | undefined;
  args: string[];
  url?: string | null | undefined;
  env: Record<string, string>;
  enabled: boolean;
};

/** 部分更新（exactOptionalPropertyTypes 下显式允许 undefined 值）。 */
export type McpServerPatch = {
  [K in keyof McpServerUpsertInput]?: McpServerUpsertInput[K] | undefined;
};

export interface McpServerStore {
  /** 含 env 值（运行时连接用；禁止直接下发）。 */
  list(): Promise<StoredMcpServer[]>;
  /** 仅 env 键名（HTTP 下发用）。 */
  listPublic(): Promise<PublicMcpServer[]>;
  findByName(name: string): Promise<StoredMcpServer | null>;
  create(input: McpServerUpsertInput): Promise<StoredMcpServer>;
  update(id: string, patch: McpServerPatch): Promise<StoredMcpServer | null>;
  setEnabled(id: string, enabled: boolean): Promise<StoredMcpServer | null>;
  remove(id: string): Promise<number>;
}

type Row = {
  id: string;
  name: string;
  kind: string;
  command: string;
  args: unknown;
  url: string | null;
  env: unknown;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === "string") {
      out[key] = val;
    }
  }
  return out;
}

function toStored(row: Row): StoredMcpServer {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === "http" ? "http" : "stdio",
    command: row.command,
    args: asStringArray(row.args),
    url: row.url,
    env: asStringRecord(row.env),
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublic(row: Row): PublicMcpServer {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === "http" ? "http" : "stdio",
    command: row.command,
    args: asStringArray(row.args),
    url: row.url,
    envKeys: Object.keys(asStringRecord(row.env)),
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS =
  "id, name, kind, command, args, url, env, enabled, created_at, updated_at";

export function createMcpServerStore(
  persistence: PersistenceService,
): McpServerStore {
  return {
    async list() {
      const rows = await persistence.query<Row>(
        `select ${COLUMNS} from public.mcp_servers order by name asc`,
      );
      return rows.map(toStored);
    },

    async listPublic() {
      const rows = await persistence.query<Row>(
        `select ${COLUMNS} from public.mcp_servers order by name asc`,
      );
      return rows.map(toPublic);
    },

    async findByName(name) {
      const row = await persistence.queryOne<Row>(
        `select ${COLUMNS} from public.mcp_servers where name = $1`,
        [name],
      );
      return row ? toStored(row) : null;
    },

    async create(input) {
      const row = await persistence.queryOne<Row>(
        `insert into public.mcp_servers (name, kind, command, args, url, env, enabled)
         values ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7)
         returning id, name, kind, command, args, url, env, enabled, created_at, updated_at`,
        [
          input.name,
          input.kind ?? "stdio",
          input.command,
          JSON.stringify(input.args),
          input.url,
          JSON.stringify(input.env),
          input.enabled,
        ],
      );
      if (!row) {
        throw new Error("[mcp] 写入 server 配置失败（无返回行）。");
      }
      return toStored(row);
    },

    async update(id, patch) {
      // 逐字段可选更新：未提供的列不动（env 提供时整体替换）
      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (fragment: string, value: unknown) => {
        params.push(value);
        sets.push(fragment.replace("$?", `$${params.length}`));
      };
      if (patch.name !== undefined) push("name = $?", patch.name);
      if (patch.kind !== undefined) push("kind = $?", patch.kind);
      if (patch.command !== undefined) push("command = $?", patch.command);
      if (patch.url !== undefined) push("url = $?", patch.url);
      if (patch.args !== undefined)
        push("args = $?::jsonb", JSON.stringify(patch.args));
      if (patch.env !== undefined)
        push("env = $?::jsonb", JSON.stringify(patch.env));
      if (patch.enabled !== undefined) push("enabled = $?", patch.enabled);
      if (sets.length === 0) {
        // 无字段可改：按 id 读回现值（不发空 UPDATE）
        const current = await persistence.queryOne<Row>(
          `select ${COLUMNS} from public.mcp_servers where id = $1`,
          [id],
        );
        return current ? toStored(current) : null;
      }
      params.push(id);
      const row = await persistence.queryOne<Row>(
        `update public.mcp_servers
            set ${sets.join(", ")}, updated_at = now()
          where id = $${params.length}
        returning ${COLUMNS}`,
        params,
      );
      return row ? toStored(row) : null;
    },

    async setEnabled(id, enabled) {
      const row = await persistence.queryOne<Row>(
        `update public.mcp_servers
            set enabled = $1, updated_at = now()
          where id = $2
        returning ${COLUMNS}`,
        [enabled, id],
      );
      return row ? toStored(row) : null;
    },

    async remove(id) {
      return persistence.execute(
        "delete from public.mcp_servers where id = $1",
        [id],
      );
    },
  };
}
