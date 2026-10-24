import type {
  AdditionalDirectory,
  CodeExecutionScope,
} from "@kenfutwork/shared";
import { canonicalLocalWorkspaceIdentity } from "@zcode/shared";
import { jsonbSafeStringify } from "../../utils/text-sanitize.js";
import type {
  InstanceSqlClient,
  PersistenceService,
  SqlRow,
} from "../persistence/types.js";
import type { CodeUiConversationState } from "./conversation.js";
import { syncGoal } from "./goals.js";
import type { CodeUiSessionRecord } from "./repository.js";
import {
  moveConflict,
  moveNotFound,
  type TaskProjectMoveInput,
} from "./task-project-move-types.js";

type Receipt = SqlRow & {
  parameter_fingerprint: string;
  state: "preparing" | "committed";
  scope_generation: string | number;
};
type Project = SqlRow & {
  id: string;
  work_dir: string;
  additional_directories: AdditionalDirectory[];
};

function moveKey(input: TaskProjectMoveInput) {
  return [
    input.task.taskId,
    input.sourceProjectId,
    input.projectId,
    input.observedRevision,
  ];
}

async function root(sql: InstanceSqlClient, taskId: string) {
  const record = await sql.queryOne<CodeUiSessionRecord>(
    "select * from public.code_ui_sessions where instance_id=:instance and id=$1 and parent_session_id is null and deleted_at is null for update",
    [taskId],
  );
  if (!record?.state || !record.root_directory || record.archived)
    throw moveNotFound();
  const owner = await sql.queryOne(
    "select task_id from public.execution_task_owners where instance_id=:instance and task_id=$1 and project_id=$2 and task_kind='code' and code_task_id=$1 for update",
    [taskId, record.project_id],
  );
  if (!owner) throw moveNotFound();
  return record;
}

function stopped(record: CodeUiSessionRecord) {
  const state = record.state!;
  const goal = state.goalRecord;
  if (
    record.active_run_id ||
    state.inputs?.some((input) =>
      ["active", "reserved", "queued"].includes(input.status),
    ) ||
    state.snapshots.some(
      (snapshot) =>
        ["running", "prewarming"].includes(snapshot.control.phase) ||
        snapshot.control.stopState !== "idle" ||
        snapshot.control.activeWorks.length > 0 ||
        snapshot.pendingInteractions.length > 0 ||
        snapshot.pendingCommands.length > 0 ||
        snapshot.queue.items.length > 0 ||
        (snapshot.subagents?.running.length ?? 0) > 0 ||
        snapshot.backgroundWorks.some((work) =>
          ["running", "resultPending"].includes(work.status),
        ) ||
        (snapshot.goal &&
          !["paused", "verified", "failed"].includes(snapshot.goal.status)),
    ) ||
    (goal &&
      (!["paused", "complete", "failed"].includes(goal.status) ||
        goal.claimedRunId ||
        goal.evaluation))
  )
    throw moveConflict("任务仍有运行、输入、审批或目标，请处理完成后再移动。");
}

async function noPendingWork(sql: InstanceSqlClient, taskId: string) {
  const pending = await sql.queryOne(
    `select 1 as pending where
       exists(select 1 from public.code_ui_sessions where instance_id=:instance and root_session_id=$1 and active_run_id is not null and deleted_at is null)
       or exists(select 1 from public.task_works where instance_id=:instance and task_id=$1 and (status='running' or consumed_at is null))
       or exists(select 1 from public.agent_runs r join public.code_ui_sessions s on s.chat_session_id=r.session_id where s.instance_id=:instance and s.root_session_id=$1 and r.status in ('accepted','running'))
       or exists(select 1 from public.background_jobs j join public.code_ui_sessions s on s.chat_session_id=j.session_id where j.instance_id=:instance and s.instance_id=:instance and s.root_session_id=$1 and j.status in ('queued','running'))
       or exists(select 1 from public.code_ui_commands c join public.code_ui_sessions s on s.id=c.session_id where c.instance_id=:instance and s.instance_id=:instance and s.root_session_id=$1 and c.status='pending')
       or exists(select 1 from public.code_history_preparations where instance_id=:instance and (source_task_id=$1 or target_task_id=$1) and published=false)
       or exists(select 1 from public.code_attachments where instance_id=:instance and task_id=$1 and status='staging')`,
    [taskId],
  );
  if (pending) throw moveConflict("任务还有未结束的工作，请确认关闭后再移动。");
}

async function projects(sql: InstanceSqlClient, input: TaskProjectMoveInput) {
  if (input.sourceProjectId === input.projectId)
    throw moveConflict("请选择另一个项目。");
  const records = await sql.query<Project>(
    "select id,work_dir,additional_directories from public.projects where instance_id=:instance and id=any($1::uuid[]) and archived_at is null and enabled_modes && array['code','design']::text[] order by id for update",
    [[input.sourceProjectId, input.projectId]],
  );
  const target = records.find((project) => project.id === input.projectId);
  if (records.length !== 2 || !target) throw moveNotFound();
  return target;
}

function directories(
  target: Project,
  record: CodeUiSessionRecord,
  input: TaskProjectMoveInput,
) {
  const current = target.additional_directories;
  if (
    target.work_dir === record.root_directory ||
    current.some((entry) => entry.path === record.root_directory)
  )
    return current;
  if (!input.addMissingRoot)
    throw moveConflict("project.root-confirmation-required");
  return [
    ...current,
    { path: record.root_directory!, access: "read-write" as const },
  ];
}

async function receipt(
  sql: InstanceSqlClient,
  input: TaskProjectMoveInput,
  fingerprint: string,
) {
  const previous = await sql.queryOne<Receipt>(
    "select parameter_fingerprint,state,scope_generation from public.code_ui_task_project_moves where instance_id=:instance and task_id=$1 and source_project_id=$2 and target_project_id=$3 and observed_revision=$4 for update",
    moveKey(input),
  );
  if (previous && previous.parameter_fingerprint !== fingerprint)
    throw moveConflict("同一次移动不能提交不同参数，请重新加载任务。");
  return previous;
}

function matchesObserved(
  record: CodeUiSessionRecord,
  input: TaskProjectMoveInput,
) {
  const snapshot = record.state!.snapshots.find(
    (entry) => entry.sessionId === record.id,
  );
  if (
    record.project_id !== input.sourceProjectId ||
    snapshot?.revision !== input.observedRevision
  )
    throw moveConflict("任务归属或内容已改变，请重新加载后移动。");
  if (
    record.root_directory !== input.task.workspacePath ||
    (input.task.workspaceIdentity !== undefined &&
      input.task.workspaceIdentity !==
        canonicalLocalWorkspaceIdentity(
          input.sourceProjectId,
          record.root_directory!,
        ))
  )
    throw moveNotFound();
}

async function preparedReceipt(
  sql: InstanceSqlClient,
  record: CodeUiSessionRecord,
  input: TaskProjectMoveInput,
  fingerprint: string,
) {
  const previous = await receipt(sql, input, fingerprint);
  if (!previous) return null;
  const generation = Number(previous.scope_generation);
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw moveConflict("移动回执的授权版本无效，请重新加载任务。");
  if (previous.state === "preparing") {
    matchesObserved(record, input);
    if (
      record.execution_state !== "revoking" ||
      Number(record.scope_generation) !== generation
    )
      throw moveConflict("任务在关闭期间已改变，请重新加载。");
    stopped(record);
    await noPendingWork(sql, record.id);
    directories(await projects(sql, input), record, input);
  }
  return {
    committed: previous.state === "committed",
    generation,
    workspacePath: record.root_directory!,
    sessionIds: record.state!.snapshots.map((entry) => entry.sessionId),
  };
}

function movedState(
  record: CodeUiSessionRecord,
  targetProjectId: string,
): CodeUiConversationState {
  const state = structuredClone(record.state!);
  const historyOwners = [
    ...(state.inheritedHistory ?? []).map((turn) => turn.owner),
    ...(state.inheritedSessions ?? []).map((session) => session.owner),
  ];
  if (
    historyOwners.some(
      (owner) =>
        owner.instanceId !== record.instance_id ||
        owner.taskId !== record.id ||
        owner.projectId !== record.project_id,
    )
  )
    throw moveConflict("历史归属与任务不一致，请重新加载后移动。");
  for (const owner of historyOwners) owner.projectId = targetProjectId;
  for (const snapshot of state.snapshots) {
    snapshot.revision += 1;
    snapshot.seq += 1;
  }
  if (state.goalRecord) {
    state.goalRecord.branchGeneration = Number(record.branch_generation) + 1;
    state.goalRecord.revision += 1;
    syncGoal(state, record.id);
  }
  return state;
}

export function createTaskProjectMoveRepository(
  persistence: PersistenceService,
) {
  return {
    replay(
      instanceId: string,
      input: TaskProjectMoveInput,
      fingerprint: string,
      signal: AbortSignal,
    ) {
      return persistence.transaction(async (transaction) => {
        signal.throwIfAborted();
        const sql = transaction.forInstance(instanceId);
        const record = await root(sql, input.task.taskId);
        signal.throwIfAborted();
        const previous = await preparedReceipt(sql, record, input, fingerprint);
        signal.throwIfAborted();
        return previous;
      });
    },
    prepare(
      instanceId: string,
      input: TaskProjectMoveInput,
      fingerprint: string,
      scope: CodeExecutionScope,
      signal: AbortSignal,
    ) {
      return persistence.transaction(async (transaction) => {
        signal.throwIfAborted();
        const sql = transaction.forInstance(instanceId);
        const record = await root(sql, input.task.taskId);
        signal.throwIfAborted();
        const previous = await preparedReceipt(sql, record, input, fingerprint);
        signal.throwIfAborted();
        if (previous) return previous;
        const sessionIds = record.state!.snapshots.map(
          (entry) => entry.sessionId,
        );
        matchesObserved(record, input);
        if (
          record.execution_state !== "ready" ||
          scope.projectId !== record.project_id ||
          scope.generation !== Number(record.scope_generation)
        )
          throw moveConflict("任务授权正在改变，请确认关闭后重新加载。");
        stopped(record);
        await noPendingWork(sql, record.id);
        signal.throwIfAborted();
        directories(await projects(sql, input), record, input);
        signal.throwIfAborted();
        const generation = Number(record.scope_generation) + 1;
        await sql.execute(
          "update public.code_ui_sessions set execution_state='revoking',scope_generation=scope_generation+1 where instance_id=:instance and root_session_id=$1 and deleted_at is null",
          [record.id],
        );
        await sql.execute(
          `insert into public.code_ui_task_project_moves(instance_id,task_id,source_project_id,target_project_id,observed_revision,parameter_fingerprint,state,scope_generation)
           values(:instance,$1,$2,$3,$4,$5,'preparing',$6)
           on conflict(instance_id,task_id,source_project_id,target_project_id,observed_revision)
           do update set state='preparing',scope_generation=excluded.scope_generation`,
          [...moveKey(input), fingerprint, generation],
        );
        signal.throwIfAborted();
        return {
          committed: false,
          generation,
          workspacePath: record.root_directory!,
          sessionIds,
        };
      });
    },
    commit(
      instanceId: string,
      input: TaskProjectMoveInput,
      fingerprint: string,
      generation: number,
    ) {
      return persistence.transaction(async (transaction) => {
        const sql = transaction.forInstance(instanceId);
        const record = await root(sql, input.task.taskId);
        const previous = await receipt(sql, input, fingerprint);
        if (previous?.state === "committed") return;
        if (
          !previous ||
          Number(previous.scope_generation) !== generation ||
          record.execution_state !== "revoking" ||
          Number(record.scope_generation) !== generation
        )
          throw moveConflict("任务在关闭期间已改变，请重新加载。");
        matchesObserved(record, input);
        stopped(record);
        await noPendingWork(sql, record.id);
        const additional = directories(
          await projects(sql, input),
          record,
          input,
        );
        await sql.execute(
          "update public.projects set additional_directories=$2::jsonb,updated_at=now() where instance_id=:instance and id=$1",
          [input.projectId, jsonbSafeStringify(additional)],
        );
        await sql.execute(
          "update public.chat_sessions c set project_id=$2 from public.code_ui_sessions s where c.instance_id=:instance and s.instance_id=:instance and c.id=s.chat_session_id and s.root_session_id=$1",
          [record.id, input.projectId],
        );
        await sql.execute(
          "update public.execution_task_owners set project_id=$2 where instance_id=:instance and task_id=$1 and project_id=$3 and task_kind='code'",
          [record.id, input.projectId, input.sourceProjectId],
        );
        await sql.execute(
          `update public.code_ui_sessions set project_id=$2,execution_state='ready',branch_generation=branch_generation+1,state=case when id=$1 then $3::jsonb else state end,revision=revision+1,updated_at=now()
           where instance_id=:instance and root_session_id=$1 and deleted_at is null`,
          [
            record.id,
            input.projectId,
            jsonbSafeStringify(movedState(record, input.projectId)),
          ],
        );
        await sql.execute(
          "update public.code_ui_task_project_moves set state='committed' where instance_id=:instance and task_id=$1 and source_project_id=$2 and target_project_id=$3 and observed_revision=$4",
          moveKey(input),
        );
      });
    },
    fail(instanceId: string, taskId: string, generation: number) {
      return persistence
        .forInstance(instanceId)
        .execute(
          "update public.code_ui_sessions set execution_state='failed' where instance_id=:instance and root_session_id=$1 and scope_generation=$2 and execution_state='revoking' and deleted_at is null",
          [taskId, generation],
        );
    },
  };
}
