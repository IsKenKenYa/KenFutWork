import type { LocalActor } from "../local-instance/types.js";
import type { ProjectMemoryService } from "./project-memory.js";

/**
 * 记忆服务的宿主 RPC 入口（原 `memory` 通道）。
 *
 * 只承接原设置页用到的两个只读方法；写入走 `memory_save` 工具，避免给界面
 * 开启任意写记忆的入口。参数校验与路径校验失败直接抛错，错误文本原样到达设置页。
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
      throw new Error(`记忆服务不支持方法：${method}`);
    },
  };
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
