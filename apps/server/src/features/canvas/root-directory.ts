import type { InstanceSqlClient } from "../persistence/types.js";
import { CanvasFileStoreError } from "./file-store.js";

/** Canvas ownership and existing Task directories are checked under one Canvas row lock. */
export async function claimCanvasRootInTransaction(
  sql: InstanceSqlClient,
  canvasId: string,
  resolveDefault: (workDir: string | null) => Promise<string>,
): Promise<string> {
  const canvas = await sql.queryOne<{
    root_directory: string | null;
    work_dir: string | null;
    project_id: string;
  }>(
    `select c.root_directory, p.work_dir, c.project_id from public.canvases c join public.projects p on p.id=c.project_id
     where c.id=$1 and p.instance_id=:instance and ('design'=any(p.enabled_modes) or 'flow'=any(p.enabled_modes)) and c.deleted_at is null and p.archived_at is null for update of c for share of p`,
    [canvasId],
  );
  if (!canvas)
    throw new CanvasFileStoreError("revision_conflict", "画布或项目不可用。");
  let root: string;
  try {
    root = await resolveDefault(canvas.work_dir);
  } catch {
    throw new CanvasFileStoreError(
      "invalid_path",
      "项目目录不可用，请重新关联项目。",
    );
  }
  if (
    (canvas.work_dir && canvas.work_dir !== root) ||
    (canvas.root_directory && canvas.root_directory !== root)
  )
    throw new CanvasFileStoreError(
      "revision_conflict",
      "项目、画布与Task目录不一致，请显式迁移。",
    );
  if (!canvas.root_directory) {
    const changed = await sql.execute(
      `update public.canvases c set root_directory=$2 from public.projects p
       where c.id=$1 and c.root_directory is null and p.id=c.project_id
         and p.instance_id=:instance and p.archived_at is null and c.deleted_at is null`,
      [canvasId, root],
    );
    if (changed !== 1)
      throw new CanvasFileStoreError(
        "revision_conflict",
        "画布目录已改变，请重新加载。",
      );
  }
  return root;
}
