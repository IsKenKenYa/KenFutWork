import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AnyBackendProtocol,
  type BackendRuntime,
  CompositeBackend,
  FilesystemBackend,
  LocalShellBackend,
  StoreBackend,
} from "deepagents";

import type { ServerEnv } from "../../config/env.js";
import type { AgentBackendResult } from "./index.js";

type AgentBackendEnv = Pick<ServerEnv, "agentFilesRoot" | "skillsRoot">;

const DEFAULT_DEV_SANDBOX_ROOT = "/tmp/loomic-sandbox-dev";

/**
 * Create a development backend with local sandbox execution.
 *
 * Uses LocalShellBackend for code execution. The agent's workspace files
 * are stored locally at agentFilesRoot, and skills are loaded from skillsRoot.
 */
export function createDevelopmentBackend(
  env: AgentBackendEnv,
  options?: {
    /** Canvas ID — used for workspace-skills Store namespace when available. */
    canvasId?: string;
    /** When true, add a /workspace-skills/ route backed by the Store. */
    hasWorkspaceSkills?: boolean;
  },
): AgentBackendResult {
  if (!env.agentFilesRoot) {
    throw new Error(
      "LOOMIC_AGENT_FILES_ROOT must be set when filesystem backend mode is enabled.",
    );
  }

  const runId = crypto.randomUUID();
  const sandboxDir = join(resolve(DEFAULT_DEV_SANDBOX_ROOT), runId);
  mkdirSync(sandboxDir, { recursive: true });
  const realSandboxDir = realpathSync(sandboxDir);

  const skillsRoot = resolve(
    env.skillsRoot ?? join(env.agentFilesRoot, "skills"),
  );

  const sandbox = new LocalShellBackend({
    rootDir: sandboxDir,
    timeout: 120,
    maxOutputBytes: 200_000,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      FONT_DIR: join(skillsRoot, "canvas-design", "canvas-fonts"),
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });
  const skillsBackend = new FilesystemBackend({
    rootDir: skillsRoot,
    virtualMode: true,
  });

  const workspaceBackend = new FilesystemBackend({
    rootDir: env.agentFilesRoot,
    virtualMode: true,
  });

  // deepagents ≥1.13: factory 参数为 BackendRuntime，返回值需为同步的 backend 实例
  const factory = (stateAndStore: BackendRuntime) => {
    const routes: Record<string, AnyBackendProtocol> = {
      "/workspace/": workspaceBackend,
      "/skills/": skillsBackend,
    };

    // In dev mode, workspace skills are served from the Store when available.
    if (
      options?.hasWorkspaceSkills &&
      options.canvasId &&
      stateAndStore.store
    ) {
      routes["/workspace-skills/"] = new StoreBackend(stateAndStore, {
        namespace: ["projects", options.canvasId, "workspace-skills"],
      });
    }

    return new CompositeBackend(sandbox, routes);
  };

  return { factory, sandboxDir: realSandboxDir };
}
