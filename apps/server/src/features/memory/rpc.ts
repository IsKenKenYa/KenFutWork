import type { LocalActor } from "../local-instance/types.js";
import type { ProjectMemoryService } from "./project-memory.js";

/**
 * 记忆服务的宿主 RPC 入口（原 `memory` 通道）。
 *
 * 设置页只读目录、回收区列表与回收区恢复三个方法；写入正文仍走 `memory_save` 工具，
 * 不给界面开启任意写记忆的入口。参数校验与路径校验失败直接抛错，错误文本原样到达设置页。
 */
export interface ProjectMemoryRpc {
  call(
    actor: LocalActor,
    method: string,
    args: unknown[],
  ): Promise<{ result: unknown }>;
}

export function createProjectMemoryRpc(
  memory: ProjectMemoryService,
): ProjectMemoryRpc {
  return {
    async call(actor: LocalActor, method: string, args: unknown[]) {
      if (method === "listProjectMemories")
        return { result: await memory.listProjectMemories(actor) };
      if (method === "readProjectMemoryFile") {
        const input = readFileArgs(args[0]);
        return { result: await memory.readProjectMemoryFile(actor, input) };
      }
      if (method === "listTrashedMemories") {
        const entries = await memory.listTrashedMemories(
          actor,
          readProjectArgs(args[0]),
        );
        return {
          result: entries.map(({ id, ...entry }) => ({
            trashId: id,
            ...entry,
          })),
        };
      }
      if (method === "restoreTrashedMemory") {
        return {
          result: await memory.restoreTrashedMemory(
            actor,
            readRestoreArgs(args[0]),
          ),
        };
      }
      throw new Error(`记忆服务不支持方法：${method}`);
    },
  };
}

function readProjectArgs(value: unknown): { projectId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("记忆项目参数无效。");
  const input = value as { projectId?: unknown };
  if (typeof input.projectId !== "string" || !input.projectId.trim())
    throw new Error("记忆项目参数无效。");
  return { projectId: input.projectId.trim() };
}

function readRestoreArgs(value: unknown): {
  projectId: string;
  trashId: string;
} {
  const project = readProjectArgs(value);
  const input = value as { trashId?: unknown };
  if (typeof input.trashId !== "string" || !input.trashId.trim())
    throw new Error("回收项参数无效。");
  return { ...project, trashId: input.trashId.trim() };
}

function readFileArgs(value: unknown): {
  workspaceId: string;
  fileName: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("记忆文件参数无效。");
  const input = value as { workspaceId?: unknown; fileName?: unknown };
  if (
    typeof input.workspaceId !== "string" ||
    typeof input.fileName !== "string" ||
    !input.workspaceId.trim() ||
    !input.fileName.trim()
  )
    throw new Error("记忆文件参数无效。");
  return {
    workspaceId: input.workspaceId.trim(),
    fileName: input.fileName.trim(),
  };
}
