import { isAbsolute } from "node:path";
import type { CodeExecutionScope, StreamEvent } from "@kenfutwork/shared";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { applyPatch, structuredPatch } from "diff";
import { z } from "zod";
import type { AuthenticatedUser } from "../auth/types.js";
import type { CheckpointService } from "../checkpoints/checkpoint-service.js";
import { hasTaskFileOperations } from "../code-tools/file-operations.js";
import type { FileRestoreChange } from "../code-tools/file-types.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import {
  acquireTaskFileRestoreBarrier,
  revokeTaskFileOperations,
} from "../execution/scoped-filesystem.js";
import type { ProcessSandbox } from "../process-sandbox/types.js";
import { requireFileChangesTarget } from "./file-changes.js";

const commitSchema = z.object({
  type: z.enum(["create", "update", "delete"]),
  filePath: z.string().min(1),
  content: z.string(),
  originalFile: z.string().nullable(),
  structuredPatch:
    protocol.fileDiffToolResultDisplaySchema.shape.structuredPatch,
  version: z.string().min(1),
  userModified: z.literal(false),
});
const patchCommitSchema = commitSchema
  .pick({ filePath: true, structuredPatch: true, version: true })
  .extend({
    type: z.enum(["add", "update", "delete", "move"]),
    movePath: z.string().min(1).optional(),
  });
const patchResultSchema = z.object({
  files: z.array(patchCommitSchema),
  failures: z.array(z.object({ filePath: z.string(), error: z.string() })),
});
type NativeCommit =
  | z.infer<typeof commitSchema>
  | z.infer<typeof patchCommitSchema>;
type Operation = { runId: string; toolName: string; commit: NativeCommit };
type Operations = [Operation, ...Operation[]];
type Unsafe =
  protocol.V4ConversationFileRewindPreviewResult["unsafeFiles"][number];
class UnsafeFile extends Error {
  constructor(
    readonly reason: Unsafe["reason"],
    message: string,
  ) {
    super(message);
  }
}

export interface FileRewindCapture {
  runId: string;
  preCheckpointId: string | null;
  postCheckpointId: string | null;
}
export interface PrepareFileRewindInput {
  scope: ExecutionScopeHandle;
  actor: AuthenticatedUser;
  snapshot: protocol.ConversationSnapshot;
  params: protocol.V4ConversationFileRewindPreviewParams;
  events: readonly StreamEvent[];
  captures?: readonly FileRewindCapture[] | null;
  checkpoints: Pick<CheckpointService, "readFileSnapshot">;
}
/** 仅可信宿主持有，字节与执行计划不得进入V4 preview。 */
export interface PreparedFileRewind {
  preview: protocol.V4ConversationFileRewindPreviewResult;
  entries: FileRestoreChange[];
  identity: CodeExecutionScope;
}
export interface ApplyFileRewindInput {
  scope: ExecutionScopeHandle;
  actor: AuthenticatedUser;
  processSandbox: Pick<ProcessSandbox, "acquireRestoreBarrier" | "closeTask">;
  beginRestore(
    scope: ExecutionScopeHandle,
    actor: AuthenticatedUser,
  ): Promise<ExecutionScopeHandle>;
  /** 宿主先持久化reverted投影与ACK，再开放Task readiness。 */
  finishRestore(
    scope: ExecutionScopeHandle,
    actor: AuthenticatedUser,
    success: boolean,
  ): Promise<void>;
}

function collectOperations(input: PrepareFileRewindInput, turnId: string) {
  const files = new Map<string, Operations>();
  const rows = new Map<string, protocol.ToolCallRow>();
  for (const row of input.snapshot.rows.window)
    if (
      row.kind === "toolCall" &&
      row.turnId === turnId &&
      ["Write", "Edit", "ApplyPatch"].includes(row.toolName)
    )
      rows.set(row.toolCallId, row);
  const seen = new Set<string>();
  // 同路径的提交顺序来自持久完成日志，启动行的先后不能代表锁内真实提交先后。
  for (const event of input.events) {
    if (event.type !== "tool.completed") continue;
    const key = `${event.runId}/${event.toolCallId}`;
    const row = rows.get(key);
    if (!row) continue;
    if (event.toolName !== row.toolName || seen.has(key))
      throw new Error("真实文件提交日志缺失或重复，不能准备回退。");
    seen.add(key);
    const single =
      row.toolName === "ApplyPatch"
        ? null
        : commitSchema.safeParse(event.output);
    const multiple =
      row.toolName === "ApplyPatch"
        ? patchResultSchema.safeParse(event.output)
        : null;
    const commits = single?.success
      ? [single.data]
      : multiple?.success
        ? multiple.data.files
        : null;
    if (!commits) {
      if (
        row.status === "success" ||
        (event.output &&
          ("filePath" in event.output || "files" in event.output)) ||
        row.output?.display?.kind === "file_diff" ||
        row.output?.display?.kind === "file_diffs"
      )
        throw new Error(
          "文件提交canonical日志不完整，不能用展示预览准备回退。",
        );
      continue;
    }
    for (const commit of commits) {
      const operation = { runId: event.runId, toolName: row.toolName, commit };
      const entries = files.get(commit.filePath);
      if (entries) entries.push(operation);
      else files.set(commit.filePath, [operation]);
    }
  }
  if (seen.size !== rows.size)
    throw new Error("真实文件提交日志缺失或重复，不能准备回退。");
  return files;
}

function decode(bytes: Uint8Array | null) {
  if (!bytes) return { text: null, encoding: "utf-8" as const, bom: false };
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  const bom =
    encoding !== "utf-8" ||
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);
  return {
    text: new TextDecoder(encoding, { fatal: true }).decode(bytes),
    encoding,
    bom,
  };
}
function encode(text: string, format: ReturnType<typeof decode>): Uint8Array {
  if (format.encoding === "utf-8")
    return Buffer.from(`${format.bom ? "\ufeff" : ""}${text}`, "utf8");
  const bytes = Buffer.from(text, "utf16le");
  if (format.encoding === "utf-16be") bytes.swap16();
  return Buffer.concat([
    Buffer.from(format.encoding === "utf-16be" ? [0xfe, 0xff] : [0xff, 0xfe]),
    bytes,
  ]);
}
function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === null || right === null
    ? left === right
    : Buffer.from(left).equals(Buffer.from(right));
}
function rebuild(
  bytes: Uint8Array | null,
  operation: Operation,
): Uint8Array | null {
  const format = decode(bytes);
  const { commit } = operation;
  if (commit.type === "move")
    throw new UnsafeFile(
      "unsupported_checkpoint",
      "移动提交缺少源与目标的完整原生版本证据，不能安全回退。",
    );
  const created = commit.type === "create" || commit.type === "add";
  if (created !== (bytes === null))
    throw new UnsafeFile(
      "external_modified",
      "精确pre文件存在性与原生提交动作不一致。",
    );
  if ("originalFile" in commit && format.text !== commit.originalFile)
    throw new UnsafeFile(
      "external_modified",
      "精确pre与原生修改原文不一致，存在未归因的同路径修改。",
    );
  const content =
    "content" in commit
      ? commit.content
      : applyPatch(
          format.text ?? "",
          {
            oldFileName: commit.filePath,
            newFileName: commit.filePath,
            oldHeader: undefined,
            newHeader: undefined,
            hunks: commit.structuredPatch,
          },
          { autoConvertLineEndings: false },
        );
  if (content === false)
    throw new UnsafeFile(
      "external_modified",
      "精确pre不能应用完整原生补丁，不能回退。",
    );
  // 与native canonical统一用零上下文校验完整hunk；这是补丁格式口径，不是预览限额。
  const expected = structuredPatch(
    commit.filePath,
    commit.filePath,
    format.text ?? "",
    content,
    undefined,
    undefined,
    { context: 0 },
  ).hunks;
  if (JSON.stringify(expected) !== JSON.stringify(commit.structuredPatch))
    throw new UnsafeFile(
      "unsupported_checkpoint",
      "完整canonical补丁不能重建原生提交。",
    );
  if (commit.type === "delete" && content !== "")
    throw new UnsafeFile(
      "unsupported_checkpoint",
      "删除补丁未完整覆盖原文件。",
    );
  return commit.type === "delete" ? null : encode(content, format);
}
async function prepareFile(
  input: PrepareFileRewindInput,
  path: string,
  operations: Operations,
): Promise<FileRestoreChange> {
  if (
    !isAbsolute(path) ||
    (await input.scope.resolvePath(path, "write")) !== path
  )
    throw new UnsafeFile(
      "unsupported_checkpoint",
      "文件路径或写权限与真实提交不一致。",
    );
  const runId = operations[0].runId;
  if (operations.some((entry) => entry.runId !== runId))
    throw new UnsafeFile(
      "unsupported_checkpoint",
      "文件含多个未联接的执行边界。",
    );
  const captures = input.captures?.filter((entry) => entry.runId === runId);
  const capture = captures?.length === 1 ? captures[0] : null;
  if (!capture?.preCheckpointId || !capture.postCheckpointId)
    throw new UnsafeFile(
      "checkpoint_missing",
      "缺少该Run精确pre/post文件检查点引用。",
    );
  let pre: Awaited<ReturnType<CheckpointService["readFileSnapshot"]>>;
  let post: Awaited<ReturnType<CheckpointService["readFileSnapshot"]>>;
  try {
    pre = await input.checkpoints.readFileSnapshot({
      scope: input.scope,
      actor: input.actor,
      checkpointId: capture.preCheckpointId,
      path,
    });
    post = await input.checkpoints.readFileSnapshot({
      scope: input.scope,
      actor: input.actor,
      checkpointId: capture.postCheckpointId,
      path,
    });
  } catch (error) {
    throw new UnsafeFile(
      "checkpoint_unreadable",
      error instanceof Error ? error.message : String(error),
    );
  }
  let expectedBytes = pre.bytes;
  let last = operations[0].commit;
  for (const operation of operations) {
    expectedBytes = rebuild(expectedBytes, operation);
    last = operation.commit;
  }
  if (!sameBytes(expectedBytes, post.bytes))
    throw new UnsafeFile(
      "external_modified",
      "精确post与完整原生提交不一致，存在shell或外部同路径修改。",
    );
  const expectedVersion = last.type === "delete" ? null : last.version;
  const current = await input.scope.backend.observeBinary(path);
  if (current.path !== path || current.version !== expectedVersion)
    throw new UnsafeFile(
      "external_modified",
      "文件已在原生提交后变化，不能回退。",
    );
  if (current.version !== null && current.mode === undefined)
    throw new UnsafeFile(
      "file_read_failed",
      "现存文件缺少实际权限观察，不能恢复。",
    );
  // Git只保存可执行位，材料化mode不是完整原权限；现存文件保留最终native观察mode。
  // POSIX 0600/0100为固定权限语义，非运行时限额；已删文件默认owner读写并仅继承owner执行位。
  const mode = current.mode ?? 0o600 | ((pre.mode ?? 0) & 0o100);
  return {
    path,
    bytes: pre.bytes,
    expectedVersion,
    ...(pre.bytes === null ? {} : { mode }),
  };
}
export async function prepareFileRewind(
  input: PrepareFileRewindInput,
): Promise<PreparedFileRewind> {
  const target = requireFileChangesTarget(input.snapshot, input.params);
  await input.scope.resolvePath(".", "read");
  const identity = input.scope.describe();
  if (
    input.scope.role !== "main" ||
    input.params.sessionId !== identity.taskId ||
    input.snapshot.sessionId !== identity.taskId
  )
    throw new Error("文件回退只接受当前根Task与轮次身份。");
  const budget = input.scope.backend.limits.codePatchMaxBytes;
  if (!Number.isSafeInteger(budget) || budget <= 0)
    throw new Error("工作区文件恢复字节预算无效。");
  const preview: protocol.V4ConversationFileRewindPreviewResult = {
    canApply: false,
    ignoredFiles: [],
    safeFiles: [],
    unsafeFiles: [],
  };
  const entries: FileRestoreChange[] = [];
  for (const [path, operations] of collectOperations(input, target.turnId)) {
    const fact = {
      path,
      operationCount: operations.length,
      toolNames: [...new Set(operations.map((entry) => entry.toolName))],
    };
    try {
      const entry = await prepareFile(input, path, operations);
      entries.push(entry);
      preview.safeFiles.push({
        ...fact,
        action: entry.bytes === null ? "delete" : "restore",
      });
    } catch (error) {
      preview.unsafeFiles.push({
        ...fact,
        reason: error instanceof UnsafeFile ? error.reason : "file_read_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (
    entries.reduce(
      (total, entry) => total + (entry.bytes?.byteLength ?? 0),
      0,
    ) > budget
  )
    throw new Error("文件恢复计划超过工作区补丁字节预算。");
  preview.canApply = entries.length > 0 && preview.unsafeFiles.length === 0;
  return {
    preview:
      protocol.v4ConversationFileRewindPreviewResultSchema.parse(preview),
    entries,
    identity,
  };
}

export async function applyFileRewind(
  plan: PreparedFileRewind,
  input: ApplyFileRewindInput,
): Promise<ExecutionScopeHandle> {
  if (
    !plan.preview.canApply ||
    !plan.entries.length ||
    plan.preview.unsafeFiles.length
  )
    throw new Error("文件回退预览不可执行，请先处理不安全文件。");
  await input.scope.resolvePath(".", "read");
  if (JSON.stringify(input.scope.describe()) !== JSON.stringify(plan.identity))
    throw new Error("文件回退作用域已变化，请重新预览。");
  const roots = [
    plan.identity.rootDirectory,
    ...plan.identity.additionalDirectories
      .filter((root) => root.access === "read-write")
      .map((root) => root.path),
  ];
  const processLease = await input.processSandbox.acquireRestoreBarrier(
    plan.identity,
    roots,
  );
  let fileLease:
    | Awaited<ReturnType<typeof acquireTaskFileRestoreBarrier>>
    | undefined;
  let restoring: ExecutionScopeHandle | undefined;
  try {
    fileLease = await acquireTaskFileRestoreBarrier(input.scope, roots);
    const lease = fileLease;
    const result = await input.scope.backend.commitBatch(
      plan.entries,
      async () => {
        restoring = lease.authorize(
          await input.beginRestore(input.scope, input.actor),
        );
        await input.processSandbox.closeTask(
          plan.identity.taskId,
          "file_rewind",
          plan.identity.generation,
        );
        await revokeTaskFileOperations(
          plan.identity.workspaceId,
          plan.identity.taskId,
        );
        if (
          hasTaskFileOperations(plan.identity.workspaceId, plan.identity.taskId)
        )
          throw new Error("旧Task文件范围未确认清空，不能完成恢复。");
        return restoring;
      },
    );
    if (!result.complete || result.failures.length || !result.newScope)
      throw new Error(
        result.failures.map((entry) => entry.error).join("\n") ||
          "文件恢复未完整完成。",
      );
    await fileLease.release();
    fileLease = undefined;
    await processLease.release();
    await input.finishRestore(result.newScope, input.actor, true);
    return result.newScope;
  } catch (error) {
    if (restoring) await input.finishRestore(restoring, input.actor, false);
    throw error;
  } finally {
    try {
      await fileLease?.release();
    } finally {
      await processLease.release();
    }
  }
}
