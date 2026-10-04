import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { PluginDefinition } from "../../kernel/types.js";
import { losesExecutionRights } from "../process-sandbox/scope-change.js";
import { createTaskCommandTools } from "./command-tools.js";
import { createTaskWorkStore } from "./repository.js";
import { createTaskWorkManager } from "./service.js";

export function createTaskWorkPlugin(): PluginDefinition {
  return {
    name: "task-work",
    inject: ["persistence", "settings", "executionScopes", "processSandbox"],
    apply(ctx) {
      ctx.register("taskWork", () =>
        createTaskWorkManager({
          store: createTaskWorkStore(ctx.get("persistence")),
          executionHostId: createHash("sha256")
            .update(resolve(ctx.env.checkpointRoot ?? "data/checkpoints"))
            .digest("hex"),
          resolveMaxConcurrent: async (context) => {
            if (!context.actor) throw new Error("后台派发缺少可信用户身份。");
            return (
              await ctx
                .get("settings")
                .getWorkspaceSettings(context.actor, context.scope.workspaceId)
            ).subagentMaxConcurrency;
          },
        }),
      );
      let commands: ReturnType<typeof createTaskCommandTools> | undefined;
      const getCommands = () => {
        commands ??= createTaskCommandTools({
          manager: ctx.get("taskWork"),
          sandbox: ctx.get("processSandbox"),
          settings: ctx.get("settings"),
        });
        return commands;
      };
      for (const name of ["Bash", "TaskOutput", "TaskInput", "TaskStop"]) {
        ctx.get("tools").registerDynamic({
          id: `task-work:${name}`,
          scope: "code",
          resolve(run) {
            if (!run.scopeHandle) return null;
            if (
              (run.scopeHandle.role === "explore" ||
                run.scopeHandle.role === "review") &&
              name === "Bash"
            )
              return null;
            if (
              (run.scopeHandle.role === "explore" ||
                run.scopeHandle.role === "review") &&
              name === "TaskInput"
            )
              return null;
            const tool = getCommands().tools.find((tool) => tool.name === name);
            if (!tool) return null;
            return name === "Bash"
              ? {
                  ...tool,
                  readonlyExecution:
                    ctx.get("processSandbox").readonlyExecution === true,
                }
              : tool;
          },
        });
      }
      ctx
        .get("capabilities")
        .register("task-close", {
          id: "task-work:command-handles",
          value: {
            close: (workspaceId: string, taskId: string) =>
              getCommands().forgetTask(workspaceId, taskId),
          },
        });
      ctx
        .get("capabilities")
        .register("process-snapshot", {
          id: "task-work:durable-output",
          value: {
            receive: (
              snapshot: import("../process-sandbox/types.js").ManagedProcessSnapshot,
            ) => getCommands().acceptSnapshot(snapshot),
          },
        });
    },
    mounted(ctx) {
      const manager = ctx.get("taskWork");
      ctx.app.addHook("onReady", async () => {
        await manager.initialize();
      });
      ctx.app.addHook("preClose", async () => {
        await manager.close("执行宿主关闭");
      });
      ctx.effect(() =>
        manager.onChanged((record) =>
          ctx.get("codeUi").onTaskWorkChanged(record),
        ),
      );
      ctx.effect(() =>
        manager.onReady(({ workspaceId, taskId }) =>
          ctx.get("codeUi").resumeTaskWork(workspaceId, taskId),
        ),
      );
      ctx.effect(() =>
        ctx
          .get("executionScopes")
          .onUpdated(({ next }) =>
            manager.notifyReady(next.workspaceId, next.taskId),
          ),
      );
      ctx.effect(() =>
        manager.onHostLost(async ({ tasks }) => {
          const { revokeTaskFileOperations } = await import(
            "../execution/scoped-filesystem.js"
          );
          const results = await Promise.allSettled(
            tasks.flatMap((task) => [
              ctx.get("agentRuns").cancelTaskRuns(task.taskId),
              revokeTaskFileOperations(task.workspaceId, task.taskId),
            ]),
          );
          const failure = results.find(
            (result) => result.status === "rejected",
          );
          if (failure?.status === "rejected") throw failure.reason;
        }),
      );
      ctx.effect(() =>
        ctx.get("executionScopes").onRevoke(async ({ previous, next }) => {
          if (!losesExecutionRights(previous, next)) return;
          // 仅停止受收紧影响的后台工作；扩权不放大旧 executor 的派发上限。
          const context = {
            scope: previous,
            agentId: "host",
            runId: "scope-revoke",
            branchGeneration: 1,
          };
          const records = await manager.list(context);
          const results = await Promise.allSettled(
            records
              .filter(
                (record) =>
                  record.status === "running" &&
                  losesExecutionRights(record.scope, next),
              )
              .map((record) =>
                manager.stop(context, record.id, "Task 目录或权限已收紧"),
              ),
          );
          const failure = results.find(
            (result) => result.status === "rejected",
          );
          if (failure?.status === "rejected") throw failure.reason;
        }),
      );
    },
  };
}
