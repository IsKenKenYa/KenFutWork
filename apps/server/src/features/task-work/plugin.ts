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
                .getInstanceSettings(context.actor, context.scope.instanceId)
            ).subagentMaxConcurrency;
          },
        }),
      );
      const commands = new Map<
        "code" | "design",
        ReturnType<typeof createTaskCommandTools>
      >();
      const getCommands = (ownerKind: "code" | "design") => {
        let tools = commands.get(ownerKind);
        if (!tools) {
          tools = createTaskCommandTools(
            {
              manager: ctx.get("taskWork"),
              sandbox: ctx.get("processSandbox"),
              settings: ctx.get("settings"),
              ...(ownerKind === "code"
                ? {
                    historicalOutputs: {
                      read: (context, id, offset, maxBytes) =>
                        ctx
                          .get("codeUi")
                          .outputHistory.read(context, id, offset, maxBytes),
                      manifest: (context) =>
                        ctx.get("codeUi").outputHistory.manifest(context),
                    },
                  }
                : {}),
            },
            { scope: ownerKind },
          );
          commands.set(ownerKind, tools);
        }
        return tools;
      };
      for (const ownerKind of ["code", "design"] as const) {
        for (const name of ["Bash", "TaskOutput", "TaskInput", "TaskStop"]) {
          ctx.get("tools").registerDynamic({
            id: `task-work:${ownerKind}:${name}`,
            scope: ownerKind,
            resolve(run) {
              if (
                !run.scopeHandle ||
                run.scopeHandle.preset !== ownerKind ||
                (run.taskWorkContext?.ownerKind ?? "code") !== ownerKind
              )
                return null;
              if (
                (run.scopeHandle.role === "explore" ||
                  run.scopeHandle.role === "review") &&
                (name === "Bash" || name === "TaskInput")
              )
                return null;
              const tool = getCommands(ownerKind).tools.find(
                (entry) => entry.name === name,
              );
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
      }
      ctx.get("capabilities").register("task-close", {
        id: "task-work:command-handles",
        value: {
          close(instanceId: string, taskId: string) {
            for (const tools of commands.values())
              tools.forgetTask(instanceId, taskId);
          },
        },
      });
      ctx.get("capabilities").register("process-snapshot", {
        id: "task-work:durable-output",
        value: {
          receive: (
            snapshot: import("../process-sandbox/types.js").ManagedProcessSnapshot,
          ) =>
            Promise.all(
              [...commands.values()].map((tools) =>
                tools.acceptSnapshot(snapshot),
              ),
            ).then(() => {}),
        },
      });
    },
    mounted(ctx) {
      const manager = ctx.get("taskWork");
      ctx.app.addHook("onReady", async () => {
        await manager.initialize();
      });
      ctx.app.addHook("preClose", async () => {
        console.log("[shutdown] 关闭TaskWork执行宿主。");
        await manager.close("执行宿主关闭");
        console.log("[shutdown] TaskWork执行宿主已关闭。");
      });
      ctx.effect(() =>
        manager.onChanged((record) =>
          (record.ownerKind ?? "code") === "code"
            ? ctx.get("codeUi").onTaskWorkChanged(record)
            : Promise.resolve(),
        ),
      );
      ctx.effect(() =>
        manager.onReady(({ instanceId, taskId, ownerKind }) =>
          ownerKind === "code"
            ? ctx.get("codeUi").resumeTaskWork(instanceId, taskId)
            : Promise.resolve(false),
        ),
      );
      ctx.effect(() =>
        ctx
          .get("executionScopes")
          .onUpdated(({ next }) =>
            manager.notifyReady(next.instanceId, next.taskId),
          ),
      );
      ctx.effect(() =>
        manager.onHostLost(async ({ tasks }) => {
          const { revokeTaskFileOperations } = await import(
            "../execution/scoped-filesystem.js"
          );
          const results = await Promise.allSettled(
            tasks
              .filter((task) => task.ownerKind === "code")
              .flatMap((task) => [
                ctx.get("agentRuns").cancelTaskRuns(task.taskId),
                revokeTaskFileOperations(task.instanceId, task.taskId),
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
