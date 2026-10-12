import type {
  InstanceSqlClient,
  PersistenceService,
} from "../persistence/types.js";
import {
  ProjectFileError,
  type ProjectFileRecord,
  type ProjectFileRelink,
  type ProjectFileRepository,
} from "./types.js";

export function createProjectFileRepository(
  persistence: PersistenceService,
): ProjectFileRepository {
  const find = async (instanceId: string, assetId: string) => {
    const row = await persistence
      .forInstance(instanceId)
      .queryOne<ProjectFileRecord>(
        `select a.id, a.instance_id, a.project_id, a.task_id, a.task_kind, a.canvas_id, a.relative_path,
      a.pending_relative_path, a.write_fingerprint, a.scope_generation, a.file_state, a.mime_type, a.byte_size
     from public.asset_objects a join public.projects p on p.id=a.project_id and p.instance_id=a.instance_id
     where a.instance_id=:instance and a.id=$1 and a.file_state<>'legacy' and p.archived_at is null`,
        [assetId],
      );
    return row
      ? {
          ...row,
          byte_size: row.byte_size === null ? null : Number(row.byte_size),
          scope_generation:
            row.scope_generation === null ? null : Number(row.scope_generation),
        }
      : null;
  };
  async function relink(
    sql: InstanceSqlClient,
    assetId: string,
    input: ProjectFileRelink,
    byteSize: number,
  ) {
    const changed = await sql.execute(
      `update public.asset_objects a set relative_path=$4,write_fingerprint=$5,byte_size=$6,pending_relative_path=null,canvas_id=coalesce($7::uuid,a.canvas_id)
          where a.instance_id=:instance and a.id=$1 and a.relative_path=$2 and a.write_fingerprint=$3
            and a.file_state='ready' and a.pending_relative_path is null
            and exists(select 1 from public.projects p where p.id=a.project_id and p.instance_id=:instance and p.archived_at is null)
            and ($7::uuid is null or (a.task_id is null and (a.canvas_id is null or a.canvas_id=$7) and exists(select 1 from public.canvases c where c.id=$7 and c.project_id=a.project_id)))`,
      [
        assetId,
        input.expectedRelativePath,
        input.expectedVersion,
        input.relativePath,
        input.fileVersion,
        byteSize,
        input.canvasId ?? null,
      ],
    );
    if (!changed)
      throw new ProjectFileError(
        "file_conflict",
        "素材位置或版本已改变，请重新加载",
      );
  }
  return {
    find,
    async relink(instanceId, assetId, input, byteSize) {
      await relink(
        persistence.forInstance(instanceId),
        assetId,
        input,
        byteSize,
      );
    },
    async relinkBatch(instanceId, entries) {
      await persistence.transaction(async (tx) => {
        const sql = tx.forInstance(instanceId);
        for (const entry of entries)
          await relink(sql, entry.assetId, entry.input, entry.byteSize);
      });
    },
    async prepare(record, accessClientId) {
      await persistence.forInstance(record.instance_id).execute(
        `insert into public.asset_objects
          (id, instance_id, project_id, task_id, task_kind, canvas_id, relative_path, write_fingerprint, scope_generation, file_state, bucket, object_path, mime_type, created_by_client_id)
         select $1, :instance, $2, $3, $10, $11, $4, $5, $6, 'pending', 'project-assets', $7, $8, $9
         where exists(select 1 from public.projects p where p.id=$2 and p.instance_id=:instance and p.archived_at is null)
          and ($11::uuid is null or ($3::uuid is null and exists(select 1 from public.canvases c join public.projects p on p.id=c.project_id where c.id=$11 and c.project_id=$2 and p.instance_id=:instance and p.kind in ('design','flow') and p.archived_at is null)))
          and ($3::uuid is null or exists(select 1 from public.execution_task_owners o left join public.code_ui_sessions c on o.task_kind='code' and c.id=o.task_id and c.instance_id=o.instance_id left join public.design_task_executions d on o.task_kind='design' and d.task_id=o.task_id and d.instance_id=o.instance_id where o.instance_id=:instance and o.task_id=$3 and o.project_id=$2 and o.task_kind=$10 and ((o.task_kind='code' and c.parent_session_id is null and c.deleted_at is null and c.execution_state='ready' and c.scope_generation=$6) or (o.task_kind='design' and d.execution_state='ready' and d.scope_generation=$6))))
         on conflict(id) do nothing`,
        [
          record.id,
          record.project_id,
          record.task_id,
          record.relative_path,
          record.write_fingerprint,
          record.scope_generation,
          `${record.instance_id}/project-files/${record.id}`,
          record.mime_type,
          accessClientId,
          record.task_kind,
          record.canvas_id ?? null,
        ],
      );
      // 显式绑定旧资产时保存可恢复源；不删旧Blob，不在object_path塞JSON。
      await persistence.forInstance(record.instance_id).execute(
        `update public.asset_objects a set legacy_bucket=a.bucket, legacy_object_path=a.object_path,
          project_id=$2, task_id=$3, task_kind=$8, canvas_id=$9, relative_path=$4, write_fingerprint=$5, scope_generation=$6, mime_type=coalesce(a.mime_type,$7), file_state='pending'
         where a.instance_id=:instance and a.id=$1 and a.file_state='legacy'
          and (a.project_id is null or a.project_id=$2)
          and exists(select 1 from public.projects p where p.id=$2 and p.instance_id=:instance and p.archived_at is null)
          and ($9::uuid is null or ($3::uuid is null and exists(select 1 from public.canvases c join public.projects p on p.id=c.project_id where c.id=$9 and c.project_id=$2 and p.instance_id=:instance and p.kind in ('design','flow') and p.archived_at is null)))
          and ($3::uuid is null or exists(select 1 from public.execution_task_owners o left join public.code_ui_sessions c on o.task_kind='code' and c.id=o.task_id and c.instance_id=o.instance_id left join public.design_task_executions d on o.task_kind='design' and d.task_id=o.task_id and d.instance_id=o.instance_id where o.instance_id=:instance and o.task_id=$3 and o.project_id=$2 and o.task_kind=$8 and ((o.task_kind='code' and c.parent_session_id is null and c.deleted_at is null and c.execution_state='ready' and c.scope_generation=$6) or (o.task_kind='design' and d.execution_state='ready' and d.scope_generation=$6))))`,
        [
          record.id,
          record.project_id,
          record.task_id,
          record.relative_path,
          record.write_fingerprint,
          record.scope_generation,
          record.mime_type,
          record.task_kind,
          record.canvas_id ?? null,
        ],
      );
      const current = await find(record.instance_id, record.id);
      if (!current)
        throw new ProjectFileError("not_found", "资产或所属项目不可用。", 404);
      return current;
    },
    async complete(instanceId, assetId, fingerprint, byteSize) {
      const changed = await persistence.forInstance(instanceId).execute(
        `update public.asset_objects a set file_state='ready', byte_size=$3,
          bucket='project-assets', object_path=$4
         where a.instance_id=:instance and a.id=$1 and a.write_fingerprint=$2 and a.file_state in ('pending','ready')
          and exists(select 1 from public.projects p where p.id=a.project_id and p.instance_id=:instance and p.archived_at is null)
          and (a.file_state='ready' or a.task_id is null or exists(select 1 from public.execution_task_owners o left join public.code_ui_sessions c on o.task_kind='code' and c.id=o.task_id and c.instance_id=o.instance_id left join public.design_task_executions d on o.task_kind='design' and d.task_id=o.task_id and d.instance_id=o.instance_id where o.instance_id=:instance and o.task_id=a.task_id and o.project_id=a.project_id and o.task_kind=a.task_kind and ((o.task_kind='code' and c.parent_session_id is null and c.deleted_at is null and c.execution_state='ready' and c.scope_generation=a.scope_generation) or (o.task_kind='design' and d.execution_state='ready' and d.scope_generation=a.scope_generation))))`,
        [
          assetId,
          fingerprint,
          byteSize,
          `${instanceId}/project-files/${assetId}`,
        ],
      );
      if (!changed)
        throw new ProjectFileError(
          "not_found",
          "资产已删除或项目已归档，文件尚未登记。",
          404,
        );
    },
    async beginMove(instanceId, assetId, previousPath, nextPath) {
      const changed = await persistence
        .forInstance(instanceId)
        .execute(
          `update public.asset_objects a set pending_relative_path=$3 where a.instance_id=:instance and a.id=$1 and a.relative_path=$2 and a.file_state='ready' and (a.pending_relative_path is null or a.pending_relative_path=$3) and exists(select 1 from public.projects p where p.id=a.project_id and p.instance_id=:instance and p.archived_at is null)`,
          [assetId, previousPath, nextPath],
        );
      if (!changed)
        throw new ProjectFileError(
          "file_conflict",
          "文件路径已改变，请重新加载。",
        );
    },
    async finishMove(instanceId, assetId, previousPath, nextPath) {
      const changed = await persistence
        .forInstance(instanceId)
        .execute(
          `update public.asset_objects a set relative_path=$3,pending_relative_path=null where a.instance_id=:instance and a.id=$1 and a.relative_path=$2 and a.pending_relative_path=$3 and a.file_state='ready' and exists(select 1 from public.projects p where p.id=a.project_id and p.instance_id=:instance and p.archived_at is null)`,
          [assetId, previousPath, nextPath],
        );
      if (!changed)
        throw new ProjectFileError(
          "file_conflict",
          "文件移动尚未确认，请重新加载。",
        );
    },
  };
}
