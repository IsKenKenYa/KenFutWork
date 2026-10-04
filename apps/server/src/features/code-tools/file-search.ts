import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, join, matchesGlob, relative } from "node:path";
import type { FileInfo } from "deepagents";
import type { ScopedFilesystemScope } from "../execution/scoped-filesystem.js";
import {
  matchesFileType,
  type RipgrepOutput,
  runRipgrep,
} from "./file-ripgrep.js";
import type {
  FileLimits,
  GlobPage,
  GlobPageInput,
  GrepPage,
  GrepPageInput,
  SearchCursor,
} from "./file-types.js";

async function* walk(
  scope: ScopedFilesystemScope,
  input: string,
  visited = new Set<string>(),
  signal?: AbortSignal,
): AsyncGenerator<FileInfo> {
  signal?.throwIfAborted();
  const path = await scope.resolvePath(input, "read");
  const info = await stat(path);
  if (info.isFile()) {
    if (visited.has(path)) return;
    visited.add(path);
    yield {
      path,
      size: info.size,
      is_dir: false,
      modified_at: info.mtime.toISOString(),
    };
    return;
  }
  if (!info.isDirectory()) throw new Error(`不是文件或目录：${path}`);
  if (visited.has(path)) return;
  visited.add(path);
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries)
    yield* walk(scope, join(path, entry.name), visited, signal);
}

function fingerprint(scope: ScopedFilesystemScope, request: object): string {
  const identity = scope.describe();
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspace: identity.workspaceId,
        task: identity.taskId,
        agent: scope.agentId,
        role: scope.role,
        generation: identity.generation,
        request,
      }),
    )
    .digest("hex");
}

function startOffset(
  continuation: SearchCursor | undefined,
  offset: number | undefined,
  key: string,
): number {
  if (continuation && continuation.fingerprint !== key)
    throw new Error("搜索继续指针与当前查询或授权代际不匹配");
  const result = continuation?.offset ?? offset ?? 0;
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error("搜索 offset 无效");
  return result;
}

function pageLimit(input: number | undefined, limits: FileLimits): number {
  if (input !== undefined && (!Number.isSafeInteger(input) || input < 0))
    throw new Error("搜索 limit 无效");
  return input === undefined || input === 0
    ? limits.codeSearchMaxResults
    : Math.min(input, limits.codeSearchMaxResults);
}

export async function globPage(
  scope: ScopedFilesystemScope,
  limits: FileLimits,
  input: GlobPageInput,
): Promise<GlobPage> {
  if (!input.pattern) throw new Error("Glob pattern 不能为空");
  const root = await scope.resolvePath(
    input.path ?? scope.describe().rootDirectory,
    "read",
  );
  const key = fingerprint(scope, {
    kind: "glob",
    root,
    pattern: input.pattern,
  });
  const offset = startOffset(input.continuation, input.offset, key);
  const limit = pageLimit(input.limit, limits);
  const files: FileInfo[] = [];
  let index = 0;
  let bytes = 0;
  for await (const file of walk(scope, root, new Set(), input.signal)) {
    if (!matchesGlob(relative(root, file.path), input.pattern)) continue;
    if (index++ < offset) continue;
    const size = Buffer.byteLength(JSON.stringify(file));
    if (files.length >= limit || bytes + size > limits.codeSearchMaxBytes) {
      if (!files.length) throw new Error("单个文件元数据超过搜索输出预算");
      return {
        files,
        truncated: true,
        continuation: { offset: offset + files.length, fingerprint: key },
      };
    }
    files.push(file);
    bytes += size;
  }
  await scope.resolvePath(root, "read");
  input.signal?.throwIfAborted();
  return { files, truncated: false };
}

class MatchPage {
  readonly matches: GrepPage["matches"] = [];
  private bytes = 0;
  skip: number;
  constructor(
    private readonly offset: number,
    private readonly key: string,
    private readonly limit: number,
    private readonly maxBytes: number,
    skip: number,
  ) {
    this.skip = skip;
  }
  add(match: GrepPage["matches"][number]): boolean {
    if (this.skip > 0) {
      this.skip -= 1;
      return true;
    }
    const size = Buffer.byteLength(JSON.stringify(match));
    if (
      this.matches.length >= this.limit ||
      this.bytes + size > this.maxBytes
    ) {
      if (!this.matches.length)
        throw new Error("单个匹配超过搜索输出预算，请缩小查询或使用 Read");
      return false;
    }
    this.matches.push(match);
    this.bytes += size;
    return true;
  }
  truncated(resume?: SearchCursor["resume"]): GrepPage {
    return {
      matches: this.matches,
      truncated: true,
      continuation: {
        offset: this.offset + this.matches.length,
        fingerprint: this.key,
        skip: this.skip,
        ...(resume ? { resume } : {}),
      },
    };
  }
}

export async function grepPage(
  scope: ScopedFilesystemScope,
  limits: FileLimits,
  input: GrepPageInput,
): Promise<GrepPage> {
  const root = await scope.resolvePath(
    input.path ?? scope.describe().rootDirectory,
    "read",
  );
  const key = fingerprint(scope, {
    kind: "grep",
    root,
    pattern: input.pattern,
    glob: input.glob ?? null,
    insensitive: input.caseInsensitive ?? false,
    multiline: input.multiline ?? false,
    onlyMatching: input.onlyMatching ?? false,
    type: input.type ?? null,
    mode: input.mode ?? "content",
    before: input.contextBefore ?? 0,
    after: input.contextAfter ?? 0,
  });
  const offset = startOffset(input.continuation, input.offset, key);
  const resume = input.continuation?.resume;
  const page = new MatchPage(
    offset,
    key,
    pageLimit(input.limit, limits),
    limits.codeSearchMaxBytes,
    resume ? (input.continuation?.skip ?? 0) : offset,
  );
  await runRipgrep(scope, undefined, input, limits.codeSearchMaxBytes);
  if (input.type) await matchesFileType("", input.type, limits);
  let foundResume = !resume;
  for await (const file of walk(scope, root, new Set(), input.signal)) {
    if (!foundResume) {
      if (file.path !== resume?.path) continue;
      foundResume = true;
    }
    const name = relative(root, file.path);
    if (
      input.glob &&
      !matchesGlob(name, input.glob) &&
      !matchesGlob(basename(file.path), input.glob)
    )
      continue;
    if (
      input.type &&
      !(await matchesFileType(basename(file.path), input.type, limits))
    )
      continue;
    const sameFile = file.path === resume?.path;
    if (
      sameFile &&
      resume?.modifiedAt &&
      file.modified_at !== resume.modifiedAt
    )
      throw new Error("搜索继续位置的文件已变化，请重新搜索");
    const fromLine = sameFile ? (resume?.line ?? 1) : 1;
    const output = await runRipgrep(
      scope,
      file.path,
      input,
      limits.codeSearchMaxBytes,
      fromLine,
    );
    await scope.resolvePath(file.path, "read");
    const hits = searchHits(file.path, output, input);
    const ordinals = new Map<number, number>();
    for (const hit of hits) {
      const ordinal = ordinals.get(hit.line) ?? 0;
      ordinals.set(hit.line, ordinal + 1);
      if (sameFile && hit.line === resume?.line && ordinal < resume.matchOffset)
        continue;
      if (!page.add(hit)) {
        if (input.mode === "count" || input.mode === "files_with_matches")
          return page.truncated();
        return page.truncated({
          path: file.path,
          line: hit.line,
          matchOffset: ordinal,
          ...(file.modified_at ? { modifiedAt: file.modified_at } : {}),
        });
      }
    }
    if (output.truncated) {
      const last = output.rows.filter((row) => row.type === "match").at(-1);
      if (!last?.data?.line_number)
        throw new Error("搜索输出截断但没有完整匹配可继续");
      const source = last.data.lines?.text ?? "";
      const lineCount = Math.max(
        1,
        source.split("\n").length - (source.endsWith("\n") ? 1 : 0),
      );
      return page.truncated({
        path: file.path,
        line: last.data.line_number + lineCount,
        matchOffset: 0,
        ...(file.modified_at ? { modifiedAt: file.modified_at } : {}),
      });
    }
  }
  if (!foundResume)
    throw new Error("搜索继续位置的文件已删除或移出范围，请重新搜索");
  await scope.resolvePath(root, "read");
  input.signal?.throwIfAborted();
  return { matches: page.matches, truncated: false };
}

function searchHits(
  path: string,
  output: RipgrepOutput,
  input: GrepPageInput,
): GrepPage["matches"] {
  if (input.mode === "count") {
    const count = output.count ?? 0;
    return count > 0 ? [{ path, line: 0, text: "", count }] : [];
  }
  if (input.mode === "files_with_matches")
    return output.hasMatch ? [{ path, line: 0, text: "" }] : [];
  const rows = output.rows;
  const matches = rows.filter(
    (row) => row.type === "match" && row.data?.lines?.text !== undefined,
  );
  return matches.flatMap((row) => {
    const number = row.data?.line_number ?? 1;
    const context = rows.flatMap((entry) => {
      const line = entry.data?.line_number;
      const text = entry.data?.lines?.text;
      if (
        line === undefined ||
        text === undefined ||
        line === number ||
        line < number - (input.contextBefore ?? 0) ||
        line > number + (input.contextAfter ?? 0)
      )
        return [];
      return [{ line, text: text.replace(/\r?\n$/, "") }];
    });
    const texts = input.onlyMatching
      ? (row.data?.submatches?.flatMap((match) =>
          match.match?.text === undefined ? [] : [match.match.text],
        ) ?? [])
      : [row.data?.lines?.text?.replace(/\r?\n$/, "") ?? ""];
    return texts.map((text) => ({
      path,
      line: number,
      text,
      ...(context.length ? { context } : {}),
    }));
  });
}

export async function listDirectory(
  scope: ScopedFilesystemScope,
  path: string,
  signal?: AbortSignal,
): Promise<FileInfo[]> {
  const root = await scope.resolvePath(path, "read");
  const entries = await readdir(root, { withFileTypes: true });
  return Promise.all(
    entries.map(async (entry) => {
      signal?.throwIfAborted();
      const canonical = await scope.resolvePath(join(root, entry.name), "read");
      const info = await stat(canonical);
      return {
        path: info.isDirectory() ? `${canonical}/` : canonical,
        is_dir: info.isDirectory(),
        size: info.size,
        modified_at: info.mtime.toISOString(),
      };
    }),
  );
}
