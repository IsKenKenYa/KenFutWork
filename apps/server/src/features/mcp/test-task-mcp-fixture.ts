import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodeExecutionScope,
  workspaceSettingsSchema,
} from "@kenfutwork/shared";
import { AgentRunEventBus, ToolRegistryImpl } from "../../kernel/context.js";
import type { ToolExecutionContext } from "../../kernel/types.js";
import type { StoredExecutionScope } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createPermissionService } from "../permissions/permission-service.js";
import { createTaskMcpService } from "./task-mcp-service.js";
import { stdioSandbox } from "./test-stdio-process.js";

export async function taskMcpFixture(
  options: Parameters<typeof stdioSandbox>[0] = {},
  addCleanup: (cleanup: () => Promise<void>) => void,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kfw-task-mcp-")));
  addCleanup(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "server.mjs"), "// 受控句柄测试夹具\n");
  const scope: CodeExecutionScope = {
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    taskId: randomUUID(),
    generation: 1,
    rootDirectory: root,
    additionalDirectories: [],
    sandboxMode: "workspace-write",
  };
  const actor = {
    id: randomUUID(),
    email: "task@fixture",
    accessToken: "token",
    userMetadata: {},
  };
  let stored: StoredExecutionScope = {
    scope,
    state: "ready",
    branchGeneration: 1,
  };
  const scopes = createExecutionScopes({
    repository: {
      load: async (workspaceId, taskId) =>
        workspaceId === scope.workspaceId && taskId === scope.taskId
          ? stored
          : null,
      beginUpdate: async (previous, patch) => {
        stored = {
          ...stored,
          state: "revoking",
          scope: {
            ...previous,
            additionalDirectories:
              patch.additionalDirectories ?? previous.additionalDirectories,
            sandboxMode: patch.sandboxMode ?? previous.sandboxMode,
            generation: previous.generation + 1,
          },
        };
        return stored;
      },
      finishUpdate: async (next, state) => {
        stored = { ...stored, scope: next, state };
        return true;
      },
    },
    viewerService: {
      resolveWorkspace: async () => ({
        id: scope.workspaceId,
        name: "个人工作区",
        ownerUserId: actor.id,
        type: "personal",
      }),
    },
  });
  const handle = await scopes.openTask(actor, scope.taskId);
  const permissions = createPermissionService();
  const events = new AgentRunEventBus();
  events.on("tool-pre-execute", async (payload, next) =>
    payload.permissionInvocation
      ? next({
          ...payload,
          decision: (await permissions.admit(payload.permissionInvocation))
            .decision,
        })
      : next(payload),
  );
  const registry = new ToolRegistryImpl(events, () => permissions);
  const process = stdioSandbox(options);
  const service = createTaskMcpService({
    sandbox: process.sandbox,
    registry,
    version: "1",
    settings: {
      getWorkspaceSettings: async () =>
        workspaceSettingsSchema.parse({
          defaultModel: "fixture",
          processMaxOutputBytes: 4096,
        }),
    },
  });
  addCleanup(async () => {
    for (const child of process.children) await child.process.stop("测试清理");
  });
  addCleanup(() => service.shutdown("测试结束"));
  scopes.onRevoke(({ previous, next }) => service.revoke(previous, next));
  const context: ToolExecutionContext = {
    scopeHandle: handle,
    runId: "run-1",
    toolCallId: "create-1",
    userId: actor.id,
    workspaceId: scope.workspaceId,
    taskWorkContext: {
      actor,
      scope,
      agentId: "main",
      runId: "run-1",
      branchGeneration: 1,
    },
    codeApproval: {
      ceiling: "yolo",
      resolve: async () => ({
        mode: "yolo",
        scopeGeneration: handle.describe().generation,
        branchGeneration: 1,
      }),
    },
  };
  const work = context.taskWorkContext;
  if (!work) throw new Error("测试缺少完整Task上下文。");
  const resolution = () => ({
    preset: "code" as const,
    scopeHandle: handle,
    backendFactory: () => handle.backend,
  });
  return {
    root,
    scope,
    actor,
    scopes,
    handle,
    registry,
    service,
    context,
    work,
    resolution,
    ...process,
  };
}
