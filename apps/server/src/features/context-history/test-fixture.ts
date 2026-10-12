import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeExecutionScope } from "@kenfutwork/shared";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  instanceSettingsSchema,
} from "@kenfutwork/shared";
import { loadServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import { AgentRunEventBus } from "../../kernel/context.js";
import type { ToolExecutionContext } from "../../kernel/types.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createPermissionService } from "../permissions/permission-service.js";
import { createContextHistoryPlugin } from "./plugin.js";

export async function archiveTaskFixture(
  preset: "code" | "design" = "code",
  initialPageBudget: number = AGENT_GOVERNANCE_DEFAULTS.codeReadPageCharacters,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-history-consumer-")),
  );
  const identity: CodeExecutionScope = {
    instanceId: randomUUID(),
    projectId: randomUUID(),
    taskId: randomUUID(),
    generation: 0,
    rootDirectory: root,
    additionalDirectories: [],
    sandboxMode: "workspace-write",
  };
  let branchGeneration = 1;
  let pageBudget = initialPageBudget;
  const actor = {
    instanceId: identity.instanceId,
    accessClientId: randomUUID(),
  };
  const scopes = createExecutionScopes({
    resolveFileLimits: async () => ({
      ...AGENT_GOVERNANCE_DEFAULTS,
      codeReadPageCharacters: pageBudget,
    }),
    repository: {
      load: async () => ({
        preset,
        scope: structuredClone(identity),
        state: "ready",
        branchGeneration,
      }),
    },
    localInstance: {
      resolve: async () => ({ instanceId: identity.instanceId, dataDir: root }),
    },
  });
  const handle = await scopes.openTask(actor, identity.taskId);
  const execution: ToolExecutionContext = {
    actor,
    instanceId: identity.instanceId,
    scopeHandle: handle,
    runId: randomUUID(),
    threadId: randomUUID(),
    toolCallId: randomUUID(),
    codeApproval: {
      ceiling: "build",
      resolve: async () => ({
        mode: "build",
        scopeGeneration: identity.generation,
        branchGeneration,
      }),
    },
  };
  return {
    handle,
    execution,
    actor,
    identity,
    scopes,
    setPageBudget: (value: number) => {
      pageBudget = value;
    },
    staleBranch: () => {
      branchGeneration++;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Actual admission/claim service, not a bypass of the production per-call gate. */
export function archiveKernelFixture() {
  const permissions = createPermissionService();
  const events = new AgentRunEventBus();
  // Runtime Provider composition also consumes this shared fixture's settings port.
  const settings = {
    onUpdated: () => {
      throw new Error("归档fixture不支持设置订阅");
    },
    getCodeUiTransportSettings: async () => {
      throw new Error("归档fixture不支持传输设置");
    },
    updateInstanceSettings: async () => {
      throw new Error("归档fixture不支持设置修改");
    },
    getInstanceSettings: async () =>
      instanceSettingsSchema.parse({ defaultModel: "" }),
  };
  events.on("tool-pre-execute", async (payload, next) => {
    if (!payload.permissionInvocation) return next(payload);
    const decision = await permissions.admit(payload.permissionInvocation);
    return next({
      ...payload,
      decision: decision.decision,
      ...(decision.reason ? { denyReason: decision.reason } : {}),
    });
  });
  return composePlugins(loadServerEnv({}, {}), [createContextHistoryPlugin()], {
    events,
    overrides: { permissions, settings },
  });
}
