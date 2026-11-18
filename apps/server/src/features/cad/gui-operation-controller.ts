import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  type CadGuiCopyDocumentInput,
  type CadGuiCopyDocumentReceipt,
  cadGuiCopyDocumentInputSchema,
  cadGuiCopyDocumentReceiptSchema,
} from "./gui-document-copy-contracts.js";
import { CAD_GUI_DOCUMENT_COPY_SOURCE } from "./gui-document-copy-source.js";
import { CAD_GUI_DOCUMENT_OBSERVER_SOURCE } from "./gui-document-observer-source.js";
import {
  type CadGuiSaveDocumentReceipt,
  cadGuiSaveDocumentReceiptSchema,
} from "./gui-document-save-contracts.js";
import { CAD_GUI_DOCUMENT_SAVE_SOURCE } from "./gui-document-save-source.js";
import {
  type CadGuiOperationReceipt,
  type CadGuiSetPropertiesInput,
  cadGuiOperationReceiptSchema,
  cadGuiSetPropertiesInputSchema,
} from "./gui-operation-contracts.js";
import {
  type CadGuiOperationBinding,
  type CadGuiOperationIdentity,
  type CadGuiOperationPaths,
  type CadGuiOperationRecord,
  type CadGuiOperationStore,
  CadGuiOperationStoreError,
} from "./gui-operation-store.js";
import type { CadGuiProbe, CadGuiProbeContext } from "./gui-probe.js";
import { CAD_GUI_PROPERTY_MUTATION_SOURCE } from "./gui-property-mutation-source.js";
import { CAD_GUI_PROPERTY_INSPECTION_SOURCE } from "./gui-property-source.js";
import {
  type CadGuiSaveDocumentRequest,
  cadGuiSaveDocumentRequestSchema,
} from "./gui-save-write-domains.js";
import {
  type CadGuiMacroTransport,
  createMacosCadGuiTransport,
} from "./gui-transport.js";
import {
  type CadGuiUndoOperationInput,
  type CadGuiUndoOperationReceipt,
  cadGuiUndoOperationInputSchema,
  cadGuiUndoOperationReceiptSchema,
  cadGuiUndoSourceSchema,
} from "./gui-undo-contracts.js";
import { CAD_GUI_UNDO_SOURCE } from "./gui-undo-source.js";

export interface CadGuiOperationResult {
  operationId: string;
  state: "prepared" | "cancelled" | "dispatched" | "executing" | "terminal";
  outcome:
    | "prepared"
    | "cancelled"
    | "unknown"
    | CadGuiOperationReceipt["outcome"]
    | CadGuiCopyDocumentReceipt["outcome"]
    | CadGuiUndoOperationReceipt["outcome"]
    | CadGuiSaveDocumentReceipt["outcome"];
  cancellationRequested: boolean;
  receipt?:
    | CadGuiOperationReceipt
    | CadGuiCopyDocumentReceipt
    | CadGuiUndoOperationReceipt
    | CadGuiSaveDocumentReceipt;
  reason?: string;
}

export interface CadGuiOperationController {
  execute(
    input: CadGuiSetPropertiesInput,
    binding: CadGuiOperationBinding,
    context: CadGuiProbeContext,
    guard?: () => Promise<void>,
  ): Promise<CadGuiOperationResult>;
  copyDocument(
    input: CadGuiCopyDocumentInput,
    binding: CadGuiOperationBinding,
    context: CadGuiProbeContext,
    guard?: () => Promise<void>,
  ): Promise<CadGuiOperationResult>;
  saveDocument(
    input: CadGuiSaveDocumentRequest,
    binding: CadGuiOperationBinding,
    context: CadGuiProbeContext,
    guard?: () => Promise<void>,
  ): Promise<CadGuiOperationResult>;
  undoOperation(
    input: CadGuiUndoOperationInput,
    binding: CadGuiOperationBinding,
    context: CadGuiProbeContext,
    guard?: () => Promise<void>,
  ): Promise<CadGuiOperationResult>;
  status(identity: CadGuiOperationIdentity): Promise<CadGuiOperationResult>;
}

export class CadGuiOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly operationId?: string,
    readonly outcome?: string,
  ) {
    super(message);
    this.name = "CadGuiOperationError";
  }
}

// 私有文件协议的轮询间隔，不是运行额度、重试或模型输出预算。
const PUBLICATION_POLL_MS = 20;

type OperationInput =
  | CadGuiSetPropertiesInput
  | CadGuiCopyDocumentInput
  | CadGuiSaveDocumentRequest
  | CadGuiUndoOperationInput;
type OperationName = "set-properties" | "save-copy" | "save-document" | "undo";

function macroPaths(paths: CadGuiOperationPaths): CadGuiOperationPaths {
  return {
    directory: paths.directory,
    manifestPath: paths.manifestPath,
    requestPath: paths.requestPath,
    macroPath: paths.macroPath,
    receiptPath: paths.receiptPath,
    cancelledPath: paths.cancelledPath,
    executionClaimPath: paths.executionClaimPath,
    dispatchClaimPath: paths.dispatchClaimPath,
  };
}

export function buildCadGuiOperationMacro(paths: CadGuiOperationPaths): string {
  const fixedPaths = macroPaths(paths);
  return [
    CAD_GUI_DOCUMENT_OBSERVER_SOURCE,
    CAD_GUI_PROPERTY_INSPECTION_SOURCE,
    CAD_GUI_PROPERTY_MUTATION_SOURCE,
    `\n_kfw_cad_set_properties(${JSON.stringify(fixedPaths)})\n`,
  ].join("\n");
}

export function buildCadGuiCopyDocumentMacro(
  paths: CadGuiOperationPaths,
): string {
  const fixedPaths = macroPaths(paths);
  return [
    CAD_GUI_DOCUMENT_OBSERVER_SOURCE,
    CAD_GUI_PROPERTY_INSPECTION_SOURCE,
    CAD_GUI_PROPERTY_MUTATION_SOURCE,
    CAD_GUI_DOCUMENT_COPY_SOURCE,
    `\n_kfw_cad_copy_document(${JSON.stringify(fixedPaths)})\n`,
  ].join("\n");
}

export function buildCadGuiSaveDocumentMacro(
  paths: CadGuiOperationPaths,
): string {
  const fixedPaths = macroPaths(paths);
  return [
    CAD_GUI_DOCUMENT_OBSERVER_SOURCE,
    CAD_GUI_PROPERTY_INSPECTION_SOURCE,
    CAD_GUI_PROPERTY_MUTATION_SOURCE,
    CAD_GUI_DOCUMENT_SAVE_SOURCE,
    `\n_kfw_cad_save_document(${JSON.stringify(fixedPaths)})\n`,
  ].join("\n");
}

export function buildCadGuiUndoOperationMacro(
  paths: CadGuiOperationPaths,
): string {
  const fixedPaths = macroPaths(paths);
  return [
    CAD_GUI_DOCUMENT_OBSERVER_SOURCE,
    CAD_GUI_PROPERTY_INSPECTION_SOURCE,
    CAD_GUI_PROPERTY_MUTATION_SOURCE,
    CAD_GUI_UNDO_SOURCE,
    `\n_kfw_cad_undo_operation(${JSON.stringify(fixedPaths)})\n`,
  ].join("\n");
}

function failure(
  error: unknown,
  operationId: string,
  outcome = "unknown",
): CadGuiOperationError {
  if (error instanceof CadGuiOperationError)
    return error.operationId
      ? error
      : new CadGuiOperationError(
          error.code,
          error.message,
          operationId,
          error.outcome ?? outcome,
        );
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "operation_failed";
  return new CadGuiOperationError(
    code,
    error instanceof Error
      ? error.message
      : "CAD 操作未完成，请查询原操作状态。",
    operationId,
    outcome,
  );
}

function validTimeout(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 2_147_483_647
  );
}

function receiptMatchesRequest(
  receipt: CadGuiOperationReceipt,
  record: CadGuiOperationRecord,
): boolean {
  if (
    receipt.operationId !== record.operationId ||
    receipt.fingerprint !== record.fingerprint ||
    !record.payload ||
    typeof record.payload !== "object"
  )
    return false;
  const { operation, timeoutMs, ...rawInput } = record.payload as Record<
    string,
    unknown
  >;
  const input = cadGuiSetPropertiesInputSchema.safeParse(rawInput);
  if (
    operation !== "set-properties" ||
    !validTimeout(timeoutMs) ||
    !input.success ||
    input.data.operationId !== record.operationId ||
    input.data.application.pid !== receipt.pid
  )
    return false;
  if (receipt.undoProvenance) {
    const snapshot = receipt.snapshot;
    if (
      !snapshot ||
      snapshot.bridgeEpoch !== input.data.bridgeEpoch ||
      snapshot.document.documentHandle !== input.data.documentHandle ||
      snapshot.applicationRevision < input.data.expectedApplicationRevision ||
      snapshot.document.revision < input.data.expectedDocumentRevision
    )
      return false;
  }
  const requested = new Map(
    input.data.changes.map((change) => [
      JSON.stringify([change.objectName, change.propertyName]),
      change,
    ]),
  );
  const seen = new Set<string>();
  for (const change of receipt.changes) {
    const key = JSON.stringify([change.objectName, change.propertyName]);
    const original = requested.get(key);
    if (
      seen.has(key) ||
      !original ||
      !isDeepStrictEqual(change.before, original.expectedValue) ||
      !isDeepStrictEqual(change.requested, original.value)
    )
      return false;
    seen.add(key);
  }
  if (receipt.outcome !== "committed" && receipt.outcome !== "no_op")
    return true;
  if (
    seen.size !== requested.size ||
    receipt.changes.some(
      (change) =>
        !isDeepStrictEqual(change.observed, change.requested) ||
        change.changed !== !isDeepStrictEqual(change.before, change.requested),
    )
  )
    return false;
  return receipt.outcome === "no_op"
    ? receipt.changes.every((change) => !change.changed)
    : receipt.changes.some((change) => change.changed);
}

function copyReceiptMatchesRequest(
  receipt: CadGuiCopyDocumentReceipt,
  record: CadGuiOperationRecord,
): boolean {
  if (!record.payload || typeof record.payload !== "object") return false;
  const { operation, timeoutMs, ...rawInput } = record.payload as Record<
    string,
    unknown
  >;
  const input = cadGuiCopyDocumentInputSchema.safeParse(rawInput);
  return (
    operation === "save-copy" &&
    validTimeout(timeoutMs) &&
    input.success &&
    input.data.operationId === record.operationId &&
    receipt.operationId === record.operationId &&
    receipt.fingerprint === record.fingerprint &&
    receipt.pid === input.data.application.pid
  );
}

function saveReceiptMatchesRequest(
  receipt: CadGuiSaveDocumentReceipt,
  record: CadGuiOperationRecord,
): boolean {
  if (!record.payload || typeof record.payload !== "object") return false;
  const { operation, timeoutMs, ...rawInput } = record.payload as Record<
    string,
    unknown
  >;
  const input = cadGuiSaveDocumentRequestSchema.safeParse(rawInput);
  return (
    operation === "save-document" &&
    validTimeout(timeoutMs) &&
    input.success &&
    input.data.operationId === record.operationId &&
    receipt.operationId === record.operationId &&
    receipt.fingerprint === record.fingerprint &&
    receipt.pid === input.data.application.pid &&
    (receipt.artifact === undefined ||
      receipt.artifact.canonicalPath === input.data.canonicalPath)
  );
}

function parseUndoSource(value: unknown) {
  const parsed = cadGuiUndoSourceSchema.safeParse(value);
  if (!parsed.success) return null;
  const { input, receipt } = parsed.data;
  const undoProvenance = receipt.undoProvenance;
  const snapshot = receipt.snapshot;
  if (receipt.outcome !== "committed" || !undoProvenance || !snapshot)
    return null;
  return {
    input,
    receipt: {
      ...receipt,
      outcome: "committed" as const,
      undoProvenance,
      snapshot,
    },
  };
}

function undoTargetMatches(
  input: CadGuiUndoOperationInput,
  source: NonNullable<ReturnType<typeof parseUndoSource>>,
): boolean {
  const snapshot = source.receipt.snapshot;
  return (
    input.sourceOperationId === source.receipt.operationId &&
    input.sourceOperationId === source.input.operationId &&
    isDeepStrictEqual(input.application, source.input.application) &&
    input.bridgeEpoch === snapshot.bridgeEpoch &&
    input.documentHandle === snapshot.document.documentHandle &&
    input.expectedApplicationRevision === snapshot.applicationRevision &&
    input.expectedDocumentRevision === snapshot.document.revision
  );
}

function undoReceiptMatchesRequest(
  receipt: CadGuiUndoOperationReceipt,
  record: CadGuiOperationRecord,
): boolean {
  if (!record.payload || typeof record.payload !== "object") return false;
  const { operation, timeoutMs, undoSource, ...rawInput } =
    record.payload as Record<string, unknown>;
  const input = cadGuiUndoOperationInputSchema.safeParse(rawInput);
  const source = parseUndoSource(undoSource);
  if (
    operation !== "undo" ||
    !validTimeout(timeoutMs) ||
    !input.success ||
    !source ||
    !undoTargetMatches(input.data, source) ||
    input.data.operationId !== record.operationId ||
    receipt.operationId !== record.operationId ||
    receipt.fingerprint !== record.fingerprint ||
    receipt.pid !== input.data.application.pid ||
    receipt.sourceOperationId !== input.data.sourceOperationId ||
    receipt.sourceFingerprint !== source.receipt.fingerprint ||
    (receipt.transactionName !== undefined &&
      receipt.transactionName !== source.receipt.undoProvenance.transactionName)
  )
    return false;
  const rows = new Map(
    source.receipt.changes.map((change) => [
      JSON.stringify([change.objectName, change.propertyName]),
      change,
    ]),
  );
  const seen = new Set<string>();
  for (const change of receipt.changes) {
    const key = JSON.stringify([change.objectName, change.propertyName]);
    const original = rows.get(key);
    if (
      seen.has(key) ||
      !original ||
      !isDeepStrictEqual(change.before, original.observed)
    )
      return false;
    seen.add(key);
    if (
      receipt.outcome === "undone" &&
      (!isDeepStrictEqual(change.observed, original.before) ||
        change.changed !== !isDeepStrictEqual(change.before, change.observed))
    )
      return false;
  }
  if (receipt.outcome !== "undone") return true;
  const snapshot = receipt.snapshot;
  return (
    seen.size === rows.size &&
    receipt.transactionName === source.receipt.undoProvenance.transactionName &&
    receipt.undoHistory?.count ===
      source.receipt.undoProvenance.undoHistory.count - 1 &&
    receipt.redoHistory?.count ===
      source.receipt.undoProvenance.redoHistory.count + 1 &&
    snapshot !== undefined &&
    snapshot.bridgeEpoch === input.data.bridgeEpoch &&
    snapshot.document.documentHandle === input.data.documentHandle &&
    snapshot.applicationRevision >= input.data.expectedApplicationRevision &&
    snapshot.document.revision >= input.data.expectedDocumentRevision
  );
}

export function createCadGuiOperationController(options: {
  store: CadGuiOperationStore;
  probe: CadGuiProbe;
  transport?: CadGuiMacroTransport;
}): CadGuiOperationController {
  const { store, probe } = options;
  const transport = options.transport ?? createMacosCadGuiTransport();

  async function result(
    record: CadGuiOperationRecord,
  ): Promise<CadGuiOperationResult> {
    const state = await store.readState(record);
    const base = {
      operationId: record.operationId,
      state: state.status,
      cancellationRequested: state.cancelled,
    };
    if (state.status === "terminal") {
      const operation =
        record.payload &&
        typeof record.payload === "object" &&
        "operation" in record.payload
          ? record.payload.operation
          : undefined;
      const receipt =
        operation === "undo"
          ? cadGuiUndoOperationReceiptSchema.safeParse(state.receipt)
          : operation === "save-copy"
            ? cadGuiCopyDocumentReceiptSchema.safeParse(state.receipt)
            : operation === "save-document"
              ? cadGuiSaveDocumentReceiptSchema.safeParse(state.receipt)
              : cadGuiOperationReceiptSchema.safeParse(state.receipt);
      if (
        !receipt.success ||
        !(receipt.data.protocol === "kfw-cad-gui-undo/1"
          ? undoReceiptMatchesRequest(receipt.data, record)
          : receipt.data.protocol === "kfw-cad-gui-copy/1"
            ? copyReceiptMatchesRequest(receipt.data, record)
            : receipt.data.protocol === "kfw-cad-gui-save/1"
              ? saveReceiptMatchesRequest(receipt.data, record)
              : receiptMatchesRequest(receipt.data, record))
      )
        return { ...base, outcome: "unknown", reason: "invalid_receipt" };
      return {
        ...base,
        outcome: receipt.data.outcome,
        receipt: receipt.data,
        ...(receipt.data.reason ? { reason: receipt.data.reason } : {}),
      };
    }
    if (state.receiptError)
      return { ...base, outcome: "unknown", reason: "invalid_receipt" };
    return {
      ...base,
      outcome:
        state.status === "prepared" || state.status === "cancelled"
          ? state.status
          : "unknown",
    };
  }

  async function cancel(record: CadGuiOperationRecord): Promise<void> {
    try {
      await store.cancel(record);
    } catch {
      throw new CadGuiOperationError(
        "stop_unconfirmed",
        "无法保存 CAD 取消请求，请查询原操作状态。",
        record.operationId,
        "unknown",
      );
    }
  }

  async function loadUndoSource(
    input: CadGuiUndoOperationInput,
    binding: CadGuiOperationBinding,
  ) {
    const sourceRecord = await store.lookup({
      instanceId: binding.instanceId,
      taskId: binding.taskId,
      operationId: input.sourceOperationId,
    });
    const unavailable = () =>
      new CadGuiOperationError(
        "undo_source_unavailable",
        "原操作缺少已确认的撤销证明，请查询原操作状态。",
        input.operationId,
        "rejected",
      );
    if (
      !sourceRecord ||
      sourceRecord.binding.instanceId !== binding.instanceId ||
      sourceRecord.binding.taskId !== binding.taskId ||
      sourceRecord.binding.projectId !== binding.projectId ||
      !sourceRecord.payload ||
      typeof sourceRecord.payload !== "object"
    )
      throw unavailable();
    const { operation, timeoutMs, ...rawSourceInput } =
      sourceRecord.payload as Record<string, unknown>;
    const sourceInput =
      cadGuiSetPropertiesInputSchema.safeParse(rawSourceInput);
    if (
      operation !== "set-properties" ||
      !validTimeout(timeoutMs) ||
      !sourceInput.success
    )
      throw unavailable();
    const original = await result(sourceRecord);
    if (
      original.outcome !== "committed" ||
      original.receipt?.protocol !== "kfw-cad-gui-operation/1"
    )
      throw unavailable();
    const source = parseUndoSource({
      input: sourceInput.data,
      receipt: original.receipt,
    });
    if (!source) throw unavailable();
    return source;
  }

  async function operationPayload(
    input: OperationInput,
    operation: OperationName,
    timeoutMs: number,
    existing: CadGuiOperationRecord | null,
    binding: CadGuiOperationBinding,
  ) {
    const conflict = () =>
      new CadGuiOperationError(
        "conflict",
        "CAD 操作编号已用于不同请求，请先查询原操作状态；独立的新操作才使用新编号。",
        input.operationId,
        "unknown",
      );
    let saved: Record<string, unknown> | undefined;
    if (existing) {
      if (
        !existing.payload ||
        typeof existing.payload !== "object" ||
        !("timeoutMs" in existing.payload) ||
        !validTimeout(existing.payload.timeoutMs)
      )
        throw new CadGuiOperationError(
          "invalid_record",
          "CAD 操作记录参数无效，请检查实例数据目录。",
          input.operationId,
          "unknown",
        );
      saved = existing.payload as Record<string, unknown>;
      timeoutMs = existing.payload.timeoutMs;
      if (saved.operation !== operation) throw conflict();
    }
    let source: ReturnType<typeof parseUndoSource> = null;
    if (operation === "undo") {
      if (!("sourceOperationId" in input)) throw conflict();
      if (saved) {
        const {
          operation: _operation,
          timeoutMs: _timeoutMs,
          undoSource,
          ...publicInput
        } = saved;
        if (!isDeepStrictEqual(publicInput, input)) throw conflict();
        source = parseUndoSource(undoSource);
      } else source = await loadUndoSource(input, binding);
      if (!source)
        throw new CadGuiOperationError(
          "invalid_record",
          "撤销操作的来源证明无效，请查询原操作状态。",
          input.operationId,
          "unknown",
        );
      if (!undoTargetMatches(input, source))
        throw new CadGuiOperationError(
          "undo_target_mismatch",
          "撤销目标与原提交后的状态不一致，请使用原操作的目标快照。",
          input.operationId,
          "rejected",
        );
    }
    const payload = {
      operation,
      ...input,
      timeoutMs,
      ...(operation === "undo" ? { undoSource: source } : {}),
    };
    if (existing && !isDeepStrictEqual(existing.payload, payload))
      throw conflict();
    return payload;
  }

  async function runOperation(
    input: OperationInput,
    operation: OperationName,
    rawBinding: CadGuiOperationBinding,
    rawContext: CadGuiProbeContext,
    guard?: () => Promise<void>,
  ): Promise<CadGuiOperationResult> {
    const macroBuilder = {
      "set-properties": buildCadGuiOperationMacro,
      "save-copy": buildCadGuiCopyDocumentMacro,
      "save-document": buildCadGuiSaveDocumentMacro,
      undo: buildCadGuiUndoOperationMacro,
    }[operation];
    const binding = { ...rawBinding };
    const context = { ...rawContext };
    if (
      !validTimeout(context.timeoutMs) ||
      !Number.isSafeInteger(context.maxOutputBytes) ||
      context.maxOutputBytes <= 0
    )
      throw new CadGuiOperationError(
        "invalid_input",
        "CAD 操作限制无效，请检查实例设置。",
        input.operationId,
      );
    const identity = {
      instanceId: binding.instanceId,
      taskId: binding.taskId,
      operationId: input.operationId,
    };
    let deadline = Date.now() + context.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(context.signal?.reason);
    context.signal?.addEventListener("abort", abort, { once: true });
    if (context.signal?.aborted) abort();
    const expire = () => {
      timedOut = true;
      controller.abort();
    };
    let timer = setTimeout(expire, context.timeoutMs);
    const remaining = () => Math.max(1, deadline - Date.now());
    let record: CadGuiOperationRecord | undefined;
    let cancellationNeeded = false;
    const assertActive = () => {
      if (Date.now() >= deadline) expire();
      if (controller.signal.aborted)
        throw new CadGuiOperationError(
          timedOut ? "operation_timeout" : "cancelled",
          timedOut
            ? "CAD 操作等待超时，请查询原操作状态。"
            : "CAD 操作已请求取消。",
          input.operationId,
          "unknown",
        );
    };
    const boundary = async () => {
      assertActive();
      await guard?.();
      assertActive();
    };
    const activeContext = () => ({
      ...context,
      signal: controller.signal,
      timeoutMs: remaining(),
    });
    async function published() {
      for (;;) {
        assertActive();
        try {
          return await store.lookup(identity);
        } catch (error) {
          if (
            !(error instanceof CadGuiOperationStoreError) ||
            error.code !== "busy"
          )
            throw error;
          try {
            await delay(Math.min(PUBLICATION_POLL_MS, remaining()), undefined, {
              signal: controller.signal,
            });
          } catch {
            // 尚无完整 manifest 时无法安全生成取消墓碑，也不能确认另一 caller 已停止。
            throw new CadGuiOperationError(
              "stop_unconfirmed",
              "CAD 操作准备状态尚未确认，请查询原操作状态。",
              input.operationId,
              "unknown",
            );
          }
        }
      }
    }
    try {
      for (;;) {
        const existing = await published();
        const payload = await operationPayload(
          input,
          operation,
          context.timeoutMs,
          existing,
          binding,
        );
        await boundary();
        try {
          record = await store.prepare({
            binding,
            operationId: input.operationId,
            payload,
            buildMacro: macroBuilder,
          });
          break;
        } catch (error) {
          if (
            !(error instanceof CadGuiOperationStoreError) ||
            error.code !== "busy"
          )
            throw error;
        }
      }
      let current = await result(record);
      // 已认领操作只能读既有状态；transport 成功不代替 GUI 的事务 ACK。
      if (current.state !== "prepared" || current.outcome !== "prepared")
        return current;
      const payload = await operationPayload(
        input,
        operation,
        context.timeoutMs,
        record,
        binding,
      );
      deadline = Math.min(deadline, record.preparedAt + payload.timeoutMs);
      clearTimeout(timer);
      timer = setTimeout(expire, remaining());
      cancellationNeeded = true;
      await boundary();
      const sourceHash = createHash("sha256")
        .update(macroBuilder(record))
        .digest("hex");
      if (sourceHash !== record.sourceHash)
        throw new CadGuiOperationError(
          "implementation_changed",
          "CAD 操作实现已变化，请先查询原操作状态；独立的新操作才使用新编号。",
          record.operationId,
          "prepared",
        );
      await probe.verify(input.application, activeContext());
      await boundary();
      if (!(await store.claimDispatch(record))) return await result(record);
      await boundary();
      await probe.verify(input.application, activeContext());
      await boundary();
      await transport.send(
        input.application,
        record.macroPath,
        activeContext(),
      );
      for (;;) {
        assertActive();
        current = await result(record);
        if (
          current.state === "terminal" ||
          current.outcome !== "unknown" ||
          current.reason ||
          current.cancellationRequested
        )
          return current;
        await delay(Math.min(PUBLICATION_POLL_MS, remaining()), undefined, {
          signal: controller.signal,
        });
      }
    } catch (error) {
      if (!record) throw failure(error, input.operationId);
      if (!cancellationNeeded) throw failure(error, input.operationId);
      await cancel(record);
      const current = await result(record);
      if (controller.signal.aborted)
        return {
          ...current,
          cancellationRequested: true,
          reason: timedOut ? "timeout" : "cancelled",
        };
      if (current.state === "terminal" && current.outcome !== "unknown")
        return current;
      throw failure(error, input.operationId, current.outcome);
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
    }
  }

  return {
    async undoOperation(rawInput, binding, context, guard) {
      const parsed = cadGuiUndoOperationInputSchema.safeParse(rawInput);
      if (!parsed.success)
        throw new CadGuiOperationError(
          "invalid_input",
          "CAD 撤销参数无效，请检查原操作编号和目标快照。",
          rawInput.operationId,
        );
      return runOperation(parsed.data, "undo", binding, context, guard);
    },
    async execute(rawInput, binding, context, guard) {
      const parsed = cadGuiSetPropertiesInputSchema.safeParse(rawInput);
      if (!parsed.success)
        throw new CadGuiOperationError(
          "invalid_input",
          "CAD 属性修改参数无效，请重新查询文档。",
          rawInput.operationId,
        );
      return runOperation(
        parsed.data,
        "set-properties",
        binding,
        context,
        guard,
      );
    },
    async copyDocument(rawInput, binding, context, guard) {
      const parsed = cadGuiCopyDocumentInputSchema.safeParse(rawInput);
      if (!parsed.success)
        throw new CadGuiOperationError(
          "invalid_input",
          "CAD 文档复制参数无效，请重新查询文档。",
          rawInput.operationId,
        );
      return runOperation(parsed.data, "save-copy", binding, context, guard);
    },
    async saveDocument(rawInput, binding, context, guard) {
      const parsed = cadGuiSaveDocumentRequestSchema.safeParse(rawInput);
      if (!parsed.success)
        throw new CadGuiOperationError(
          "invalid_input",
          "CAD 文档保存参数无效，请重新查询已有文档和文件路径。",
          rawInput.operationId,
        );
      return runOperation(
        parsed.data,
        "save-document",
        binding,
        context,
        guard,
      );
    },
    async status(identity) {
      try {
        const record = await store.lookup(identity);
        if (!record)
          throw new CadGuiOperationError(
            "not_found",
            "CAD 操作记录不存在，请检查操作编号。",
            identity.operationId,
          );
        return await result(record);
      } catch (error) {
        throw failure(error, identity.operationId);
      }
    },
  };
}
