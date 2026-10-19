import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface CadGuiOperationBinding {
  instanceId: string;
  projectId: string;
  taskId: string;
  scopeGeneration: number;
  branchGeneration: number;
  runId: string;
  toolCallId: string;
}

export interface CadGuiOperationPaths {
  directory: string;
  manifestPath: string;
  requestPath: string;
  macroPath: string;
  receiptPath: string;
  cancelledPath: string;
  executionClaimPath: string;
  dispatchClaimPath: string;
}

export interface CadGuiOperationRecord extends CadGuiOperationPaths {
  operationId: string;
  preparedAt: number;
  binding: CadGuiOperationBinding;
  payload: unknown;
  fingerprint: string;
  sourceHash: string;
}

export interface CadGuiOperationIdentity {
  instanceId: string;
  taskId: string;
  operationId: string;
}

export interface CadGuiOperationRecordFilter {
  instanceId?: string;
  taskId?: string;
  runId?: string;
}

export type CadGuiOperationState = {
  status: "prepared" | "cancelled" | "dispatched" | "executing" | "terminal";
  record: CadGuiOperationRecord;
  cancelled: boolean;
  outcome?: "unknown";
  receipt?: unknown;
  receiptError?: "invalid_json" | "too_large" | "unsafe_file";
};

export interface CadGuiOperationStore {
  prepare(input: {
    binding: CadGuiOperationBinding;
    operationId: string;
    payload: unknown;
    buildMacro(paths: CadGuiOperationPaths): string;
  }): Promise<CadGuiOperationRecord>;
  /** 查询结果不具备派发权限；新代际只能读取原操作的结果。 */
  lookup(
    identity: CadGuiOperationIdentity,
  ): Promise<CadGuiOperationRecord | null>;
  /** 只读枚举不授予派发权限；原始 terminal 仍须由 Controller 校验业务回执。 */
  listRecords(
    filter?: CadGuiOperationRecordFilter,
  ): Promise<readonly CadGuiOperationRecord[]>;
  claimDispatch(record: CadGuiOperationRecord): Promise<boolean>;
  cancel(record: CadGuiOperationRecord): Promise<void>;
  cancelPending(filter?: { runId?: string }): Promise<void>;
  readPublication(
    record: CadGuiOperationRecord,
  ): Promise<{ claim?: unknown; receipt?: unknown }>;
  claimPublication(
    record: CadGuiOperationRecord,
    payload: unknown,
  ): Promise<boolean>;
  completePublication(
    record: CadGuiOperationRecord,
    receipt: unknown,
  ): Promise<void>;
  readState(
    record: CadGuiOperationRecord | CadGuiOperationIdentity,
  ): Promise<CadGuiOperationState>;
}

export class CadGuiOperationStoreError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "conflict"
      | "busy"
      | "invalid_record"
      | "not_found"
      | "read_only"
      | "stop_unconfirmed",
    message: string,
  ) {
    super(message);
    this.name = "CadGuiOperationStoreError";
  }
}

interface Manifest {
  version: 1;
  operationId: string;
  preparedAt: number;
  binding: CadGuiOperationBinding;
  payload: unknown;
  fingerprint: string;
  sourceHash: string;
}

// 固定磁盘协议边界，避免损坏或伪造的控制JSON占满内存；不是执行额度或文件容量预算。
export const CAD_GUI_OPERATION_RECEIPT_MAX_BYTES = 64 * 1024;
const RECORD_MAX_BYTES = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/u;
const bindingKeys = [
  "instanceId",
  "projectId",
  "taskId",
  "scopeGeneration",
  "branchGeneration",
  "runId",
  "toolCallId",
] as const;

function fail(code: CadGuiOperationStoreError["code"]): never {
  const messages = {
    invalid_input: "CAD 操作参数无效，请重新发起操作。",
    conflict:
      "CAD 操作编号已用于不同请求，请先查询原操作状态；独立的新操作才使用新编号。",
    busy: "CAD 操作记录尚未完整发布，请查询原操作状态。",
    invalid_record: "CAD 操作记录不完整或已改变，请检查实例数据目录。",
    not_found: "CAD 操作记录不存在，请检查操作编号。",
    read_only: "CAD 状态查询不能派发操作，请发起当前任务的操作请求。",
    stop_unconfirmed: "无法确认历史 CAD 操作已停止，请检查操作记录。",
  };
  throw new CadGuiOperationStoreError(code, messages[code]);
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeOperationId(value: string): string {
  if (typeof value !== "string" || !UUID.test(value)) fail("invalid_input");
  return value.toLowerCase();
}

function normalizeBinding(
  input: CadGuiOperationBinding,
): CadGuiOperationBinding {
  if (!input || typeof input !== "object") fail("invalid_input");
  const binding = Object.fromEntries(
    bindingKeys.map((key) => [key, input[key]]),
  );
  for (const key of bindingKeys) {
    const value = binding[key];
    if (key === "scopeGeneration" || key === "branchGeneration") {
      if (!Number.isSafeInteger(value) || (value as number) < 0)
        fail("invalid_input");
    } else if (typeof value !== "string" || value.length === 0)
      fail("invalid_input");
  }
  return binding as unknown as CadGuiOperationBinding;
}

/** JSON 值在第一次 await 前规范化，调用方之后修改输入不改变已认领请求。 */
function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_input");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) fail("invalid_input");
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return `[${Array.from(value, (entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      fail("invalid_input");
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function operationPaths(directory: string): CadGuiOperationPaths {
  return {
    directory,
    manifestPath: join(directory, "manifest.json"),
    requestPath: join(directory, "request.json"),
    macroPath: join(directory, "operation.FCMacro"),
    receiptPath: join(directory, "receipt.json"),
    cancelledPath: join(directory, "cancelled"),
    executionClaimPath: join(directory, "execute.claim"),
    dispatchClaimPath: join(directory, "dispatch.claim"),
  };
}

async function checkedDirectory(
  path: string,
  create: boolean,
): Promise<boolean> {
  let created = false;
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    if (!(await handle.stat()).isDirectory()) fail("invalid_record");
    if (create) await handle.chmod(0o700);
    if (created) await syncDirectory(dirname(path));
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT") && !create) return false;
    if (isCode(error, "ELOOP") || isCode(error, "ENOTDIR"))
      fail("invalid_record");
    throw error;
  } finally {
    await handle?.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

class UnreadableFile extends Error {
  constructor(readonly reason: "too_large" | "unsafe_file") {
    super(reason);
  }
}

async function readRegular(
  path: string,
  maxBytes: number,
): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!before.isFile()) throw new UnreadableFile("unsafe_file");
    if (before.size > maxBytes) throw new UnreadableFile("too_large");
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        size,
        bytes.length - size,
        size,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new UnreadableFile("too_large");
    const after = await lstat(path);
    // 发布后的临时硬链接清理会改变 ctime/nlink，但不会改变文件内容或 mtime。
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      size !== before.size
    )
      throw new UnreadableFile("unsafe_file");
    return bytes.subarray(0, size);
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    if (isCode(error, "ELOOP")) throw new UnreadableFile("unsafe_file");
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readImmutable(path: string): Promise<Buffer> {
  try {
    const bytes = await readRegular(path, RECORD_MAX_BYTES);
    if (!bytes) fail("invalid_record");
    return bytes;
  } catch {
    return fail("invalid_record");
  }
}

async function writeExclusive(path: string, contents: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishMarker(path: string, contents: string): Promise<boolean> {
  const directory = dirname(path);
  const temporary = join(directory, `.claim-${randomUUID()}.tmp`);
  let written = false;
  try {
    await writeExclusive(temporary, contents);
    written = true;
    await syncDirectory(directory);
    try {
      // 认领必须一次发布完整内容，其他 caller 不能读到创建后的写入中间态。
      await link(temporary, path);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      await hasMarker(path);
      return false;
    }
    await syncDirectory(directory);
    return true;
  } finally {
    if (written) {
      await rm(temporary);
      await syncDirectory(directory);
    }
  }
}

async function hasMarker(path: string): Promise<boolean> {
  try {
    return (
      (await readRegular(path, CAD_GUI_OPERATION_RECEIPT_MAX_BYTES)) !== null
    );
  } catch {
    return fail("invalid_record");
  }
}

function publicationJson(value: unknown): string {
  const contents = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(contents) > CAD_GUI_OPERATION_RECEIPT_MAX_BYTES)
    fail("invalid_input");
  return contents;
}

async function readPublicationFile(path: string): Promise<unknown | undefined> {
  try {
    const bytes = await readRegular(path, CAD_GUI_OPERATION_RECEIPT_MAX_BYTES);
    return bytes ? freeze(JSON.parse(bytes.toString("utf8"))) : undefined;
  } catch {
    return fail("invalid_record");
  }
}

async function readPublicationFiles(
  record: CadGuiOperationRecord,
): Promise<{ claim?: unknown; receipt?: unknown }> {
  const claimPath = join(record.directory, "publication.claim.json");
  let claim = await readPublicationFile(claimPath);
  const receipt = await readPublicationFile(
    join(record.directory, "publication.receipt.json"),
  );
  // 完成回执可能恰在首次读取claim之后发布；只重读已有日志，不重建认领。
  if (receipt !== undefined && claim === undefined)
    claim = await readPublicationFile(claimPath);
  if (receipt !== undefined && claim === undefined) fail("invalid_record");
  return {
    ...(claim !== undefined ? { claim } : {}),
    ...(receipt !== undefined ? { receipt } : {}),
  };
}

function parseManifest(bytes: Buffer): Manifest {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("invalid_record");
    const manifest = value as Manifest;
    const keys = [
      "version",
      "operationId",
      "preparedAt",
      "binding",
      "payload",
      "fingerprint",
      "sourceHash",
    ];
    if (
      Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key))
    )
      fail("invalid_record");
    if (
      manifest.version !== 1 ||
      normalizeOperationId(manifest.operationId) !== manifest.operationId ||
      !Number.isSafeInteger(manifest.preparedAt) ||
      manifest.preparedAt < 0 ||
      Object.keys(manifest.binding).length !== bindingKeys.length
    )
      fail("invalid_record");
    normalizeBinding(manifest.binding);
    if (
      !HASH.test(manifest.fingerprint) ||
      !HASH.test(manifest.sourceHash) ||
      hash(canonicalJson(manifest.payload)) !== manifest.fingerprint
    )
      fail("invalid_record");
    return manifest;
  } catch {
    return fail("invalid_record");
  }
}

function sameScope(
  one: CadGuiOperationBinding,
  two: CadGuiOperationBinding,
): boolean {
  return (
    one.instanceId === two.instanceId &&
    one.projectId === two.projectId &&
    one.taskId === two.taskId &&
    one.scopeGeneration === two.scopeGeneration &&
    one.branchGeneration === two.branchGeneration
  );
}

export function createCadGuiOperationStore(options: {
  rootDirectory: string;
}): CadGuiOperationStore {
  const root = resolve(options.rootDirectory);
  const dispatchable = new WeakSet<CadGuiOperationRecord>();

  async function directoryFor(
    identity: CadGuiOperationIdentity,
    create: boolean,
  ): Promise<string | null> {
    if (
      typeof identity.instanceId !== "string" ||
      !identity.instanceId ||
      typeof identity.taskId !== "string" ||
      !identity.taskId
    )
      fail("invalid_input");
    const operationId = normalizeOperationId(identity.operationId);
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await checkedDirectory(root, false))) return null;
    let parent = await realpath(root);
    for (const component of [
      "cad",
      "gui-operations",
      hash(identity.instanceId),
      hash(identity.taskId),
    ]) {
      parent = join(parent, component);
      if (!(await checkedDirectory(parent, create))) return null;
    }
    return join(parent, hash(operationId));
  }

  async function lookup(
    identity: CadGuiOperationIdentity,
  ): Promise<CadGuiOperationRecord | null> {
    const directory = await directoryFor(identity, false);
    if (!directory || !(await checkedDirectory(directory, false))) return null;
    const paths = operationPaths(directory);
    let manifestBytes: Buffer | null;
    try {
      manifestBytes = await readRegular(paths.manifestPath, RECORD_MAX_BYTES);
    } catch {
      return fail("invalid_record");
    }
    if (!manifestBytes) fail("busy");
    const manifest = parseManifest(manifestBytes);
    if (
      manifest.binding.instanceId !== identity.instanceId ||
      manifest.binding.taskId !== identity.taskId ||
      manifest.operationId !== normalizeOperationId(identity.operationId)
    )
      fail("invalid_record");
    const request = await readImmutable(paths.requestPath);
    const macro = await readImmutable(paths.macroPath);
    if (
      request.toString("utf8") !== `${canonicalJson(manifest.payload)}\n` ||
      hash(macro) !== manifest.sourceHash
    )
      fail("invalid_record");
    return freeze({ ...paths, ...manifest });
  }

  async function verified(
    record: CadGuiOperationRecord,
  ): Promise<CadGuiOperationRecord> {
    const current = await lookup({
      ...record.binding,
      operationId: record.operationId,
    });
    if (!current) fail("not_found");
    if (
      canonicalJson(current.binding) !== canonicalJson(record.binding) ||
      current.fingerprint !== record.fingerprint ||
      current.sourceHash !== record.sourceHash
    )
      fail("invalid_record");
    return current;
  }

  async function prepare(
    input: Parameters<CadGuiOperationStore["prepare"]>[0],
  ): Promise<CadGuiOperationRecord> {
    const binding = normalizeBinding(input.binding);
    const operationId = normalizeOperationId(input.operationId);
    const preparedAt = Date.now();
    if (!Number.isSafeInteger(preparedAt) || preparedAt < 0)
      fail("invalid_input");
    const request = canonicalJson(input.payload);
    const buildMacro = input.buildMacro;
    if (typeof buildMacro !== "function") fail("invalid_input");
    if (Buffer.byteLength(request) + 1 > RECORD_MAX_BYTES)
      fail("invalid_input");
    const payload: unknown = JSON.parse(request);
    const fingerprint = hash(request);
    const identity = { ...binding, operationId };
    const existing = await lookup(identity);
    if (existing) {
      if (
        !sameScope(existing.binding, binding) ||
        existing.fingerprint !== fingerprint
      )
        fail("conflict");
      dispatchable.add(existing);
      return existing;
    }
    const directory = await directoryFor(identity, true);
    if (!directory) fail("invalid_record");
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      const raced = await lookup(identity);
      if (!raced) fail("busy");
      if (
        !sameScope(raced.binding, binding) ||
        raced.fingerprint !== fingerprint
      )
        fail("conflict");
      dispatchable.add(raced);
      return raced;
    }
    await syncDirectory(dirname(directory));
    await checkedDirectory(directory, true);
    const paths = operationPaths(directory);
    const temporary = await mkdtemp(join(directory, ".prepare-"));
    try {
      await checkedDirectory(temporary, true);
      const source = buildMacro(freeze({ ...paths }));
      if (
        typeof source !== "string" ||
        Buffer.byteLength(source) > RECORD_MAX_BYTES
      )
        fail("invalid_input");
      const manifest: Manifest = {
        version: 1,
        operationId,
        preparedAt,
        binding,
        payload,
        fingerprint,
        sourceHash: hash(source),
      };
      const manifestText = `${canonicalJson(manifest)}\n`;
      if (Buffer.byteLength(manifestText) > RECORD_MAX_BYTES)
        fail("invalid_input");
      await writeExclusive(join(temporary, "request.json"), `${request}\n`);
      await writeExclusive(join(temporary, "operation.FCMacro"), source);
      await writeExclusive(join(temporary, "manifest.json"), manifestText);
      await syncDirectory(temporary);
      // link 不替换任何已有目标；manifest 是唯一发布点。残缺 slot 永远不重建。
      await link(join(temporary, "request.json"), paths.requestPath);
      await link(join(temporary, "operation.FCMacro"), paths.macroPath);
      await syncDirectory(directory);
      await link(join(temporary, "manifest.json"), paths.manifestPath);
      await syncDirectory(directory);
      const record = freeze({ ...paths, ...manifest });
      dispatchable.add(record);
      return record;
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await syncDirectory(directory);
    }
  }

  async function scannedRecord(
    directory: string,
    filter: CadGuiOperationRecordFilter,
  ): Promise<CadGuiOperationRecord | null> {
    const paths = operationPaths(directory);
    const bytes = await readRegular(paths.manifestPath, RECORD_MAX_BYTES);
    if (!bytes) {
      // 没有发布痕迹才是未完成的prepare；丢失manifest的旧认领不能被误判为安全。
      for (const path of [
        paths.dispatchClaimPath,
        paths.executionClaimPath,
        paths.receiptPath,
        paths.cancelledPath,
      ])
        if (await hasMarker(path)) fail("invalid_record");
      return null;
    }
    const manifest = parseManifest(bytes);
    const identity = { ...manifest.binding, operationId: manifest.operationId };
    if ((await directoryFor(identity, false)) !== directory)
      fail("invalid_record");
    if (
      (filter.instanceId !== undefined &&
        manifest.binding.instanceId !== filter.instanceId) ||
      (filter.taskId !== undefined &&
        manifest.binding.taskId !== filter.taskId) ||
      (filter.runId !== undefined && manifest.binding.runId !== filter.runId)
    )
      return null;
    const record = await lookup(identity);
    if (!record) fail("invalid_record");
    return record;
  }

  async function cancelPendingDirectory(
    directory: string,
    filter: { runId?: string },
  ): Promise<void> {
    const record = await scannedRecord(directory, filter);
    if (!record) return;
    for (const path of [
      record.dispatchClaimPath,
      record.executionClaimPath,
      record.cancelledPath,
    ])
      await hasMarker(path);
    const receipt = await readRegular(
      record.receiptPath,
      CAD_GUI_OPERATION_RECEIPT_MAX_BYTES,
    );
    if (receipt) {
      // 这里只识别安全的物理终态；业务ACK仍由controller严格校验。
      JSON.parse(receipt.toString("utf8"));
      return;
    }
    await publishMarker(record.cancelledPath, "cancelled\n");
  }

  async function scanOperationDirectories(
    accept: (directory: string) => Promise<void>,
  ): Promise<boolean> {
    let complete = true;
    async function visit(
      directory: string,
      remainingLevels: number,
    ): Promise<void> {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch {
        complete = false;
        return;
      }
      for (const name of names) {
        if (!HASH.test(name)) continue;
        const child = join(directory, name);
        try {
          if (!(await checkedDirectory(child, false))) fail("invalid_record");
          if (remainingLevels > 1) await visit(child, remainingLevels - 1);
          else await accept(child);
        } catch {
          // 一个坏记录不能阻止其它可验证记录继续对账。
          complete = false;
        }
      }
    }
    try {
      if (!(await checkedDirectory(root, false))) return true;
      let directory = await realpath(root);
      for (const component of ["cad", "gui-operations"]) {
        directory = join(directory, component);
        if (!(await checkedDirectory(directory, false))) return true;
      }
      // 磁盘格式固定为instance/task/operation三层hash，不接受调用方路径或新索引。
      await visit(directory, 3);
    } catch {
      complete = false;
    }
    return complete;
  }

  async function cancelPending(filter: { runId?: string } = {}): Promise<void> {
    if (
      !(await scanOperationDirectories((directory) =>
        cancelPendingDirectory(directory, filter),
      ))
    )
      fail("stop_unconfirmed");
  }

  async function listRecords(
    filter: CadGuiOperationRecordFilter = {},
  ): Promise<readonly CadGuiOperationRecord[]> {
    const records: CadGuiOperationRecord[] = [];
    const complete = await scanOperationDirectories(async (directory) => {
      const record = await scannedRecord(directory, filter);
      if (record) records.push(record);
    });
    if (!complete) fail("invalid_record");
    return records;
  }

  return {
    prepare,
    lookup,
    listRecords,
    cancelPending,
    async readPublication(record) {
      return readPublicationFiles(await verified(record));
    },
    async claimPublication(record, payload) {
      const contents = publicationJson(payload);
      const current = await verified(record);
      if ((await readPublicationFiles(current)).claim !== undefined)
        return false;
      const claimed = await publishMarker(
        join(current.directory, "publication.claim.json"),
        contents,
      );
      if (!claimed) await readPublicationFiles(current);
      return claimed;
    },
    async completePublication(record, receipt) {
      const contents = publicationJson(receipt);
      const current = await verified(record);
      const state = await readPublicationFiles(current);
      if (state.claim === undefined) fail("invalid_record");
      if (state.receipt !== undefined) {
        if (publicationJson(state.receipt) !== contents) fail("conflict");
        return;
      }
      if (
        await publishMarker(
          join(current.directory, "publication.receipt.json"),
          contents,
        )
      )
        return;
      const raced = await readPublicationFiles(current);
      if (raced.receipt === undefined) fail("invalid_record");
      if (publicationJson(raced.receipt) !== contents) fail("conflict");
    },
    async claimDispatch(record) {
      if (!dispatchable.has(record)) fail("read_only");
      const current = await verified(record);
      if (await hasMarker(current.cancelledPath)) return false;
      if (await hasMarker(current.executionClaimPath)) return false;
      if (await hasMarker(current.receiptPath)) return false;
      if (
        !(await publishMarker(current.dispatchClaimPath, `${randomUUID()}\n`))
      )
        return false;
      return !(await hasMarker(current.cancelledPath));
    },
    async cancel(record) {
      const current = await verified(record);
      await publishMarker(current.cancelledPath, "cancelled\n");
    },
    async readState(input) {
      const record =
        "binding" in input ? await verified(input) : await lookup(input);
      if (!record) fail("not_found");
      const cancelled = await hasMarker(record.cancelledPath);
      const executing = await hasMarker(record.executionClaimPath);
      const dispatched = await hasMarker(record.dispatchClaimPath);
      let receiptError: CadGuiOperationState["receiptError"];
      try {
        const bytes = await readRegular(
          record.receiptPath,
          CAD_GUI_OPERATION_RECEIPT_MAX_BYTES,
        );
        if (bytes) {
          try {
            const receipt: unknown = JSON.parse(bytes.toString("utf8"));
            return { status: "terminal", record, cancelled, receipt };
          } catch {
            receiptError = "invalid_json";
          }
        }
      } catch (error) {
        receiptError =
          error instanceof UnreadableFile ? error.reason : "unsafe_file";
      }
      const status = executing
        ? "executing"
        : dispatched
          ? "dispatched"
          : cancelled
            ? "cancelled"
            : "prepared";
      return {
        status,
        record,
        cancelled,
        ...(status === "dispatched" || status === "executing" || receiptError
          ? { outcome: "unknown" as const }
          : {}),
        ...(receiptError ? { receiptError } : {}),
      };
    },
  };
}
