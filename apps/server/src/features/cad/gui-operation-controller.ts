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
  type CadGuiMacroTransport,
  createMacosCadGuiTransport,
} from "./gui-transport.js";

export interface CadGuiOperationResult {
  operationId: string;
  state: "prepared" | "cancelled" | "dispatched" | "executing" | "terminal";
  outcome:
    | "prepared"
    | "cancelled"
    | "unknown"
    | CadGuiOperationReceipt["outcome"]
    | CadGuiCopyDocumentReceipt["outcome"];
  cancellationRequested: boolean;
  receipt?: CadGuiOperationReceipt | CadGuiCopyDocumentReceipt;
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

type OperationInput = CadGuiSetPropertiesInput | CadGuiCopyDocumentInput;
type OperationName = "set-properties" | "save-copy";

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

function operationPayload(
  input: OperationInput,
  operation: OperationName,
  timeoutMs: number,
  existing: CadGuiOperationRecord | null,
) {
  if (existing) {
    const payload = existing.payload;
    if (
      !payload ||
      typeof payload !== "object" ||
      !("timeoutMs" in payload) ||
      !validTimeout(payload.timeoutMs)
    )
      throw new CadGuiOperationError(
        "invalid_record",
        "CAD 操作记录参数无效，请检查实例数据目录。",
        input.operationId,
        "unknown",
      );
    timeoutMs = payload.timeoutMs;
  }
  const payload = { operation, ...input, timeoutMs };
  if (existing && !isDeepStrictEqual(existing.payload, payload))
    throw new CadGuiOperationError(
      "conflict",
      "CAD 操作编号已用于不同请求，请先查询原操作状态；独立的新操作才使用新编号。",
      input.operationId,
      "unknown",
    );
  return payload;
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
      const isCopy =
        record.payload &&
        typeof record.payload === "object" &&
        "operation" in record.payload &&
        record.payload.operation === "save-copy";
      const receipt = isCopy
        ? cadGuiCopyDocumentReceiptSchema.safeParse(state.receipt)
        : cadGuiOperationReceiptSchema.safeParse(state.receipt);
      if (
        !receipt.success ||
        !(receipt.data.protocol === "kfw-cad-gui-copy/1"
          ? copyReceiptMatchesRequest(receipt.data, record)
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

  async function runOperation(
    input: OperationInput,
    operation: OperationName,
    rawBinding: CadGuiOperationBinding,
    rawContext: CadGuiProbeContext,
    guard?: () => Promise<void>,
  ): Promise<CadGuiOperationResult> {
    const macroBuilder =
      operation === "save-copy"
        ? buildCadGuiCopyDocumentMacro
        : buildCadGuiOperationMacro;
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
        const payload = operationPayload(
          input,
          operation,
          context.timeoutMs,
          existing,
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
      const payload = operationPayload(
        input,
        operation,
        context.timeoutMs,
        record,
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
