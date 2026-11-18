import { z } from "zod";

function isAbsoluteWorkspacePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[a-z]:[\\/]/i.test(path) ||
    /^\\\\[^\\]+\\[^\\]+/.test(path)
  );
}

const localIdentitySchema = z.tuple([
  z.uuid(),
  z.string().min(1).refine(isAbsoluteWorkspacePath),
]);

/** 仅解析本机展示/路由身份；目录授权仍必须核对真实 Project 与 Task 元信息。 */
export function parseLocalWorkspaceIdentity(
  identity: string | null | undefined,
  workspacePath?: string,
): { projectId: string; rootDirectory: string } | null {
  if (!identity) return null;
  try {
    const parsed = localIdentitySchema.safeParse(JSON.parse(identity));
    if (!parsed.success) return null;
    const [projectId, rootDirectory] = parsed.data;
    if (workspacePath !== undefined && workspacePath !== rootDirectory)
      return null;
    return { projectId, rootDirectory };
  } catch {
    return null;
  }
}

export function canonicalLocalWorkspaceIdentity(
  projectId: string,
  rootDirectory: string,
): string {
  return JSON.stringify(localIdentitySchema.parse([projectId, rootDirectory]));
}

/** 显式远端上下文优先；旧无身份目录为本机，未知非空身份继续按远端收紧。 */
export function isLocalWorkspaceTarget(target: {
  workspacePath?: string | undefined;
  workspaceIdentity?: string | null | undefined;
  remoteSessionId?: string | null | undefined;
  remoteTarget?: unknown;
}): boolean {
  if (target.remoteSessionId || target.remoteTarget) return false;
  const identity = target.workspaceIdentity?.trim();
  return (
    !identity ||
    parseLocalWorkspaceIdentity(identity, target.workspacePath) !== null
  );
}
