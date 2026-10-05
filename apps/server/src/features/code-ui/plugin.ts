import { resolve } from "node:path";
import { registerCodeUiRoutes } from "../../http/code-ui.js";
import type { PluginDefinition } from "../../kernel/types.js";
import {
  createInstanceSkillSettingsRepository,
  createSkillCatalogRepository,
} from "../skills/repository.js";
import { createTaskResourceCloser } from "../task-work/close-resources.js";
import { createCodeAttachmentRepository } from "./attachments/repository.js";
import { createCodeUiRepository } from "./repository.js";
import { createCodeUiService } from "./service.js";

export function createCodeUiPlugin(): PluginDefinition {
  return {
    name: "code-ui",
    inject: [
      "localAccess",
      "localInstance",
      "persistence",
      "projects",
      "modelProviders",
      "modelCatalog",
      "settings",
      "threads",
      "agentRuns",
      "agentRunMetadata",
      "checkpoints",
      "executionScopes",
      "taskWork",
      "permissions",
      "codeTerminal",
      "blob",
      "processSandbox",
      "plugins",
    ],
    apply(ctx) {
      ctx.register("codeUi", () =>
        createCodeUiService({
          repository: createCodeUiRepository(ctx.get("persistence")),
          executionScopes: ctx.get("executionScopes"),
          taskWork: ctx.get("taskWork"),
          permissions: ctx.get("permissions"),
          terminals: ctx.get("codeTerminal"),
          processSandbox: ctx.get("processSandbox"),
          plugins: ctx.get("plugins"),
          blob: ctx.get("blob"),
          attachmentRepository: createCodeAttachmentRepository(
            ctx.get("persistence"),
            resolve(ctx.env.checkpointRoot ?? "data/checkpoints"),
          ),
          skillRepository: createSkillCatalogRepository(ctx.get("persistence")),
          skillSettingsRepository: createInstanceSkillSettingsRepository(
            ctx.get("persistence"),
          ),
          beforeCloseTask: createTaskResourceCloser({
            localInstance: ctx.get("localInstance"),
            resources: () => ({
              runs: ctx.get("agentRuns"),
              work: ctx.get("taskWork"),
              sandbox: ctx.get("processSandbox"),
              capabilities: ctx.get("capabilities"),
            }),
          }),
          localInstance: ctx.get("localInstance"),
          projects: ctx.get("projects"),
          modelProviders: ctx.get("modelProviders"),
          modelCatalog: ctx.get("modelCatalog"),
          settings: ctx.get("settings"),
          threads: ctx.get("threads"),
          agentRuns: ctx.get("agentRuns"),
          agentRunMetadata: ctx.get("agentRunMetadata"),
          checkpoints: ctx.get("checkpoints"),
          env: ctx.env,
        }),
      );
    },
    mounted(ctx) {
      ctx.effect(() =>
        ctx.get("settings").onUpdated(({ instanceId, changedKeys }) => {
          if (
            changedKeys.includes("defaultModel") ||
            changedKeys.includes("commands")
          )
            return ctx.get("codeUi").refreshWorkspaceConfiguration(instanceId);
        }),
      );
      ctx.app.addHook("onReady", async () => {
        await ctx.get("codeUi").initialize();
      });
      const permissions = ctx.get("permissions");
      ctx.effect(() =>
        permissions.onEvent((event) =>
          ctx.get("codeUi").onApprovalEvent(event),
        ),
      );
      ctx.effect(() =>
        ctx
          .get("executionScopes")
          .onRevoke(({ previous }) =>
            permissions.cancel(
              { instanceId: previous.instanceId, taskId: previous.taskId },
              "Task 授权发生变更",
            ),
          ),
      );
      ctx.effect(() =>
        ctx
          .get("executionScopes")
          .onRevoke(({ previous }) =>
            ctx
              .get("codeUi")
              .closeTaskWatchers(previous.instanceId, previous.taskId),
          ),
      );
      ctx.effect(() => () => ctx.get("codeUi").closeConnections());
      ctx.get("capabilities").register("task-close", {
        id: "code-ui:file-watchers",
        value: {
          close: (instanceId: string, taskId: string) =>
            ctx.get("codeUi").closeTaskWatchers(instanceId, taskId),
        },
      });
      ctx.get("capabilities").register("task-close", {
        id: "permissions:code-calls",
        value: {
          close: (instanceId: string, taskId: string) =>
            permissions.cancel({ instanceId, taskId }, "Task 已关闭"),
        },
      });
      void registerCodeUiRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        service: ctx.get("codeUi"),
      });
    },
  };
}
