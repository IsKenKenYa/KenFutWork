import {
  type AdditionalDirectory,
  type CodeExecutionScope,
  codeExecutionScopeSchema,
  type SandboxMode,
} from "@kenfutwork/shared";
import type { PersistenceService, SqlRow } from "../persistence/types.js";

export type ScopeState = "ready" | "revoking" | "failed";
export type StoredExecutionScope = {
  scope: CodeExecutionScope;
  state: ScopeState;
  branchGeneration: number;
};
export type TaskScopePatch = {
  additionalDirectories?: AdditionalDirectory[] | undefined;
  sandboxMode?: SandboxMode | undefined;
};
export interface ScopeRepository {
  load(
    workspaceId: string,
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
  workspace_id: string;
  root_directory: string;
  additional_directories: AdditionalDirectory[];
  sandbox_mode: SandboxMode;
  scope_generation: number | string;
  branch_generation: number | string;
  execution_state: ScopeState;
};

function fromRow(row: ScopeRow): StoredExecutionScope {
  return {
    branchGeneration: Number(row.branch_generation),
    state: row.execution_state,
    scope: codeExecutionScopeSchema.parse({
      workspaceId: row.workspace_id,
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
    async load(workspaceId, taskId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<ScopeRow>(
          `select s.id, s.project_id, s.workspace_id, s.root_directory,
                s.additional_directories, s.sandbox_mode, s.scope_generation, s.execution_state, s.branch_generation
           from public.code_ui_sessions s
           join public.projects p on p.id = s.project_id and p.workspace_id = s.workspace_id
           join public.chat_sessions c on c.id = s.chat_session_id and c.project_id = p.id
          where s.workspace_id = :workspace and s.id = $1
            and c.workspace_id = :workspace and c.mode = 'code' and p.kind = 'code'
            and p.archived_at is null and s.deleted_at is null and s.archived = false
            and s.parent_session_id is null`,
          [taskId],
        );
      return row ? fromRow(row) : null;
    },
    async beginUpdate(scope, patch) {
      const row = await persistence
        .forWorkspace(scope.workspaceId)
        .queryOne<ScopeRow>(
          `update public.code_ui_sessions s
            set additional_directories = coalesce($3::jsonb, s.additional_directories),
                sandbox_mode = coalesce($4::text, s.sandbox_mode),
                scope_generation = scope_generation + 1, execution_state = 'revoking'
           from public.projects p
          where s.workspace_id = :workspace and p.workspace_id = :workspace
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
      return (
        (await persistence.forWorkspace(scope.workspaceId).execute(
          `update public.code_ui_sessions set execution_state = $3
          where workspace_id = :workspace and id = $1 and scope_generation = $2
            and execution_state = 'revoking' and deleted_at is null`,
          [scope.taskId, scope.generation, state],
        )) === 1
      );
    },
  };
}
