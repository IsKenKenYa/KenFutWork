import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

import type { SettingsService } from "../settings/settings-service.js";
import type { LocalActor } from "../local-instance/types.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import type { ProjectService } from "../projects/project-service.js";
import type { CodeUiRepository } from "../code-ui/repository.js";
import type { CanvasService } from "../canvas/canvas-service.js";
import type { AgentPersistenceService } from "../../agent/persistence/index.js";
import {
  listTrashEntries,
  maintainMemoryDirectory,
  restoreTrashEntry,
  type MemoryMaintenanceResult,
  type MemoryTrashEntry,
} from "./memory-maintenance.js";

const MEMORY_INDEX_FILE_NAME = "MEMORY.md";
const MEMORY_DIRECTORY_NAME = "memory";

export interface ProjectMemoryFileSummary {
  name: string;
  /** 已校验并限制在记忆根目录内的绝对路径（设置页「用编辑器打开」直接用）。 */
  path: string;
  kind: "index" | "item";
  size: number;
  updatedAt: number;
}

export interface ProjectMemoryWorkspaceSummary {
  id: string;
  label: string;
  updatedAt: number;
  files: ProjectMemoryFileSummary[];
}

/** 一次记忆搜索的结果；`truncated` 为 true 时还有命中没装进输出。 */
export interface ProjectMemorySearchResult {
  query: string;
  matches: Array<{ fileName: string; title: string; snippet: string }>;
  truncated: boolean;
}

/** 设置页回收区的一行：除条目本身外给出可恢复判定，避免界面自己算窗口。 */
export interface ProjectMemoryTrashItem extends MemoryTrashEntry {
  restorable: boolean;
}

export interface ProjectMemoryService {
  /** 记忆开关的当前事实（读实例偏好，缺省关闭）。 */
  isEnabled(instanceId: string): Promise<boolean>;
  /** 在项目记忆里按关键词查找正文与索引，供模型召回旧结论。 */
  searchMemories(
    actor: LocalActor,
    input: { projectId: string; query: string },
  ): Promise<ProjectMemorySearchResult>;
  listProjectMemories(
    actor: LocalActor,
  ): Promise<ProjectMemoryWorkspaceSummary[]>;
  readProjectMemoryFile(
    actor: LocalActor,
    input: { workspaceId: string; fileName: string },
  ): Promise<{ content: string; updatedAt: number }>;
  /** 系统提示段用的索引正文；未开启或没有索引时返回 null。 */
  readIndex(
    instanceId: string,
    projectId: string,
  ): Promise<string | null>;
  /** 记忆目录（系统提示段指路用）。 */
  memoryDirectory(projectId: string): string;
  /** 把一条记忆写成独立文件并在 MEMORY.md 追加一行索引。 */
  saveMemory(
    actor: LocalActor,
    input: { projectId: string; title: string; content: string },
  ): Promise<{ fileName: string; path: string; indexUpdated: boolean }>;
  /**
   * 解析本次运行的记忆归属：Code 直接用 Task 句柄的项目 id；Design 没有 Task
   * 句柄时经画布 id 映射到所属项目。画布不存在、越权或不属于同一项目时拒绝。
   */
  resolveProjectId(
    actor: LocalActor,
    input: { projectId?: string | undefined; canvasId?: string | undefined },
  ): Promise<string | null>;
  /**
   * 旧 Design 记忆通道 `/memories/`（画布级 StoreBackend）迁移到项目记忆目录。
   * 迁移幂等：同名文件不覆盖，索引行去重，完成后写画布级标记避免每轮重复扫描。
   */
  migrateLegacyCanvasMemory(
    actor: LocalActor,
    input: { projectId: string; canvasId: string },
  ): Promise<{ migrated: number }>;
  /**
   * 整理项目记忆：合并重复正文、清理索引悬挂行、把闲置超期的孤儿正文移入回收区，
   * 并清除超过可恢复窗口的回收项。被索引引用的条目不会自动删除。
   */
  maintainProjectMemory(
    actor: LocalActor,
    input: { projectId: string },
  ): Promise<MemoryMaintenanceResult>;
  /** 回收区里的条目；窗口内的可恢复，过窗口的仍列出但标记不可恢复。 */
  listTrashedMemories(
    actor: LocalActor,
    input: { projectId: string },
  ): Promise<ProjectMemoryTrashItem[]>;
  /** 把回收区条目恢复到记忆目录；正文同名时自动加后缀，索引行去重追加。 */
  restoreTrashedMemory(
    actor: LocalActor,
    input: { projectId: string; trashId: string },
  ): Promise<{ fileName: string | null }>;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isPlainDirectory(metadata: {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): boolean {
  return metadata.isDirectory() && !metadata.isSymbolicLink();
}

function isValidPathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    basename(value) === value &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function isMemoryFileName(fileName: string): boolean {
  return fileName === MEMORY_INDEX_FILE_NAME || fileName.endsWith(".md");
}

/** 旧 StoreBackend 的 FileData 正文：v1 是行数组，v2 是字符串。 */
function legacyText(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const content = (value as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (
    Array.isArray(content) &&
    content.every((line) => typeof line === "string")
  )
    return content.join("\n");
  return null;
}

/** 旧通道键 `/memories/notes/a.md` → 扁平文件名 `notes-a.md`。 */
function flattenLegacyFileName(relativePath: string): string | null {
  const flat = relativePath.split("/").join("-");
  if (!isValidPathSegment(flat) || !flat.endsWith(".md")) return null;
  return flat;
}

async function requirePlainFile(filePath: string): Promise<number> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`记忆文件不是普通文件：${filePath}`);
  return metadata.size;
}

async function assertContained(root: string, target: string): Promise<void> {
  const rootReal = await realpath(root);
  const targetReal = await realpath(target);
  const relativePath = relative(rootReal, targetReal);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    throw new Error(`记忆文件路径越出了记忆目录：${target}`);
}

function memorySlug(title: string): string {
  const slug = title
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60);
  return slug || "memory";
}

function indexHook(content: string): string {
  const firstLine =
    content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  return firstLine.slice(0, 120);
}

/**
 * 项目长期记忆（对齐 ZCode 项目记忆的文件形状）：
 * - 每个项目一个记忆目录，`MEMORY.md` 是一行一条的索引，主题正文各占一个 `.md`；
 * - 目录在应用数据目录下（不写用户工作目录），由服务端按项目 id 归属；
 * - 开关来自实例偏好 `memoryEnabled`，关闭时提示段与写入工具都不参与。
 */
export function createProjectMemoryService(options: {
  /** 应用数据目录（`resolveDesktopDataDir` 的结果）。 */
  dataDir: string;
  projects: Pick<ProjectService, "listProjects">;
  localInstance: Pick<LocalInstanceService, "resolve">;
  preferences: Pick<CodeUiRepository, "readHumanPreferences">;
  settings: Pick<SettingsService, "getInstanceSettings">;
  /** Design 记忆归属：画布 → 项目映射与越权校验的唯一来源。 */
  canvases: Pick<CanvasService, "getCanvas">;
  /** 旧 `/memories/` 通道的存储；未配置 Postgres 时是进程内 store。 */
  agentPersistence: Pick<AgentPersistenceService, "getPersistence">;
  /** 整理与回收的时间源；测试注入固定时钟。 */
  now?: () => number;
}): ProjectMemoryService {
  const projectsRoot = join(options.dataDir, "memories", "projects");
  const clock = options.now ?? Date.now;

  const memoryDirectory = (projectId: string) =>
    join(projectsRoot, projectId, MEMORY_DIRECTORY_NAME);

  const readPreferences = async (instanceId: string) =>
    options.preferences.readHumanPreferences(instanceId);

  const readLimits = async (actor: LocalActor) => {
    const instance = await options.localInstance.resolve(actor);
    const settings = await options.settings.getInstanceSettings(
      actor,
      instance.instanceId,
    );
    return {
      maxFileBytes: settings.codeReadMaxBytes,
      orphanRetentionDays: settings.memoryOrphanRetentionDays,
      recoverableWindowDays: settings.memoryRecoverableWindowDays,
    };
  };

  const isEnabled = async (instanceId: string) => {
    const preferences = await readPreferences(instanceId);
    // memoryEnabled 缺省 false：没有显式打开就不把记忆注入上下文。
    return preferences.memoryEnabled === true;
  };

  const requireMemoryEnabled = async (actor: LocalActor) => {
    const instance = await options.localInstance.resolve(actor);
    if (!(await isEnabled(instance.instanceId)))
      throw new Error("记忆功能已关闭，请先在设置里打开。");
  };

  const maintainProject = async (
    actor: LocalActor,
    projectId: string,
  ): Promise<MemoryMaintenanceResult> => {
    await requireMemoryEnabled(actor);
    if (!isValidPathSegment(projectId))
      throw new Error("项目标识无效。");
    const limits = await readLimits(actor);
    return maintainMemoryDirectory({
      memoryRoot: memoryDirectory(projectId),
      now: clock(),
      orphanRetentionDays: limits.orphanRetentionDays,
      recoverableWindowDays: limits.recoverableWindowDays,
      maxFileBytes: limits.maxFileBytes,
    });
  };

  return {
    memoryDirectory,

    isEnabled,

    async resolveProjectId(actor, input) {
      if (input.projectId) return input.projectId;
      if (!input.canvasId) return null;
      if (!isValidPathSegment(input.canvasId))
        throw new Error("画布标识无效。");
      const canvas = await options.canvases.getCanvas(actor, input.canvasId);
      if (!isValidPathSegment(canvas.projectId))
        throw new Error("画布所属项目标识无效。");
      return canvas.projectId;
    },

    async migrateLegacyCanvasMemory(actor, input) {
      if (
        !isValidPathSegment(input.projectId) ||
        !isValidPathSegment(input.canvasId)
      )
        throw new Error("画布或项目标识无效。");
      // 归属校验同时拒绝已删除画布（服务按 actor 取不到记录即抛错）。
      const canvas = await options.canvases.getCanvas(actor, input.canvasId);
      if (canvas.projectId !== input.projectId)
        throw new Error("画布不属于该项目的记忆。");
      const persistence = await options.agentPersistence.getPersistence();
      if (!persistence) return { migrated: 0 };

      // 旧通道键是画布级绝对路径（`/memories/...`），namespace 与后端同一处。
      const namespace = ["projects", input.canvasId, "memories"];
      const items: Array<{ key: string; value: unknown }> = [];
      const pageSize = 100;
      for (let offset = 0; ; offset += pageSize) {
        const page = (await persistence.store.search(namespace, {
          limit: pageSize,
          offset,
        })) as Array<{ key: string; value: unknown }>;
        if (page.length === 0) break;
        items.push(...page);
        if (page.length < pageSize) break;
      }

      const files: Array<{ key: string; fileName: string; content: string }> = [];
      const legacyIndexLines: string[] = [];
      for (const item of items) {
        if (!item.key.startsWith("/memories/")) continue;
        const content = legacyText(item.value);
        if (content === null || content.trim().length === 0) continue;
        const relativePath = item.key.slice("/memories/".length);
        if (relativePath === MEMORY_INDEX_FILE_NAME) {
          legacyIndexLines.push(
            ...content
              .split(/\r?\n/u)
              .map((line) => line.trim())
              .filter((line) => line.length > 0),
          );
          continue;
        }
        const fileName = flattenLegacyFileName(relativePath);
        if (!fileName) continue;
        files.push({ key: item.key, fileName, content });
      }
      if (files.length === 0 && legacyIndexLines.length === 0)
        return { migrated: 0 };

      const memoryRoot = memoryDirectory(input.projectId);
      await mkdir(memoryRoot, { recursive: true });
      const limits = await readLimits(actor);
      const indexPath = join(memoryRoot, MEMORY_INDEX_FILE_NAME);
      const existingIndex = await readFile(indexPath, "utf8").catch(
        (error: unknown) => {
          if (isNotFound(error)) return "";
          throw error;
        },
      );
      const knownLines = new Set(
        existingIndex
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      );
      const referencedFiles = new Set(
        [...knownLines]
          .map((line) => line.match(/\]\(([^)]+)\)/u)?.[1])
          .filter((name): name is string => typeof name === "string"),
      );
      // 迁移记录按「旧键 + 正文」指纹去重：同一旧文件重复扫描不再生成副本，
      // 旧通道后续新写的正文仍会被下一轮补进来。
      const markerPath = join(memoryRoot, `.legacy-${input.canvasId}.json`);
      const markerRaw = await readFile(markerPath, "utf8").catch(
        (error: unknown) => {
          if (isNotFound(error)) return "";
          throw error;
        },
      );
      const records: Array<{ fingerprint: string; fileName: string }> =
        markerRaw === ""
          ? []
          : (JSON.parse(markerRaw) as Array<{
              fingerprint: string;
              fileName: string;
            }>);
      const byFingerprint = new Map(
        records.map((record) => [record.fingerprint, record.fileName]),
      );
      const existingNames = new Set(
        (await readdir(memoryRoot, { withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name),
      );
      const additions: string[] = [];
      let migrated = 0;
      let recordsChanged = false;

      for (const file of files) {
        const fingerprint = createHash("sha256")
          .update(`${file.key}\u0000${file.content}`)
          .digest("hex");
        const base = file.fileName.replace(/\.md$/u, "");
        let targetName = byFingerprint.get(fingerprint);
        let mustWrite = false;
        if (!targetName) {
          // 不覆盖新通道已写下的同名文件；冲突时改名保留旧正文。
          targetName = file.fileName;
          for (let suffix = 2; ; suffix += 1) {
            if (!existingNames.has(targetName)) break;
            targetName =
              suffix === 2
                ? `${base}-legacy.md`
                : `${base}-legacy-${suffix}.md`;
          }
          existingNames.add(targetName);
          byFingerprint.set(fingerprint, targetName);
          records.push({ fingerprint, fileName: targetName });
          recordsChanged = true;
          mustWrite = true;
        } else if (!existingNames.has(targetName)) {
          // 迁移记录在但正文被删：按记录恢复，避免旧数据静默缺失。
          mustWrite = true;
        }
        if (mustWrite) {
          await writeFile(
            join(memoryRoot, targetName),
            `${file.content}\n`,
            "utf8",
          );
          existingNames.add(targetName);
          migrated += 1;
        }
        if (!referencedFiles.has(targetName)) {
          additions.push(
            `- [旧记忆：${base}](${targetName}) — ${indexHook(file.content)}`,
          );
          referencedFiles.add(targetName);
        }
      }

      for (const line of legacyIndexLines) {
        if (knownLines.has(line)) continue;
        additions.push(line);
        knownLines.add(line);
      }
      if (additions.length > 0) {
        const prefix =
          existingIndex === "" || existingIndex.endsWith("\n")
            ? existingIndex
            : `${existingIndex}\n`;
        const nextIndex = `${prefix}${additions.join("\n")}\n`;
        // 索引超限时只保留正文文件；正文不丢，设置页仍能列出。
        if (Buffer.byteLength(nextIndex, "utf8") <= limits.maxFileBytes)
          await writeFile(indexPath, nextIndex, "utf8");
      }
      if (recordsChanged)
        await writeFile(
          markerPath,
          `${JSON.stringify(records, null, 2)}\n`,
          "utf8",
        );
      return { migrated };
    },

    maintainProjectMemory(actor, input) {
      return maintainProject(actor, input.projectId);
    },

    async listTrashedMemories(actor, input) {
      await requireMemoryEnabled(actor);
      if (!isValidPathSegment(input.projectId))
        throw new Error("项目标识无效。");
      const limits = await readLimits(actor);
      const entries = await listTrashEntries(memoryDirectory(input.projectId));
      const now = clock();
      return entries.map((entry) => ({
        ...entry,
        restorable:
          now - entry.trashedAt <= limits.recoverableWindowDays * 24 * 60 * 60 * 1000,
      }));
    },

    async restoreTrashedMemory(actor, input) {
      await requireMemoryEnabled(actor);
      if (!isValidPathSegment(input.projectId))
        throw new Error("项目标识无效。");
      const limits = await readLimits(actor);
      return restoreTrashEntry({
        memoryRoot: memoryDirectory(input.projectId),
        trashId: input.trashId,
        recoverableWindowDays: limits.recoverableWindowDays,
        now: clock(),
        maxFileBytes: limits.maxFileBytes,
      });
    },

    async listProjectMemories(actor) {
      const rootMetadata = await lstat(projectsRoot).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (!rootMetadata) return [];
      if (!isPlainDirectory(rootMetadata))
        throw new Error("记忆根目录不是普通目录，已停止读取。");

      const projects = await options.projects.listProjects(actor);
      const labelById = new Map(
        projects.map((project) => [project.id, project.name]),
      );
      const entries = await readdir(projectsRoot, { withFileTypes: true });
      const workspaces: ProjectMemoryWorkspaceSummary[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (!isValidPathSegment(entry.name)) continue;
        const memoryRoot = join(projectsRoot, entry.name, MEMORY_DIRECTORY_NAME);
        const memoryMetadata = await lstat(memoryRoot).catch(
          (error: unknown) => {
            if (isNotFound(error)) return null;
            throw error;
          },
        );
        if (!memoryMetadata || !isPlainDirectory(memoryMetadata)) continue;

        const files: ProjectMemoryFileSummary[] = [];
        for (const file of await readdir(memoryRoot, {
          withFileTypes: true,
        })) {
          if (file.isSymbolicLink() || !file.isFile()) continue;
          if (!isMemoryFileName(file.name)) continue;
          const filePath = join(memoryRoot, file.name);
          const metadata = await lstat(filePath);
          if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
          files.push({
            name: file.name,
            path: filePath,
            kind:
              file.name === MEMORY_INDEX_FILE_NAME ? "index" : "item",
            size: metadata.size,
            updatedAt: metadata.mtimeMs,
          });
        }
        if (files.length === 0) continue;
        files.sort((left, right) =>
          left.kind === right.kind
            ? left.name.localeCompare(right.name, "en")
            : left.kind === "index"
              ? -1
              : 1,
        );
        workspaces.push({
          id: entry.name,
          label: labelById.get(entry.name) ?? entry.name,
          updatedAt: Math.max(...files.map((file) => file.updatedAt)),
          files,
        });
      }
      workspaces.sort(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          left.id.localeCompare(right.id, "en"),
      );
      return workspaces;
    },

    async readProjectMemoryFile(actor, input) {
      if (
        !isValidPathSegment(input.workspaceId) ||
        !isValidPathSegment(input.fileName) ||
        !isMemoryFileName(input.fileName)
      )
        throw new Error("记忆文件路径无效。");
      const instance = await options.localInstance.resolve(actor);
      if (!(await isEnabled(instance.instanceId)))
        throw new Error("记忆功能已关闭，请先在设置里打开。");
      const limits = await readLimits(actor);

      const memoryRoot = join(
        projectsRoot,
        input.workspaceId,
        MEMORY_DIRECTORY_NAME,
      );
      const rootMetadata = await lstat(memoryRoot);
      if (!isPlainDirectory(rootMetadata))
        throw new Error("记忆目录不是普通目录。");
      // 大小写不敏感文件系统上按名字找一遍，避免命中不同大小写的文件。
      const matched = (
        await readdir(memoryRoot, { withFileTypes: true })
      ).find((entry) => entry.name === input.fileName);
      const filePath = join(memoryRoot, input.fileName);
      if (!matched) {
        await lstat(filePath).catch((error: unknown) => {
          if (isNotFound(error)) throw new Error("记忆文件不存在。");
          throw error;
        });
        throw new Error("记忆文件名大小写不匹配。");
      }
      const size = await requirePlainFile(filePath);
      if (size > limits.maxFileBytes)
        throw new Error("记忆文件超过可读取大小，请改用编辑器打开。");
      await assertContained(projectsRoot, filePath);
      const content = await readFile(filePath, "utf8");
      const metadata = await lstat(filePath);
      return { content, updatedAt: metadata.mtimeMs };
    },

    async searchMemories(actor, input) {
      const instance = await options.localInstance.resolve(actor);
      if (!(await isEnabled(instance.instanceId)))
        throw new Error("记忆功能已关闭，请先在设置里打开。");
      if (!isValidPathSegment(input.projectId))
        throw new Error("项目标识无效。");
      const query = input.query.trim();
      if (!query) throw new Error("搜索词不能为空。");
      const terms = query
        .toLocaleLowerCase()
        .split(/\s+/u)
        .filter((term) => term.length > 0);
      const settings = await options.settings.getInstanceSettings(
        actor,
        instance.instanceId,
      );
      const memoryRoot = memoryDirectory(input.projectId);
      const entries = await readdir(memoryRoot, { withFileTypes: true }).catch(
        (error: unknown) => {
          if (isNotFound(error)) return [];
          throw error;
        },
      );
      const files = entries
        .filter(
          (entry) =>
            entry.isFile() &&
            !entry.isSymbolicLink() &&
            isMemoryFileName(entry.name),
        )
        .map((entry) => entry.name)
        .sort((left, right) =>
          left === MEMORY_INDEX_FILE_NAME
            ? -1
            : right === MEMORY_INDEX_FILE_NAME
              ? 1
              : left.localeCompare(right, "en"),
        );
      const titles = new Map<string, string>();
      const indexPath = join(memoryRoot, MEMORY_INDEX_FILE_NAME);
      const indexContent = files.includes(MEMORY_INDEX_FILE_NAME)
        ? await readFile(indexPath, "utf8").catch((error: unknown) => {
            if (isNotFound(error)) return "";
            throw error;
          })
        : "";
      for (const line of indexContent.split(/\r?\n/u)) {
        const matched = /^- \[(.+)\]\(([^)]+)\)/u.exec(line.trim());
        if (matched?.[1] && matched[2]) titles.set(matched[2], matched[1]);
      }

      const matches: ProjectMemorySearchResult["matches"] = [];
      let used = 0;
      let truncated = false;
      for (const fileName of files) {
        if (truncated) break;
        const filePath = join(memoryRoot, fileName);
        const metadata = await lstat(filePath).catch((error: unknown) => {
          if (isNotFound(error)) return null;
          throw error;
        });
        if (!metadata) continue;
        if (metadata.size > settings.codeReadMaxBytes) {
          truncated = true;
          continue;
        }
        const content = await readFile(filePath, "utf8");
        const lines = content.split(/\r?\n/u);
        const title =
          titles.get(fileName) ??
          (fileName === MEMORY_INDEX_FILE_NAME
            ? "记忆索引"
            : fileName.replace(/\.md$/u, ""));
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const lower = trimmed.toLocaleLowerCase();
          if (!terms.every((term) => lower.includes(term))) continue;
          const remaining = settings.codeReadPageCharacters - used;
          if (remaining <= 0) {
            truncated = true;
            break;
          }
          const snippet =
            trimmed.length <= remaining ? trimmed : trimmed.slice(0, remaining);
          if (trimmed.length > remaining) truncated = true;
          matches.push({ fileName, title, snippet });
          used += snippet.length;
        }
      }
      return { query, matches, truncated };
    },

    async readIndex(instanceId, projectId) {
      if (!isValidPathSegment(projectId)) return null;
      if (!(await isEnabled(instanceId))) return null;
      const indexPath = join(memoryDirectory(projectId), MEMORY_INDEX_FILE_NAME);
      const metadata = await lstat(indexPath).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (!metadata) return null;
      await requirePlainFile(indexPath);
      await assertContained(projectsRoot, indexPath);
      const settings = await options.settings.getInstanceSettings(
        { instanceId, accessClientId: null },
        instanceId,
      );
      const content = await readFile(indexPath, "utf8");
      if (content.length <= settings.codeReadPageCharacters) return content;
      // 超长索引只截一段并如实说明；剩下部分让模型自己按需读文件。
      return `${content.slice(0, settings.codeReadPageCharacters)}
> 索引超过单次注入上限，以上为前 ${settings.codeReadPageCharacters} 个字符；需要其余条目时用编辑器或再次保存整理索引。`;
    },

    async saveMemory(actor, input) {
      const instance = await options.localInstance.resolve(actor);
      if (!(await isEnabled(instance.instanceId)))
        throw new Error("记忆功能已关闭，请先在设置里打开。");
      if (!isValidPathSegment(input.projectId))
        throw new Error("项目标识无效。");
      const title = input.title.trim();
      const content = input.content.trim();
      if (!title) throw new Error("记忆标题不能为空。");
      if (!content) throw new Error("记忆正文不能为空。");
      const limits = await readLimits(actor);
      if (Buffer.byteLength(content, "utf8") > limits.maxFileBytes)
        throw new Error("记忆正文超过可保存大小。");

      const memoryRoot = memoryDirectory(input.projectId);
      await mkdir(memoryRoot, { recursive: true });
      const slug = memorySlug(title);
      let fileName = `${slug}.md`;
      for (let suffix = 2; ; suffix += 1) {
        const exists = await lstat(join(memoryRoot, fileName)).catch(
          (error: unknown) => {
            if (isNotFound(error)) return null;
            throw error;
          },
        );
        if (!exists) break;
        fileName = `${slug}-${suffix}.md`;
      }
      const filePath = join(memoryRoot, fileName);
      const temporary = join(memoryRoot, `.${fileName}.${randomUUID()}.tmp`);
      await writeFile(temporary, `${content}\n`, "utf8");
      await rename(temporary, filePath);

      const indexPath = join(memoryRoot, MEMORY_INDEX_FILE_NAME);
      const indexLine = `- [${title}](${fileName}) — ${indexHook(content)}\n`;
      const existingIndex = await readFile(indexPath, "utf8").catch(
        (error: unknown) => {
          if (isNotFound(error)) return "";
          throw error;
        },
      );
      const nextIndex = `${existingIndex}${existingIndex.endsWith("\n") || existingIndex === "" ? "" : "\n"}${indexLine}`;
      if (Buffer.byteLength(nextIndex, "utf8") > limits.maxFileBytes)
        throw new Error("记忆索引已满，请先整理 MEMORY.md。");
      await writeFile(indexPath, nextIndex, "utf8");
      // 提炼时机：每写入一条记忆后整理一次，合并重复正文并评估遗忘；失败不静默。
      await maintainProject(actor, input.projectId);
      return { fileName, path: filePath, indexUpdated: true };
    },
  };
}
