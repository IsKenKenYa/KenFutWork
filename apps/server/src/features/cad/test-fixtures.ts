import type { CodeExecutionScope } from "@kenfutwork/shared";
import type { ToolExecutionContext } from "../../kernel/types.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import type { ProcessExit, ProcessLimits } from "../process-sandbox/types.js";

export const cadTestLimits: ProcessLimits = {
  maxOutputBytes: 1_048_576,
  previewMaxChars: 8_000,
  yieldMs: 100,
  killGraceMs: 2_000,
};
export const cadTestExit: ProcessExit = {
  exitCode: 0,
  signal: null,
  reason: null,
  stopped: false,
  rangeEmpty: true,
};

export async function createCadTestContext(root: string) {
  const scope: CodeExecutionScope = {
    instanceId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    taskId: "00000000-0000-4000-8000-000000000003",
    generation: 1,
    rootDirectory: root,
    additionalDirectories: [],
    sandboxMode: "workspace-write",
  };
  const actor = { instanceId: scope.instanceId, accessClientId: null };
  const stored = {
    scope,
    preset: "code" as const,
    state: "ready" as const,
    branchGeneration: 1,
  };
  const scopes = createExecutionScopes({
    repository: { load: async () => structuredClone(stored) },
    localInstance: {
      resolve: async () => ({ instanceId: scope.instanceId, dataDir: root }),
    },
  });
  const handle = await scopes.openTask(actor, scope.taskId);
  const controller = new AbortController();
  const context: ToolExecutionContext = {
    actor,
    instanceId: scope.instanceId,
    runId: "cad-test-run",
    toolCallId: "cad-test-call",
    signal: controller.signal,
    scopeHandle: handle,
    taskWorkContext: {
      actor,
      scope,
      runId: "cad-test-run",
      agentId: "main",
      branchGeneration: 1,
    },
  };
  return { context, controller, scope, stored };
}
