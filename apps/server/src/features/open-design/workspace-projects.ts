import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * KenFutWork 项目 → OpenDesign 项目的绑定。
 *
 * 右侧设计面板按**当前项目**取资源；一个项目一块设计工作区，换项目就换资源页。
 * 绑定是可重建的投影（上游项目删了就重建），不是业务真相，所以损坏按「没有」处理。
 * 只存 workspaceKey 的 SHA-256，不把用户目录路径写进配置文件。
 */
export interface OpenDesignWorkspaceProjectBinding {
  projectId: string;
  name: string;
  updatedAt: string;
}

interface BindingFile {
  bindings: Record<string, OpenDesignWorkspaceProjectBinding>;
}

/** 只保留最近使用的这些绑定，防止长期切项目后配置文件无限长。 */
const MAX_WORKSPACE_BINDINGS = 200;

export function openDesignWorkspaceProjectsPath(dataDir: string): string {
  return join(dataDir, "config", "open-design-workspace-projects.json");
}

function hashWorkspaceKey(workspaceKey: string): string {
  return createHash("sha256").update(workspaceKey).digest("hex");
}

function parse(text: string): BindingFile {
  try {
    const value = JSON.parse(text) as { bindings?: unknown };
    if (!value.bindings || typeof value.bindings !== "object") {
      return { bindings: {} };
    }
    const bindings: Record<string, OpenDesignWorkspaceProjectBinding> = {};
    for (const [key, entry] of Object.entries(
      value.bindings as Record<string, unknown>,
    )) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Partial<OpenDesignWorkspaceProjectBinding>;
      if (
        typeof candidate.projectId !== "string" ||
        !candidate.projectId.trim() ||
        typeof candidate.name !== "string"
      )
        continue;
      bindings[key] = {
        projectId: candidate.projectId,
        name: candidate.name,
        updatedAt:
          typeof candidate.updatedAt === "string" ? candidate.updatedAt : "",
      };
    }
    return { bindings };
  } catch {
    return { bindings: {} };
  }
}

export function readOpenDesignWorkspaceProject(input: {
  dataDir: string;
  workspaceKey: string;
  readImpl?: typeof readFileSync;
}): OpenDesignWorkspaceProjectBinding | null {
  const read = input.readImpl ?? readFileSync;
  let file: BindingFile;
  try {
    file = parse(read(openDesignWorkspaceProjectsPath(input.dataDir), "utf8"));
  } catch {
    return null;
  }
  return file.bindings[hashWorkspaceKey(input.workspaceKey)] ?? null;
}

export function writeOpenDesignWorkspaceProject(input: {
  dataDir: string;
  workspaceKey: string;
  project: { projectId: string; name: string };
  writeImpl?: typeof writeFileSync;
  now?: Date;
}): void {
  const target = openDesignWorkspaceProjectsPath(input.dataDir);
  let file: BindingFile = { bindings: {} };
  try {
    file = parse(readFileSync(target, "utf8"));
  } catch {
    // 首次写入或文件损坏：从空表重建。
  }
  file.bindings[hashWorkspaceKey(input.workspaceKey)] = {
    projectId: input.project.projectId,
    name: input.project.name,
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
  const entries = Object.entries(file.bindings)
    .sort((left, right) => right[1].updatedAt.localeCompare(left[1].updatedAt))
    .slice(0, MAX_WORKSPACE_BINDINGS);
  const next: BindingFile = { bindings: Object.fromEntries(entries) };
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  (input.writeImpl ?? writeFileSync)(
    target,
    `${JSON.stringify(next, null, 2)}\n`,
    { mode: 0o600 },
  );
}
