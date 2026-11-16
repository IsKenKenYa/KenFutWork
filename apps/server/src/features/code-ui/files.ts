import { constants } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { CodeUiViewerScope, InstanceSettings } from "@kenfutwork/shared";
import { codeUiViewerScopeSchema } from "@kenfutwork/shared";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { packWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
} from "@zcode/shared/workspaceFileSearch";
import { z } from "zod";
import { binaryMimeType } from "../code-tools/file-media.js";
import { CodeUiRepositoryError } from "./repository.js";

const paramsSchema = z.object({
  path: z.string().min(1),
  viewerScope: codeUiViewerScopeSchema,
  offset: z.number().int().nonnegative().optional(),
  length: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().positive().optional(),
  includeHidden: z.boolean().optional(),
});
export type ViewerResolver = (
  viewer: CodeUiViewerScope,
  path: string,
) => Promise<string>;
const missing = (error: unknown) =>
  Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
type ViewerLimits = Pick<
  InstanceSettings,
  "codeReadMaxBytes" | "codeSearchMaxResults" | "codeSearchMaxBytes"
>;
const indexParamsSchema = z.object({
  rootPath: z.string().min(1),
  viewerScope: codeUiViewerScopeSchema,
});
const pagedIndexParamsSchema = indexParamsSchema.extend({
  scanId: z.uuid().optional(),
  offset: z.number().int().nonnegative().optional(),
  length: z.number().int().positive().optional(),
});
type FileIndexScope = Pick<
  z.infer<typeof pagedIndexParamsSchema>,
  "viewerScope" | "rootPath" | "scanId"
>;

async function viewerTree(
  viewer: CodeUiViewerScope,
  root: string,
  resolvePath: ViewerResolver,
  limits: ViewerLimits,
) {
  const result: WorkspaceFileEntry[] = [];
  const directories = [root];
  let bytes = 0;
  while (directories.length) {
    const directory = directories.shift();
    if (!directory) break;
    if ((await resolvePath(viewer, directory)) !== directory)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "目录真实路径已改变，请重新扫描。",
      );
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    if ((await resolvePath(viewer, directory)) !== directory)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "目录授权在扫描期间变化。",
      );
    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.isSymbolicLink() ||
        (!entry.isDirectory() && !entry.isFile())
      )
        continue;
      const path = join(directory, entry.name);
      if ((await resolvePath(viewer, path)) !== path)
        throw new CodeUiRepositoryError(
          "command_conflict",
          "目录项真实路径已改变，请重新扫描。",
        );
      const item = {
        name: entry.name,
        path,
        relativePath: relative(root, path).split(sep).join("/"),
        type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
      };
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (
        result.length >= limits.codeSearchMaxResults ||
        bytes > limits.codeSearchMaxBytes
      )
        throw new CodeUiRepositoryError(
          "command_conflict",
          "文件索引超过工作区扫描预算，请调整治理设置。",
        );
      result.push(item);
      if (entry.isDirectory()) directories.push(path);
    }
  }
  await resolvePath(viewer, root);
  return { entries: result, bytes };
}

type FileIndexSnapshot = {
  scopeKey: string;
  packed: string;
  entries: WorkspaceFileEntry[];
  bytes: number;
};

function indexScopeKey(scope: FileIndexScope) {
  return JSON.stringify([scope.viewerScope, scope.rootPath, scope.scanId]);
}

/** 同一连接内的各次扫描独立保存；旧调用方沿用一个兼容位置。 */
export class CodeUiFileIndex {
  private readonly snapshots = new Map<string, FileIndexSnapshot>();
  private retainedBytes = 0;

  capture(
    scope: FileIndexScope,
    scan: Awaited<ReturnType<typeof viewerTree>>,
    maxBytes: number,
  ) {
    const scopeKey = indexScopeKey(scope);
    const key = scope.scanId ? scopeKey : "";
    const existing = this.snapshots.get(key);
    if (scope.scanId && existing) return existing.packed.length;
    const packed = packWorkspaceFileEntries(scan.entries);
    const bytes = Math.max(
      scan.bytes,
      Buffer.byteLength(packed),
      Buffer.byteLength(scopeKey),
    );
    if (existing) this.remove(key, existing);
    // 文件树与命令中心可各使用一份完整扫描预算；空目录也计入范围标识的字节数。
    const cacheBudget = 2 * maxBytes;
    for (const [oldKey, snapshot] of this.snapshots) {
      if (this.retainedBytes + bytes <= cacheBudget) break;
      this.remove(oldKey, snapshot);
    }
    this.snapshots.set(key, { scopeKey, packed, entries: scan.entries, bytes });
    this.retainedBytes += bytes;
    return packed.length;
  }

  private remove(key: string, snapshot: FileIndexSnapshot) {
    this.snapshots.delete(key);
    this.retainedBytes -= snapshot.bytes;
  }

  async read(
    scope: FileIndexScope,
    offset: number,
    length: number,
    resolvePath: ViewerResolver,
    limits: ViewerLimits,
  ) {
    const scopeKey = indexScopeKey(scope);
    const key = scope.scanId ? scopeKey : "";
    const snapshot = this.snapshots.get(key);
    if (!snapshot || snapshot.scopeKey !== scopeKey)
      throw new CodeUiRepositoryError(
        "command_conflict",
        scope.scanId ? "文件列表已过期，请重新读取。" : "请先刷新文件列表。",
      );
    if (
      snapshot.entries.length > limits.codeSearchMaxResults ||
      Buffer.byteLength(snapshot.packed) > limits.codeSearchMaxBytes
    )
      throw new CodeUiRepositoryError(
        "command_conflict",
        "文件索引超过当前治理预算，请重新扫描。",
      );
    for (const entry of snapshot.entries)
      if ((await resolvePath(scope.viewerScope, entry.path)) !== entry.path)
        throw new CodeUiRepositoryError(
          "command_conflict",
          "文件索引路径已改变，请重新扫描。",
        );
    await resolvePath(scope.viewerScope, scope.rootPath);
    if (this.snapshots.get(key) !== snapshot)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "文件列表已过期，请重新读取。",
      );
    const chunk = snapshot.packed.slice(offset, offset + length);
    if (Buffer.byteLength(chunk) > limits.codeSearchMaxBytes)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "文件索引分块超过工作区字节预算。",
      );
    return chunk;
  }
}

async function byteSlice(
  value: z.infer<typeof paramsSchema>,
  resolvePath: ViewerResolver,
  maxBytes: number,
) {
  const path = await resolvePath(value.viewerScope, value.path);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    if (!before.isFile())
      throw new CodeUiRepositoryError(
        "not_found",
        "Code viewer 只能读取常规文件。",
      );
    const offset = value.offset ?? 0;
    const length = Math.min(
      value.length ?? value.maxBytes ?? before.size,
      maxBytes,
      Math.max(0, before.size - offset),
    );
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, offset);
    const after = await file.stat();
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      (await resolvePath(value.viewerScope, value.path)) !== path
    )
      throw new CodeUiRepositoryError(
        "command_conflict",
        "文件或目录授权在预览期间变化，请重新读取。",
      );
    return {
      path,
      bytes: buffer.subarray(0, bytesRead),
      offset,
      totalBytes: after.size,
      truncated: offset + bytesRead < after.size,
    };
  } finally {
    await file.close();
  }
}

interface ViewerRpcInput {
  method: string;
  value: unknown;
  resolvePath: ViewerResolver;
  limits: ViewerLimits;
  fileIndex?: CodeUiFileIndex;
}

async function viewerIndexRpc(input: ViewerRpcInput) {
  if (!input.fileIndex)
    throw new CodeUiRepositoryError(
      "command_conflict",
      "文件索引必须绑定已连接的人工 viewer。",
    );
  const params = pagedIndexParamsSchema.parse(input.value);
  const root = await input.resolvePath(params.viewerScope, params.rootPath);
  const scope = { ...params, rootPath: root };
  if (input.method === "listWorkspaceFilesLength") {
    const scan = await viewerTree(
      params.viewerScope,
      root,
      input.resolvePath,
      input.limits,
    );
    return {
      result: input.fileIndex.capture(
        scope,
        scan,
        input.limits.codeSearchMaxBytes,
      ),
    };
  }
  if (params.offset === undefined || params.length === undefined)
    throw new CodeUiRepositoryError(
      "command_conflict",
      "文件索引分页需要 offset 与 length。",
    );
  return {
    result: await input.fileIndex.read(
      scope,
      params.offset,
      params.length,
      input.resolvePath,
      input.limits,
    ),
  };
}

async function viewerExistsRpc(input: ViewerRpcInput) {
  const value = z
    .object({
      paths: z.array(z.string().min(1)),
      viewerScope: codeUiViewerScopeSchema,
    })
    .parse(input.value);
  if (value.paths.length > input.limits.codeSearchMaxResults)
    throw new CodeUiRepositoryError(
      "command_conflict",
      "文件数量超过工作区配置上限。",
    );
  const result = await Promise.all(
    value.paths.map(async (path) => {
      try {
        const canonical = await input.resolvePath(value.viewerScope, path);
        await stat(canonical);
        if ((await input.resolvePath(value.viewerScope, path)) !== canonical)
          throw new CodeUiRepositoryError(
            "command_conflict",
            "文件路径在检查期间改变。",
          );
        return { path, exists: true };
      } catch (error) {
        if (!missing(error)) throw error;
        await input.resolvePath(value.viewerScope, path);
        return { path, exists: false };
      }
    }),
  );
  return { result };
}

async function viewerSearchRpc(input: ViewerRpcInput) {
  const params = indexParamsSchema
    .extend({
      query: z.string(),
      limit: z.number().int().positive().optional(),
    })
    .parse(input.value);
  const root = await input.resolvePath(params.viewerScope, params.rootPath);
  const maximum = Math.min(
    params.limit ?? input.limits.codeSearchMaxResults,
    input.limits.codeSearchMaxResults,
  );
  const { entries } = await viewerTree(
    params.viewerScope,
    root,
    input.resolvePath,
    input.limits,
  );
  const result = filterWorkspaceFileSearchCandidates(
    mapWorkspaceFileEntriesToSearchCandidates(entries),
    params.query,
    { limit: maximum },
  ).map(({ name, path, relativePath, type }) => ({
    name,
    path,
    relativePath,
    type,
  }));
  return { result };
}

async function viewerMetadataRpc(
  input: ViewerRpcInput,
  params: z.infer<typeof paramsSchema>,
) {
  const path = await input.resolvePath(params.viewerScope, params.path);
  if (input.method === "resolvePath") return { result: path };
  if (input.method === "stat") {
    const metadata = await stat(path);
    await input.resolvePath(params.viewerScope, params.path);
    return {
      result: {
        path: params.path,
        type: metadata.isDirectory() ? "directory" : "file",
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
      },
    };
  }
  const directory = await readdir(path, { withFileTypes: true });
  const entries = directory.filter(
    (entry) => params.includeHidden || !entry.name.startsWith("."),
  );
  if (entries.length > input.limits.codeSearchMaxResults)
    throw new CodeUiRepositoryError(
      "command_conflict",
      "目录内容超过工作区配置上限。",
    );
  const result = entries.map((entry) => ({
    name: entry.name,
    path: join(params.path, entry.name),
    type: entry.isDirectory() ? "directory" : "file",
    ...(entry.isSymbolicLink() ? { isSymbolicLink: true } : {}),
  }));
  await input.resolvePath(params.viewerScope, params.path);
  return { result };
}

async function viewerReadRpc(
  input: ViewerRpcInput,
  params: z.infer<typeof paramsSchema>,
) {
  const slice = await byteSlice(
    params,
    input.resolvePath,
    input.limits.codeReadMaxBytes,
  );
  if (input.method === "readTextFile") {
    const isBinary = slice.bytes.includes(0);
    return {
      result: {
        path: params.path,
        content: isBinary ? "" : slice.bytes.toString("utf8"),
        offset: slice.offset,
        bytesRead: slice.bytes.length,
        totalBytes: slice.totalBytes,
        truncated: slice.truncated,
        isBinary,
      },
    };
  }
  if (input.method === "readFileRange")
    return {
      result: { encoding: "base64", data: slice.bytes.toString("base64") },
    };
  if (slice.truncated)
    throw new CodeUiRepositoryError(
      "command_conflict",
      "预览文件超过工作区字节预算，请使用分页读取或调高治理设置。",
    );
  return {
    result: {
      path: params.path,
      dataBase64: slice.bytes.toString("base64"),
      totalBytes: slice.totalBytes,
      ...(input.method === "readMediaPreview"
        ? { mediaType: binaryMimeType(slice.bytes) }
        : {}),
    },
  };
}

const viewerMethods = new Set([
  "readTextFile",
  "readFileRange",
  "readBinaryPreview",
  "readMediaPreview",
  "readdir",
  "stat",
  "checkFilesExist",
  "resolvePath",
  "searchWorkspaceFiles",
  "listWorkspaceFilesLength",
  "listWorkspaceFilesRange",
]);

/** 人工文件预览不写入模型读观察；Task与project草稿的权限解析分别注入。 */
export async function codeUiViewerRpc(input: ViewerRpcInput) {
  if (!viewerMethods.has(input.method)) return null;
  if (
    input.method === "listWorkspaceFilesLength" ||
    input.method === "listWorkspaceFilesRange"
  )
    return viewerIndexRpc(input);
  if (input.method === "checkFilesExist") return viewerExistsRpc(input);
  if (input.method === "searchWorkspaceFiles") return viewerSearchRpc(input);
  const params = paramsSchema.parse(input.value);
  if (
    input.method === "resolvePath" ||
    input.method === "stat" ||
    input.method === "readdir"
  )
    return viewerMetadataRpc(input, params);
  return viewerReadRpc(input, params);
}
