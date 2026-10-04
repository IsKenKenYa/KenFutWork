import { realpathSync, statSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { AdditionalDirectory } from "@kenfutwork/shared";
import type { CanvasRepository } from "../canvas/repository.js";
import { createCanvasRepository } from "../canvas/repository.js";
import type { PersistenceService } from "../persistence/types.js";
import type { ProjectRepository } from "./repository.js";
import { createProjectRepository } from "./repository.js";

/**
 * 项目工作目录（`projects.work_dir`）的**唯一**校验与读取处。
 *
 * 为什么单独抽出来：这个值有三个消费者——agent 后端（文件工具与 execute 的 cwd）、
 * 终端/git（同一目录）、索引库（索引里记的路径）。判定若各写一份，「agent 写在 A、
 * git 操作 B」就会静默发生（本项目已有一次文件系统割裂的历史事故）。
 *
 * 与 `agent/sandbox-dir.ts` 的分工：那边决定「用不用绑定目录、拼接规则是什么」，
 * 这边只负责「用户填的路径是不是能用」与「哪个画布绑了哪个目录」。
 */

/** 校验结果：不可用时带**可读原因**（界面直接显示，不吞成「失败」）。 */
export type WorkDirValidation =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * 绝对路径判定（**跨平台**，不依赖 host 的 path 模块）。
 *
 * 接受三种写法：POSIX 绝对 `/home/me/app`、Windows 盘符 `D:\…` / `D:/…`、
 * UNC `\\server\share`。相对路径一律拒绝——相对路径会按服务进程的 cwd 解析，
 * 用户根本不知道文件落到哪去了。
 */
export function isAbsoluteWorkDir(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (value.includes("\0")) return false;
  if (value.startsWith("/")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  return value.startsWith("\\\\") || value.startsWith("//");
}

/**
 * 校验一个用户填的工作目录。**同步**做完全部判定（服务端在这里只是 stat 一次，
 * 调用点都是请求处理路径，异步化没有收益）。
 */
export function validateWorkDir(raw: string): WorkDirValidation {
  const value = raw.trim();
  if (!value) {
    return { ok: false, reason: "工作目录不能为空。" };
  }
  if (!isAbsoluteWorkDir(value)) {
    return {
      ok: false,
      reason: `「${value}」不是绝对路径。请填完整路径（如 D:\\Desktop\\test 或 /home/me/app）——相对路径会按服务进程的当前目录解析，文件会落到你预期之外的地方。`,
    };
  }

  // 用 host 的 path 模块归一化：盘符大小写、分隔符、`.`/`..` 都收干净再入库，
  // 避免同目录出现两种拼写（后续相等比较、索引缓存键都依赖这一点）。
  const normalized = normalizeWorkDir(value);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(normalized);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return {
        ok: false,
        reason: `目录不存在：${normalized}（服务端读的是本机文件系统，请确认路径拼写，且它在运行服务的这台机器上）。`,
      };
    }
    if (code === "EACCES" || code === "EPERM") {
      return {
        ok: false,
        reason: `没有权限访问：${normalized}。请换一个有读权限的目录，或调整该目录的权限。`,
      };
    }
    return {
      ok: false,
      reason: `无法访问目录 ${normalized}：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!stats.isDirectory()) {
    return {
      ok: false,
      reason: `${normalized} 不是目录（是一个文件）。工作目录必须是文件夹。`,
    };
  }

  return { ok: true, path: realpathSync(normalized) };
}

/** Code 项目默认目录由服务端身份稳定生成；显式目录不可吞错换落点。 */
export async function resolveProjectWorkDirectory(input: {
  workspaceId: string;
  projectId: string;
  sandboxRoot: string;
  workDir?: string | null | undefined;
}): Promise<string> {
  if (input.workDir) {
    const verdict = validateWorkDir(input.workDir);
    if (!verdict.ok) throw new Error(verdict.reason);
    return verdict.path;
  }
  const directory = resolve(input.sandboxRoot, input.workspaceId, input.projectId);
  await mkdir(directory, { recursive: true });
  return realpath(directory);
}

export function normalizeAdditionalDirectories(directories: AdditionalDirectory[]): AdditionalDirectory[] {
  return directories.map((directory) => {
    const verdict = validateWorkDir(directory.path);
    if (!verdict.ok) throw new Error(verdict.reason);
    return { path: verdict.path, access: directory.access };
  });
}

/** 归一化（仅用于已通过 `isAbsoluteWorkDir` 的值）。 */
export function normalizeWorkDir(raw: string): string {
  return resolve(raw.trim());
}

/**
 * 画布 → 绑定工作目录（agent 运行时用：它手里只有 canvasId）。
 *
 * 读不到（画布不属于任何工作区、项目未绑定、查询失败）一律返回 null：工作目录是
 * **增强**而不是前置条件，读数失败不该让整轮 run 失败——回落到沙箱目录即可。
 */
export function createProjectWorkDirLoader(options: {
  canvases: Pick<CanvasRepository, "findWorkspaceIdByCanvas">;
  projects: Pick<ProjectRepository, "findWorkDirByCanvas">;
}): (canvasId: string) => Promise<string | null> {
  return async (canvasId) => {
    const workspaceId = await options.canvases
      .findWorkspaceIdByCanvas(canvasId)
      .catch(() => null);
    if (!workspaceId) return null;
    return options.projects
      .findWorkDirByCanvas(workspaceId, canvasId)
      .catch(() => null);
  };
}

/**
 * 从 persistence 直接装配加载器——插件里的统一入口。
 *
 * 有 5 个消费点（agent 运行时、git/终端、技能包导入、插件安装、MCP 脚本注册）都要这份
 * 判定，各写一遍 `createCanvasRepository + createProjectRepository` 只是重复；判定逻辑
 * 仍然只有上面一处（谁也不会各自去读 work_dir）。
 */
export function projectWorkDirLoaderFor(
  persistence: PersistenceService,
): (canvasId: string) => Promise<string | null> {
  return createProjectWorkDirLoader({
    canvases: createCanvasRepository(persistence),
    projects: createProjectRepository(persistence),
  });
}
