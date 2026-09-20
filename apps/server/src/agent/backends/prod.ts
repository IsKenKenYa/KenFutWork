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

import { runtimeEnvAdditions } from "../../desktop/runtimes.js";
import { resolveSandboxDir } from "../sandbox-dir.js";
import { withWorkDirAlias } from "./path-alias.js";

const DEFAULT_SKILLS_ROOT = "/opt/kenfutwork/skills";

/**
 * Create a production backend with a per-project persistent workspace.
 *
 * **文件系统统一（割裂修复）**：曾经 default backend（execute 的 cwd）是
 * per-run 目录、`/workspace/` 路由是 StoreBackend（Postgres）——两套互不可见的
 * 文件系统，模型 write_file 写 /workspace 后 execute 找不到文件，被迫用 shell
 * 绕行（GUI 实测复现）。现在 /workspace 路由改为 **FilesystemBackend 且
 * rootDir 与 default backend 相同**（每画布一个持久目录）：
 * - write_file("/workspace/x") ≡ 沙箱根下的 x（同一物理文件）；
 * - execute 的 cwd 就是沙箱根 → 相对路径直接命中 /workspace 的内容；
 * - 持久化从 Postgres store 变为**磁盘持久**（每画布目录，跨 run 保留，
 *   不再随 run 结束清理——runtime 按 `ephemeral` 标志区分）。
 *
 * Routes:
 *   /workspace/        → FilesystemBackend（与 default 同一根目录：统一文件系统）
 *   /memories/         → StoreBackend (PostgresStore, per-project，跨 run 记忆)
 *   /skills/           → FilesystemBackend (shared, read-only system skills)
 *   /workspace-skills/ → StoreBackend (user-installed workspace skills, optional)
 *   default            → LocalShellBackend (per-project persistent dir, provides execute tool)
 */
export function createProductionBackendFactory(
  canvasId: string,
  options?: {
    sandboxRoot?: string;
    /** 画布 → 真实目录映射（`KENFUTWORK_CANVAS_WORK_DIRS`）；命中时直接落该目录。 */
    workDir?: string;
    skillsRoot?: string;
    hasWorkspaceSkills?: boolean;
    /** 随包运行时 bin 目录（前置到 sandbox PATH）。 */
    runtimePathAdditions?: string[];
    /** 随包 JDK 根目录（JAVA_HOME）。 */
    javaHome?: string;
  },
): {
  factory: (runtime: BackendRuntime) => AnyBackendProtocol;
  sandboxDir: string;
  /** false：目录按画布持久（跨 run 保留），runtime 不做 run 级清理。 */
  ephemeral: false;
} {
  const skillsRoot = resolve(options?.skillsRoot ?? DEFAULT_SKILLS_ROOT);

  // 沙箱目录的判定集中在 resolveSandboxDir（git 分支操作等能力共用同一处，避免漂移）
  const sandboxDir = resolveSandboxDir(
    canvasId,
    options?.sandboxRoot,
    options?.workDir,
  );
  mkdirSync(sandboxDir, { recursive: true });
  const realSandboxDir = realpathSync(sandboxDir);

  // LocalShellBackend = FilesystemBackend + execute tool
  // env 只传必要变量，不传 API key 等敏感信息
  // virtualMode: true 限制文件工具（write_file/read_file/ls 等）只能操作 rootDir 内的文件。
  // 防止多用户并发时通过 write_file 写绝对路径导致冲突。
  // 注意：virtualMode 不限制 execute 工具（shell 命令仍可访问全文件系统）。
  const sandbox = new LocalShellBackend({
    rootDir: realSandboxDir,
    virtualMode: true,
    timeout: 120,
    maxOutputBytes: 200_000,
    env: {
      // 随包运行时（Node/Python/uv/JDK）前置到 PATH 并补 PATHEXT：宿主机没装也能跑对应任务
      ...runtimeEnvAdditions({
        runtimePathAdditions: options?.runtimePathAdditions,
        javaHome: options?.javaHome,
      }),
      HOME: realSandboxDir,
      FONT_DIR: join(skillsRoot, "canvas-design", "canvas-fonts"),
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });

  const skillsBackend = new FilesystemBackend({
    rootDir: skillsRoot,
    virtualMode: true,
  });

  // /workspace 与 default backend 同一根目录：文件工具与 execute 看到同一份文件
  const workspaceBackend = new FilesystemBackend({
    rootDir: realSandboxDir,
    virtualMode: true,
  });

  // deepagents ≥1.13: factory 参数为 BackendRuntime，返回值需为同步的 backend 实例
  const factory = (stateAndStore: BackendRuntime) => {
    const routes: Record<string, AnyBackendProtocol> = {
      "/memories/": new StoreBackend(stateAndStore, {
        namespace: ["projects", canvasId, "memories"],
      }),
      "/workspace/": workspaceBackend,
      "/skills/": skillsBackend,
    };

    if (options?.hasWorkspaceSkills) {
      routes["/workspace-skills/"] = new StoreBackend(stateAndStore, {
        namespace: ["projects", canvasId, "workspace-skills"],
      });
    }

    // 路径别名：virtualMode 沙箱把根外绝对路径**静默吞成空结果**，而模型拿得到真实
    // 路径（用户贴的路径/历史对话/execute 的 pwd 回显），ls 之即得「目录是空的」
    // （2026-09-20 实测）。别名层让以沙箱真实目录开头的路径直达虚拟根；realpath 两个
    // 形态都认（macOS 的 /tmp → /private/tmp、外挂卷宗挂载点都可能差一层）。
    return withWorkDirAlias(new CompositeBackend(sandbox, routes), [
      realSandboxDir,
      sandboxDir,
    ]);
  };

  return { factory, sandboxDir: realSandboxDir, ephemeral: false };
}
