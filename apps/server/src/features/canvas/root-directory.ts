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
     where c.id=$1 and p.instance_id=:instance and p.kind in ('design','flow') and p.archived_at is null for update of c for share of p`,
    [canvasId],
  );
  if (!canvas)
    throw new CanvasFileStoreError("revision_conflict", "画布或项目不可用。");
  const tasks = await sql.query<{ root_directory: string; project_id: string }>(
    `select distinct d.root_directory,d.project_id from public.design_task_executions d
     join public.chat_sessions s on s.id=d.task_id and s.instance_id=d.instance_id and s.project_id=d.project_id
     where d.instance_id=:instance and s.canvas_id=$1 and s.mode='design'`,
    [canvasId],
  );
  if (
    tasks.length > 1 ||
    tasks.some((task) => task.project_id !== canvas.project_id) ||
    (canvas.root_directory &&
      tasks.some((task) => task.root_directory !== canvas.root_directory))
  )
    throw new CanvasFileStoreError(
      "revision_conflict",
      "画布任务目录冲突，请迁移到一致目录。",
    );
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
    (canvas.root_directory && canvas.root_directory !== root) ||
    tasks.some((task) => task.root_directory !== root)
  )
    throw new CanvasFileStoreError(
      "revision_conflict",
      "项目、画布与Task目录不一致，请显式迁移。",
    );
  if (!canvas.root_directory) {
    const changed = await sql.execute(
      `update public.canvases c set root_directory=$2 from public.projects p
       where c.id=$1 and c.root_directory is null and p.id=c.project_id
         and p.instance_id=:instance and p.archived_at is null`,
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
