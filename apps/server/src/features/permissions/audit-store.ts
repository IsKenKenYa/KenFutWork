import type {
  PermissionAuditEntry,
  PermissionDecisionSource,
} from "@kenfutwork/shared";
import {
  PERMISSION_AUDIT_LIMIT,
  permissionDecisionSourceSchema,
} from "@kenfutwork/shared";

import type { PersistenceService } from "../persistence/types.js";
import type { PermissionAuditRecord } from "./permission-service.js";

/**
 * 审计中心（参考 WorkBuddy 安全中心）的持久化：权限判定的放行/拦截流水。
 *
 * 三条纪律：
 * - **不存工具参数**：参数可能带文件内容、命令与凭据；审计只回答哪个工具、
 *   什么结论、为什么（理由文案本身已足够定位规则）。
 * - **上限裁剪**：只保留最近 {@link PERMISSION_AUDIT_LIMIT} 条，写入后顺手裁掉更旧的
 *   ——桌面形态的数据目录不该被流水无限撑大。
 * - **写失败不影响判定**：记录器在 service 侧已吞掉异常，这里只负责落库。
 */
export interface PermissionAuditStore {
  /** 记一条（裁剪同一次调用内完成）。 */
  record(record: PermissionAuditRecord): Promise<void>;
  /** 读最近的记录（新的在前）。 */
  list(options?: { limit?: number }): Promise<PermissionAuditEntry[]>;
  /** 清空（用户点「清空记录」）。 */
  clear(): Promise<void>;
}

type AuditRow = {
  id: string | number;
  occurred_at: Date | string;
  tool_name: string;
  decision: string;
  source: string | null;
  blocked: boolean;
  reason: string | null;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function createPermissionAuditStore(
  persistence: PersistenceService,
): PermissionAuditStore {
  return {
    async record(record) {
      await persistence.execute(
        `insert into public.permission_audit_entries
           (tool_name, decision, source, blocked, reason)
         values ($1, $2, $3, $4, $5)`,
        [
          record.toolName,
          record.decision,
          record.source ?? null,
          record.blocked,
          record.reason ?? null,
        ],
      );
      // 裁剪：id 递增，留最新的 N 条（一条语句，不做「先数再删」的两步竞态）。
      await persistence.execute(
        `delete from public.permission_audit_entries
           where id <= (
             select id from public.permission_audit_entries
              order by id desc offset $1 limit 1
           )`,
        [PERMISSION_AUDIT_LIMIT],
      );
    },

    async list(options) {
      const limit = Math.min(
        Math.max(options?.limit ?? 200, 1),
        PERMISSION_AUDIT_LIMIT,
      );
      const rows = await persistence.query<AuditRow>(
        `select id, occurred_at, tool_name, decision, source, blocked, reason
           from public.permission_audit_entries
          order by id desc
          limit $1`,
        [limit],
      );
      return rows.map((row) => {
        const source = permissionDecisionSourceSchema.safeParse(row.source);
        return {
          id: String(row.id),
          occurredAt: toIso(row.occurred_at),
          toolName: row.tool_name,
          decision: row.decision === "deny" ? "deny" : "allow",
          source: source.success
            ? (source.data as PermissionDecisionSource)
            : null,
          blocked: row.blocked === true,
          reason: row.reason,
        };
      });
    },

    async clear() {
      await persistence.execute("delete from public.permission_audit_entries");
    },
  };
}
