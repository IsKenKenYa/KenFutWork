import {
  codeProjectEditorDeleteArgsSchema,
  codeProjectEditorReadDirectorySchema,
  codeProjectEditorReadProjectsSchema,
  codeProjectEditorSaveSchema,
} from "@kenfutwork/shared";
import type { PluginDefinition } from "../../kernel/types.js";
import {
  CODE_UI_HOST_RPC_CAPABILITY,
  CodeUiHostRpcError,
  type CodeUiHostRpcHandler,
} from "../code-ui/host-rpc-handler.js";
import { createProjectEditorRepository } from "./project-editor-repository.js";
import { createProjectEditorService } from "./project-editor-service.js";

export function createProjectEditorPlugin(): PluginDefinition {
  return {
    name: "projects:editor",
    inject: [
      "codeUi",
      "persistence",
      "localInstance",
      "projects",
      "capabilities",
    ],
    apply() {},
    mounted(ctx) {
      const service = createProjectEditorService({
        repository: createProjectEditorRepository(ctx.get("persistence")),
        localInstance: ctx.get("localInstance"),
        projects: ctx.get("projects"),
        codeUi: ctx.get("codeUi"),
      });
      const methods: Record<string, CodeUiHostRpcHandler["call"]> = {
        async readProjects(actor, args) {
          codeProjectEditorReadProjectsSchema.parse(args[0] ?? {});
          return service.readProjects(actor);
        },
        async readDirectory(actor, args, context) {
          return service.readDirectory(
            actor,
            codeProjectEditorReadDirectorySchema.parse(args[0] ?? {}),
            context,
          );
        },
        async saveProject(actor, args, context) {
          return service.saveProject(
            actor,
            codeProjectEditorSaveSchema.parse(args[0]),
            context.signal,
          );
        },
        async deleteProject(actor, args) {
          const [projectId] = codeProjectEditorDeleteArgsSchema.parse([
            args[0],
            args[1],
          ]);
          await service.deleteProject(actor, projectId);
          return null;
        },
      };
      for (const [method, call] of Object.entries(methods))
        ctx.effect(() =>
          ctx
            .get("capabilities")
            .register<CodeUiHostRpcHandler>(CODE_UI_HOST_RPC_CAPABILITY, {
              id: `project.${method}`,
              value: {
                async call(actor, args, context) {
                  context.requireInitialized();
                  context.signal.throwIfAborted();
                  const operation = call(actor, args, context);
                  // 错误由原 RPC 返回，关闭只等待此调用结束。
                  const release = context.onClose(() =>
                    operation.then(
                      () => undefined,
                      () => undefined,
                    ),
                  );
                  try {
                    const result = await operation;
                    context.signal.throwIfAborted();
                    return result;
                  } catch (error) {
                    if (context.signal.aborted)
                      throw new CodeUiHostRpcError(
                        "code_ui_not_found",
                        "连接已关闭，请重新连接工作台。",
                        404,
                      );
                    throw error;
                  } finally {
                    release();
                  }
                },
              },
            }),
        );
    },
  };
}
