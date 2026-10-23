import {
  type AdditionalDirectory,
  type CodeProjectEditorProject,
  codeProjectEditorProjectSchema,
} from "@kenfutwork/shared";
import { CodeUiHostRpcError } from "../code-ui/host-rpc-handler.js";
import type {
  InstanceSqlClient,
  PersistenceService,
  SqlRow,
} from "../persistence/types.js";

export type ProjectEditorRow = SqlRow & {
  id: string;
  name: string;
  work_dir: string | null;
  additional_directories: AdditionalDirectory[];
  created_at: string;
  updated_at: string;
  editor_revision: number;
  archived_at: string | null;
  archive_state: "open" | "closing" | "failed";
};

export type ProjectEditorChange = {
  name: string;
  additionalDirectories: AdditionalDirectory[];
};

export interface ProjectEditorRepository {
  list(instanceId: string): Promise<CodeProjectEditorProject[]>;
  save(
    instanceId: string,
    projectId: string,
    expectedRevision: number,
    parameterFingerprint: string,
    signal: AbortSignal,
    prepare: (project: ProjectEditorRow) => ProjectEditorChange,
  ): Promise<CodeProjectEditorProject>;
}

function projectEditorProject(row: ProjectEditorRow): CodeProjectEditorProject {
  return codeProjectEditorProjectSchema.parse({
    id: row.id,
    hostId: "local",
    name: row.name,
    roots: [
      ...(row.work_dir
        ? [{ rootPath: row.work_dir, position: 0, isPrimary: true }]
        : []),
      ...row.additional_directories.map((directory, index) => ({
        rootPath: directory.path,
        position: index + 1,
        isPrimary: false,
        access: directory.access,
      })),
    ],
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    revision: row.editor_revision,
  });
}

function changed(row: ProjectEditorRow, change: ProjectEditorChange): boolean {
  return (
    row.name !== change.name ||
    row.additional_directories.length !== change.additionalDirectories.length ||
    row.additional_directories.some((directory, index) => {
      const next = change.additionalDirectories[index];
      return directory.path !== next?.path || directory.access !== next?.access;
    })
  );
}

function conflict(message = "项目已更新，请刷新后重新保存。") {
  return new CodeUiHostRpcError("project_revision_conflict", message, 409);
}

async function activeProject(sql: InstanceSqlClient, projectId: string) {
  const project = await sql.queryOne<ProjectEditorRow>(
    `select * from public.projects
      where instance_id=:instance and id=$1 for update`,
    [projectId],
  );
  if (!project || project.archived_at)
    throw new CodeUiHostRpcError(
      "project_not_found",
      "项目已归档或删除，请刷新项目列表。",
      404,
    );
  if (project.archive_state !== "open")
    throw conflict("项目正在关闭，请处理完成后再编辑。");
  return project;
}

export function createProjectEditorRepository(
  persistence: PersistenceService,
): ProjectEditorRepository {
  return {
    async list(instanceId) {
      const projects = await persistence
        .forInstance(instanceId)
        .query<ProjectEditorRow>(
          `select * from public.projects
            where instance_id=:instance and archived_at is null
            order by updated_at desc,id`,
        );
      return projects.map(projectEditorProject);
    },
    async save(
      instanceId,
      projectId,
      expectedRevision,
      parameterFingerprint,
      signal,
      prepare,
    ) {
      return persistence.transaction(async (tx) => {
        signal.throwIfAborted();
        const sql = tx.forInstance(instanceId);
        const project = await activeProject(sql, projectId);
        signal.throwIfAborted();
        const receipt = await sql.queryOne<
          SqlRow & { parameter_fingerprint: string; result: unknown }
        >(
          `select parameter_fingerprint,result from public.project_editor_save_receipts
            where instance_id=:instance and project_id=$1 and expected_revision=$2`,
          [projectId, expectedRevision],
        );
        if (receipt) {
          if (receipt.parameter_fingerprint !== parameterFingerprint)
            throw conflict("同一项目修订已保存其他修改，请刷新后重新编辑。");
          return codeProjectEditorProjectSchema.parse(receipt.result);
        }
        if (project.editor_revision !== expectedRevision) throw conflict();
        const change = prepare(project);
        if (!changed(project, change)) return projectEditorProject(project);
        signal.throwIfAborted();
        const updated = await sql.queryOne<ProjectEditorRow>(
          `update public.projects
              set name=$2,additional_directories=$3::jsonb
            where instance_id=:instance and id=$1
            returning *`,
          [
            projectId,
            change.name,
            JSON.stringify(change.additionalDirectories),
          ],
        );
        if (!updated) throw conflict();
        const result = projectEditorProject(updated);
        await sql.execute(
          `insert into public.project_editor_save_receipts
              (instance_id,project_id,expected_revision,parameter_fingerprint,result)
            values (:instance,$1,$2,$3,$4::jsonb)`,
          [
            projectId,
            expectedRevision,
            parameterFingerprint,
            JSON.stringify(result),
          ],
        );
        signal.throwIfAborted();
        return result;
      });
    },
  };
}
