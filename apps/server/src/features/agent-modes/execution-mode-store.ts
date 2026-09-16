import { type ExecutionMode, executionModeSchema } from "@kenfutwork/shared";

import type { PersistenceService } from "../persistence/types.js";

/**
 * 执行模式持久化（chat_sessions.execution_mode，按线程）。
 * chat_sessions 是工作区归属数据（经 画布→项目 链），读写都走 `forWorkspace`
 * 客户端——DB 层已无 RLS 兜底，隔离谓词必须显式出现在语句里（FORM-9）。
 *
 * **入参同时接受 thread_id 与会话 id**：run 路径（WS）用服务端内部 thread_id，
 * 而画布助手面板的选择器只有会话 id（会话列表仅回 id/title/updatedAt，见 contracts.ts）。
 * 此前只匹配 thread_id，面板切换必然落空——接口回 400「Invalid mode.」（catch-all 盖住了
 * 真实原因），实际是「该线程不存在」。
 */

/** 模式持久化的工作区作用域。 */
export interface ExecutionModeScope {
  workspaceId: string;
}

/** 归属校验 + 读回：行不存在（或不属于该工作区）时 exists=false。 */
export interface ExecutionModeLookup {
  exists: boolean;
  mode: ExecutionMode | null;
}

export interface ExecutionModeStore {
  lookup(workspaceId: string, threadId: string): Promise<ExecutionModeLookup>;
  save(
    workspaceId: string,
    threadId: string,
    mode: ExecutionMode,
  ): Promise<void>;
}

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return executionModeSchema.safeParse(value).success;
}

export function createExecutionModeStore(
  persistence: PersistenceService,
): ExecutionModeStore {
  return {
    async lookup(workspaceId, threadId) {
      const rows = await persistence
        .forWorkspace(workspaceId)
        .query<{ execution_mode: unknown }>(
          `select s.execution_mode
             from public.chat_sessions s
             join public.canvases c on c.id = s.canvas_id
             join public.projects p on p.id = c.project_id
            where (s.thread_id = $1 or s.id::text = $1)
              and p.workspace_id = :workspace`,
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

    async save(workspaceId, threadId, mode) {
      // 行不存在（会话尚未落库）或不在本工作区：0 行更新，内存中的激活仍对本轮 run 生效
      await persistence.forWorkspace(workspaceId).execute(
        `update public.chat_sessions s
            set execution_mode = $2
          where (s.thread_id = $1 or s.id::text = $1)
            and exists (
              select 1
                from public.canvases c
                join public.projects p on p.id = c.project_id
               where c.id = s.canvas_id
                 and p.workspace_id = :workspace
            )`,
        [threadId, mode],
      );
    },
  };
}
