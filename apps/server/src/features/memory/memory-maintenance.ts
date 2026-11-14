import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * 项目记忆的自动整理与遗忘。
 *
 * 边界：
 * - 被 `MEMORY.md` 索引引用的条目永不由这里删除，只有索引悬挂行与「未被引用且闲置超期」
 *   的正文会进入回收区；重复正文只保留最早被引用的一份。
 * - 回收区按可调天数保留，窗口内可恢复；过期后才永久删除。
 * - 只读写记忆目录内的普通文件，符号链接与超限文件跳过整理。
 */

const INDEX_FILE_NAME = "MEMORY.md";
const TRASH_DIRECTORY_NAME = ".trash";
const DAY_MS = 86_400_000;
const INDEX_LINE = /^- \[(.*?)\]\(([^/\\]+\.md)\)(?:[ \t]+—[ \t]+(.*))?\s*$/u;

export interface MemoryIndexEntry {
  raw: string;
  title: string;
  fileName: string;
  hook: string;
}

export interface MemoryTrashEntry {
  id: string;
  fileName: string | null;
  /** 索引行里记录的标题；没有索引行时用文件名（去扩展名）。 */
  title: string | null;
  reason: "duplicate" | "orphan" | "dangling-index";
  indexLine: string | null;
  trashedAt: number;
}

export interface MemoryMaintenanceResult {
  /** 被合并掉的重复正文数量。 */
  merged: number;
  /** 进入回收区的文件或索引行数量。 */
  trashed: number;
  /** 回收窗口过期后永久删除的回收项数量。 */
  purged: number;
  indexUpdated: boolean;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isValidSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    basename(value) === value &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

export function parseMemoryIndexLine(raw: string): MemoryIndexEntry | null {
  const matched = INDEX_LINE.exec(raw.trim());
  if (!matched?.[1] || !matched[2]) return null;
  return {
    raw,
    title: matched[1],
    fileName: matched[2],
    hook: matched[3]?.trim() ?? "",
  };
}

export function renderMemoryIndexLine(entry: MemoryIndexEntry): string {
  return entry.hook
    ? `- [${entry.title}](${entry.fileName}) — ${entry.hook}`
    : `- [${entry.title}](${entry.fileName})`;
}

function indexHook(content: string): string {
  const firstLine =
    content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  return firstLine.slice(0, 120);
}

function titleFromIndexLine(indexLine: string | null): string | null {
  if (!indexLine) return null;
  const matched = indexLine.match(/^- \[(.*?)\]/u);
  const title = matched?.[1]?.trim();
  return title && title.length > 0 ? title : null;
}

async function readOptional(filePath: string): Promise<string> {
  return readFile(filePath, "utf8").catch((error: unknown) => {
    if (isNotFound(error)) return "";
    throw error;
  });
}

async function listMemoryFiles(memoryRoot: string): Promise<string[]> {
  const entries = await readdir(memoryRoot, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (isNotFound(error)) return [];
      throw error;
    },
  );
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        entry.name.endsWith(".md") &&
        entry.name !== INDEX_FILE_NAME,
    )
    .map((entry) => entry.name);
}

async function readPlainFiles(
  memoryRoot: string,
  names: string[],
  maxFileBytes: number,
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const name of names) {
    const metadata = await lstat(join(memoryRoot, name)).catch(
      (error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      },
    );
    if (!metadata || !metadata.isFile() || metadata.isSymbolicLink()) continue;
    // 超限正文跳过整理：读不完就不判断重复，避免误删。
    if (metadata.size > maxFileBytes) continue;
    contents.set(name, await readFile(join(memoryRoot, name), "utf8"));
  }
  return contents;
}

async function moveToTrash(options: {
  memoryRoot: string;
  fileName: string | null;
  reason: MemoryTrashEntry["reason"];
  indexLine: string | null;
  now: number;
}): Promise<MemoryTrashEntry> {
  const id = `${options.now}-${randomUUID().slice(0, 8)}`;
  const trashRoot = join(options.memoryRoot, TRASH_DIRECTORY_NAME);
  const trashDirectory = join(trashRoot, id);
  await mkdir(trashDirectory, { recursive: true });
  if (options.fileName) {
    await rename(
      join(options.memoryRoot, options.fileName),
      join(trashDirectory, options.fileName),
    ).catch((error: unknown) => {
      // 同一文件已被另一个整理进程移走：按幂等结果继续。
      if (!isNotFound(error)) throw error;
    });
  }
  const entry: MemoryTrashEntry = {
    id,
    fileName: options.fileName,
    title:
      titleFromIndexLine(options.indexLine) ??
      options.fileName?.replace(/\.md$/u, "") ??
      null,
    reason: options.reason,
    indexLine: options.indexLine,
    trashedAt: options.now,
  };
  await writeFile(
    join(trashDirectory, "meta.json"),
    `${JSON.stringify(entry, null, 2)}\n`,
    "utf8",
  );
  return entry;
}

async function purgeExpiredTrash(options: {
  memoryRoot: string;
  recoverableWindowDays: number;
  now: number;
}): Promise<number> {
  const trashRoot = join(options.memoryRoot, TRASH_DIRECTORY_NAME);
  const entries = await readdir(trashRoot, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (isNotFound(error)) return [];
      throw error;
    },
  );
  let purged = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const meta = await readOptional(join(trashRoot, entry.name, "meta.json"));
    if (meta === "") continue;
    const parsed = JSON.parse(meta) as Partial<MemoryTrashEntry>;
    if (typeof parsed.trashedAt !== "number") continue;
    if (
      options.now - parsed.trashedAt <=
      options.recoverableWindowDays * DAY_MS
    )
      continue;
    await rm(join(trashRoot, entry.name), { recursive: true, force: true });
    purged += 1;
  }
  return purged;
}

export async function listTrashEntries(
  memoryRoot: string,
): Promise<MemoryTrashEntry[]> {
  const trashRoot = join(memoryRoot, TRASH_DIRECTORY_NAME);
  const entries = await readdir(trashRoot, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (isNotFound(error)) return [];
      throw error;
    },
  );
  const results: MemoryTrashEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const meta = await readOptional(join(trashRoot, entry.name, "meta.json"));
    if (meta === "") continue;
    const parsed = JSON.parse(meta) as Partial<MemoryTrashEntry>;
    if (typeof parsed.trashedAt !== "number") continue;
    const fileName =
      typeof parsed.fileName === "string" ? parsed.fileName : null;
    const indexLine =
      typeof parsed.indexLine === "string" ? parsed.indexLine : null;
    results.push({
      id: entry.name,
      fileName,
      title:
        (typeof parsed.title === "string" ? parsed.title : null) ??
        titleFromIndexLine(indexLine) ??
        fileName?.replace(/\.md$/u, "") ??
        null,
      reason:
        parsed.reason === "duplicate" ||
        parsed.reason === "orphan" ||
        parsed.reason === "dangling-index"
          ? parsed.reason
          : "orphan",
      indexLine,
      trashedAt: parsed.trashedAt,
    });
  }
  results.sort((left, right) => right.trashedAt - left.trashedAt);
  return results;
}

export async function maintainMemoryDirectory(options: {
  memoryRoot: string;
  now: number;
  orphanRetentionDays: number;
  recoverableWindowDays: number;
  maxFileBytes: number;
}): Promise<MemoryMaintenanceResult> {
  const rootMetadata = await lstat(options.memoryRoot).catch(
    (error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    },
  );
  if (!rootMetadata) {
    return { merged: 0, trashed: 0, purged: 0, indexUpdated: false };
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())
    throw new Error("记忆目录不是普通目录，已停止整理。");

  const names = await listMemoryFiles(options.memoryRoot);
  const nameSet = new Set(names);
  const contents = await readPlainFiles(
    options.memoryRoot,
    names,
    options.maxFileBytes,
  );
  const indexPath = join(options.memoryRoot, INDEX_FILE_NAME);
  const indexRaw = await readOptional(indexPath);
  const lines = indexRaw === "" ? [] : indexRaw.split(/\r?\n/u);
  const parsed = lines.map((raw) => ({
    raw,
    entry: parseMemoryIndexLine(raw),
  }));
  const lineByName = new Map<string, number>();
  parsed.forEach((line, index) => {
    if (!line.entry) return;
    if (!lineByName.has(line.entry.fileName))
      lineByName.set(line.entry.fileName, index);
  });

  const byHash = new Map<string, string[]>();
  for (const [name, content] of contents) {
    const hash = createHash("sha256").update(content).digest("hex");
    const bucket = byHash.get(hash) ?? [];
    bucket.push(name);
    byHash.set(hash, bucket);
  }

  const dropped = new Set<number>();
  const added: MemoryIndexEntry[] = [];
  const removed = new Set<string>();
  let merged = 0;
  let trashed = 0;

  // 重复正文：保留最早被索引引用的一份，其余进回收区；索引行只留一行。
  for (const bucket of byHash.values()) {
    if (bucket.length < 2) continue;
    const referenced = bucket.filter((name) => lineByName.has(name));
    // 保留索引里出现最早的一份，读者看到的链接位置不变。
    const keeper =
      referenced.length > 0
        ? referenced.reduce((best, name) =>
            lineByName.get(name)! < lineByName.get(best)! ? name : best,
          )
        : [...bucket].sort()[0]!;
    for (const name of bucket) {
      if (name === keeper) continue;
      const lineIndex = lineByName.get(name);
      if (lineIndex !== undefined) {
        if (lineByName.has(keeper)) dropped.add(lineIndex);
        else {
          const entry = parsed[lineIndex]!.entry!;
          entry.fileName = keeper;
          parsed[lineIndex]!.raw = renderMemoryIndexLine(entry);
          lineByName.set(keeper, lineIndex);
        }
      }
      await moveToTrash({
        memoryRoot: options.memoryRoot,
        fileName: name,
        reason: "duplicate",
        indexLine: null,
        now: options.now,
      });
      removed.add(name);
      merged += 1;
      trashed += 1;
    }
    if (!lineByName.has(keeper)) {
      const content = contents.get(keeper) ?? "";
      added.push({
        raw: "",
        title: keeper.replace(/\.md$/u, ""),
        fileName: keeper,
        hook: indexHook(content),
      });
    }
  }

  // 索引悬挂行：正文已不存在，连同说明一起进回收区，窗口内可恢复索引行。
  for (const [index, line] of parsed.entries()) {
    if (!line.entry || dropped.has(index)) continue;
    const fileName = line.entry.fileName;
    if (removed.has(fileName) || nameSet.has(fileName)) continue;
    dropped.add(index);
    await moveToTrash({
      memoryRoot: options.memoryRoot,
      fileName: null,
      reason: "dangling-index",
      indexLine: line.raw,
      now: options.now,
    });
    trashed += 1;
  }

  // 未被索引引用且闲置超期的正文：进回收区。
  const referencedNames = new Set(
    parsed
      .filter((line, index) => line.entry && !dropped.has(index))
      .map((line) => line.entry!.fileName),
  );
  for (const entry of added) referencedNames.add(entry.fileName);
  for (const name of names) {
    if (removed.has(name) || referencedNames.has(name)) continue;
    const metadata = await lstat(join(options.memoryRoot, name)).catch(
      (error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      },
    );
    if (!metadata) continue;
    if (options.now - metadata.mtimeMs < options.orphanRetentionDays * DAY_MS)
      continue;
    await moveToTrash({
      memoryRoot: options.memoryRoot,
      fileName: name,
      reason: "orphan",
      indexLine: null,
      now: options.now,
    });
    removed.add(name);
    trashed += 1;
  }

  const purged = await purgeExpiredTrash({
    memoryRoot: options.memoryRoot,
    recoverableWindowDays: options.recoverableWindowDays,
    now: options.now,
  });

  const keptLines = parsed
    .filter((_, index) => !dropped.has(index))
    .map((line) => line.raw)
    .filter((raw) => raw.trim().length > 0);
  for (const entry of added)
    keptLines.push(renderMemoryIndexLine({ ...entry, raw: "" }));
  const nextRaw = keptLines.length === 0 ? "" : `${keptLines.join("\n")}\n`;
  if (nextRaw === indexRaw)
    return { merged, trashed, purged, indexUpdated: false };
  if (Buffer.byteLength(nextRaw, "utf8") > options.maxFileBytes)
    throw new Error("记忆索引超出上限，已停止整理。");
  const temporary = join(options.memoryRoot, `.MEMORY.md.${randomUUID()}.tmp`);
  await writeFile(temporary, nextRaw, "utf8");
  await rename(temporary, indexPath);
  return { merged, trashed, purged, indexUpdated: true };
}

export async function restoreTrashEntry(options: {
  memoryRoot: string;
  trashId: string;
  recoverableWindowDays: number;
  now: number;
  maxFileBytes: number;
}): Promise<{ fileName: string | null }> {
  if (!isValidSegment(options.trashId)) throw new Error("回收项标识无效。");
  const trashDirectory = join(
    options.memoryRoot,
    TRASH_DIRECTORY_NAME,
    options.trashId,
  );
  const metaRaw = await readOptional(join(trashDirectory, "meta.json"));
  if (metaRaw === "") throw new Error("回收项不存在。");
  const meta = JSON.parse(metaRaw) as Partial<MemoryTrashEntry>;
  // 过期回收项保留在磁盘上等待整理任务清除，但恢复入口必须拒绝，避免把已出窗口的条目悄悄放回。
  if (
    typeof meta.trashedAt === "number" &&
    options.now - meta.trashedAt > options.recoverableWindowDays * DAY_MS
  )
    throw new Error("回收项已过可恢复窗口。");

  let fileName: string | null = null;
  if (typeof meta.fileName === "string" && isValidSegment(meta.fileName)) {
    fileName = meta.fileName;
    for (let suffix = 2; ; suffix += 1) {
      const exists = await lstat(join(options.memoryRoot, fileName)).catch(
        (error: unknown) => {
          if (isNotFound(error)) return null;
          throw error;
        },
      );
      if (!exists) break;
      fileName = `${meta.fileName.replace(/\.md$/u, "")}-restored${suffix === 2 ? "" : `-${suffix}`}.md`;
    }
    await rename(
      join(trashDirectory, meta.fileName),
      join(options.memoryRoot, fileName),
    );
  }

  if (typeof meta.indexLine === "string" && meta.indexLine.trim()) {
    const indexPath = join(options.memoryRoot, INDEX_FILE_NAME);
    const indexRaw = await readOptional(indexPath);
    const known = new Set(
      indexRaw
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
    if (!known.has(meta.indexLine.trim())) {
      const nextRaw = `${indexRaw}${indexRaw.endsWith("\n") || indexRaw === "" ? "" : "\n"}${meta.indexLine.trim()}\n`;
      if (Buffer.byteLength(nextRaw, "utf8") > options.maxFileBytes)
        throw new Error("记忆索引超出上限，已停止恢复。");
      await writeFile(indexPath, nextRaw, "utf8");
    }
  }

  await rm(trashDirectory, { recursive: true, force: true });
  return { fileName };
}
