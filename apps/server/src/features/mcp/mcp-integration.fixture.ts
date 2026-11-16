import { randomUUID } from "node:crypto";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ServerEnv } from "../../config/env.js";
import { AgentRunEventBus, ToolRegistryImpl } from "../../kernel/context.js";
import type { ToolExecutionContext } from "../../kernel/types.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createPermissionService } from "../permissions/permission-service.js";
import { createProcessSandbox } from "../process-sandbox/service.js";
import { createSettingsRepository } from "../settings/repository.js";
import { createSettingsService } from "../settings/settings-service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createMcpService } from "./mcp-service.js";
import { createMcpServerStore } from "./server-store.js";
import { createTaskMcpService } from "./task-mcp-service.js";

/** 真实数据库、审批、执行作用域与进程，供 MCP 的公开行为回归共用。 */
export async function createMcpIntegrationFixture(
  tools: Tool[],
  addCleanup: (close: () => Promise<void>) => void,
) {
  const database = await createTaskWorkDatabase();
  addCleanup(() => database.close());
  const scope = database.context.scope;
  const sql = database.persistence.forInstance(database.instanceId);
  await sql.execute(
    "insert into public.chat_sessions(id,instance_id,project_id,mode,created_by_client_id,thread_id) values($1,:instance,$2,'code',$3,$4)",
    [
      scope.taskId,
      scope.projectId,
      database.actor.accessClientId,
      randomUUID(),
    ],
  );
  await sql.execute(
    "update public.code_ui_sessions set chat_session_id=$1 where instance_id=:instance and id=$1",
    [scope.taskId],
  );
  const handle = await createExecutionScopes({
    repository: createScopeRepository(database.persistence),
    localInstance: database.localInstance,
  }).openTask(database.actor, scope.taskId);
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
  const settings = createSettingsService({
    repository: createSettingsRepository(database.persistence),
    localInstance: database.localInstance,
  });
  const sandbox = createProcessSandbox({
    captureRoot: join(database.directory, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
  });
  addCleanup(() => sandbox.close("MCP测试结束"));
  const tasks = createTaskMcpService({
    sandbox,
    settings,
    registry,
    version: "test",
  });
  addCleanup(() => tasks.shutdown("MCP测试结束"));
  const service = createMcpService({
    env: { version: "test" } as ServerEnv,
    registry,
    store: createMcpServerStore(database.persistence, database.localInstance),
    executeTool: (source, metadata, args, context, remoteCall) =>
      source.kind === "stdio"
        ? tasks.callConfigured(source, metadata, args, context)
        : remoteCall(),
    readConfiguredResource: (source, request, context) =>
      tasks.readConfiguredResource(source, request, context),
    onDisconnect: (name) => tasks.closeSource(name),
  });
  addCleanup(() => service.shutdown());
  const context: ToolExecutionContext = {
    scopeHandle: handle,
    actor: database.actor,
    instanceId: database.instanceId,
    runId: database.context.runId,
    toolCallId: "mcp-integration",
    taskWorkContext: database.context,
    codeApproval: {
      ceiling: "yolo",
      resolve: async () => ({
        mode: "yolo",
        scopeGeneration: handle.describe().generation,
        branchGeneration: handle.branchGeneration,
      }),
    },
  };
  const resolution = () => ({
    preset: "code" as const,
    scopeHandle: handle,
    backendFactory: () => handle.backend,
  });
  const resolved = () => registry.resolveRunTools(resolution());
  const root = scope.rootDirectory;
  await copyFile(
    new URL("./fixtures/mcp-visibility-server.mjs", import.meta.url),
    join(root, "server.mjs"),
  );
  await writeFile(join(root, "tools.json"), JSON.stringify(tools));
  return {
    database,
    root,
    context,
    handle,
    registry,
    service,
    tasks,
    resolved,
    resolution,
  };
}
