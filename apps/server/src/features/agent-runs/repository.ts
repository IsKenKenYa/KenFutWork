import type { PersistenceService } from "../persistence/types.js";

export type AgentRunRecord = {
  id: string;
  model: string | null;
  session_id: string;
  status: string;
  thread_id: string;
};

export type NewAgentRun = {
  model?: string | null | undefined;
  runId: string;
  sessionId: string;
  status: string;
  threadId: string;
};

/**
 * agent-runs 聚合的数据访问（`agent_runs`）。
 *
 * `agent_runs` **没有 `workspace_id` 列**，其隔离边界是 `session_id → canvas →
 * project → workspace` 这条链；本聚合的写入是运行生命周期的元数据（run id 由
 * 服务端生成、随本次运行传递），故按 id 走根客户端——调用方是已鉴权的 runtime，
 * run id 不是外部输入。若将来需要按工作区列出运行历史，应经会话链加谓词。
 */
export interface AgentRunRepository {
  insert(input: NewAgentRun): Promise<void>;
  updateById(runId: string, patch: Record<string, unknown>): Promise<number>;
}

export function createAgentRunRepository(
  persistence: PersistenceService,
): AgentRunRepository {
  return {
    async insert(input) {
      await persistence.query(
        `insert into public.agent_runs (id, model, session_id, status, thread_id)
         values ($1, $2, $3, $4, $5)`,
        [
          input.runId,
          input.model ?? null,
          input.sessionId,
          input.status,
          input.threadId,
        ],
      );
    },

    async updateById(runId, patch) {
      const assignments: string[] = [];
      const values: unknown[] = [runId];

      for (const [column, value] of Object.entries(patch)) {
        if (value === undefined) {
          continue;
        }
        values.push(value);
        assignments.push(`${column} = $${values.length}`);
      }

      if (assignments.length === 0) {
        return 0;
      }

      return persistence.execute(
        `update public.agent_runs
            set ${assignments.join(", ")}
          where id = $1`,
        values,
      );
    },
  };
}
