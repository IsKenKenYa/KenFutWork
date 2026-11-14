import {
  codeProjectEditorDeleteArgsSchema,
  codeProjectEditorReadDirectorySchema,
  codeProjectEditorReadProjectsSchema,
  codeProjectEditorReadTreeArgsSchema,
  codeProjectEditorSaveArgsSchema,
  codeProjectPrepareSessionArgsSchema,
} from "@kenfutwork/shared";
import type { PluginDefinition } from "../../kernel/types.js";
import {
  CODE_UI_HOST_RPC_CAPABILITY,
  type CodeUiHostRpcHandler,
  runCodeUiHostRpc,
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
        async readTree(actor, args, context) {
          const [input] = codeProjectEditorReadTreeArgsSchema.parse(args);
          return service.readTree(actor, input ?? {}, context.signal);
        },
        async prepareSession(actor, args, context) {
          const [input] = codeProjectPrepareSessionArgsSchema.parse(args);
          return service.prepareSession(actor, input, context);
        },
        async readDirectory(actor, args, context) {
          return service.readDirectory(
            actor,
            codeProjectEditorReadDirectorySchema.parse(args[0] ?? {}),
            context,
          );
        },
        async saveProject(actor, args, context) {
          const [input] = codeProjectEditorSaveArgsSchema.parse(args);
          return service.saveProject(actor, input, context.signal);
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
                  return runCodeUiHostRpc(context, () =>
                    call(actor, args, context),
                  );
                },
              },
            }),
        );
    },
  };
}
