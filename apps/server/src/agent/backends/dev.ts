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
import { runtimeEnvAdditions } from "../../desktop/runtimes.js";
import type { AgentBackendResult } from "./index.js";

type AgentBackendEnv = Pick<
  ServerEnv,
  "agentFilesRoot" | "sandboxRoot" | "skillsRoot"
>;

/** filesystem 模式的缺省沙箱根（相对 cwd；生产入口会注入 `<项目根>/tmp/sandbox`）。 */
const DEFAULT_DEV_SANDBOX_ROOT = "tmp/sandbox-dev";

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
    hasInstanceSkills?: boolean;
    /** 随包运行时 bin 目录（前置到 sandbox PATH）。 */
    runtimePathAdditions?: string[];
    /** 随包 JDK 根目录（JAVA_HOME）。 */
    javaHome?: string;
  },
): AgentBackendResult {
  if (!env.agentFilesRoot) {
    throw new Error(
      "KENFUTWORK_AGENT_FILES_ROOT must be set when filesystem backend mode is enabled.",
    );
  }

  const runId = crypto.randomUUID();
  const sandboxDir = join(
    resolve(env.sandboxRoot ?? DEFAULT_DEV_SANDBOX_ROOT),
    runId,
  );
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
      // 随包运行时（Node/Python/uv/JDK）前置到 PATH 并补 PATHEXT：宿主机没装也能跑对应任务
      ...runtimeEnvAdditions({
        runtimePathAdditions: options?.runtimePathAdditions,
        javaHome: options?.javaHome,
      }),
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
    if (options?.hasInstanceSkills && options.canvasId && stateAndStore.store) {
      routes["/workspace-skills/"] = new StoreBackend(stateAndStore, {
        namespace: ["projects", options.canvasId, "workspace-skills"],
      });
    }

    return new CompositeBackend(sandbox, routes);
  };

  return { factory, sandboxDir: realSandboxDir, ephemeral: true };
}
