import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runCreateRequestSchema } from "@kenfutwork/shared";
import type { ModelInvocationSnapshot } from "../../providers/types.js";
import { claimCanvasRootInTransaction } from "../canvas/root-directory.js";
import type { GoalFence } from "../goals/service.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import type {
  InstanceSqlClient,
  PersistenceService,
  SqlRow,
  SqlTransaction,
} from "../persistence/types.js";
import {
  normalizeAdditionalDirectories,
  resolveProjectWorkDirectory,
} from "../projects/work-dir.js";
import type { DesignGoalLifecycle } from "./design-goals-types.js";
import { loadOpenDesignProject } from "./design-project-authority.js";
import { DesignTaskError } from "./design-task-errors.js";
import { createDesignTaskLeases } from "./design-task-lease.js";
import {
  type DesignProjectRow,
  designProjectFingerprint,
  designTaskPolicy,
  insertDesignTaskInTransaction,
  loadDesignTask,
} from "./design-task-metadata.js";
import type {
  DesignAdmissionReceipt,
  DesignTasksService,
} from "./design-task-types.js";
import { parameterFingerprint } from "./parameter-fingerprint.js";

type InputRow = SqlRow & {
  model_invocation: ModelInvocationSnapshot | null;
  input_id: string;
  run_id: string;
  admission_seq: number | string;
  request: DesignAdmissionReceipt["request"];
  status: string;
  fingerprint: string;
  input_origin: "userInput" | "backgroundResult" | "goalContinuation";
  goal_fence: GoalFence | null;
  created_by_client_id: string | null;
};
function receipt(
  taskId: string,
  row: InputRow,
  kind: DesignAdmissionReceipt["kind"],
): DesignAdmissionReceipt {
  return {
    kind,
    taskId,
    inputId: row.input_id,
    runId: row.run_id,
    sequence: Number(row.admission_seq),
    request: kind === "duplicate" ? null : row.request,
  };
}
async function requireTask(
  sql: InstanceSqlClient,
  taskId: string,
  lock = false,
) {
  const task = await loadDesignTask(sql, taskId, lock);
  if (!task)
    throw new DesignTaskError(
      "design_task_unprovisioned",
      "任务尚未配置执行目录",
    );
  return task;
}

async function requireOpenProject(sql: InstanceSqlClient, taskId: string) {
  if (!(await loadOpenDesignProject(sql, taskId)))
    throw new DesignTaskError(
      "design_task_unavailable",
      "项目正在关闭或关闭失败，请重试归档。",
    );
}

export function createDesignTasksService(options: {
  persistence: PersistenceService;
  localInstance: LocalInstanceService;
  sandboxRoot?: string | undefined;
  goalLifecycle?: DesignGoalLifecycle;
}): DesignTasksService {
  const { persistence, localInstance, sandboxRoot } = options;
  const leases = createDesignTaskLeases(persistence, options.goalLifecycle);
  async function admissionTransaction<T>(
    fn: (tx: SqlTransaction) => Promise<T>,
  ): Promise<T> {
    const release = localInstance.beginAdmission();
    try {
      return await persistence.transaction(fn);
    } finally {
      release();
    }
  }
  const service: DesignTasksService = {
    async beginRestore(actor, input) {
      await localInstance.resolve(actor);
      return leases.withTask(actor.instanceId, input.taskId, async () => {
        if (!(await leases.acquire(actor.instanceId, input.taskId)))
          throw new DesignTaskError(
            "design_task_host_busy",
            "任务正在其他运行进程中执行",
          );
        return persistence.transaction(async (tx) => {
          const sql = tx.forInstance(actor.instanceId);
          await requireOpenProject(sql, input.taskId);
          const task = await requireTask(sql, input.taskId, true);
          if (
            Number(task.scope_generation) !== input.expectedScopeGeneration ||
            Number(task.branch_generation) !== input.expectedBranchGeneration ||
            task.execution_state === "revoking" ||
            task.restore_operation_id ||
            task.runtime_owner_id !== leases.ownerId
          )
            throw new DesignTaskError(
              "design_restore_conflict",
              "任务恢复状态或代际已改变，请重新加载",
            );
          await options.goalLifecycle?.rebranch(
            sql,
            task,
            Number(task.branch_generation) + 1,
            Date.now(),
          );
          const operationId = randomUUID();
          await sql.execute(
            `update public.design_task_executions set execution_state='revoking',
            scope_generation=scope_generation+1,branch_generation=branch_generation+1,
            restore_operation_id=$2 where instance_id=:instance and task_id=$1`,
            [input.taskId, operationId],
          );
          await sql.execute(
            `update public.design_task_inputs set status='canceled',request=null
            where instance_id=:instance and task_id=$1 and status='queued'`,
            [input.taskId],
          );
          const updated = await requireTask(sql, input.taskId);
          const policy = designTaskPolicy(updated);
          return {
            taskId: input.taskId,
            projectId: policy.projectId,
            canvasId: policy.canvasId,
            operationId,
            scopeGeneration: policy.scopeGeneration,
            branchGeneration: policy.branchGeneration,
            activeRunId: updated.active_run_id,
            scope: {
              instanceId: actor.instanceId,
              projectId: policy.projectId,
              taskId: input.taskId,
              generation: policy.scopeGeneration,
              rootDirectory: policy.rootDirectory,
              additionalDirectories: policy.additionalDirectories,
              sandboxMode: policy.sandboxMode,
            },
          };
        });
      });
    },
    async finishRestore(actor, input) {
      await localInstance.resolve(actor);
      return leases.withTask(actor.instanceId, input.taskId, async () =>
        persistence.transaction(async (tx) => {
          const sql = tx.forInstance(actor.instanceId);
          if (input.state === "ready")
            await requireOpenProject(sql, input.taskId);
          const task = await requireTask(sql, input.taskId, true);
          if (
            task.runtime_owner_id !== leases.ownerId ||
            task.restore_operation_id !== input.operationId ||
            Number(task.scope_generation) !== input.scopeGeneration ||
            Number(task.branch_generation) !== input.branchGeneration ||
            task.execution_state !== "revoking" ||
            task.active_run_id
          )
            return false;
          await sql.execute(
            `update public.design_task_executions set execution_state=$2,restore_operation_id=null
          where instance_id=:instance and task_id=$1`,
            [input.taskId, input.state],
          );
          return true;
        }),
      );
    },
    async markRunStarted(actor, input) {
      await localInstance.resolve(actor);
      return persistence.transaction(async (tx) => {
        const sql = tx.forInstance(actor.instanceId);
        if (!(await loadOpenDesignProject(sql, input.taskId))) return false;
        const task = await requireTask(sql, input.taskId, true);
        if (
          task.active_run_id !== input.runId ||
          task.runtime_owner_id !== leases.ownerId ||
          task.run_state !== "running" ||
          task.execution_state !== "ready"
        )
          return false;
        const changed = await sql.execute(
          `update public.agent_runs r set status='running' from public.chat_sessions c
          where c.instance_id=:instance and c.id=$1 and c.mode='design' and r.session_id=c.id
            and r.id=$2 and r.status='accepted'`,
          [input.taskId, input.runId],
        );
        return changed === 1;
      });
    },
    close: leases.close,
    onLeaseLost: leases.onLost,
    async recoverInterruptedTasks(actor) {
      await localInstance.resolve(actor);
      const rows = await persistence
        .forInstance(actor.instanceId)
        .query<SqlRow & { task_id: string }>(
          `select d.task_id from public.design_task_executions d join public.projects p on p.id=d.project_id and p.instance_id=d.instance_id
            where d.instance_id=:instance and (d.active_run_id is not null or d.restore_operation_id is not null) and p.kind='design' and p.archived_at is null`,
        );
      let recovered = 0;
      for (const row of rows) {
        await leases.withTask(actor.instanceId, row.task_id, async () => {
          if (await leases.acquire(actor.instanceId, row.task_id)) recovered++;
        });
      }
      return recovered;
    },
    async prepareCreation(actor, canvasId) {
      const context = await localInstance.resolve(actor);
      const project = await persistence
        .forInstance(actor.instanceId)
        .queryOne<DesignProjectRow>(
          `select p.id as project_id, v.id as canvas_id, p.kind, p.work_dir, p.additional_directories
           from public.canvases v join public.projects p on p.id=v.project_id
          where p.instance_id=:instance and v.id=$1 and p.archived_at is null and p.archive_state='open'`,
          [canvasId],
        );
      if (!project)
        throw new DesignTaskError(
          "design_task_unavailable",
          "画布或项目不可用",
        );
      if (project.kind === "flow") return null;
      if (project.kind !== "design")
        throw new DesignTaskError(
          "design_task_unavailable",
          "项目类型不支持画布任务",
        );
      const rootDirectory = await persistence.transaction((tx) =>
        claimCanvasRootInTransaction(
          tx.forInstance(actor.instanceId),
          canvasId,
          (workDir) =>
            resolveProjectWorkDirectory({
              instanceId: actor.instanceId,
              projectId: project.project_id,
              sandboxRoot: sandboxRoot ?? join(context.dataDir, "sandbox"),
              workDir,
            }),
        ),
      );
      project.canvas_root_directory = rootDirectory;
      return {
        instanceId: actor.instanceId,
        projectId: project.project_id,
        canvasId,
        projectFingerprint: designProjectFingerprint(project),
        rootDirectory,
        additionalDirectories: normalizeAdditionalDirectories(
          project.additional_directories,
        ),
      };
    },
    async provision(actor, taskId) {
      await localInstance.resolve(actor);
      const existing = await loadDesignTask(
        persistence.forInstance(actor.instanceId),
        taskId,
      );
      if (existing) return designTaskPolicy(existing);
      const session = await persistence
        .forInstance(actor.instanceId)
        .queryOne<SqlRow & { canvas_id: string }>(
          `select c.canvas_id from public.chat_sessions c join public.projects p on p.id=c.project_id
          where c.instance_id=:instance and p.instance_id=:instance and c.id=$1
            and c.mode='design' and p.kind='design' and p.archived_at is null`,
          [taskId],
        );
      if (!session)
        throw new DesignTaskError("design_task_unavailable", "任务不可用");
      const prepared = await service.prepareCreation(actor, session.canvas_id);
      if (!prepared)
        throw new DesignTaskError(
          "design_task_unavailable",
          "任务类型不支持执行目录",
        );
      return persistence.transaction((tx) =>
        insertDesignTaskInTransaction(
          tx.forInstance(actor.instanceId),
          taskId,
          prepared,
        ),
      );
    },
    async read(actor, taskId) {
      return service.readPolicy(actor, taskId);
    },
    async readPolicy(actor, taskId) {
      await localInstance.resolve(actor);
      return designTaskPolicy(
        await requireTask(persistence.forInstance(actor.instanceId), taskId),
      );
    },
    async updatePolicy(actor, input) {
      await localInstance.resolve(actor);
      return admissionTransaction(async (tx) => {
        const sql = tx.forInstance(actor.instanceId);
        await requireOpenProject(sql, input.taskId);
        const task = await requireTask(sql, input.taskId, true);
        if (
          Number(task.scope_generation) !== input.scopeGeneration ||
          Number(task.planning_epoch) !== input.planningEpoch
        ) {
          throw new DesignTaskError(
            "design_task_policy_changed",
            "任务权限已变更，请重试",
          );
        }
        const mode = input.mode ?? task.permission_mode;
        const planEnabled = input.planEnabled ?? task.plan_enabled;
        if (mode === task.permission_mode && planEnabled === task.plan_enabled)
          return designTaskPolicy(task);
        if (task.active_run_id || task.execution_state !== "ready")
          throw new DesignTaskError("design_task_busy", "请先停止当前任务");
        const queued = await sql.queryOne(
          `select input_id from public.design_task_inputs
          where instance_id=:instance and task_id=$1 and status='queued' limit 1`,
          [input.taskId],
        );
        if (queued)
          throw new DesignTaskError(
            "design_task_queue_busy",
            "请先清空任务队列",
          );
        await sql.execute(
          `update public.design_task_executions set permission_mode=$2,plan_enabled=$3,
          planning_epoch=planning_epoch+1,scope_generation=scope_generation+1
          where instance_id=:instance and task_id=$1`,
          [input.taskId, mode, planEnabled],
        );
        return designTaskPolicy(await requireTask(sql, input.taskId));
      });
    },
    async admitInput(actor, input) {
      await localInstance.resolve(actor);
      if (!(await leases.acquire(actor.instanceId, input.taskId)))
        throw new DesignTaskError(
          "design_task_host_busy",
          "任务正在其他运行进程中执行",
        );
      const { accessToken: _accessToken, ...request } =
        runCreateRequestSchema.parse(input.request);
      if (
        request.sessionId !== input.taskId ||
        (request.taskId && request.taskId !== input.taskId) ||
        (request.preset && request.preset !== "design")
      )
        throw new DesignTaskError(
          "design_task_identity_mismatch",
          "任务身份不匹配",
        );
      const fingerprint = parameterFingerprint({
        request,
        scopeGeneration: input.scopeGeneration,
        branchGeneration: input.branchGeneration,
        origin: input.origin ?? "userInput",
        goalFence: input.goalFence,
      });
      return admissionTransaction(async (tx) => {
        const sql = tx.forInstance(actor.instanceId);
        await requireOpenProject(sql, input.taskId);
        const task = await requireTask(sql, input.taskId, true);
        const previous = await sql.queryOne<InputRow>(
          `select * from public.design_task_inputs where instance_id=:instance and task_id=$1 and input_id=$2`,
          [input.taskId, input.inputId],
        );
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new DesignTaskError(
              "design_input_conflict",
              "输入编号已用于其他内容",
            );
          return receipt(input.taskId, previous, "duplicate");
        }
        if (request.projectId && request.projectId !== task.project_id)
          throw new DesignTaskError(
            "design_task_identity_mismatch",
            "项目归属不匹配",
          );
        if (
          task.execution_state !== "ready" ||
          Number(task.scope_generation) !== input.scopeGeneration ||
          Number(task.branch_generation) !== input.branchGeneration
        )
          throw new DesignTaskError(
            "design_task_policy_changed",
            "任务权限已变更，请重试",
          );
        const modelInvocation =
          input.modelInvocation ?? (await input.captureModelInvocation?.());
        const queued = await sql.queryOne(
          `select input_id from public.design_task_inputs
          where instance_id=:instance and task_id=$1 and status='queued' limit 1`,
          [input.taskId],
        );
        const running = !task.active_run_id && !queued;
        if (input.origin === "goalContinuation" && !running)
          throw new DesignTaskError(
            "design_goal_conflict",
            "用户输入或前台运行优先",
          );
        if (running)
          await options.goalLifecycle?.claim(sql, task, {
            actor,
            ...(modelInvocation ? { modelInvocation } : {}),
            runId: input.runId,
            inputId: input.inputId,
            origin: input.origin ?? "userInput",
            ...(input.goalFence ? { goalFence: input.goalFence } : {}),
            ...(request.executionMode === "goal"
              ? { objective: request.prompt }
              : {}),
          });
        const row = await sql.queryOne<InputRow>(
          `insert into public.design_task_inputs
            (task_id,instance_id,input_id,run_id,admission_seq,scope_generation,branch_generation,request,fingerprint,created_by_client_id,status,input_origin,goal_fence,model_invocation)
           values ($1,:instance,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb,$13::jsonb) returning *`,
          [
            input.taskId,
            input.inputId,
            input.runId,
            Number(task.next_input_seq),
            input.scopeGeneration,
            input.branchGeneration,
            JSON.stringify(request),
            fingerprint,
            actor.accessClientId,
            running ? "running" : "queued",
            input.origin ?? "userInput",
            input.goalFence ? JSON.stringify(input.goalFence) : null,
            modelInvocation ? JSON.stringify(modelInvocation) : null,
          ],
        );
        await sql.execute(
          `update public.design_task_executions set next_input_seq=next_input_seq+1,
          active_run_id=case when $2 then $3 else active_run_id end,
          run_state=case when $2 then 'running' else run_state end
          where instance_id=:instance and task_id=$1`,
          [input.taskId, running, input.runId],
        );
        if (!row)
          throw new DesignTaskError("design_task_unavailable", "输入登记失败");
        return receipt(input.taskId, row, running ? "running" : "queued");
      });
    },
    async claimNextInput(actor, taskId) {
      await localInstance.resolve(actor);
      if (!(await leases.acquire(actor.instanceId, taskId))) return null;
      return admissionTransaction(async (tx) => {
        const sql = tx.forInstance(actor.instanceId);
        if (!(await loadOpenDesignProject(sql, taskId))) return null;
        const task = await requireTask(sql, taskId, true);
        if (task.active_run_id || task.execution_state !== "ready") return null;
        await sql.execute(
          `update public.design_task_inputs set status='canceled',request=null
          where instance_id=:instance and task_id=$1 and status='queued'
            and (scope_generation<>$2 or branch_generation<>$3)`,
          [
            taskId,
            Number(task.scope_generation),
            Number(task.branch_generation),
          ],
        );
        const row = await sql.queryOne<InputRow>(
          `select * from public.design_task_inputs
          where instance_id=:instance and task_id=$1 and status='queued' order by admission_seq limit 1 for update`,
          [taskId],
        );
        if (!row) return null;
        await options.goalLifecycle?.claim(sql, task, {
          actor: {
            instanceId: actor.instanceId,
            accessClientId: row.created_by_client_id,
          },
          ...(row.model_invocation
            ? { modelInvocation: row.model_invocation }
            : {}),
          runId: row.run_id,
          inputId: row.input_id,
          origin: row.input_origin,
          ...(row.goal_fence ? { goalFence: row.goal_fence } : {}),
          ...(row.request?.executionMode === "goal"
            ? { objective: row.request.prompt }
            : {}),
        });
        await sql.execute(
          `update public.design_task_inputs set status='running'
          where instance_id=:instance and task_id=$1 and input_id=$2`,
          [taskId, row.input_id],
        );
        await sql.execute(
          `update public.design_task_executions set active_run_id=$2,run_state='running'
          where instance_id=:instance and task_id=$1`,
          [taskId, row.run_id],
        );
        return receipt(taskId, row, "running");
      });
    },
    async requestStop(actor, input) {
      await localInstance.resolve(actor);
      return persistence.transaction(async (tx) => {
        const sql = tx.forInstance(actor.instanceId);
        const task = await requireTask(sql, input.taskId, true);
        if (input.expectedRunId && task.active_run_id !== input.expectedRunId)
          return { kind: "targetChanged" };
        await options.goalLifecycle?.pause(sql, task, "user.stop", Date.now());
        await sql.execute(
          `update public.design_task_inputs set status='canceled',request=null
          where instance_id=:instance and task_id=$1 and status='queued'`,
          [input.taskId],
        );
        if (!task.active_run_id) return { kind: "idle" };
        await sql.execute(
          `update public.design_task_executions set run_state='stopping'
          where instance_id=:instance and task_id=$1`,
          [input.taskId],
        );
        return { kind: "stopping", runId: task.active_run_id };
      });
    },
    async settleRun(actor, input) {
      await localInstance.resolve(actor);
      const settled = await persistence.transaction(async (tx) => {
        const sql = tx.forInstance(actor.instanceId);
        const task = await requireTask(sql, input.taskId, true);
        if (
          task.active_run_id !== input.runId ||
          task.runtime_owner_id !== leases.ownerId
        )
          return false;
        let outcome = input.outcome;
        let matched = true;
        if (input.terminalMetadata) {
          const run = await sql.queryOne<SqlRow & { status: string }>(
            `select r.status from public.agent_runs r join public.chat_sessions c on c.id=r.session_id
              where c.instance_id=:instance and c.id=$1 and r.id=$2 for update of r`,
            [input.taskId, input.runId],
          );
          if (!run)
            throw new DesignTaskError(
              "design_run_missing",
              "运行账本缺少准入记录",
            );
          if (
            run.status === "completed" ||
            run.status === "canceled" ||
            run.status === "failed"
          ) {
            outcome = run.status;
            matched = outcome === input.outcome;
          } else {
            await sql.execute(
              `update public.agent_runs r set status=$3,completed_at=$4,
              error_code=$5,error_message=$6,stop_reason=$7 from public.chat_sessions c
              where c.instance_id=:instance and c.id=$1 and r.session_id=c.id and r.id=$2
                and r.status in ('accepted','running')`,
              [
                input.taskId,
                input.runId,
                outcome,
                input.terminalMetadata.completedAt,
                input.terminalMetadata.errorCode ?? null,
                input.terminalMetadata.errorMessage ?? null,
                input.terminalMetadata.stopReason ?? null,
              ],
            );
          }
          const assistant = input.terminalMetadata.assistant;
          if (matched && assistant)
            await sql.execute(
              `insert into public.chat_messages(id,session_id,role,content,content_blocks)
              select $1,c.id,'assistant',$3,$4::jsonb from public.chat_sessions c
              where c.instance_id=:instance and c.id=$2 and c.mode='design' on conflict(id) do nothing`,
              [
                assistant.messageId,
                input.taskId,
                assistant.text,
                JSON.stringify(assistant.blocks),
              ],
            );
        }
        await options.goalLifecycle?.settle(sql, task, {
          runId: input.runId,
          outcome,
          at: input.terminalMetadata
            ? new Date(input.terminalMetadata.completedAt).getTime()
            : Date.now(),
        });
        await sql.execute(
          `update public.design_task_inputs set status='settled',request=null
          where instance_id=:instance and task_id=$1 and run_id=$2 and status='running'`,
          [input.taskId, input.runId],
        );
        await sql.execute(
          `update public.design_task_executions set active_run_id=null,run_state='idle',
          last_settled_run_id=$2,last_run_outcome=$3 where instance_id=:instance and task_id=$1`,
          [input.taskId, input.runId, outcome],
        );
        return matched;
      });

      return settled;
    },
  };
  const admit = service.admitInput.bind(service);
  service.admitInput = (actor, input) =>
    leases.withTask(actor.instanceId, input.taskId, () => admit(actor, input));
  const claim = service.claimNextInput.bind(service);
  service.claimNextInput = (actor, taskId) =>
    leases.withTask(actor.instanceId, taskId, () => claim(actor, taskId));
  const settle = service.settleRun.bind(service);
  service.settleRun = (actor, input) =>
    leases.withTask(actor.instanceId, input.taskId, () => settle(actor, input));
  const stop = service.requestStop.bind(service);
  service.requestStop = (actor, input) =>
    leases.withTask(actor.instanceId, input.taskId, () => stop(actor, input));
  return service;
}
