import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { CodeUiConversationState } from "./conversation.js";
import type { CodeAdmittedInput } from "./input-intents.js";

export const CODE_QUEUE_COMMANDS = new Set<protocol.CommandType>(["setAutoDrain", "reorderQueueItem", "deleteQueueItem", "editQueueItem", "sendQueuedNow"]);

export interface CodeInputSettlement {
  clientId: string;
  commandId: string;
  ack: protocol.CommandAck;
}

export function codeInputRouting(snapshot: protocol.ConversationSnapshot): protocol.InputRouting {
  return { mode: snapshot.control.phase === "running" ? "enqueue" : !snapshot.queue.autoDrain && snapshot.queue.items.length ? "choice" : "startNow" };
}

export function resolveHeldQueue(snapshot: protocol.ConversationSnapshot, inputs: CodeAdmittedInput[], payload: { heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend" | undefined; expectedHeldQueueItemIds?: string[] | undefined }): { ok: true; settlements: CodeInputSettlement[] } | { ok: false; reasonCode: string; message: string } {
  if (!payload.heldQueueDisposition) return { ok: false, reasonCode: "guard.heldQueueChoiceRequired", message: "队列已暂停，请确认保留或清空这些排队输入后再发送。" };
  const expected = payload.expectedHeldQueueItemIds;
  if (!expected || new Set(expected).size !== expected.length || expected.length !== snapshot.queue.items.length || snapshot.queue.items.some((item) => !expected.includes(item.queueItemId))) return { ok: false, reasonCode: "proto.staleRevision", message: "队列已改变，请重新确认当前完整队列。" };
  const settlements: CodeInputSettlement[] = [];
  if (payload.heldQueueDisposition === "clearQueueAndSend") {
    for (const item of snapshot.queue.items) {
      const record = inputs.find((entry) => entry.status === "queued" && entry.intent.queueItemId === item.queueItemId);
      if (record) { record.status = "discarded"; settlements.push({ clientId: record.intent.clientId, commandId: record.intent.sourceCommandId, ack: { commandId: record.intent.sourceCommandId, status: "failed", reasonCode: "fault.command.heldQueueCleared", revisionAtDecision: snapshot.revision + 1, result: { type: "inputDisposition", delivery: record.intent.delivery.admitted } } }); }
    }
    snapshot.queue.items = [];
  }
  return { ok: true, settlements };
}

/** Operates on a transaction-owned state copy; queue identity and revision are host facts. */
export function applyCodeQueueCommand(state: CodeUiConversationState, sessionId: string, envelope: protocol.CommandEnvelope): { ack: protocol.CommandAck; settlements: CodeInputSettlement[]; dispatch?: CodeAdmittedInput } {
  const snapshot = state.snapshots.find((entry) => entry.sessionId === sessionId)!;
  const reject = (reasonCode: string, message: string) => ({ ack: { commandId: envelope.commandId, status: "rejected" as const, reasonCode, message, revisionAtDecision: snapshot.revision }, settlements: [] });
  if (envelope.baseRevision !== snapshot.revision) return reject("proto.staleRevision", "队列已改变，请刷新后再操作。");
  if (envelope.baseLogEpoch !== undefined && envelope.baseLogEpoch !== snapshot.logEpoch) return reject("proto.staleLogEpoch", "会话分支已改变，请刷新后再操作。");
  const settlements: CodeInputSettlement[] = [];
  let dispatch: CodeAdmittedInput | undefined;
  if (envelope.type === "setAutoDrain") {
    const { autoDrain } = protocol.commandPayloadSchemas.setAutoDrain.parse(envelope.payload);
    snapshot.queue.autoDrain = autoDrain;
    if (autoDrain) delete snapshot.queue.pauseReason;
    else snapshot.queue.pauseReason = "manual";
  } else {
    const payload = protocol.commandPayloadSchemas[envelope.type].parse(envelope.payload) as { queueItemId: string; beforeQueueItemId?: string | null; newText?: string };
    const index = snapshot.queue.items.findIndex((entry) => entry.queueItemId === payload.queueItemId);
    const item = snapshot.queue.items[index];
    const record = state.inputs?.find((entry) => entry.status === "queued" && entry.intent.queueItemId === payload.queueItemId);
    if (!item || !record) return reject("guard.queueItemUnavailable", "排队输入已消费或不可编辑。");
    if (item.dispatch.state !== "queued") return reject("guard.queueItemReserved", "排队输入已被运行认领。");
    if (envelope.type === "sendQueuedNow") {
      if (state.inputs?.some((entry) => entry.status === "reserved")) return reject("guard.preemptionPending", "已有输入正在抢占当前运行，请等待。");
      const previousRunId = snapshot.control.activeWorks.find((entry) => entry.kind === "primaryTurn")?.foregroundExecutionId;
      if (snapshot.control.phase === "running" && !previousRunId) return reject("guard.queueItemUnavailable", "前台身份不可用，不能安全立即发送。");
      snapshot.queue.items.splice(index, 1);
      record.status = "reserved";
      record.autoDrainAtAdmission = snapshot.queue.autoDrain;
      if (previousRunId) record.previousRunId = previousRunId;
      record.intent.dispatch = { state: "reserved", reservationId: record.runId };
      snapshot.pendingCommands.push({ commandId: record.intent.sourceCommandId, clientId: record.intent.clientId, type: record.intent.kind, state: "executing", at: record.intent.admittedAt });
      dispatch = structuredClone(record);
    } else if (envelope.type === "reorderQueueItem") {
      if (payload.beforeQueueItemId === payload.queueItemId) return { ack: { commandId: envelope.commandId, status: "accepted", revisionAtDecision: snapshot.revision }, settlements };
      if (payload.beforeQueueItemId !== null && !snapshot.queue.items.some((entry) => entry.queueItemId === payload.beforeQueueItemId)) return reject("guard.queueItemUnavailable", "目标队列位置已改变。");
      snapshot.queue.items.splice(index, 1);
      const before = payload.beforeQueueItemId === null ? snapshot.queue.items.length : snapshot.queue.items.findIndex((entry) => entry.queueItemId === payload.beforeQueueItemId);
      snapshot.queue.items.splice(before, 0, item);
    } else if (envelope.type === "deleteQueueItem") {
      snapshot.queue.items.splice(index, 1);
      record.status = "discarded";
      settlements.push({ clientId: record.intent.clientId, commandId: record.intent.sourceCommandId, ack: { commandId: record.intent.sourceCommandId, status: "failed", reasonCode: "fault.command.queueItemDeleted", revisionAtDecision: snapshot.revision + 1, result: { type: "inputDisposition", delivery: record.intent.delivery.admitted } } });
    } else if (envelope.type === "editQueueItem") {
      if (item.kind === "compact" || (!payload.newText?.trim() && !item.attachments.length)) return reject("guard.queueItemUnavailable", "此队列项不能编辑为空输入。");
      item.text = payload.newText!;
      record.intent.text = payload.newText!;
    } else return reject("guard.capabilityUnavailable", "此队列命令不可用。");
  }
  snapshot.queue.items.forEach((item, index) => { item.order.queuePosition = index; const record = state.inputs?.find((entry) => entry.intent.queueItemId === item.queueItemId); if (record) record.intent.order.queuePosition = index; });
  snapshot.seq += 1; snapshot.revision += 1;
  snapshot.inputRouting = codeInputRouting(snapshot);
  return { ack: { commandId: envelope.commandId, status: "accepted", revisionAtDecision: snapshot.revision }, settlements, ...(dispatch ? { dispatch } : {}) };
}
