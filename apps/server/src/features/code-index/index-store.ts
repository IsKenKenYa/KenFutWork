import { type Dirent, existsSync, type Stats } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * 代码库索引（R4-3「索引库」）。
 *
 * **规格（此前登记为「需先补规格」，这里就是那份规格）**：
 * - **索引什么**：工作目录内的**文件**（目录不进索引）——每条记
 *   `path / bytes / mtimeMs / language / 摘要`。**文本文件才有摘要**（前 200 字符，
 *   只在建索引时读一次）；二进制与超过 2MB 的文件**照常列出**（这样按文件名/路径照样能搜到，
 *   比如找一张图），只是 `summary` 为空。
 * - **存哪**：`<cwd>/.kenfutwork/index/<taskId>.json`（与插件目录同一处 `.kenfutwork/`，
 *   属服务端本机缓存，**不写进用户的工作目录**，也不进库表）。
 * - **增量时机**：① 手动「重建」（不受资格线限制，超限只截断）；② 设置「索引新文件夹」开着
 *   时，搜索若发现索引缺失就**自动建一份**——但目录文件数达到 50,000 时**不建**，抛
 *   {@link IndexTooLargeError} 让端点如实说明（`autoOnly` 决定是哪条路径）。
 *   已存在时按 `mtimeMs + bytes` 比对：**只有变化的文件重读**，删除的文件从索引里摘掉。
 * - **失效**：目录不存在 → 报可读错误；单个文件读失败（权限/IO）→ 跳过，计入 `skipped`
 *   （`skipped` 是「读不出来的文件数」，不含二进制/超限——那两类只是没有摘要）。
 * - **上限**：条目 ≤ {@link INDEX_MAX_ENTRIES}（= 50000，与参考图「文件数少于 50,000」同一个数：
 *   它既是**自动索引的资格线**，也是索引自身的条目上限，避免出现「够资格却必然被截断」的
 *   两套数字）；单文件 ≤ 2MB 才读摘要（更大的只记元数据）；索引文件 ≤ 30MB；
 *   跳过 `.git`、`node_modules`、`dist`、`.next`、`.venv` 等目录。
 * - **谁在用**：右栏「文件目录」的搜索框（按文件名/路径/摘要匹配）。**agent 不用它**——
 *   agent 有自己的 glob/grep 工具，索引只是给人找文件用的本机缓存。
 */

/**
 * 条目上限 = 自动索引资格线（参考图：`自动索引文件数少于 50,000 的新文件夹`）。
 * 两个数**故意同一个**：若资格线高于条目上限，就会出现「够资格但必然被截断」的假承诺。
 */
export const INDEX_MAX_ENTRIES = 50_000;
export const INDEX_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const INDEX_MAX_INDEX_BYTES = 30 * 1024 * 1024;
export const INDEX_SUMMARY_CHARS = 200;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".kenfutwork",
  ".kenfutwork-data",
]);

/** 扩展名 → 语言标签（给界面上的小徽标用；认不出留空，不猜）。 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".swift": "swift",
  ".sql": "sql",
  ".sh": "shell",
  ".bash": "shell",
  ".ps1": "powershell",
  ".md": "markdown",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
};

export interface CodeIndexEntry {
  path: string;
  bytes: number;
  mtimeMs: number;
  language: string;
  /** 前 {@link INDEX_SUMMARY_CHARS} 字符（去掉换行折成空格，便于结果里单行展示）。 */
  summary: string;
}

export interface CodeIndexFile {
  taskId: string;
  root: string;
  /** 建索引的时刻（ISO）。 */
  builtAt: string;
  /** 上次扫描时的工作目录 mtime 参考值（仅用于展示）。 */
  entries: CodeIndexEntry[];
  /** 扫描时跳过的文件数（读失败/超限/二进制）。 */
  skipped: number;
  truncated: boolean;
}

export interface CodeIndexStats {
  files: number;
  bytes: number;
  builtAt: string;
  skipped: number;
  truncated: boolean;
  /** 索引文件本身的大小（字节）。 */
  indexBytes: number;
}

export interface CodeIndexSearchHit {
  path: string;
  bytes: number;
  language: string;
  summary: string;
  /** 命中的字段（文件名 / 路径 / 内容），界面按它排序与标注。 */
  matched: "name" | "path" | "content";
}

function languageOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0
    ? (LANGUAGE_BY_EXTENSION[path.slice(dot).toLowerCase()] ?? "")
    : "";
}

/** 二进制判定：前 8KB 里出现 NUL 即当二进制（与沙箱文件读取同一口径）。 */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

function summarize(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, INDEX_SUMMARY_CHARS);
}

/** 自动索引装不下这个目录：文件数达到 {@link INDEX_MAX_ENTRIES}（= 参考图的 50,000）。 */
export class IndexTooLargeError extends Error {
  readonly files = INDEX_MAX_ENTRIES;
  constructor(readonly root: string) {
    super(
      `这个工作目录的文件数达到 ${INDEX_MAX_ENTRIES.toLocaleString("en-US")} 上限，` +
        "按「索引新文件夹」的设置没有自动建索引。要建的话请到「设置 → 索引库」点「重建索引」" +
        "（超大目录只索引前一部分，界面会标注已截断）。",
    );
    this.name = "IndexTooLargeError";
  }
}

export interface CodeIndexStoreOptions {
  /** 索引根目录（默认 `<cwd>/.kenfutwork/index`）。测试注入临时目录。 */
  indexDir?: string;
  /**
   * 条目上限（默认 {@link INDEX_MAX_ENTRIES}）。**仅测试注入**：造 50,000 个文件不现实，
   * 用一个小数字才能验到「自动建超限拒绝」与「手动重建超限截断」两条分支。
   */
  entryLimit?: number;
}

export function createCodeIndexStore(options: CodeIndexStoreOptions = {}) {
  const indexDir = resolve(
    options.indexDir ?? join(process.cwd(), ".kenfutwork", "index"),
  );

  const fileFor = (taskId: string) =>
    join(indexDir, `${taskId.replace(/[^a-zA-Z0-9_-]/g, "-")}.json`);

  /** 读索引文件；不存在/坏 JSON 视为「没有索引」（下次重建）。 */
  const load = async (taskId: string): Promise<CodeIndexFile | null> => {
    const path = fileFor(taskId);
    if (!existsSync(path)) return null;
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as CodeIndexFile;
      return Array.isArray(parsed.entries) ? parsed : null;
    } catch {
      return null;
    }
  };

  /**
   * 建（或增量刷新）索引。
   * `previous` 存在时按 mtime+bytes 复用摘要，只有变化的条目重读内容。
   *
   * `autoOnly` = 这是「索引新文件夹」的**自动**路径：条目数达到上限时抛
   * {@link IndexTooLargeError} 并**不落盘**（不给用户留一份假装完整的索引）；
   * 手动「重建」不带这个标记，超限只截断（`truncated` 已在界面上标注）。
   */
  const build = async (
    taskId: string,
    root: string,
    previous?: CodeIndexFile | null,
    buildOptions: { autoOnly?: boolean; entryLimit?: number } = {},
  ): Promise<CodeIndexFile> => {
    const entryLimit =
      buildOptions.entryLimit ?? options.entryLimit ?? INDEX_MAX_ENTRIES;
    const startedAt = Date.now();
    const priorByPath = new Map(
      (previous?.entries ?? []).map((entry) => [entry.path, entry]),
    );
    const entries: CodeIndexEntry[] = [];
    let skipped = 0;
    let truncated = false;

    const walk = async (dir: string, relative: string): Promise<void> => {
      let children: Dirent[];
      try {
        children = (await readdir(dir, { withFileTypes: true })) as Dirent[];
      } catch {
        skipped += 1;
        return;
      }
      for (const child of children) {
        if (entries.length >= entryLimit) {
          // 自动路径：超限即拒绝（调用方转成可读说明），不写半截索引
          if (buildOptions.autoOnly) throw new IndexTooLargeError(root);
          truncated = true;
          return;
        }
        if (child.name.startsWith(".") && child.isDirectory()) continue;
        const childRelative = relative
          ? `${relative}/${child.name}`
          : child.name;
        const absolute = join(dir, child.name);
        if (child.isDirectory()) {
          if (SKIP_DIRS.has(child.name)) continue;
          await walk(absolute, childRelative);
          continue;
        }
        if (!child.isFile()) continue;
        let info: Stats;
        try {
          info = await stat(absolute);
        } catch {
          skipped += 1;
          continue;
        }
        const prior = priorByPath.get(childRelative);
        if (
          prior &&
          prior.mtimeMs === info.mtimeMs &&
          prior.bytes === info.size
        ) {
          entries.push(prior);
          continue;
        }
        // 文本文件才读摘要；二进制/超限照常入索引（无摘要），读失败才算 skipped
        let summary = "";
        if (info.size <= INDEX_MAX_FILE_BYTES) {
          try {
            const buffer = await readFile(absolute);
            if (!looksBinary(buffer)) {
              summary = summarize(buffer.toString("utf8"));
            }
          } catch {
            skipped += 1;
          }
        }
        entries.push({
          path: childRelative,
          bytes: info.size,
          mtimeMs: info.mtimeMs,
          language: languageOf(childRelative),
          summary,
        });
      }
    };

    await walk(root, "");
    const index: CodeIndexFile = {
      taskId,
      root,
      builtAt: new Date(startedAt).toISOString(),
      entries,
      skipped,
      truncated,
    };
    await mkdir(indexDir, { recursive: true });
    const payload = JSON.stringify(index);
    if (Buffer.byteLength(payload, "utf8") <= INDEX_MAX_INDEX_BYTES) {
      await writeFile(fileFor(taskId), payload, "utf8");
    } else {
      // 索引本身超上限：去掉摘要再存（元数据比摘要重要，搜索仍可按名字/路径）
      const slim: CodeIndexFile = {
        ...index,
        truncated: true,
        entries: entries.map((entry) => ({ ...entry, summary: "" })),
      };
      await writeFile(fileFor(taskId), JSON.stringify(slim), "utf8");
    }
    return index;
  };

  /**
   * 拿索引：有就直接用；没有就按「索引新文件夹」的设置建一份。
   *
   * `auto` = 允许自动建（设置里那一行开着）。关着时**不建**，返回 null 让调用方
   * 如实告诉用户「没有索引，请手动重建」——不偷偷建，也不假装搜过。
   */
  const ensure = async (
    taskId: string,
    root: string,
    ensureOptions: { auto?: boolean } = {},
  ): Promise<CodeIndexFile | null> => {
    const existing = await load(taskId);
    if (existing) return existing;
    if (!ensureOptions.auto) return null;
    return build(taskId, root, null, { autoOnly: true });
  };

  const rebuild = async (taskId: string, root: string) =>
    build(taskId, root, await load(taskId));

  const clear = async (taskId: string): Promise<void> => {
    await rm(fileFor(taskId), { force: true });
  };

  const stats = async (
    index: CodeIndexFile | null,
  ): Promise<CodeIndexStats | null> => {
    if (!index) return null;
    let indexBytes = 0;
    try {
      indexBytes = (await stat(fileFor(index.taskId))).size;
    } catch {
      indexBytes = 0;
    }
    return {
      files: index.entries.length,
      bytes: index.entries.reduce((sum, entry) => sum + entry.bytes, 0),
      builtAt: index.builtAt,
      skipped: index.skipped,
      truncated: index.truncated,
      indexBytes,
    };
  };

  /**
   * 搜索：文件名 > 路径 > 摘要，各档内按路径排序（界面按这个顺序列）。
   * `limit` 截断（默认 50）。
   */
  const search = (
    index: CodeIndexFile,
    query: string,
    limit = 50,
  ): CodeIndexSearchHit[] => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const hits: CodeIndexSearchHit[] = [];
    for (const entry of index.entries) {
      const path = entry.path.toLowerCase();
      const name = path.slice(path.lastIndexOf("/") + 1);
      const matched: CodeIndexSearchHit["matched"] | null = name.includes(
        needle,
      )
        ? "name"
        : path.includes(needle)
          ? "path"
          : entry.summary.toLowerCase().includes(needle)
            ? "content"
            : null;
      if (!matched) continue;
      hits.push({
        path: entry.path,
        bytes: entry.bytes,
        language: entry.language,
        summary: entry.summary,
        matched,
      });
    }
    const rank: Record<CodeIndexSearchHit["matched"], number> = {
      name: 0,
      path: 1,
      content: 2,
    };
    return hits
      .sort(
        (a, b) =>
          rank[a.matched] - rank[b.matched] || a.path.localeCompare(b.path),
      )
      .slice(0, limit);
  };

  return { load, build, ensure, rebuild, clear, stats, search };
}

export type CodeIndexStore = ReturnType<typeof createCodeIndexStore>;
