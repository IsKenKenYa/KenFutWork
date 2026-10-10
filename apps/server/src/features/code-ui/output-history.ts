import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { AgentContextResourceBinding } from "../../agent/context-history.js";
import type { BlobStore } from "../blob/types.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { ProcessOutput } from "../process-sandbox/types.js";
import type { SettingsService } from "../settings/settings-service.js";
import type { TaskWorkContext, TaskWorkManager } from "../task-work/types.js";
import {
  readCapturedOutputView,
  resolveCapturedOutputPath,
} from "./captured-output-reader.js";
import {
  type CapturedOutputSource,
  type CodeUiOutputHistory,
  type CodeUiOutputTarget,
  type FrozenHistoryOutput,
  frozenHistoryOutputSchema,
  type HistoryOutputStats,
  historyOutputListSchema,
  historyOutputStatsSchema,
  type OwnedHistoryOutput,
  ownedHistoryOutputSchema,
} from "./output-history-types.js";
import {
  type CodeUiRepository,
  CodeUiRepositoryError,
  type CodeUiSessionRecord,
} from "./repository.js";

type WorkCandidate = {
  kind: "work";
  id: string;
  ref: string;
  childSessionId?: string;
  frozenAt?: FrozenHistoryOutput;
};
type BashCandidate = {
  kind: "bash";
  id: string;
  ref: string;
  label: string;
  summary?: string;
  status: "completed" | "failed";
  outputStats: HistoryOutputStats;
};
type Candidate = WorkCandidate | BashCandidate;
type OutputSource = {
  id: string;
  ref: string;
  kind: OwnedHistoryOutput["kind"];
  label: string;
  status: OwnedHistoryOutput["status"];
  summary?: string;
  childSessionId?: string;
  outputStats: HistoryOutputStats;
  statisticsComplete: boolean;
  bytes: Uint8Array;
  frozenAt?: FrozenHistoryOutput;
};
const conflict = (message: string) =>
  new CodeUiRepositoryError("command_conflict", message);
const refFor = (taskId: string, id: string) => `code-output:${taskId}/${id}`;
const objectPathFor = (owner: OwnedHistoryOutput["owner"], id: string) =>
  `${owner.instanceId}/${owner.projectId}/${owner.taskId}/${id}`;
const checksum = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function ownedRecords(root: CodeUiSessionRecord): OwnedHistoryOutput[] {
  const sessions = new Set(
    root.state?.snapshots.map((snapshot) => snapshot.sessionId),
  );
  const ids = new Set<string>();
  return (root.state?.inheritedOutputs ?? []).map((raw) => {
    const parsed = ownedHistoryOutputSchema.safeParse(raw);
    if (!parsed.success) throw conflict("历史输出持久事实不完整，拒绝读取。");
    const record = parsed.data;
    if (
      ids.has(record.id) ||
      record.owner.instanceId !== root.instance_id ||
      record.owner.projectId !== root.project_id ||
      record.owner.taskId !== root.id ||
      record.ref !== refFor(root.id, record.id) ||
      record.objectPath !== objectPathFor(record.owner, record.id) ||
      !record.visibleSessions.includes(root.id) ||
      record.visibleSessions.some((id) => !sessions.has(id)) ||
      (record.childSessionId && !sessions.has(record.childSessionId)) ||
      (record.frozenAt &&
        (record.status !== "interrupted" ||
          record.statisticsComplete ||
          JSON.stringify(record.frozenAt.outputStats) !==
            JSON.stringify(record.outputStats)))
    )
      throw conflict("历史输出不属于当前根Task或其可见历史。");
    ids.add(record.id);
    return record;
  });
}

type ToolRow = Extract<protocol.ConversationRow, { kind: "toolCall" }>;

function canonicalOutput(row: ToolRow) {
  let value: unknown;
  try {
    value = JSON.parse(row.output?.text ?? "");
  } catch {
    throw conflict("成功任务工具的输出不是完整canonical JSON。");
  }
  if (!value || typeof value !== "object")
    throw conflict("成功任务工具缺少canonical输出对象或列表。");
  return value;
}

function listCandidates(
  root: CodeUiSessionRecord,
  value: unknown[],
): WorkCandidate[] {
  const parsed = historyOutputListSchema.safeParse(value);
  if (!parsed.success) throw conflict("TaskOutput历史列表不是合法工作投影。");
  const owned = new Map(
    ownedRecords(root).map((record) => [record.id, record]),
  );
  return parsed.data.flatMap((item) => {
    if (item.readOnly !== true) return [];
    const record = owned.get(item.taskId);
    if (
      !record ||
      record.kind !== item.kind ||
      record.status !== item.status ||
      record.label !== item.label
    )
      throw conflict("TaskOutput只读列表项不属于当前Task的正规输出事实。");
    return [
      {
        kind: "work" as const,
        id: record.id,
        ref: record.ref,
        ...(record.childSessionId !== undefined
          ? { childSessionId: record.childSessionId }
          : {}),
      },
    ];
  });
}

function rowCandidates(root: CodeUiSessionRecord, row: ToolRow): Candidate[] {
  const canonical = canonicalOutput(row);
  if (Array.isArray(canonical)) {
    if (row.toolName !== "TaskOutput")
      throw conflict("该工具不提供TaskOutput列表。");
    return listCandidates(root, canonical);
  }
  const payload = canonical as Record<string, unknown>;
  const candidate =
    row.toolName === "Bash"
      ? bashCandidate(root, row, payload)
      : workCandidate(row, payload);
  return candidate ? [candidate] : [];
}

function workCandidate(
  row: ToolRow,
  canonical: Record<string, unknown>,
): WorkCandidate | null {
  const id = canonical.taskId;
  const ref =
    row.toolName === "Task" ? canonical.outputPath : canonical.outputRef;
  if (ref === undefined) return null; // 尚未产生完整保留输出的派发/失败事实。
  if (typeof id !== "string" || !id.trim() || typeof ref !== "string" || !ref)
    throw conflict("任务工具的完整输出身份或引用无效。");
  const captured = canonical.output;
  let frozenAt: FrozenHistoryOutput | undefined;
  if (
    canonical.status === "running" ||
    (row.toolName === "TaskOutput" &&
      (!captured ||
        typeof captured !== "object" ||
        Array.isArray(captured) ||
        !("done" in captured) ||
        captured.done !== true))
  ) {
    const output =
      captured && typeof captured === "object" && !Array.isArray(captured)
        ? (captured as Record<string, unknown>)
        : undefined;
    const parsed = frozenHistoryOutputSchema.safeParse({
      sourceStatus: canonical.status,
      outputStats: {
        retainedBytes: output?.retainedBytes,
        totalBytes: output?.totalBytes,
        discardedBytes: output?.discardedBytes,
      },
    });
    if (!parsed.success) throw conflict("运行中历史输出缺少可信的字节截点。");
    frozenAt = parsed.data;
  }
  const childSessionId = canonical.childSessionId;
  if (childSessionId !== undefined && typeof childSessionId !== "string")
    throw conflict("任务工具的子会话身份无效。");
  return {
    kind: "work",
    id,
    ref,
    ...(frozenAt ? { frozenAt } : {}),
    ...(childSessionId ? { childSessionId } : {}),
  };
}

function bashCandidate(
  root: CodeUiSessionRecord,
  row: ToolRow,
  canonical: Record<string, unknown>,
): BashCandidate | null {
  const ref = canonical.outputPath;
  if (ref === undefined) return null; // 普通后台派发没有私有日志引用。
  if (
    typeof ref !== "string" ||
    !ref ||
    !row.toolCallId.trim() ||
    canonical.state !== "exited" ||
    !(
      canonical.exitCode === null ||
      (typeof canonical.exitCode === "number" &&
        Number.isSafeInteger(canonical.exitCode))
    )
  )
    throw conflict("Bash私有输出缺少已退出的可信捕获事实。");
  const stats = historyOutputStatsSchema.safeParse({
    retainedBytes: canonical.retainedBytes,
    totalBytes: canonical.totalBytes,
    discardedBytes: canonical.discardedBytes,
  });
  if (!stats.success) throw conflict("Bash私有输出的完整捕获字节事实不一致。");
  // 这是已持久工具事实的只读资源身份，不是进程或Task Work执行ID。
  const id = `bash-log:${createHash("sha256")
    .update(JSON.stringify([root.id, row.toolCallId]))
    .digest("hex")}`;
  const input =
    row.input && typeof row.input === "object" && !Array.isArray(row.input)
      ? (row.input as Record<string, unknown>)
      : undefined;
  const label =
    typeof input?.description === "string"
      ? input.description
      : typeof input?.command === "string"
        ? input.command
        : row.inputText;
  return {
    kind: "bash",
    id,
    ref,
    label,
    status: canonical.exitCode === 0 ? "completed" : "failed",
    outputStats: stats.data,
    ...(typeof canonical.output === "string"
      ? { summary: canonical.output }
      : {}),
  };
}

function candidates(
  root: CodeUiSessionRecord,
  rows: readonly protocol.ConversationRow[],
) {
  const result = new Map<string, Candidate>();
  for (const row of rows) {
    if (
      row.kind !== "toolCall" ||
      row.status !== "success" ||
      !["Task", "TaskOutput", "Bash"].includes(row.toolName) ||
      !row.output
    )
      continue;
    for (const candidate of rowCandidates(root, row)) {
      const previous = result.get(candidate.id);
      if (
        previous &&
        (previous.ref !== candidate.ref ||
          previous.kind !== candidate.kind ||
          (previous.kind === "work" &&
            candidate.kind === "work" &&
            previous.childSessionId &&
            candidate.childSessionId &&
            previous.childSessionId !== candidate.childSessionId) ||
          (previous.kind === "bash" &&
            candidate.kind === "bash" &&
            (previous.status !== candidate.status ||
              JSON.stringify(previous.outputStats) !==
                JSON.stringify(candidate.outputStats))))
      )
        throw conflict("同一历史输出身份不能指向不同事实。");
      result.set(
        candidate.id,
        previous?.kind === "work" &&
          candidate.kind === "work" &&
          previous.childSessionId
          ? { ...candidate, childSessionId: previous.childSessionId }
          : candidate,
      );
    }
  }
  return [...result.values()];
}

function sourceContext(
  actor: LocalActor,
  root: CodeUiSessionRecord,
): TaskWorkContext {
  if (!root.root_directory) throw conflict("源Task的固定工作目录缺失。");
  return {
    actor,
    scope: {
      instanceId: root.instance_id,
      projectId: root.project_id,
      taskId: root.id,
      generation: Number(root.scope_generation),
      rootDirectory: root.root_directory,
      additionalDirectories: root.additional_directories ?? [],
      sandboxMode: root.sandbox_mode,
    },
    agentId: "main",
    runId: root.state?.runId ?? "",
    branchGeneration: Number(root.branch_generation),
  };
}

async function readCaptureBytes(file: FileHandle, length: number) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < bytes.length) {
    const read = await file.read(bytes, offset, bytes.length - offset, offset);
    if (!read.bytesRead) throw conflict("完整输出在复制期间被截断。");
    offset += read.bytesRead;
  }
  return bytes;
}

async function readSourceFile(
  executionOutputRoot: string,
  record: CapturedOutputSource,
  maxBytes: number,
  frozen?: HistoryOutputStats,
) {
  if (!record.outputRef || !isAbsolute(record.outputRef) || !record.outputStats)
    throw conflict("任务缺少完整保留输出的可信路径或字节事实。");
  const path = await resolveCapturedOutputPath(executionOutputRoot, record);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    const recorded = historyOutputStatsSchema.parse(record.outputStats);
    const stats =
      frozen ??
      (record.status === "interrupted"
        ? {
            retainedBytes: before.size,
            totalBytes: Math.max(before.size, recorded.totalBytes),
            discardedBytes:
              Math.max(before.size, recorded.totalBytes) - before.size,
          }
        : recorded);
    if (
      !before.isFile() ||
      (frozen
        ? before.size < stats.retainedBytes
        : before.size !== stats.retainedBytes) ||
      stats.retainedBytes > maxBytes
    )
      throw conflict("完整保留输出缺失、字节事实改变或超过当前输出预算。");
    const bytes = await readCaptureBytes(file, stats.retainedBytes);
    const after = await file.stat();
    const current = await stat(path);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      (frozen
        ? after.size < stats.retainedBytes
        : before.size !== after.size) ||
      (!frozen && before.mtimeMs !== after.mtimeMs) ||
      (!frozen && before.ctimeMs !== after.ctimeMs) ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      (frozen
        ? current.size < stats.retainedBytes
        : current.size !== before.size) ||
      (!frozen && current.mtimeMs !== before.mtimeMs) ||
      (!frozen && current.ctimeMs !== before.ctimeMs) ||
      (await realpath(record.outputRef)) !== path
    )
      throw conflict("源私有输出在复制期间改变。");
    if (frozen) {
      // 捕获日志由宿主追加；允许后续尾部增长，但复制的前缀不得被原位改写。
      const checked = await readCaptureBytes(file, stats.retainedBytes);
      if (!checked.equals(bytes))
        throw conflict("截点输出的前缀在复制期间改变。");
    }
    return { bytes, stats };
  } finally {
    await file.close();
  }
}

function page(
  bytes: Uint8Array,
  stats: HistoryOutputStats,
  offset: number,
  maxBytes: number,
): ProcessOutput {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > bytes.length ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  )
    throw conflict("历史输出游标或分页大小无效。");
  let end = Math.min(bytes.length, offset + maxBytes);
  const content = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // UTF-8 continuation位及最长四字节属于编码结构，不是运行时预算。
  while (end < content.length && (content.readUInt8(end) & 0xc0) === 0x80)
    end++;
  return {
    data: content.subarray(offset, end).toString("utf8"),
    offset,
    nextOffset: end,
    ...stats,
    truncated: stats.discardedBytes > 0,
    done: true,
  };
}

export function createCodeUiOutputHistory(deps: {
  repository: Pick<CodeUiRepository, "find">;
  taskWork: Pick<TaskWorkManager, "find">;
  settings: Pick<SettingsService, "getInstanceSettings">;
  localInstance: Pick<LocalInstanceService, "resolve">;
  blob?: BlobStore | undefined;
  executionOutputRoot: string;
}): CodeUiOutputHistory {
  const bucket = () => {
    if (!deps.blob) throw conflict("历史输出私有存储未装配。");
    return deps.blob.bucket("task-output-history");
  };
  async function currentRoot(actor: LocalActor, expected: CodeUiSessionRecord) {
    const instance = await deps.localInstance.resolve(actor);
    const root = await deps.repository.find(instance.instanceId, expected.id);
    if (
      !root?.state ||
      root.deleted_at ||
      root.parent_session_id ||
      root.root_session_id !== root.id ||
      root.instance_id !== actor.instanceId ||
      root.instance_id !== expected.instance_id ||
      root.project_id !== expected.project_id
    )
      throw new CodeUiRepositoryError(
        "not_found",
        "历史输出所属根Task不可见或已删除。",
      );
    return root;
  }
  async function readableRoot(context: TaskWorkContext) {
    if (!context.actor || context.actor.instanceId !== context.scope.instanceId)
      throw new CodeUiRepositoryError(
        "not_found",
        "历史输出读取缺少当前实例身份。",
      );
    const instance = await deps.localInstance.resolve(context.actor);
    const root = await deps.repository.find(
      instance.instanceId,
      context.scope.taskId,
    );
    if (
      !root?.state ||
      root.deleted_at ||
      root.parent_session_id ||
      root.root_session_id !== root.id ||
      root.instance_id !== context.scope.instanceId ||
      root.project_id !== context.scope.projectId ||
      root.execution_state !== "ready" ||
      Number(root.scope_generation) !== context.scope.generation ||
      Number(root.branch_generation) !== context.branchGeneration
    )
      throw new CodeUiRepositoryError(
        "not_found",
        "历史输出Task已关闭或读取代际过期。",
      );
    return root;
  }
  async function assertSource(
    actor: LocalActor,
    expected: CodeUiSessionRecord,
  ) {
    const root = await currentRoot(actor, expected);
    if (
      root.archived ||
      root.execution_state !== "ready" ||
      Number(root.scope_generation) !== Number(expected.scope_generation) ||
      Number(root.branch_generation) !== Number(expected.branch_generation)
    )
      throw conflict("源Task已归档或分叉授权代际改变。");
    return root;
  }
  async function ownedBytes(record: OwnedHistoryOutput, maxBytes: number) {
    if (record.outputStats.retainedBytes > maxBytes)
      throw conflict("完整历史输出超过当前输出预算，请调整治理设置。");
    const bytes = await bucket().download(record.objectPath, { maxBytes });
    if (
      bytes.length !== record.outputStats.retainedBytes ||
      checksum(bytes) !== record.checksum
    )
      throw conflict("私有历史输出内容与持久字节事实不一致。");
    return bytes;
  }
  async function inheritedSource(
    inherited: OwnedHistoryOutput,
    candidate: Candidate,
    maxBytes: number,
  ): Promise<OutputSource> {
    if (
      (candidate.kind === "work" &&
        (candidate.id !== inherited.id ||
          (candidate.childSessionId &&
            candidate.childSessionId !== inherited.childSessionId))) ||
      (candidate.kind === "bash" &&
        (inherited.kind !== "command" ||
          inherited.status !== candidate.status ||
          JSON.stringify(inherited.outputStats) !==
            JSON.stringify(candidate.outputStats)))
    )
      throw conflict("继承输出与当前Task的正规引用不匹配。");
    if (
      candidate.kind === "work" &&
      candidate.frozenAt &&
      (!inherited.frozenAt ||
        JSON.stringify(candidate.frozenAt) !==
          JSON.stringify(inherited.frozenAt))
    )
      throw conflict("继承输出与已保存的历史字节截点不匹配。");
    return {
      id: inherited.id,
      ref: inherited.ref,
      kind: inherited.kind,
      label: inherited.label,
      status: inherited.status,
      outputStats: inherited.outputStats,
      statisticsComplete: inherited.statisticsComplete,
      ...(inherited.frozenAt ? { frozenAt: inherited.frozenAt } : {}),
      bytes: await ownedBytes(inherited, maxBytes),
      ...(inherited.summary !== undefined
        ? { summary: inherited.summary }
        : {}),
      ...(inherited.childSessionId !== undefined
        ? { childSessionId: inherited.childSessionId }
        : {}),
    };
  }
  async function bashSource(
    root: CodeUiSessionRecord,
    candidate: BashCandidate,
    maxBytes: number,
  ): Promise<OutputSource> {
    const { bytes, stats } = await readSourceFile(
      deps.executionOutputRoot,
      {
        instanceId: root.instance_id,
        taskId: root.id,
        kind: "command",
        outputRef: candidate.ref,
        outputStats: candidate.outputStats,
        status: candidate.status,
      },
      maxBytes,
    );
    return {
      id: candidate.id,
      ref: candidate.ref,
      kind: "command",
      label: candidate.label,
      status: candidate.status,
      outputStats: stats,
      statisticsComplete: true,
      bytes,
      ...(candidate.summary !== undefined
        ? { summary: candidate.summary }
        : {}),
    };
  }
  async function workSource(
    actor: LocalActor,
    root: CodeUiSessionRecord,
    candidate: WorkCandidate,
    maxBytes: number,
  ): Promise<OutputSource> {
    const work = await deps.taskWork.find(
      sourceContext(actor, root),
      candidate.id,
    );
    if (
      !work ||
      work.scope.instanceId !== root.instance_id ||
      work.scope.projectId !== root.project_id ||
      work.scope.taskId !== root.id ||
      work.outputRef !== candidate.ref ||
      (candidate.childSessionId &&
        candidate.childSessionId !== work.childSessionId)
    )
      throw conflict("完整输出不属于源Task的真实工作。");
    if (work.status === "running" && !candidate.frozenAt)
      throw conflict("完整输出尚未结算，不能把当前尾部复制成已完成历史。");
    if (!work.outputRef || !work.outputStats)
      throw conflict("真实工作缺少已保留完整输出的捕获事实。");
    const { bytes, stats } = await readSourceFile(
      deps.executionOutputRoot,
      {
        instanceId: work.scope.instanceId,
        taskId: work.scope.taskId,
        kind: work.kind,
        outputRef: work.outputRef,
        outputStats: work.outputStats,
        status: work.status,
        ...(work.childSessionId ? { childSessionId: work.childSessionId } : {}),
      },
      maxBytes,
      candidate.frozenAt?.outputStats,
    );
    return {
      id: work.id,
      ref: candidate.ref,
      kind: work.kind,
      label: work.label,
      status:
        candidate.frozenAt || work.status === "running"
          ? "interrupted"
          : work.status,
      outputStats: stats,
      statisticsComplete: !candidate.frozenAt && work.status !== "interrupted",
      bytes,
      ...(candidate.frozenAt
        ? {
            frozenAt: candidate.frozenAt,
            summary: "只读历史输出截点，不继承执行；源工作当时仍未结算。",
          }
        : work.summary !== undefined
          ? { summary: work.summary }
          : {}),
      ...(work.childSessionId ? { childSessionId: work.childSessionId } : {}),
    };
  }
  async function resolveSource(
    actor: LocalActor,
    root: CodeUiSessionRecord,
    candidate: Candidate,
    maxBytes: number,
  ): Promise<OutputSource> {
    const inherited = ownedRecords(root).find(
      (record) => record.ref === candidate.ref,
    );
    if (inherited) return inheritedSource(inherited, candidate, maxBytes);
    return candidate.kind === "bash"
      ? bashSource(root, candidate, maxBytes)
      : workSource(actor, root, candidate, maxBytes);
  }
  async function prepareRecord(
    sourceRoot: CodeUiSessionRecord,
    target: CodeUiOutputTarget,
    source: OutputSource,
    paths: string[],
    planObject?: (path: string) => Promise<void>,
  ) {
    const childSessionId = source.childSessionId
      ? target.childSessionIds.get(source.childSessionId)
      : undefined;
    if (source.childSessionId && !childSessionId)
      throw conflict("完整输出的目标子历史身份映射缺失。");
    const id = randomUUID();
    const owner = {
      instanceId: target.instanceId,
      projectId: target.projectId,
      taskId: target.taskId,
    };
    const objectPath = objectPathFor(owner, id);
    const record = ownedHistoryOutputSchema.parse({
      id,
      owner,
      ref: refFor(target.taskId, id),
      objectPath,
      checksum: checksum(source.bytes),
      kind: source.kind,
      label: source.label,
      status: source.status,
      outputStats: source.outputStats,
      statisticsComplete: source.statisticsComplete,
      ...(source.frozenAt ? { frozenAt: source.frozenAt } : {}),
      visibleSessions: [
        target.taskId,
        ...(childSessionId ? [childSessionId] : []),
      ],
      source: {
        taskId: sourceRoot.id,
        id: source.id,
        outputRef: source.ref,
        ...(source.childSessionId
          ? { childSessionId: source.childSessionId }
          : {}),
      },
      ...(source.summary !== undefined ? { summary: source.summary } : {}),
      ...(childSessionId ? { childSessionId } : {}),
    });
    paths.push(objectPath);
    await planObject?.(objectPath);
    await bucket().upload(objectPath, source.bytes, {
      contentType: "text/plain; charset=utf-8",
      upsert: false,
    });
    const binding: AgentContextResourceBinding = {
      source: {
        id: source.id,
        outputRef: source.ref,
        ...(source.childSessionId
          ? { childSessionId: source.childSessionId }
          : {}),
      },
      target: {
        id,
        outputRef: record.ref,
        ...(childSessionId ? { childSessionId } : {}),
      },
    };
    return { record, binding };
  }
  return {
    async readView(actor, expected, id, input) {
      const root = await currentRoot(actor, expected);
      if (!ownedHistoryOutputSchema.shape.id.safeParse(id).success) return null;
      if (root.execution_state === "revoking")
        throw conflict("Task正在关闭，暂不能读取日志。");
      const settings = await deps.settings.getInstanceSettings(
        actor,
        root.instance_id,
      );
      const budget = Math.min(input.maxBytes, settings.codeReadMaxBytes);
      if (
        !Number.isSafeInteger(input.offset) ||
        input.offset < 0 ||
        !Number.isSafeInteger(budget) ||
        budget < 0
      )
        throw conflict("输出查看分页无效。");
      const owned = ownedRecords(root).find((record) => record.id === id);
      let value: Awaited<ReturnType<CodeUiOutputHistory["readView"]>>;
      if (owned) {
        const bytes = await ownedBytes(owned, settings.processMaxOutputBytes);
        const offset = input.tail
          ? Math.max(0, bytes.length - budget)
          : input.offset;
        if (offset > bytes.length) throw conflict("输出查看游标超过日志范围。");
        let start = offset;
        if (input.tail && start > 0)
          while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80)
            start++;
        value = {
          id,
          kind: owned.kind,
          status: owned.status,
          outputRef: owned.ref,
          bytes: bytes.subarray(start, Math.min(bytes.length, offset + budget)),
          offset: start,
          ...owned.outputStats,
        };
      } else {
        const record = await deps.taskWork.find(sourceContext(actor, root), id);
        if (!record?.outputRef) return null;
        if (
          record.scope.instanceId !== root.instance_id ||
          record.scope.projectId !== root.project_id ||
          record.scope.taskId !== root.id
        )
          throw conflict("日志不属于该Task。");
        value = {
          id,
          kind: record.kind,
          status: record.status,
          outputRef: refFor(root.id, id),
          ...(await readCapturedOutputView(deps.executionOutputRoot, record, {
            offset: input.offset,
            maxBytes: budget,
            tail: input.tail,
            maxRetainedBytes: settings.processMaxOutputBytes,
          })),
        };
      }
      const after = await currentRoot(actor, root);
      if (after.execution_state === "revoking")
        throw conflict("Task已进入关闭，日志读取已失效。");
      return value;
    },
    async prepare(actor, sourceRoot, target, rows, planObject) {
      const root = await assertSource(actor, sourceRoot);
      if (
        target.instanceId !== root.instance_id ||
        target.projectId !== root.project_id ||
        target.taskId === root.id
      )
        throw conflict("完整输出副本必须属于同实例/项目的新Task。");
      const settings = await deps.settings.getInstanceSettings(
        actor,
        root.instance_id,
      );
      const paths: string[] = [];
      let state: "prepared" | "released" | "discarded" = "prepared";
      const discard = async () => {
        if (state !== "prepared") return;
        if (paths.length) await bucket().remove(paths);
        state = "discarded";
      };
      const records: OwnedHistoryOutput[] = [];
      const bindings: AgentContextResourceBinding[] = [];
      const copiedSources = new Map<string, string>();
      try {
        for (const candidate of candidates(root, rows)) {
          const source = await resolveSource(
            actor,
            root,
            candidate,
            settings.processMaxOutputBytes,
          );
          const copiedRef = copiedSources.get(source.id);
          if (copiedRef !== undefined) {
            if (copiedRef !== source.ref)
              throw conflict("同一已验证源输出不能映射多个引用。");
            continue;
          }
          const copied = await prepareRecord(
            root,
            target,
            source,
            paths,
            planObject,
          );
          copiedSources.set(source.id, source.ref);
          records.push(copied.record);
          bindings.push(copied.binding);
        }
        await assertSource(actor, sourceRoot);
        return {
          records,
          bindings,
          release() {
            if (state === "prepared") state = "released";
          },
          discard,
        };
      } catch (error) {
        try {
          await discard();
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            "完整输出准备失败，私有副本未全部确认清理。",
          );
        }
        throw error;
      }
    },
    async read(context, id, offset, maxBytes) {
      const root = await readableRoot(context);
      const record = ownedRecords(root).find((entry) => entry.id === id);
      if (!record) return null;
      const actor = context.actor;
      if (!actor) throw conflict("历史输出缺少当前读取身份。");
      const settings = await deps.settings.getInstanceSettings(
        actor,
        root.instance_id,
      );
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
        throw conflict("历史输出分页预算无效。");
      const bytes = await ownedBytes(record, settings.processMaxOutputBytes);
      await readableRoot(context);
      // UTF-8最长四字节为编码常量，实际分页/保留预算仍由实例设置提供。
      const budget = Math.min(
        maxBytes,
        settings.processMaxOutputBytes,
        settings.processPreviewMaxChars * 4,
      );
      return {
        id: record.id,
        kind: record.kind,
        label: record.label,
        status: record.status,
        outputRef: record.ref,
        output: page(bytes, record.outputStats, offset, budget),
        statisticsComplete: record.statisticsComplete,
        ...(record.frozenAt ? { frozenAt: record.frozenAt } : {}),
        ...(record.summary !== undefined ? { summary: record.summary } : {}),
      };
    },
    async manifest(context) {
      return ownedRecords(await readableRoot(context));
    },
    async purge(actor, expected, expectedScopeGeneration) {
      const requireRevoking = async () => {
        const root = await currentRoot(actor, expected);
        if (
          root.execution_state !== "revoking" ||
          Number(root.scope_generation) !== expectedScopeGeneration
        )
          throw conflict("历史输出清理要求当前Task已关闭且代际一致。");
        return root;
      };
      const root = await requireRevoking();
      const records = ownedRecords(root);
      if (records.length)
        await bucket().remove(records.map((record) => record.objectPath));
      await requireRevoking();
      let executionRoot: string;
      try {
        executionRoot = await realpath(resolve(deps.executionOutputRoot));
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return;
        throw error;
      }
      // 只删除当前Task的两个固定宿主目录，不按持久ref或source路径删除。
      const paths = [
        join(executionRoot, createHash("sha256").update(root.id).digest("hex")),
        join(executionRoot, root.instance_id, root.id),
      ];
      for (const path of paths) {
        await requireRevoking();
        await rm(path, { recursive: true, force: true });
        await requireRevoking();
      }
    },
  };
}
