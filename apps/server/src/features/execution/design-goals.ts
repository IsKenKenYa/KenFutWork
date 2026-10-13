import { randomUUID } from "node:crypto";
import type { StreamEvent } from "@kenfutwork/shared";
import type {
  PromptExecutionContext,
  ToolExecutionContext,
} from "../../kernel/types.js";
import type { ModelInvocationSnapshot } from "../../providers/types.js";
import type { GoalEvidenceCandidate } from "../goals/consumer.js";
import type { GoalFence, GoalRecord, GoalService } from "../goals/service.js";
import { isGoalToolEvidence } from "../goals/tool-evidence.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { CodeApprovalService } from "../permissions/approval-types.js";
import type {
  InstanceSqlClient,
  PersistenceService,
  PersistenceSessionLock,
  SqlRow,
} from "../persistence/types.js";
import type { DesignGoalsService } from "./design-goals-types.js";
import type { DesignModelSelection } from "./design-model-selection.js";
import { DesignTaskError } from "./design-task-errors.js";
import { type DesignTaskRow, loadDesignTask } from "./design-task-metadata.js";

type GoalRow = SqlRow & {
  state: GoalRecord;
  model_invocation: ModelInvocationSnapshot | null;
  owner_client_id: string;
  observed_at?: Date | string;
};
type EvidenceRow = SqlRow & {
  source_id: string;
  kind: "toolCall" | "assistantText";
  tool_name: string | null;
  input: Record<string, unknown> | null;
  detail: string;
  status: string;
};
const at = () => Date.now();
const conflict = () =>
  new DesignTaskError(
    "design_goal_conflict",
    "目标或任务状态已改变，请重新加载",
  );
function checkFence(
  task: DesignTaskRow,
  state: GoalRecord | undefined,
  input: GoalFence & { branchGeneration?: number },
) {
  if (
    !state ||
    state.goalId !== input.goalId ||
    state.revision !== input.revision ||
    (input.branchGeneration !== undefined &&
      (input.branchGeneration !== state.branchGeneration ||
        input.branchGeneration !== Number(task.branch_generation)))
  )
    throw conflict();
}
function usable(row: EvidenceRow): boolean {
  if (row.status !== "success" || !row.detail.trim()) return false;
  if (row.kind === "assistantText") return true;
  return isGoalToolEvidence(
    row.tool_name ?? "",
    row.detail,
    String(row.input?.command ?? ""),
  );
}
export function createDesignGoals(options: {
  modelSelection: DesignModelSelection;
  persistence: PersistenceService;
  goals: GoalService;
  localInstance: Pick<LocalInstanceService, "resolve" | "getContext">;
  permissions: Pick<CodeApprovalService, "listPending">;
}): DesignGoalsService {
  const { persistence, goals, localInstance, permissions } = options;
  let leader: PersistenceSessionLock | null = null;
  let initialization: Promise<void> | undefined;
  let lost = false;
  const lostListeners = new Set<() => void>();
  const assertLeader = () => {
    if (!leader || leader.signal.aborted || lost)
      throw new DesignTaskError(
        "design_goal_host_lost",
        "目标宿主连接已失效，请重试",
        503,
      );
  };
  async function initialize() {
    initialization ??= (async () => {
      const { instanceId } = await localInstance.getContext();
      leader = await persistence.acquireSessionLock(
        `design-goals-host:${instanceId}`,
      );
      if (!leader)
        throw new DesignTaskError(
          "design_goal_host_busy",
          "另一运行进程持有目标宿主",
          409,
        );
      leader.signal.addEventListener(
        "abort",
        () => {
          lost = true;
          for (const listener of lostListeners) listener();
        },
        { once: true },
      );
      try {
        const rows = await persistence
          .forInstance(instanceId)
          .query<SqlRow & { task_id: string }>(
            `select task_id from public.design_task_goals where instance_id=:instance`,
          );
        for (const row of rows)
          await persistence.transaction(async (tx) => {
            const sql = tx.forInstance(instanceId);
            const current = await loadDesignTask(sql, row.task_id, true);
            if (!current) return;
            const stored = await goalRow(sql, row.task_id, true);
            if (!stored) return;
            assertLeader();
            await save(
              sql,
              row.task_id,
              goals.recover(
                stored.state,
                new Date(stored.observed_at ?? Date.now()).getTime(),
              ),
            );
          });
      } catch (error) {
        await leader.release();
        leader = null;
        throw error;
      }
    })();
    return initialization;
  }

  const goalRow = (sql: InstanceSqlClient, taskId: string, lock = false) =>
    sql.queryOne<GoalRow>(
      `select state,model_invocation,owner_client_id,observed_at from public.design_task_goals where instance_id=:instance and task_id=$1 ${lock ? "for update" : ""}`,
      [taskId],
    );
  const save = (sql: InstanceSqlClient, taskId: string, state: GoalRecord) =>
    sql.execute(
      `update public.design_task_goals set state=$2::jsonb,observed_at=now() where instance_id=:instance and task_id=$1`,
      [taskId, JSON.stringify(state)],
    );
  async function task(sql: InstanceSqlClient, taskId: string) {
    const row = await loadDesignTask(sql, taskId, true);
    if (!row) throw conflict();
    return row;
  }
  async function mutate<T>(
    actor: LocalActor,
    taskId: string,
    change: (
      sql: InstanceSqlClient,
      task: DesignTaskRow,
      current: GoalRow | null,
    ) => Promise<T>,
  ): Promise<T> {
    await initialize();
    assertLeader();
    await localInstance.resolve(actor);
    return persistence.transaction(async (tx) => {
      const sql = tx.forInstance(actor.instanceId);
      return change(
        sql,
        await task(sql, taskId),
        await goalRow(sql, taskId, true),
      );
    });
  }
  function scope(context: PromptExecutionContext) {
    context.signal?.throwIfAborted();
    const handle = context.scopeHandle;
    const opened = handle?.describe();
    if (
      !opened ||
      !context.actor ||
      context.actor.instanceId !== opened.instanceId ||
      handle?.preset !== "design" ||
      handle.role !== "main" ||
      handle.agentId !== "main" ||
      !context.runId
    )
      throw conflict();
    return opened;
  }
  function currentRun(
    task: DesignTaskRow,
    context: PromptExecutionContext,
  ): boolean {
    const opened = scope(context);
    return (
      task.active_run_id === context.runId &&
      Number(task.scope_generation) === opened.generation &&
      Number(task.branch_generation) ===
        context.scopeHandle?.branchGeneration &&
      task.execution_state === "ready"
    );
  }
  const evidence = (sql: InstanceSqlClient, taskId: string, runId: string) =>
    sql.query<EvidenceRow>(
      `select source_id,kind,tool_name,input,detail,status from public.design_goal_evidence where instance_id=:instance and task_id=$1 and run_id=$2`,
      [taskId, runId],
    );
  const service: DesignGoalsService = {
    initialize,
    onLost(listener) {
      lostListeners.add(listener);
      return () => lostListeners.delete(listener);
    },
    async close() {
      lost = true;
      if (leader) {
        const held = leader;
        leader = null;
        await held.release();
      }
      lostListeners.clear();
    },
    lifecycle: {
      async claim(sql, t, input) {
        let row = await goalRow(sql, t.task_id, true);
        if (input.objective && (!row || row.state.status === "complete")) {
          if (!input.actor.accessClientId) throw conflict();
          const created = goals.create(row?.state ?? null, {
            goalId: randomUUID(),
            objective: input.objective,
            branchGeneration: Number(t.branch_generation),
            at: at(),
          });
          await sql.execute(
            `insert into public.design_task_goals(task_id,instance_id,project_id,state,owner_client_id,model_invocation)
            values($1,:instance,$2,$3::jsonb,$4,$5::jsonb) on conflict(task_id) do update set state=excluded.state,owner_client_id=excluded.owner_client_id,model_invocation=excluded.model_invocation,observed_at=now()`,
            [
              t.task_id,
              t.project_id,
              JSON.stringify(created),
              input.actor.accessClientId,
              input.modelInvocation
                ? JSON.stringify(input.modelInvocation)
                : null,
            ],
          );
          row = {
            state: created,
            owner_client_id: input.actor.accessClientId,
            model_invocation: input.modelInvocation ?? null,
          };
        }
        if (!row) {
          if (input.origin === "goalContinuation") throw conflict();
          return;
        }
        assertLeader();
        const goal = row.state;
        if (
          input.origin === "goalContinuation" &&
          (!input.goalFence ||
            goal.goalId !== input.goalFence.goalId ||
            goal.revision !== input.goalFence.revision)
        )
          throw conflict();
        if (
          !["active", "notSatisfied"].includes(goal.status) ||
          goal.claimedRunId
        ) {
          if (input.origin === "goalContinuation") throw conflict();
          return;
        }
        const waiting =
          permissions.listPending(sql.instanceId, t.task_id).length > 0 ||
          t.plan_enabled;
        const queued =
          input.origin === "goalContinuation" &&
          !!(await sql.queryOne(
            `select input_id from public.design_task_inputs where instance_id=:instance and task_id=$1 and status='queued'`,
            [t.task_id],
          ));
        if (
          input.origin === "goalContinuation" &&
          (waiting ||
            queued ||
            t.active_run_id ||
            t.execution_state !== "ready")
        )
          throw conflict();
        const claimed = goals.claimRun(goal, {
          goalId: goal.goalId,
          revision: goal.revision,
          runId: input.runId,
          at: at(),
          foreground: {
            branchGeneration: Number(t.branch_generation),
            taskReady: t.execution_state === "ready",
            activeRunId: null,
            userReserved: false,
            userQueued: false,
            approvalWaiting: false,
          },
        });
        await sql.execute(
          `delete from public.design_goal_evidence where instance_id=:instance and task_id=$1`,
          [t.task_id],
        );
        await save(sql, t.task_id, claimed);
        if (input.origin === "userInput" && input.actor.accessClientId)
          await sql.execute(
            `update public.design_task_goals set owner_client_id=$2 where instance_id=:instance and task_id=$1`,
            [t.task_id, input.actor.accessClientId],
          );
      },
      async settle(sql, t, input) {
        const row = await goalRow(sql, t.task_id, true);
        if (!row) return;
        if (lost || !leader || leader.signal.aborted) return;
        let state = row.state;
        if (
          state.claimedRunId === input.runId &&
          (t.plan_enabled ||
            permissions.listPending(sql.instanceId, t.task_id).length)
        )
          state = goals.pause(state, {
            goalId: state.goalId,
            revision: state.revision,
            reason: t.plan_enabled ? "plan.waiting" : "interaction.waiting",
            at: input.at,
          });
        await save(sql, t.task_id, goals.observeTerminal(state, input));
      },
      async pause(sql, t, reason, time) {
        if (lost || !leader || leader.signal.aborted) return;
        const row = await goalRow(sql, t.task_id, true);
        if (row && !["complete", "paused"].includes(row.state.status))
          await save(
            sql,
            t.task_id,
            goals.pause(row.state, {
              goalId: row.state.goalId,
              revision: row.state.revision,
              reason,
              at: time,
            }),
          );
      },
      async recover(sql, t, time) {
        const row = await goalRow(sql, t.task_id, true);
        if (row) await save(sql, t.task_id, goals.recover(row.state, time));
      },
      async rebranch(sql, t, branchGeneration, time) {
        const row = await goalRow(sql, t.task_id, true);
        if (row)
          await save(
            sql,
            t.task_id,
            goals.rebranch(row.state, branchGeneration, time),
          );
      },
    },
    async readTask(actor, taskId) {
      await localInstance.resolve(actor);
      return mutate(
        actor,
        taskId,
        async (_sql, _task, row) => row?.state ?? null,
      );
    },
    async create(actor, input) {
      const modelInvocation = await options.modelSelection.capture(
        actor,
        input.model,
      );
      if (!actor.accessClientId) throw conflict();
      return mutate(actor, input.taskId, async (sql, t, row) => {
        if (t.active_run_id || t.execution_state !== "ready") throw conflict();
        if (row && row.state.status !== "complete") throw conflict();
        if (
          input.expectedBranchGeneration !== undefined &&
          input.expectedBranchGeneration !== Number(t.branch_generation)
        )
          throw conflict();
        if (input.expectedGoal !== undefined) {
          if (input.expectedGoal === null) {
            if (row) throw conflict();
          } else checkFence(t, row?.state, input.expectedGoal);
        }
        const state = goals.create(row?.state ?? null, {
          goalId: randomUUID(),
          objective: input.objective,
          branchGeneration: Number(t.branch_generation),
          ...(input.tokenBudget !== undefined
            ? { tokenBudget: input.tokenBudget }
            : {}),
          at: at(),
        });
        await sql.execute(
          `insert into public.design_task_goals(task_id,instance_id,project_id,state,owner_client_id,model_invocation)
     values($1,:instance,$2,$3::jsonb,$4,$5::jsonb) on conflict(task_id) do update set state=excluded.state,owner_client_id=excluded.owner_client_id,model_invocation=excluded.model_invocation,observed_at=now()`,
          [
            input.taskId,
            t.project_id,
            JSON.stringify(state),
            actor.accessClientId,
            JSON.stringify(modelInvocation),
          ],
        );
        return state;
      });
    },
    async pause(actor, input) {
      return mutate(actor, input.taskId, async (sql, t, row) => {
        if (!row) throw conflict();
        checkFence(t, row.state, input);
        const state = goals.pause(row.state, {
          ...input,
          reason: input.reason ?? "user.pause",
          at: at(),
        });
        await save(sql, input.taskId, state);
        return state;
      });
    },
    async resume(actor, input) {
      return mutate(actor, input.taskId, async (sql, t, row) => {
        if (
          !row ||
          !actor.accessClientId ||
          t.active_run_id ||
          t.execution_state !== "ready" ||
          t.plan_enabled ||
          permissions.listPending(actor.instanceId, input.taskId).length
        )
          throw conflict();
        checkFence(t, row.state, input);
        if (
          row.state.tokenBudget !== null &&
          row.state.tokensUsed >= row.state.tokenBudget
        )
          throw new DesignTaskError(
            "design_goal_budget_exhausted",
            "目标预算已用尽，请调整预算后恢复",
          );
        if (row.state.status !== "paused" || row.state.claimedRunId)
          throw conflict();
        const modelInvocation = input.model
          ? await options.modelSelection.capture(actor, input.model)
          : row.model_invocation;
        if (!modelInvocation)
          throw new DesignTaskError(
            "design_model_invalid",
            "请重新选择模型后恢复目标",
          );
        await options.modelSelection.validate(actor, modelInvocation);
        const state = goals.resume(row.state, {
          ...input,
          branchGeneration: Number(t.branch_generation),
        });
        await save(sql, input.taskId, state);
        await sql.execute(
          `update public.design_task_goals set owner_client_id=$2,model_invocation=$3::jsonb where instance_id=:instance and task_id=$1`,
          [input.taskId, actor.accessClientId, JSON.stringify(modelInvocation)],
        );
        return state;
      });
    },
    async setBudget(actor, input) {
      return mutate(actor, input.taskId, async (sql, t, row) => {
        if (!row) throw conflict();
        checkFence(t, row.state, input);
        const state = goals.setBudget(row.state, input);
        await save(sql, input.taskId, state);
        return state;
      });
    },
    async read(context) {
      const opened = scope(context);
      return mutate(context.actor!, opened.taskId, async (sql, t, row) => {
        if (!row) return null;
        if (!currentRun(t, context)) throw conflict();
        const state = structuredClone(row.state);
        for (const proof of state.verification?.evidence ?? [])
          delete proof.detail;
        const candidates = (await evidence(sql, opened.taskId, context.runId!))
          .filter(usable)
          .map(
            (row) =>
              ({
                id: row.source_id,
                kind: row.kind,
                revision: state.revision,
              }) satisfies GoalEvidenceCandidate,
          );
        return { ...state, evidenceCandidates: candidates };
      });
    },
    async verify(context: ToolExecutionContext, input) {
      const opened = scope(context);
      return mutate(context.actor!, opened.taskId, async (sql, t, row) => {
        if (!row || !context.toolCallId || !currentRun(t, context))
          throw conflict();
        const records = await evidence(sql, opened.taskId, context.runId!);
        const selected = input.evidenceIds.map((id) =>
          records.find((row) => row.source_id === id),
        );
        if (!selected.length || selected.some((row) => !row || !usable(row)))
          throw new DesignTaskError(
            "design_goal_evidence_invalid",
            "验收引用不属于当前Run的有效结果，请先读取GetGoal候选",
          );
        const state = goals.verify(row.state, {
          goalId: row.state.goalId,
          revision: input.revision,
          runId: context.runId!,
          evidence: selected.map((row) => ({
            sourceId: row!.source_id,
            passed: true,
            detail: row!.detail,
          })),
          verdict: { passed: input.passed, reason: input.reason },
          at: at(),
        });
        await save(sql, opened.taskId, state);
        return state;
      });
    },
    async observe(actor, taskId, event: StreamEvent) {
      return mutate(actor, taskId, async (sql, t, row) => {
        if (
          !row ||
          row.state.claimedRunId !== event.runId ||
          t.active_run_id !== event.runId
        )
          return { stop: false };
        let state = row.state;
        if (
          event.type === "run.usage" &&
          event.runInputTokens !== undefined &&
          event.runOutputTokens !== undefined
        )
          state = goals.observeUsage(state, {
            runId: event.runId,
            tokensUsed: event.runInputTokens + event.runOutputTokens,
          });
        if (event.type === "tool.started" && !event.agentCallId)
          await sql.execute(
            `insert into public.design_goal_evidence(task_id,instance_id,run_id,source_id,kind,tool_name,input)
      values($1,:instance,$2,$3,'toolCall',$4,$5::jsonb) on conflict(task_id,source_id) do nothing`,
            [
              taskId,
              event.runId,
              `tool:${event.runId}/${event.toolCallId}`,
              event.toolName,
              JSON.stringify(event.input ?? {}),
            ],
          );
        if (event.type === "tool.completed" && !event.agentCallId)
          await sql.execute(
            `update public.design_goal_evidence set detail=$4,status=$5
      where instance_id=:instance and task_id=$1 and run_id=$2 and source_id=$3 and tool_name=$6`,
            [
              taskId,
              event.runId,
              `tool:${event.runId}/${event.toolCallId}`,
              event.outputText ?? JSON.stringify(event.output ?? {}),
              event.status ?? "pending",
              event.toolName,
            ],
          );
        if (event.type === "message.delta" && !event.agentCallId)
          await sql.execute(
            `insert into public.design_goal_evidence(task_id,instance_id,run_id,source_id,kind,detail,status)
      values($1,:instance,$2,$3,'assistantText',$4,'success') on conflict(task_id,source_id) do update set detail=design_goal_evidence.detail||excluded.detail`,
            [
              taskId,
              event.runId,
              `assistant:${event.runId}/${event.messageId}`,
              event.delta,
            ],
          );
        if (state !== row.state) await save(sql, taskId, state);
        else
          await sql.execute(
            `update public.design_task_goals set observed_at=now() where instance_id=:instance and task_id=$1`,
            [taskId],
          );
        return {
          stop:
            state.status === "paused" &&
            ["budget.stop", "budget.usageUnavailable"].includes(
              state.reason ?? "",
            ),
        };
      });
    },
    async continuation(instanceId, taskId) {
      await initialize();
      assertLeader();
      const row = await persistence.forInstance(instanceId).queryOne<
        GoalRow & {
          scope_generation: string;
          branch_generation: string;
          active_run_id: string | null;
          execution_state: string;
          plan_enabled: boolean;
        }
      >(
        `select g.state,g.model_invocation,g.owner_client_id,d.scope_generation,d.branch_generation,d.active_run_id,d.execution_state,d.plan_enabled
     from public.design_task_goals g join public.design_task_executions d on d.task_id=g.task_id and d.instance_id=g.instance_id
     join public.local_access_clients c on c.id=g.owner_client_id and c.instance_id=g.instance_id
     where g.instance_id=:instance and g.task_id=$1 and c.revoked_at is null and (c.expires_at is null or c.expires_at>now())`,
        [taskId],
      );
      if (
        !row ||
        row.active_run_id ||
        row.execution_state !== "ready" ||
        row.plan_enabled ||
        row.state.claimedRunId ||
        !["active", "notSatisfied"].includes(row.state.status) ||
        Number(row.branch_generation) !== row.state.branchGeneration ||
        (row.state.tokenBudget !== null &&
          row.state.tokensUsed >= row.state.tokenBudget) ||
        permissions.listPending(instanceId, taskId).length
      )
        return null;
      if (!row.model_invocation)
        throw new DesignTaskError(
          "design_model_invalid",
          "请重新选择模型后恢复目标",
        );
      const actor = { instanceId, accessClientId: row.owner_client_id };
      await options.modelSelection.validate(actor, row.model_invocation);
      return {
        modelInvocation: row.model_invocation,
        actor,
        goalFence: { goalId: row.state.goalId, revision: row.state.revision },
        inputId: `goal:${row.state.goalId}/${row.state.iteration + 1}`,
        prompt: `继续完成当前Task目标，逐项验收真实结果：${row.state.objective}`,
      };
    },
  };
  return service;
}
