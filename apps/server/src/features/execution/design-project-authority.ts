import type { InstanceSqlClient } from "../persistence/types.js";

/** Hold the project before locking its Task; closing intents cannot race a new authorization. */
export async function loadOpenDesignProject(
  sql: InstanceSqlClient,
  taskId: string,
) {
  return sql.queryOne<{ id: string }>(
    `select p.id from public.projects p
     join public.design_task_executions d on d.project_id=p.id and d.instance_id=p.instance_id
     join public.chat_sessions c on c.id=d.task_id and c.instance_id=d.instance_id
     where p.instance_id=:instance and d.task_id=$1 and c.project_id=p.id
       and c.mode='design' and p.kind='design' and p.archived_at is null
       and p.archive_state='open' for share of p`,
    [taskId],
  );
}
