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
  /**
   * 孤儿对账：把**本进程启动前**遗留的非终态 run 收敛成 `failed` 终态。
   *
   * 为什么需要：run 的行只在本进程的内存里推进——进程被重启/杀掉时没人写终态，
   * 行就永远停在 `running`，客户端于是永远显示「生成中」（实测复现过一次）。
   * 进程刚起来时它必然没在跑任何 run，故「启动前的非终态行」一定是孤儿。
   *
   * 边界：只碰 `created_at < before` 的行——本进程启动后起的 run 绝不会被误杀。
   * 多副本拓扑下这条会误伤同伴在飞的 run（本仓当前部署是单 API 实例：Docker 一份
   * api、桌面单进程），故不引入心跳/租约那套机制。
   */
  reconcileInterrupted(before: Date, message: string): Promise<number>;
  /**
   * 工作区在给定时间窗内的 agent 运行次数与**累计运行时长**
   * （参考图 Git 弹层的「智能体 26 秒 · 4 运行」）。**口径定义在这里**：
   * - 时间范围 = 近 7 天（`since` 由服务层算好传入）；
   * - **范围 = 整个工作区**：不按会话/画布切。实测两条「更细」的路都不可靠——
   *   客户端任务 id 与服务端会话 id 不保证一致（同一轮对话两边 id 不同），
   *   run 挂的又是会话的载体画布而非项目画布（按项目画布查恒为 0）；
   * - 时长 = 各轮 `completed_at - created_at` 求和；仍在跑的按「到现在」计
   *   （`coalesce(completed_at, now())`），数字不会在运行中冻住；
   * - 隔离：`agent_runs` 无 workspace_id，谓词走 `chat_sessions → canvases → projects`
   *   父链（与 chat 仓储同一条链）。
   */
  workspaceActivity(input: {
    workspaceId: string;
    since: Date;
  }): Promise<{ runs: number; totalSeconds: number }>;
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

    async workspaceActivity(input) {
      const rows = await persistence
        .forWorkspace(input.workspaceId)
        .query<{ seconds: string | number | null; runs: string | number }>(
          `select count(*)::int as runs,
                  coalesce(sum(extract(epoch from (coalesce(r.completed_at, now()) - r.created_at))), 0) as seconds
             from public.agent_runs r
             join public.chat_sessions s on s.id = r.session_id
             join public.canvases c on c.id = s.canvas_id
             join public.projects p on p.id = c.project_id
            where p.workspace_id = :workspace
              and r.created_at >= $1`,
          [input.since.toISOString()],
        );
      const runs = Number(rows[0]?.runs ?? 0);
      const seconds = Number(rows[0]?.seconds ?? 0);
      return {
        runs: Number.isFinite(runs) && runs > 0 ? runs : 0,
        totalSeconds:
          Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0,
      };
    },

    async reconcileInterrupted(before, message) {
      return persistence.execute(
        `update public.agent_runs
            set status = 'failed',
                completed_at = now(),
                error_code = 'run_failed',
                error_message = $1
          where status in ('accepted', 'running')
            and created_at < $2`,
        [message, before.toISOString()],
      );
    },
  };
}
