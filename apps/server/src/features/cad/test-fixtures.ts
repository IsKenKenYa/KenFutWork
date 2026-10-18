import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeExecutionScope } from "@kenfutwork/shared";
import { z } from "zod";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import type { PluginStateChangedEvent } from "../plugins/state-lifecycle.js";
import { createProcessSandbox } from "../process-sandbox/service.js";
import type { ProcessExit, ProcessLimits } from "../process-sandbox/types.js";
import { detectFreeCadRuntime } from "./runtime.js";
import { type CadService, createCadService } from "./service.js";

/** 独立服务夹具显式模拟市场已成功装载；生产只能消费真实库存生命周期。 */
export function activateCadTestService(service: CadService): void {
  service.pluginLifecycle.afterStateChanged?.({
    reason: "install",
    previous: null,
    current: {
      id: "bundled__kenfutwork-cad",
      name: "kenfutwork-cad",
      enabled: true,
    } as NonNullable<PluginStateChangedEvent["current"]>,
  });
}

export async function executeCadTestTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) {
  return z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z.record(z.string(), z.unknown()),
    })
    .parse(await tool.execute(args, context));
}

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

export async function withNativeCad(
  run: (fixture: {
    root: string;
    service: CadService;
    context: ToolExecutionContext;
  }) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kfw-cad-native-")));
  const sandbox = createProcessSandbox({
    captureRoot: join(root, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
  });
  const failures: unknown[] = [];
  try {
    const runtime = await detectFreeCadRuntime();
    if (!runtime) throw new Error("显式原生验收要求本机已安装 FreeCAD");
    const { context } = await createCadTestContext(root);
    const service = createCadService({
      sandbox,
      gate: async () => ({ ok: true }),
      detectRuntime: async () => runtime,
      resolveLimits: async () => ({ limits: cadTestLimits, timeoutMs: 30_000 }),
    });
    activateCadTestService(service);
    await run({ root, service, context });
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await sandbox.close("cad_native_integration_cleanup");
      if (failures.length === 0)
        await rm(root, { recursive: true, force: true });
      else console.error(`CAD 原生验收诊断目录：${root}`);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "CAD 原生验收和资源清理均失败。");
}
