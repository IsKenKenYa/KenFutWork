import { realpath } from "node:fs/promises";
import type { CodeExecutionScope } from "@kenfutwork/shared";
import { pathWithin } from "./policy.js";
import type { ManagedProcessSnapshot, ProcessSpawnRequest } from "./types.js";
import { ProcessSandboxError } from "./types.js";

interface WriteDomain {
  writable: string[];
  readonly: string[];
}
interface Admission {
  scope: CodeExecutionScope;
  agentId: string;
  invocationId: string;
  domain: Promise<WriteDomain>;
}
interface Barrier {
  taskId: string;
  roots: string[];
}

async function writeDomain(scope: CodeExecutionScope): Promise<WriteDomain> {
  if (scope.sandboxMode === "read-only") return { writable: [], readonly: [] };
  const root = await realpath(scope.rootDirectory);
  const additional = await Promise.all(
    scope.additionalDirectories.map(async (directory) => ({
      ...directory,
      path: await realpath(directory.path),
    })),
  );
  return {
    writable: [
      root,
      ...additional
        .filter((directory) => directory.access === "read-write")
        .map((directory) => directory.path),
    ],
    readonly: additional
      .filter((directory) => directory.access === "read-only")
      .map((directory) => directory.path),
  };
}

function intersects(domain: WriteDomain, roots: readonly string[]): boolean {
  return roots.some((root) =>
    domain.writable.some((grant) => {
      const intersection = pathWithin(root, grant)
        ? root
        : pathWithin(grant, root)
          ? grant
          : null;
      return (
        intersection !== null &&
        !domain.readonly.some((restriction) =>
          pathWithin(intersection, restriction),
        )
      );
    }),
  );
}

function conflict(): ProcessSandboxError & { statusCode: number } {
  return Object.assign(
    new ProcessSandboxError(
      "restore_conflict",
      "恢复目录存在其它 Task 的读写命令或正在恢复，等待其明确停止后再重试。",
    ),
    { statusCode: 409 },
  );
}

/** 只协调本Provider的真实进程写域；不宣称外部shell/editor受此锁管理。 */
export function createProcessRestoreCoordinator() {
  const admissions = new Map<symbol, Admission>();
  const barriers = new Map<symbol, Barrier>();
  let admissionRevision = 0;
  return {
    reserve(request: ProcessSpawnRequest) {
      const id = Symbol("process-admission");
      if (request.scope.sandboxMode === "read-only") return id;
      const scope = structuredClone(request.scope);
      const domain = writeDomain(scope);
      void domain.catch(() => {});
      admissions.set(id, {
        scope,
        agentId: request.agentId,
        invocationId: request.invocationId,
        domain,
      }); // 第一次 await 前预留，覆盖冷helper与policy准备。
      admissionRevision++;
      return id;
    },
    async admit(id: symbol) {
      const admission = admissions.get(id);
      if (!admission) return;
      const domain = await admission.domain;
      if (
        [...barriers.values()].some((barrier) =>
          intersects(domain, barrier.roots),
        )
      )
        throw conflict();
    },
    discardUnlaunched(id: symbol) {
      if (admissions.delete(id)) admissionRevision++;
    },
    observe(snapshot: ManagedProcessSnapshot) {
      if (!snapshot.exit?.rangeEmpty) return;
      for (const [id, admission] of admissions) {
        if (
          admission.scope.taskId === snapshot.ownerTaskId &&
          admission.scope.generation === snapshot.generation &&
          admission.agentId === snapshot.agentId &&
          admission.invocationId === snapshot.invocationId
        ) {
          admissions.delete(id);
          admissionRevision++;
        }
      }
    },
    async acquire(scope: CodeExecutionScope, roots: readonly string[]) {
      const canonical = await Promise.all(roots.map((root) => realpath(root)));
      for (;;) {
        const observedRevision = admissionRevision;
        const pending = await Promise.all(
          [...admissions].map(async ([token, admission]) => ({
            token,
            admission,
            domain: await admission.domain,
          })),
        );
        // await期间新准入/已确认退出会改变集合；重新读取，不能遗漏新pending。
        if (observedRevision !== admissionRevision) continue;
        if (
          [...barriers.values()].some((barrier) =>
            canonical.some((root) =>
              barrier.roots.some(
                (other) => pathWithin(root, other) || pathWithin(other, root),
              ),
            ),
          )
        )
          throw conflict();
        if (
          pending.some(
            ({ admission, domain }) =>
              (admission.scope.taskId !== scope.taskId ||
                admission.scope.workspaceId !== scope.workspaceId ||
                admission.scope.projectId !== scope.projectId) &&
              intersects(domain, canonical),
          )
        )
          throw conflict();
        // 最终检查与安装同一同步步骤。检查中的临时barrier不能撤销已有pending请求。
        const id = Symbol("restore-barrier");
        barriers.set(id, { taskId: scope.taskId, roots: canonical });
        return {
          release() {
            barriers.delete(id);
          },
        };
      }
    },
  };
}
