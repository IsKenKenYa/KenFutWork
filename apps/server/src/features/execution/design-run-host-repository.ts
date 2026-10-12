import { createHash } from "node:crypto";
import { runCreateRequestSchema } from "@kenfutwork/shared";
import type { ModelInvocationSnapshot } from "../../providers/types.js";
import type { PersistenceService, SqlRow } from "../persistence/types.js";
import type {
  DesignHostRepository,
  DesignHostStoredInput,
} from "./design-run-host-types.js";

export function designHostMessageId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
export function createDesignHostRepository(
  persistence: PersistenceService,
): DesignHostRepository {
  const origin = async (
    instanceId: string,
    taskId: string,
    runId: string,
    running: boolean,
  ) =>
    persistence.forInstance(instanceId).queryOne<
      SqlRow & {
        created_by_client_id: string;
        input_id: string;
        input_origin: DesignHostStoredInput["origin"];
        request: unknown;
        model: string | null;
        model_invocation: ModelInvocationSnapshot | null;
        scope_generation: number | string;
        branch_generation: number | string;
      }
    >(
      `select i.created_by_client_id,i.input_id,i.input_origin,i.request,i.model_invocation,i.scope_generation,i.branch_generation,r.model
   from public.design_task_inputs i join public.design_task_executions d on d.task_id=i.task_id and d.instance_id=i.instance_id
   join public.chat_sessions c on c.id=d.task_id and c.instance_id=d.instance_id and c.project_id=d.project_id
   join public.projects p on p.id=d.project_id and p.instance_id=d.instance_id
   join public.local_access_clients a on a.id=i.created_by_client_id and a.instance_id=i.instance_id
   left join public.agent_runs r on r.id::text=i.run_id and r.session_id=i.task_id
   where i.instance_id=:instance and i.task_id=$1 and i.run_id=$2
     and c.mode='design' and p.kind='design' and p.archived_at is null
     and a.revoked_at is null and (a.expires_at is null or a.expires_at>now())
     ${running ? "and i.status='running' and d.active_run_id=i.run_id" : ""}`,
      [taskId, runId],
    );
  return {
    async loadLatestActor(instanceId, taskId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<SqlRow & { run_id: string }>(
          `select i.run_id from public.design_task_inputs i join public.local_access_clients a
          on a.id=i.created_by_client_id and a.instance_id=i.instance_id
          where i.instance_id=:instance and i.task_id=$1 and a.revoked_at is null
            and (a.expires_at is null or a.expires_at>now()) order by i.admission_seq desc limit 1`,
          [taskId],
        );
      if (!row) return null;
      const bound = await origin(instanceId, taskId, row.run_id, false);
      return bound
        ? {
            actor: { instanceId, accessClientId: bound.created_by_client_id },
            ...(bound.model_invocation
              ? { modelInvocation: bound.model_invocation }
              : {}),
            ...(bound.model ? { model: bound.model } : {}),
          }
        : null;
    },
    async cancelQueuedForClient(instanceId, clientId) {
      await persistence
        .forInstance(instanceId)
        .execute(
          `update public.design_task_inputs set status='canceled',request=null where instance_id=:instance and created_by_client_id=$1 and status='queued'`,
          [clientId],
        );
    },
    async loadInput(instanceId, taskId, runId) {
      const row = await origin(instanceId, taskId, runId, true);
      if (!row) return null;
      const { accessToken: _secret, ...request } = runCreateRequestSchema.parse(
        row.request,
      );
      return {
        actor: { instanceId, accessClientId: row.created_by_client_id },
        taskId,
        inputId: row.input_id,
        runId,
        origin: row.input_origin,
        scopeGeneration: Number(row.scope_generation),
        branchGeneration: Number(row.branch_generation),
        request,
        ...(row.model_invocation
          ? { modelInvocation: row.model_invocation }
          : {}),
        ...(row.model ? { model: row.model } : {}),
      };
    },
    async loadOriginActor(instanceId, taskId, runId) {
      const row = await origin(instanceId, taskId, runId, false);
      return row
        ? {
            actor: { instanceId, accessClientId: row.created_by_client_id },
            ...(row.model_invocation
              ? { modelInvocation: row.model_invocation }
              : {}),
            ...(row.model ? { model: row.model } : {}),
          }
        : null;
    },
    async listPending(instanceId) {
      return (
        await persistence
          .forInstance(instanceId)
          .query<SqlRow & { task_id: string }>(
            `select distinct i.task_id from public.design_task_inputs i join public.design_task_executions d on d.task_id=i.task_id and d.instance_id=i.instance_id
      where i.instance_id=:instance and i.status='queued' and d.execution_state='ready' and d.active_run_id is null
        and exists(select 1 from public.projects p where p.instance_id=:instance and p.id=d.project_id and p.kind='design' and p.archived_at is null)
      union select w.task_id from public.task_works w join public.design_task_executions d on d.task_id=w.task_id and d.instance_id=w.instance_id
      where w.instance_id=:instance and w.owner_kind='design' and w.status<>'running' and w.consumed_at is null
        and d.execution_state='ready' and d.active_run_id is null
        and exists(select 1 from public.projects p where p.instance_id=:instance and p.id=d.project_id and p.kind='design' and p.archived_at is null)`,
          )
      ).map((row) => row.task_id);
    },
    async lastOutcome(instanceId, taskId) {
      return (
        (
          await persistence
            .forInstance(instanceId)
            .queryOne<SqlRow & { last_run_outcome: string | null }>(
              `select last_run_outcome from public.design_task_executions where instance_id=:instance and task_id=$1`,
              [taskId],
            )
        )?.last_run_outcome ?? null
      );
    },
    async persistInput(input) {
      await persistence.forInstance(input.actor.instanceId).execute(
        `insert into public.chat_messages(id,session_id,role,content)
      select $1,c.id,'user',$3 from public.chat_sessions c
       where c.instance_id=:instance and c.id=$2 and c.mode='design' on conflict(id) do nothing`,
        [
          designHostMessageId(`${input.taskId}/input/${input.inputId}`),
          input.taskId,
          input.request.prompt,
        ],
      );
    },
  };
}
