import { createHash } from "node:crypto";
import {
  type ContextRequestSummary,
  contextRequestListInputSchema,
  contextRequestListSchema,
  contextRequestReadInputSchema,
} from "@kenfutwork/shared";
import { CodeUiHostRpcError } from "../code-ui/host-rpc-handler.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type {
  InstanceSqlClient,
  PersistenceService,
  SqlRow,
} from "../persistence/types.js";
import type { ContextRequestWriter } from "./types.js";

// 检查页面一次显示 50 条摘要；不限制 Agent 的执行次数或历史保留量。
const LIST_PAGE_SIZE = 50;
function fingerprint(value: unknown) {
  const normalized = JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      return item;
    return Object.fromEntries(
      Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
  return createHash("sha256").update(normalized).digest("hex");
}
const unavailable = () =>
  new CodeUiHostRpcError(
    "code_ui_not_found",
    "请求记录已不可用，请重新选择任务。",
    404,
  );

async function requireTask(
  sql: InstanceSqlClient,
  taskId: string,
  lock = false,
) {
  const row = await sql.queryOne(
    `select id from public.code_ui_sessions where instance_id=:instance and id=$1
      and root_session_id=id and deleted_at is null ${lock ? "for update" : ""}`,
    [taskId],
  );
  if (!row) throw unavailable();
}

export function createContextInspectionService(deps: {
  persistence: PersistenceService;
  localInstance: Pick<LocalInstanceService, "resolve">;
  readPageCharacters(actor: LocalActor): Promise<number>;
}) {
  const writer: ContextRequestWriter = {
    async start(input) {
      const text = JSON.stringify(input.input);
      const hash = fingerprint({ owner: input.owner, input: input.input });
      await deps.persistence.transaction(async (tx) => {
        const sql = tx.forInstance(input.owner.instanceId);
        await requireTask(sql, input.owner.taskId, true);
        const row = await sql.queryOne<SqlRow & { input_fingerprint: string }>(
          `insert into public.context_model_requests
            (id,instance_id,task_id,run_id,agent_call_id,agent_name,started_at,model,input_text,input_fingerprint,input_characters,message_count,tool_count)
           values ($1,:instance,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           on conflict (id) do update set id=excluded.id
             where context_model_requests.instance_id=:instance
           returning input_fingerprint`,
          [
            input.id,
            input.owner.taskId,
            input.owner.runId,
            input.owner.agentCallId ?? null,
            input.owner.agentName ?? null,
            input.startedAt,
            input.input.model,
            text,
            hash,
            text.length,
            input.input.messages.reduce(
              (sum, messages) => sum + messages.length,
              0,
            ),
            input.input.tools?.length ?? null,
          ],
        );
        if (row?.input_fingerprint !== hash)
          throw new CodeUiHostRpcError(
            "context_request_conflict",
            "请求身份冲突，请重新运行任务。",
            409,
          );
      });
    },
    async finish(input) {
      const text = JSON.stringify(input.output);
      const hash = fingerprint({
        status: input.status,
        output: input.output,
        usage: input.usage,
      });
      await deps.persistence.transaction(async (tx) => {
        const sql = tx.forInstance(input.owner.instanceId);
        const row = await sql.queryOne<
          SqlRow & { output_fingerprint: string | null }
        >(
          `select output_fingerprint from public.context_model_requests
           where instance_id=:instance and id=$1 and task_id=$2 and run_id=$3 for update`,
          [input.id, input.owner.taskId, input.owner.runId],
        );
        // 删除后的迟到回调不重建正文；未保存过的请求也不凭终态创建记录。
        if (!row) return;
        if (row.output_fingerprint) {
          if (row.output_fingerprint !== hash)
            throw new CodeUiHostRpcError(
              "context_request_conflict",
              "请求终态冲突，请重新加载记录。",
              409,
            );
          return;
        }
        await sql.execute(
          `update public.context_model_requests set ended_at=$4,status=$5,output_text=$6,
             output_fingerprint=$7,output_characters=$8,usage=$9::jsonb
           where instance_id=:instance and id=$1 and task_id=$2 and run_id=$3`,
          [
            input.id,
            input.owner.taskId,
            input.owner.runId,
            input.endedAt,
            input.status,
            text,
            hash,
            text.length,
            input.usage === null ? null : JSON.stringify(input.usage),
          ],
        );
      });
    },
  };
  return {
    writer,
    async list(actor: LocalActor, value: unknown) {
      const input = contextRequestListInputSchema.parse(value);
      const { instanceId } = await deps.localInstance.resolve(actor);
      const sql = deps.persistence.forInstance(instanceId);
      await requireTask(sql, input.taskId);
      const rows = await sql.query<SqlRow & { summary: ContextRequestSummary }>(
        `select jsonb_build_object('id',r.id,'runId',r.run_id,'sequence',r.sequence,
          'agentCallId',r.agent_call_id,'agentName',r.agent_name,
          'startedAt',to_char(r.started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'endedAt',to_char(r.ended_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'status',r.status,'model',r.model,'messageCount',r.message_count,'toolCount',r.tool_count,
          'inputCharacters',r.input_characters,'outputCharacters',r.output_characters,'usage',r.usage) summary
         from public.context_model_requests r join public.code_ui_sessions t on t.id=r.task_id and t.instance_id=r.instance_id
         where r.instance_id=:instance and r.task_id=$1 and t.deleted_at is null
           and ($2::bigint is null or r.sequence<$2)
         order by r.sequence desc limit $3`,
        [input.taskId, input.before ?? null, LIST_PAGE_SIZE + 1],
      );
      const requests = rows.slice(0, LIST_PAGE_SIZE).map((row) => row.summary);
      return contextRequestListSchema.parse({
        requests,
        nextBefore:
          rows.length > LIST_PAGE_SIZE ? requests.at(-1)?.sequence : null,
      });
    },
    async read(actor: LocalActor, value: unknown) {
      const input = contextRequestReadInputSchema.parse(value);
      const { instanceId } = await deps.localInstance.resolve(actor);
      const sql = deps.persistence.forInstance(instanceId);
      const size = await deps.readPageCharacters(actor);
      if (!Number.isSafeInteger(size) || size <= 0)
        throw new Error("上下文读取预算无效，请检查实例设置。");
      const row = await sql.queryOne<SqlRow & { text: string | null }>(
        `select case when $3='input' then r.input_text else r.output_text end as text
         from public.context_model_requests r join public.code_ui_sessions t on t.id=r.task_id and t.instance_id=r.instance_id
         where r.instance_id=:instance and r.task_id=$1 and r.id=$2 and t.deleted_at is null and t.root_session_id=t.id`,
        [input.taskId, input.requestId, input.part],
      );
      if (!row) throw unavailable();
      const text = row.text ?? "null";
      const end = Math.min(text.length, input.offset + size);
      return {
        text: text.slice(input.offset, end),
        nextOffset: end < text.length ? end : null,
        totalCharacters: text.length,
      };
    },
  };
}
