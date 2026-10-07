import { type ExecutionMode, executionModeSchema } from "@kenfutwork/shared";

import type { PersistenceService } from "../persistence/types.js";

/**
 * 执行模式持久化（chat_sessions.execution_mode，按线程）。
 * chat_sessions 直接持有项目/工作区归属，以项目与工作区复合键校验，
 * 读写都走 `forInstance` 客户端——DB 层已无 RLS 兜底（FORM-9）。
 *
 * **入参同时接受 thread_id 与会话 id**：run 路径（WS）用服务端内部 thread_id，
 * 而界面选择器只有会话 id（会话列表仅回 id/title/updatedAt，见 contracts.ts）。
 * 此前只匹配 thread_id，面板切换必然落空——接口回 400「Invalid mode.」（catch-all 盖住了
 * 真实原因），实际是「该线程不存在」。
 */

/** 模式持久化的工作区作用域。 */
export interface ExecutionModeScope {
  instanceId: string;
}

/** 归属校验 + 读回：行不存在（或不属于该工作区）时 exists=false。 */
export interface ExecutionModeLookup {
  exists: boolean;
  mode: ExecutionMode | null;
}

export interface ExecutionModeStore {
  lookup(instanceId: string, threadId: string): Promise<ExecutionModeLookup>;
  save(
    instanceId: string,
    threadId: string,
    mode: ExecutionMode,
  ): Promise<boolean>;
}

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return executionModeSchema.safeParse(value).success;
}

export function createExecutionModeStore(
  persistence: PersistenceService,
): ExecutionModeStore {
  return {
    async lookup(instanceId, threadId) {
      const rows = await persistence
        .forInstance(instanceId)
        .query<{ execution_mode: unknown }>(
          `select s.execution_mode
             from public.chat_sessions s
             join public.projects p on p.id = s.project_id and p.instance_id = s.instance_id
            where (s.thread_id = $1 or s.id::text = $1)
              and s.instance_id = :instance`,
          [threadId],
        );
      const row = rows[0];
      if (!row) {
        return { exists: false, mode: null };
      }
      return {
        exists: true,
        mode: isExecutionMode(row.execution_mode) ? row.execution_mode : null,
      };
    },

    async save(instanceId, threadId, mode) {
      // 受影响行是原子归属/存活证明；零行不改库，也不能被consumer当作激活成功。
      const changed = await persistence.forInstance(instanceId).execute(
        `update public.chat_sessions s
            set execution_mode = $2
           from public.projects p
          where p.id = s.project_id and p.instance_id = s.instance_id
            and s.instance_id = :instance
            and (s.thread_id = $1 or s.id::text = $1)`,
        [threadId, mode],
      );
      return changed > 0;
    },
  };
}
