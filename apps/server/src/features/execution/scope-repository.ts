import {
  type AdditionalDirectory,
  type CodeExecutionScope,
  codeExecutionScopeSchema,
  type SandboxMode,
} from "@kenfutwork/shared";
import type { PersistenceService, SqlRow } from "../persistence/types.js";
import { loadOpenDesignProject } from "./design-project-authority.js";

export type ScopeState = "ready" | "revoking" | "failed";
export type StoredExecutionScope = {
  preset: "code" | "design";
  scope: CodeExecutionScope;
  state: ScopeState;
  branchGeneration: number;
};
export type TaskScopePatch = {
  additionalDirectories?: AdditionalDirectory[] | undefined;
  sandboxMode?: SandboxMode | undefined;
};
export interface ScopeRepository {
  isProjectOpen?(scope: CodeExecutionScope): Promise<boolean>;
  load(
    instanceId: string,
    taskId: string,
  ): Promise<StoredExecutionScope | null>;
  beginUpdate?(
    scope: CodeExecutionScope,
    patch: TaskScopePatch,
  ): Promise<StoredExecutionScope | null>;
  finishUpdate?(
    scope: CodeExecutionScope,
    state: "ready" | "failed",
  ): Promise<boolean>;
}

type ScopeRow = SqlRow & {
  id: string;
  project_id: string;
  instance_id: string;
  root_directory: string;
  additional_directories: AdditionalDirectory[];
  sandbox_mode: SandboxMode;
  scope_generation: number | string;
  branch_generation: number | string;
  execution_state: ScopeState;
};

function fromRow(
  row: ScopeRow,
  preset: "code" | "design" = "code",
): StoredExecutionScope {
  return {
    preset,
    branchGeneration: Number(row.branch_generation),
    state: row.execution_state,
    scope: codeExecutionScopeSchema.parse({
      instanceId: row.instance_id,
      projectId: row.project_id,
      taskId: row.id,
      generation: Number(row.scope_generation),
      rootDirectory: row.root_directory,
      additionalDirectories: row.additional_directories,
      sandboxMode: row.sandbox_mode,
    }),
  };
}

export function createScopeRepository(
  persistence: PersistenceService,
): ScopeRepository {
  return {
    async load(instanceId, taskId) {
      const row = await persistence.forInstance(instanceId).queryOne<ScopeRow>(
        `select s.id, s.project_id, s.instance_id, s.root_directory,
                s.additional_directories, s.sandbox_mode, s.scope_generation, s.execution_state, s.branch_generation
           from public.code_ui_sessions s
           join public.projects p on p.id = s.project_id and p.instance_id = s.instance_id
           join public.chat_sessions c on c.id = s.chat_session_id and c.project_id = p.id
          where s.instance_id = :instance and s.id = $1
            and c.instance_id = :instance and c.mode = 'code' and p.kind = 'code'
            and p.archived_at is null and s.deleted_at is null and s.archived = false
            and s.parent_session_id is null`,
        [taskId],
      );
      if (row) return fromRow(row);
      const mode = await persistence.forInstance(instanceId).queryOne(
        `select c.mode from public.chat_sessions c join public.projects p on p.id=c.project_id
          where c.instance_id=:instance and p.instance_id=:instance and c.id=$1
            and c.mode='design' and p.kind='design' and p.archived_at is null`,
        [taskId],
      );
      if (!mode) return null;
      const design = await persistence
        .forInstance(instanceId)
        .queryOne<ScopeRow>(
          `select d.*, d.task_id as id from public.design_task_executions d
          where d.instance_id=:instance and d.task_id=$1`,
          [taskId],
        );
      return design ? fromRow(design, "design") : null;
    },
    async isProjectOpen(scope) {
      const project = await loadOpenDesignProject(
        persistence.forInstance(scope.instanceId),
        scope.taskId,
      );
      return project?.id === scope.projectId;
    },
    async beginUpdate(scope, patch) {
      const current = await this.load(scope.instanceId, scope.taskId);
      if (current?.preset === "design") {
        return persistence.transaction(async (tx) => {
          const sql = tx.forInstance(scope.instanceId);
          if (
            (await loadOpenDesignProject(sql, scope.taskId))?.id !==
            scope.projectId
          )
            return null;
          const row = await sql.queryOne<ScopeRow>(
            `update public.design_task_executions d set
             additional_directories=coalesce($3::jsonb,d.additional_directories),
             sandbox_mode=coalesce($4::text,d.sandbox_mode),
             scope_generation=scope_generation+1,execution_state='revoking'
           from public.chat_sessions c, public.projects p
           where d.instance_id=:instance and c.instance_id=:instance and p.instance_id=:instance
             and c.id=d.task_id and c.project_id=d.project_id and p.id=d.project_id
             and c.mode='design' and p.kind='design' and p.archived_at is null
             and d.task_id=$1 and d.scope_generation=$2 and d.execution_state<>'revoking'
           returning d.*,d.task_id as id`,
            [
              scope.taskId,
              scope.generation,
              patch.additionalDirectories === undefined
                ? null
                : JSON.stringify(patch.additionalDirectories),
              patch.sandboxMode ?? null,
            ],
          );
          return row ? fromRow(row, "design") : null;
        });
      }
      const row = await persistence
        .forInstance(scope.instanceId)
        .queryOne<ScopeRow>(
          `update public.code_ui_sessions s
            set additional_directories = coalesce($3::jsonb, s.additional_directories),
                sandbox_mode = coalesce($4::text, s.sandbox_mode),
                scope_generation = scope_generation + 1, execution_state = 'revoking'
           from public.projects p
          where s.instance_id = :instance and p.instance_id = :instance
            and p.id = s.project_id and p.kind = 'code' and p.archived_at is null
            and s.id = $1 and s.scope_generation = $2 and s.deleted_at is null
            and s.parent_session_id is null and s.execution_state <> 'revoking'
          returning s.*`,
          [
            scope.taskId,
            scope.generation,
            patch.additionalDirectories === undefined
              ? null
              : JSON.stringify(patch.additionalDirectories),
            patch.sandboxMode ?? null,
          ],
        );
      return row ? fromRow(row) : null;
    },
    async finishUpdate(scope, state) {
      const current = await this.load(scope.instanceId, scope.taskId);
      if (current?.preset === "design") {
        return persistence.transaction(async (tx) => {
          const sql = tx.forInstance(scope.instanceId);
          if (
            state === "ready" &&
            (await loadOpenDesignProject(sql, scope.taskId))?.id !==
              scope.projectId
          )
            return false;
          return (
            (await sql.execute(
              `update public.design_task_executions set execution_state=$3
            where instance_id=:instance and task_id=$1 and scope_generation=$2
              and execution_state='revoking'`,
              [scope.taskId, scope.generation, state],
            )) === 1
          );
        });
      }
      return (
        (await persistence.forInstance(scope.instanceId).execute(
          `update public.code_ui_sessions set execution_state = $3
          where instance_id = :instance and id = $1 and scope_generation = $2
            and execution_state = 'revoking' and deleted_at is null`,
          [scope.taskId, scope.generation, state],
        )) === 1
      );
    },
  };
}
