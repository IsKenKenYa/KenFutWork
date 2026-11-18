import { randomUUID } from "node:crypto";
import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { z } from "zod";
import type { AgentRunService } from "../../agent/runtime.js";
import type { BlobStore } from "../blob/types.js";
import type {
  InstanceSqlClient,
  PersistenceService,
  SqlRow,
} from "../persistence/types.js";
import { CodeUiRepositoryError } from "./repository.js";

const manifestSchema = z
  .object({
    instanceId: z.uuid(),
    projectId: z.uuid(),
    sourceTaskId: z.uuid(),
    targetTaskId: z.uuid(),
    targetThreadId: z.string().min(1),
    clientId: z.string().min(1),
    commandId: z.string().min(1),
    hostId: z.string().min(1),
    runtimeId: z.string().min(1),
    objects: z
      .array(
        z
          .object({
            bucket: z.enum(["code-attachments", "task-output-history"]),
            path: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
export type HistoryPreparedObject = Manifest["objects"][number];
type Preparation = SqlRow & {
  id: string;
  instance_id: string;
  published: boolean;
  manifest: Manifest;
};
export type HistoryPreparationOwner = { hostId: string; runtimeId: string };

/** Definition/Provider：只读私有准备事实，不接受模型或HTTP提供目标路径。 */
export function createHistoryPreparations(persistence: PersistenceService) {
  return {
    async begin(manifest: z.input<typeof manifestSchema>): Promise<string> {
      const value = manifestSchema.parse(manifest);
      const id = randomUUID();
      await persistence.transaction(async (tx) => {
        const scoped = tx.forInstance(value.instanceId);
        const command = await scoped.queryOne<
          SqlRow & { status: string; session_id: string }
        >(
          "select status,session_id from public.code_ui_commands where instance_id=:instance and client_id=$1 and command_id=$2 for update",
          [value.clientId, value.commandId],
        );
        if (
          !command ||
          command.status !== "pending" ||
          command.session_id !== value.sourceTaskId
        )
          throw new CodeUiRepositoryError(
            "command_conflict",
            "分叉命令没有有效持久认领，未准备资源。",
          );
        await scoped.execute(
          `insert into public.code_history_preparations (id,instance_id,source_task_id,target_task_id,target_thread_id,client_id,command_id,host_id,runtime_id,manifest)
         values ($1,:instance,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [
            id,
            value.sourceTaskId,
            value.targetTaskId,
            value.targetThreadId,
            value.clientId,
            value.commandId,
            value.hostId,
            value.runtimeId,
            JSON.stringify(value),
          ],
        );
      });
      return id;
    },
    async planObject(
      instanceId: string,
      id: string,
      object: HistoryPreparedObject,
    ) {
      await persistence.transaction(async (tx) => {
        const scoped = tx.forInstance(instanceId);
        const row = await scoped.queryOne<Preparation>(
          "select * from public.code_history_preparations where instance_id=:instance and id=$1 for update",
          [id],
        );
        if (!row || row.published)
          throw new CodeUiRepositoryError(
            "command_conflict",
            "分叉资源准备已失效。",
          );
        const manifest = manifestSchema.parse(row.manifest);
        assertObject(manifest, object);
        if (
          !manifest.objects.some(
            (entry) =>
              entry.bucket === object.bucket && entry.path === object.path,
          )
        )
          manifest.objects.push(object);
        await scoped.execute(
          "update public.code_history_preparations set manifest=$2::jsonb where instance_id=:instance and id=$1",
          [id, JSON.stringify(manifest)],
        );
      });
    },
    async remove(instanceId: string, id: string) {
      await persistence
        .forInstance(instanceId)
        .execute(
          "delete from public.code_history_preparations where instance_id=:instance and id=$1",
          [id],
        );
    },
    async recover(
      owner: HistoryPreparationOwner,
      agent: Pick<
        AgentRunService,
        | "getContextBranchPreparation"
        | "discardContextBranch"
        | "releaseContextBranch"
      >,
      blob?: BlobStore,
    ) {
      const pending = await persistence.query<Preparation>(
        "select * from public.code_history_preparations where host_id=$1 and runtime_id<>$2 order by created_at,id",
        [owner.hostId, owner.runtimeId],
      );
      for (const item of pending) {
        await persistence.transaction(async (tx) => {
          const scoped = tx.forInstance(item.instance_id);
          const current = await scoped.queryOne<Preparation>(
            "select * from public.code_history_preparations where instance_id=:instance and id=$1 for update",
            [item.id],
          );
          if (!current || current.manifest.runtimeId === owner.runtimeId)
            return;
          const manifest = manifestSchema.parse(current.manifest);
          if (
            manifest.instanceId !== current.instance_id ||
            manifest.hostId !== owner.hostId
          )
            throw new CodeUiRepositoryError(
              "command_conflict",
              "历史准备的可信归属不匹配，未清理。",
            );
          const target = await scoped.queryOne<SqlRow & { thread_id: string }>(
            "select c.thread_id from public.code_ui_sessions s join public.chat_sessions c on c.instance_id=s.instance_id and c.id=s.chat_session_id where s.instance_id=:instance and s.id=$1 and s.project_id=$2",
            [manifest.targetTaskId, manifest.projectId],
          );
          if (target && target.thread_id !== manifest.targetThreadId)
            throw new CodeUiRepositoryError(
              "command_conflict",
              "准备目标已绑定不同原生上下文，未清理。",
            );
          const native = await agent.getContextBranchPreparation(
            manifest.targetThreadId,
          );
          if (native) {
            if (current.published || target)
              await agent.releaseContextBranch(native);
            else await agent.discardContextBranch(native);
          }
          if (!current.published && !target) {
            for (const object of manifest.objects) {
              assertObject(manifest, object);
              if (!blob)
                throw new CodeUiRepositoryError(
                  "command_conflict",
                  "分叉私有资源清理能力未装配，准备事实已保留。",
                );
              await blob.bucket(object.bucket).remove([object.path]);
            }
            const root = await scoped.queryOne<
              SqlRow & { revision: number | string }
            >(
              "select revision from public.code_ui_sessions where instance_id=:instance and id=$1 for update",
              [manifest.sourceTaskId],
            );
            const ack: protocol.CommandAck = {
              commandId: manifest.commandId,
              status: "failed",
              reasonCode: "guard.preparationInterrupted",
              message: "分叉准备已因服务重启中断，未重新执行。",
              revisionAtDecision: Number(root?.revision ?? 0),
            };
            await scoped.execute(
              "update public.code_ui_commands set status='failed',ack=$3::jsonb where instance_id=:instance and client_id=$1 and command_id=$2 and status='pending' and ack is null",
              [manifest.clientId, manifest.commandId, JSON.stringify(ack)],
            );
          }
          await scoped.execute(
            "delete from public.code_history_preparations where instance_id=:instance and id=$1",
            [item.id],
          );
        });
      }
    },
  };
}

function assertObject(manifest: Manifest, object: HistoryPreparedObject) {
  const expected = `${manifest.instanceId}/${manifest.projectId}/${manifest.targetTaskId}/`;
  const key = object.path.slice(expected.length);
  if (
    !object.path.startsWith(expected) ||
    !/^(?:[0-9a-f]{64}|[0-9a-f-]{36})$/u.test(key)
  )
    throw new CodeUiRepositoryError(
      "command_conflict",
      "分叉准备对象不属于目标Task私有命名空间，未清理。",
    );
}

/** 与新Task、原ACK同一事务，不能用后续通知表示发表完成。 */
export async function publishHistoryPreparation(
  scoped: InstanceSqlClient,
  input: {
    clientId: string;
    commandId: string;
    targetTaskId: string;
    targetThreadId: string;
  },
) {
  const marked = await scoped.execute(
    "update public.code_history_preparations set published=true where instance_id=:instance and client_id=$1 and command_id=$2 and target_task_id=$3 and target_thread_id=$4",
    [input.clientId, input.commandId, input.targetTaskId, input.targetThreadId],
  );
  if (marked !== 1)
    throw new CodeUiRepositoryError(
      "command_conflict",
      "分叉目标缺少持久准备认领，未发表。",
    );
}
