import { randomUUID } from "node:crypto";
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

export interface ProjectMemoryService {
  /** 记忆开关的当前事实（读实例偏好，缺省关闭）。 */
  isEnabled(instanceId: string): Promise<boolean>;
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
}): ProjectMemoryService {
  const projectsRoot = join(options.dataDir, "memories", "projects");

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
    };
  };

  const isEnabled = async (instanceId: string) => {
    const preferences = await readPreferences(instanceId);
    // memoryEnabled 缺省 false：没有显式打开就不把记忆注入上下文。
    return preferences.memoryEnabled === true;
  };

  return {
    memoryDirectory,

    isEnabled,

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
      return { fileName, path: filePath, indexUpdated: true };
    },
  };
}
