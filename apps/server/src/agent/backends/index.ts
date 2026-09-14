import type { AnyBackendProtocol, BackendRuntime } from "deepagents";

import type { ServerEnv } from "../../config/env.js";
import { createDevelopmentBackend } from "./dev.js";
import { createProductionBackendFactory } from "./prod.js";

type AgentBackendEnv = Pick<
  ServerEnv,
  "agentBackendMode" | "agentFilesRoot" | "skillsRoot"
>;

// deepagents ≥1.13: backend 工厂为同步签名，返回 BackendProtocolV2 兼容实例
export type AgentBackendFactory = (
  runtime: BackendRuntime,
) => AnyBackendProtocol;

export type AgentBackendResult = {
  factory: AgentBackendFactory;
  sandboxDir?: string;
  /**
   * 沙箱目录是否随 run 结束清理。dev（filesystem 模式）为 per-run 目录 → true；
   * prod（state 模式）为 per-canvas 持久工作区 → false（文件跨 run 保留）。
   */
  ephemeral: boolean;
};

export function createAgentBackend(
  env: AgentBackendEnv,
  canvasId?: string,
  options?: { hasWorkspaceSkills?: boolean },
): AgentBackendResult {
  if (env.agentBackendMode === "filesystem") {
    return createDevelopmentBackend(env, {
      ...(canvasId != null ? { canvasId } : {}),
      ...(options?.hasWorkspaceSkills ? { hasWorkspaceSkills: true } : {}),
    });
  }

  if (!canvasId) {
    throw new Error(
      "canvasId is required for production (state) backend mode. " +
        "Each agent run must be scoped to a project.",
    );
  }

  return createProductionBackendFactory(canvasId, {
    ...(env.skillsRoot ? { skillsRoot: env.skillsRoot } : {}),
    ...(options?.hasWorkspaceSkills ? { hasWorkspaceSkills: true } : {}),
  });
}
