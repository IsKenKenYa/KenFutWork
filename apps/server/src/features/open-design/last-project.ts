import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 「最近一次由对话创建的 OpenDesign 项目」。
 *
 * 为什么不做会话级绑定：`chat_sessions` 没有 metadata 列，会话级绑定要前向迁移；
 * 而右侧面板拿不到当前会话 id（它挂在共享侧栏里，不随会话重挂）。先用一个明确的
 * 单槽位把「对话建了项目 → 右侧打开这块画布」跑通，等绑定落点定下来再升级为
 * sessionId → projectId 映射；文件形状预留了升级空间。
 */
export interface OpenDesignLastProject {
  projectId: string;
  name: string;
  /** ISO 时间；仅用于调试与「最近」判定。 */
  updatedAt: string;
}

export function openDesignLastProjectPath(dataDir: string): string {
  return join(dataDir, "config", "open-design-last-project.json");
}

function parse(text: string): OpenDesignLastProject | null {
  try {
    const value = JSON.parse(text) as Partial<OpenDesignLastProject>;
    if (
      typeof value.projectId === "string" &&
      value.projectId.trim() &&
      typeof value.name === "string"
    ) {
      return {
        projectId: value.projectId,
        name: value.name,
        updatedAt:
          typeof value.updatedAt === "string" ? value.updatedAt : "",
      };
    }
  } catch {
    // 损坏的文件按「没有」处理：这是可重建的投影，不是持久真相。
  }
  return null;
}

export function readOpenDesignLastProject(input: {
  dataDir: string;
  readImpl?: typeof readFileSync;
}): OpenDesignLastProject | null {
  const read = input.readImpl ?? readFileSync;
  try {
    return parse(read(openDesignLastProjectPath(input.dataDir), "utf8"));
  } catch {
    return null;
  }
}

export function writeOpenDesignLastProject(input: {
  dataDir: string;
  project: { projectId: string; name: string };
  writeImpl?: typeof writeFileSync;
  now?: Date;
}): void {
  const file = openDesignLastProjectPath(input.dataDir);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const value: OpenDesignLastProject = {
    projectId: input.project.projectId,
    name: input.project.name,
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
  (input.writeImpl ?? writeFileSync)(file, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
  });
}
