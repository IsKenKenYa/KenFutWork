import { createHash } from "node:crypto";
import { lstat, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CodeExecutionScope } from "@kenfutwork/shared";

export function checkpointWorkRoots(scope: CodeExecutionScope): string[] {
  return [
    ...new Set([
      scope.rootDirectory,
      ...scope.additionalDirectories
        .filter((entry) => entry.access === "read-write")
        .map((entry) => entry.path),
    ]),
  ];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    // 包括旧 Windows 长路径无法访问的情形。
    return false;
  }
}

/** 服务与沙箱共用可信 Task 路径；短布局优先，搬迁失败保留旧仓库。 */
export async function resolveCheckpointGitDirectory(
  checkpointRoot: string,
  scope: Pick<CodeExecutionScope, "instanceId" | "projectId" | "taskId">,
  workRoot: string,
): Promise<string> {
  const hash = createHash("sha256").update(workRoot).digest("hex");
  const short = join(
    checkpointRoot,
    `${scope.taskId}-${hash.slice(0, 16)}.git`,
  );
  if (await isDirectory(short)) return short;
  const legacy = join(
    checkpointRoot,
    scope.instanceId,
    scope.projectId,
    `${scope.taskId}.git`,
    hash,
  );
  if (!(await isDirectory(legacy))) return short;
  try {
    await mkdir(dirname(short), { recursive: true });
    await rename(legacy, short);
    return short;
  } catch {
    // 并发解析可能已完成同一搬迁，优先采用已存在的短仓库。
    return (await isDirectory(short)) ? short : legacy;
  }
}
