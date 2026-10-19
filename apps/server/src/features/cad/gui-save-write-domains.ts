import { posix } from "node:path";
import { z } from "zod";
import type { TaskFileOperationParticipant } from "../code-tools/file-operations.js";
import { cadGuiSaveDocumentInputSchema } from "./gui-document-save-contracts.js";
import type {
  CadGuiOperationController,
  CadGuiOperationResult,
} from "./gui-operation-controller.js";
import {
  type CadGuiOperationIdentity,
  type CadGuiOperationRecord,
  type CadGuiOperationStore,
  CadGuiOperationStoreError,
} from "./gui-operation-store.js";

/** Host 字段只进入冻结请求，不向公共工具参数开放。 */
export const cadGuiSaveDocumentRequestSchema = cadGuiSaveDocumentInputSchema
  .extend({
    canonicalPath: z
      .string()
      .min(1)
      .refine(
        (path) =>
          posix.isAbsolute(path) &&
          posix.normalize(path) === path &&
          !path.includes("\0") &&
          path.toLowerCase().endsWith(".fcstd"),
        "保存目标必须是归一化的绝对 .FCStd 路径。",
      ),
    writeRoots: z.tuple([z.string().min(1)]),
  })
  .strict()
  .refine(
    (request) => request.writeRoots[0] === posix.dirname(request.canonicalPath),
    { path: ["writeRoots"], message: "保存写域必须是目标文件的唯一父目录。" },
  );
export type CadGuiSaveDocumentRequest = z.infer<
  typeof cadGuiSaveDocumentRequestSchema
>;

const saveEnvelopeSchema = z
  .object({
    operation: z.literal("save-document"),
    timeoutMs: z.number().int().positive().max(2_147_483_647),
  })
  .passthrough();

function saveRequest(
  record: CadGuiOperationRecord,
): CadGuiSaveDocumentRequest | null {
  if (
    !record.payload ||
    typeof record.payload !== "object" ||
    !("operation" in record.payload) ||
    record.payload.operation !== "save-document"
  )
    return null;
  const envelope = saveEnvelopeSchema.safeParse(record.payload);
  if (envelope.success) {
    const {
      operation: _operation,
      timeoutMs: _timeoutMs,
      ...rawInput
    } = envelope.data;
    const input = cadGuiSaveDocumentRequestSchema.safeParse(rawInput);
    if (input.success && input.data.operationId === record.operationId)
      return input.data;
  }
  throw new CadGuiOperationStoreError(
    "invalid_record",
    "CAD 保存记录的文件写域无效，请检查实例数据目录。",
  );
}

function writePending(result: CadGuiOperationResult): boolean {
  if (
    result.receipt?.protocol === "kfw-cad-gui-save/1" &&
    result.receipt.writeFinished
  )
    return false;
  return !(
    (result.state === "prepared" && result.outcome === "prepared") ||
    (result.state === "cancelled" && result.outcome === "cancelled")
  );
}

/** 在取消与当前调用清理之后再次对账，不把取消标记当作原生写入结束。 */
export async function confirmCadGuiSaveWritesStopped(
  options: {
    store: CadGuiOperationStore;
    controller: Pick<CadGuiOperationController, "status">;
  },
  filter: { runId?: string } = {},
): Promise<void> {
  for (const record of await options.store.listRecords(filter)) {
    if (!saveRequest(record)) continue;
    const result = await options.controller.status({
      ...record.binding,
      operationId: record.operationId,
    });
    if (writePending(result))
      throw new CadGuiOperationStoreError(
        "stop_unconfirmed",
        "CAD 保存写入尚未确认结束，请查询原操作编号。",
      );
  }
}

/** 活跃调用的旧失败只能由同一持久编号的可信完成事实解除。 */
export async function confirmCadGuiSaveOperationStopped(
  options: {
    store: CadGuiOperationStore;
    controller: Pick<CadGuiOperationController, "status">;
  },
  identity: CadGuiOperationIdentity,
): Promise<void> {
  const record = await options.store.lookup(identity);
  if (
    !record ||
    !saveRequest(record) ||
    writePending(await options.controller.status(identity))
  )
    throw new CadGuiOperationStoreError(
      "stop_unconfirmed",
      "该次 CAD 保存仍缺少可信结束记录，请查询原操作编号。",
    );
}

export function createCadGuiFileOperationParticipant(options: {
  store: CadGuiOperationStore;
  controller: Pick<CadGuiOperationController, "status">;
}): TaskFileOperationParticipant {
  const { store, controller } = options;
  return {
    async pendingWrites() {
      const writes: {
        instanceId: string;
        taskId: string;
        writeRoots: string[];
      }[] = [];
      for (const record of await store.listRecords()) {
        const request = saveRequest(record);
        if (!request) continue;
        const result = await controller.status({
          ...record.binding,
          operationId: record.operationId,
        });
        if (writePending(result))
          writes.push({
            instanceId: record.binding.instanceId,
            taskId: record.binding.taskId,
            writeRoots: [...request.writeRoots],
          });
      }
      return writes;
    },
    async revoke(instanceId, taskId) {
      const records = await store.listRecords({ instanceId, taskId });
      const stopped = await Promise.allSettled(
        records.map(async (record) => {
          if (!saveRequest(record)) return;
          await store.cancel(record);
          const result = await controller.status({
            ...record.binding,
            operationId: record.operationId,
          });
          if (writePending(result))
            throw new CadGuiOperationStoreError(
              "stop_unconfirmed",
              "CAD 保存写入尚未确认结束，请查询原操作编号。",
            );
        }),
      );
      const failure = stopped.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}
