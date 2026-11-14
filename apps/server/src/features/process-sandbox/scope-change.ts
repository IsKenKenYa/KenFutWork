import { pathWithin } from "./policy.js";
import { processOwnerKey } from "./process-identity.js";
import type { SandboxProcessScope as CodeExecutionScope } from "./types.js";

function roots(scope: CodeExecutionScope) {
  return [
    { path: scope.rootDirectory, writable: scope.sandboxMode !== "read-only" },
    ...scope.additionalDirectories.map((directory) => ({
      path: directory.path,
      writable:
        scope.sandboxMode !== "read-only" && directory.access === "read-write",
    })),
  ];
}

/** 检查整个已授予执行域是否仍被覆盖；shell 的未来访问不可只看最近一次 cwd。 */
export function losesExecutionRights(
  previous: CodeExecutionScope,
  next: CodeExecutionScope,
): boolean {
  if (
    previous.sandboxMode === "danger-full-access" &&
    next.sandboxMode !== "danger-full-access"
  )
    return true;
  if (
    previous.instanceId !== next.instanceId ||
    previous.projectId !== next.projectId ||
    processOwnerKey(previous) !== processOwnerKey(next) ||
    previous.rootDirectory !== next.rootDirectory
  )
    return true;
  const before = roots(previous);
  const after = roots(next);
  for (const grant of before) {
    if (!after.some((candidate) => pathWithin(grant.path, candidate.path)))
      return true;
    if (!grant.writable) continue;
    if (
      !after.some(
        (candidate) =>
          candidate.writable && pathWithin(grant.path, candidate.path),
      )
    )
      return true;
    for (const restriction of after.filter(
      (candidate) => !candidate.writable,
    )) {
      if (!pathWithin(restriction.path, grant.path)) continue;
      if (
        !before.some(
          (candidate) =>
            !candidate.writable && pathWithin(restriction.path, candidate.path),
        )
      )
        return true;
    }
  }
  return false;
}
