import { resolve } from "node:path";
import type { AgentRunExtension } from "../../agent/run-extension.js";
import { registerCodeUiRoutes } from "../../http/code-ui.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createTaskResourceCloser } from "../task-work/close-resources.js";
import { createApprovedPlanPromptSection } from "./approved-plan-prompt.js";
import { createAskUserQuestionToolDefinition } from "./ask-user-question.js";
import { createCodeAttachmentRepository } from "./attachments/repository.js";
import { createEnterPlanModeToolDefinition } from "./enter-plan.js";
import { createExitPlanModeToolDefinition } from "./exit-plan.js";
import { createCodeGuideMiddleware } from "./guide-model-mailbox.js";
import {
  CODE_UI_HOST_RPC_CAPABILITY,
  type CodeUiHostRpcHandler,
} from "./host-rpc-handler.js";
import { createCodeHistoryOutputPrompt } from "./output-history-prompt.js";
import { createCodeUiRepository } from "./repository.js";
import { createCodeUiService } from "./service.js";
import { createUserInputBroker } from "./user-input-broker.js";

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
      ctx.register("codeUi", () => {
        const userInputs = createUserInputBroker();
        return createCodeUiService({
          hostRpcHandler: (service, method) =>
            ctx
              .get("capabilities")
              .get<CodeUiHostRpcHandler>(
                CODE_UI_HOST_RPC_CAPABILITY,
                `${service}.${method}`,
              ),
          userInputs,
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
        });
      });
      ctx.get("tools").registerDynamic({
        id: "code.planning.enter",
        scope: "code",
        resolve(run) {
          if (
            run.scopeHandle?.role !== "main" ||
            run.scopeHandle.agentId !== "main"
          )
            return null;
          return createEnterPlanModeToolDefinition({
            control: {
              enter: (context) => ctx.get("codeUi").enterPlanMode(context),
            },
          });
        },
      });
      ctx.get("systemPrompt").register(
        createApprovedPlanPromptSection({
          read: (context) => ctx.get("codeUi").readApprovedPlan(context),
        }),
      );
      ctx.get("systemPrompt").register(
        createCodeHistoryOutputPrompt({
          manifest: (context) =>
            ctx.get("codeUi").outputHistory.manifest(context),
        }),
      );
      ctx.get("tools").registerDynamic({
        id: "code.planning.exit",
        scope: "code",
        resolve(run) {
          if (
            run.scopeHandle?.role !== "main" ||
            run.scopeHandle.agentId !== "main"
          )
            return null;
          return createExitPlanModeToolDefinition({
            control: {
              exit: (context) => ctx.get("codeUi").exitPlanMode(context),
            },
          });
        },
      });
      ctx.get("tools").registerDynamic({
        id: "code.user-input.ask-user-question",
        scope: "code",
        resolve(run) {
          if (!run.scopeHandle) return null;
          const broker = ctx.get("codeUi").userInputs;
          if (!broker) throw new Error("Code UI 提问服务未装配");
          return createAskUserQuestionToolDefinition({ broker });
        },
      });
    },
    mounted(ctx) {
      const guideExtension: AgentRunExtension = {
        preset: "code",
        createMiddleware(identity, context) {
          return createCodeGuideMiddleware(
            ctx.get("codeUi"),
            identity,
            context,
          );
        },
      };
      ctx.get("capabilities").register("agent-run-extension", {
        id: "code-ui:guide",
        value: guideExtension,
      });
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
      const userInputs = ctx.get("codeUi").userInputs;
      if (!userInputs) throw new Error("Code UI 提问服务未装配");
      ctx.effect(() =>
        userInputs.onEvent((event) =>
          ctx.get("codeUi").onUserInputEvent(event),
        ),
      );
      ctx.effect(() => () => userInputs.close("Code UI 宿主关闭"));
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
            userInputs.cancel(
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
        id: "code-ui:user-input",
        value: {
          close: (instanceId: string, taskId: string) =>
            userInputs.cancel({ instanceId, taskId }, "Task 已关闭"),
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
