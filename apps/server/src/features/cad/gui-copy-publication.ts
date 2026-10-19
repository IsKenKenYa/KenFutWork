import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { observeBinary } from "../code-tools/file-bytes.js";
import { ScopedFileController } from "../code-tools/file-controller.js";
import { runFileOperation } from "../code-tools/file-operations.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { ScopedFilesystemScope } from "../execution/scoped-filesystem.js";
import { cadGuiCopyDocumentReceiptSchema } from "./gui-document-copy-contracts.js";
import type {
  CadGuiOperationRecord,
  CadGuiOperationStore,
} from "./gui-operation-store.js";

export interface CadGuiCopyPublicationResult {
  operationId: string;
  outcome: "published" | "not_published" | "unknown";
  outputPath?: string;
  sha256?: string;
  sizeBytes?: number;
  version?: string;
  reason?: string;
}

export interface CadGuiCopyPublisher {
  publish(
    record: CadGuiOperationRecord,
    handle: ExecutionScopeHandle,
    signal: AbortSignal,
    guard?: () => Promise<void>,
  ): Promise<CadGuiCopyPublicationResult>;
  status(record: CadGuiOperationRecord): Promise<CadGuiCopyPublicationResult>;
}

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const fields = {
  operationId: z.string().uuid(),
  fingerprint: hash,
  outputPath: z.string().min(1).refine(isAbsolute),
  sha256: hash,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  scopeGeneration: z.number().int().nonnegative(),
  branchGeneration: z.number().int().nonnegative(),
};
const claimSchema = z
  .object({ protocol: z.literal("kfw-cad-copy-publication/1"), ...fields })
  .strict();
const receiptSchema = z
  .object({
    protocol: z.literal("kfw-cad-copy-publication-receipt/1"),
    ...fields,
    outcome: z.literal("published"),
    version: hash,
    publishedAt: z.number().int().nonnegative(),
  })
  .strict();

class PublicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function reject(code: string, message: string): never {
  throw new PublicationError(code, message);
}

function publicationFacts(
  value: z.infer<typeof claimSchema> | z.infer<typeof receiptSchema>,
) {
  const {
    operationId,
    fingerprint,
    outputPath,
    sha256,
    sizeBytes,
    scopeGeneration,
    branchGeneration,
  } = value;
  return {
    operationId,
    fingerprint,
    outputPath,
    sha256,
    sizeBytes,
    scopeGeneration,
    branchGeneration,
  };
}
function belongs(
  record: CadGuiOperationRecord,
  value: z.infer<typeof claimSchema>,
) {
  return (
    value.operationId === record.operationId &&
    value.fingerprint === record.fingerprint &&
    value.scopeGeneration === record.binding.scopeGeneration &&
    value.branchGeneration === record.binding.branchGeneration
  );
}

async function readArtifact(
  record: CadGuiOperationRecord,
  store: CadGuiOperationStore,
  signal: AbortSignal,
) {
  const native = await store.readState(record);
  const parsed = cadGuiCopyDocumentReceiptSchema.safeParse(native.receipt);
  const payload = record.payload;
  const pid =
    payload &&
    typeof payload === "object" &&
    "application" in payload &&
    payload.application &&
    typeof payload.application === "object" &&
    "pid" in payload.application
      ? payload.application.pid
      : undefined;
  if (
    !parsed.success ||
    parsed.data.outcome !== "copied" ||
    !parsed.data.artifact ||
    parsed.data.operationId !== record.operationId ||
    parsed.data.fingerprint !== record.fingerprint ||
    parsed.data.pid !== pid
  )
    return reject(
      "native_copy_unconfirmed",
      "FreeCAD 副本尚未确认，请查询原操作状态。",
    );
  const artifact = parsed.data.artifact;
  signal.throwIfAborted();
  const file = await open(
    join(record.directory, artifact.name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== artifact.size)
      reject("artifact_changed", "FreeCAD 副本文件已变化，已停止发布。");
    const bytes = await file.readFile({ signal });
    const after = await file.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
    )
      reject("artifact_changed", "FreeCAD 副本文件已变化，已停止发布。");
    return { bytes, artifact };
  } finally {
    await file.close();
  }
}

function createPublicationScope(
  record: CadGuiOperationRecord,
  handle: ExecutionScopeHandle,
  signal: AbortSignal,
  guard?: () => Promise<void>,
) {
  const assertScope = async () => {
    signal.throwIfAborted();
    await guard?.();
    const scope = handle.describe();
    if (handle.role !== "main" || scope.sandboxMode === "read-only")
      reject("forbidden", "当前 Task 不能发布 FreeCAD 副本。");
    if (
      scope.instanceId !== record.binding.instanceId ||
      scope.projectId !== record.binding.projectId ||
      scope.taskId !== record.binding.taskId ||
      scope.generation !== record.binding.scopeGeneration ||
      handle.branchGeneration !== record.binding.branchGeneration
    )
      reject("scope_changed", "Task 或目录授权已变化，已停止发布。");
    signal.throwIfAborted();
  };
  const scope: ScopedFilesystemScope = {
    describe: () => handle.describe(),
    role: handle.role,
    agentId: handle.agentId,
    async resolvePath(path, access) {
      await assertScope();
      const resolved = await handle.resolvePath(path, access);
      await assertScope();
      return resolved;
    },
  };
  return { scope, assertScope };
}

export function createCadGuiCopyPublisher({
  store,
}: {
  store: CadGuiOperationStore;
}): CadGuiCopyPublisher {
  async function status(
    record: CadGuiOperationRecord,
  ): Promise<CadGuiCopyPublicationResult> {
    const base = { operationId: record.operationId };
    try {
      const journal = await store.readPublication(record);
      if (journal.claim === undefined && journal.receipt === undefined)
        return { ...base, outcome: "not_published" };
      const claim = claimSchema.safeParse(journal.claim);
      if (!claim.success || !belongs(record, claim.data))
        return { ...base, outcome: "unknown", reason: "invalid_publication" };
      if (journal.receipt === undefined)
        return {
          ...base,
          outcome: "unknown",
          outputPath: claim.data.outputPath,
          reason: "publication_unconfirmed",
        };
      const receipt = receiptSchema.safeParse(journal.receipt);
      if (
        !receipt.success ||
        !isDeepStrictEqual(
          publicationFacts(claim.data),
          publicationFacts(receipt.data),
        )
      )
        return {
          ...base,
          outcome: "unknown",
          outputPath: claim.data.outputPath,
          reason: "invalid_publication",
        };
      return {
        ...base,
        outcome: "published",
        outputPath: receipt.data.outputPath,
        sha256: receipt.data.sha256,
        sizeBytes: receipt.data.sizeBytes,
        version: receipt.data.version,
      };
    } catch {
      return { ...base, outcome: "unknown", reason: "invalid_publication" };
    }
  }
  return {
    status,
    async publish(record, handle, signal, guard) {
      let claimed = false;
      let outputPath: string | undefined;
      const { scope, assertScope } = createPublicationScope(
        record,
        handle,
        signal,
        guard,
      );
      try {
        await assertScope();
        const previous = await status(record);
        if (previous.outcome !== "not_published") return previous;
        const payload = record.payload;
        if (
          !payload ||
          typeof payload !== "object" ||
          !("operation" in payload) ||
          payload.operation !== "save-copy"
        )
          reject("invalid_record", "原操作不是文档副本，不能发布。");
        const requested =
          "outputPath" in payload && typeof payload.outputPath === "string"
            ? payload.outputPath
            : `.kfw-cad/gui-snapshots/${record.operationId}.FCStd`;
        outputPath = await scope.resolvePath(requested, "write");
        if (!/\.FCStd$/iu.test(outputPath))
          reject("invalid_output_path", "副本文件必须使用 .FCStd 扩展名。");
        const { bytes, artifact } = await readArtifact(record, store, signal);
        if ((await observeBinary(scope, outputPath, signal)).version !== null)
          reject("output_exists", "目标文件已存在，请使用新的文件名。");
        await assertScope();
        const claim = claimSchema.parse({
          protocol: "kfw-cad-copy-publication/1",
          operationId: record.operationId,
          fingerprint: record.fingerprint,
          outputPath,
          sha256: artifact.sha256,
          sizeBytes: bytes.length,
          scopeGeneration: record.binding.scopeGeneration,
          branchGeneration: record.binding.branchGeneration,
        });
        if (!(await store.claimPublication(record, claim)))
          return await status(record);
        claimed = true;
        await assertScope();
        const controller = new ScopedFileController(
          scope,
          handle.backend.limits,
        );
        const published = await runFileOperation(
          scope,
          signal,
          (activeSignal) =>
            controller.publishBytes(
              claim.outputPath,
              bytes,
              null,
              undefined,
              activeSignal,
            ),
          "write",
        );
        await assertScope();
        if (
          published.path !== outputPath ||
          !published.version ||
          published.sizeBytes !== bytes.length
        )
          reject(
            "publication_unconfirmed",
            "副本发布结果未确认，请查询原操作状态。",
          );
        await store.completePublication(record, {
          ...publicationFacts(claim),
          protocol: "kfw-cad-copy-publication-receipt/1",
          outcome: "published",
          version: published.version,
          publishedAt: Date.now(),
        });
        return await status(record);
      } catch (error) {
        // 同编号的另一调用可能已在本次读取目标前发布；以持久认领/回执为准。
        if (!claimed && outputPath) {
          const concurrent = await status(record);
          if (concurrent.outcome !== "not_published") return concurrent;
        }
        const reason =
          error instanceof PublicationError
            ? error.code
            : signal.aborted
              ? "cancelled"
              : "publication_failed";
        return {
          operationId: record.operationId,
          outcome: claimed ? "unknown" : "not_published",
          ...(outputPath ? { outputPath } : {}),
          reason,
        };
      }
    },
  };
}
