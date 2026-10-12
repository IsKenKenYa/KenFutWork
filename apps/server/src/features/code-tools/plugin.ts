import type {
  PluginDefinition,
  RunToolResolutionContext,
  ToolDefinition,
} from "../../kernel/types.js";
import { runFileOperation } from "../code-tools/file-operations.js";
import { createPersistSandboxFileToolDefinition } from "./persist-sandbox-file.js";
import { loadCodeProjectContext } from "./project-instructions.js";
import { createProjectSearchToolDefinition } from "./project-search.js";
import {
  codeModePromptSection,
  taskWorkDirectoryPromptSection,
} from "./prompt.js";
import { createCodeFileTools } from "./tool-definitions.js";

const coreNames = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "ApplyPatch",
  "preview_file",
  "diff_files",
];

export function createCodeToolsPlugin(): PluginDefinition {
  return {
    name: "code-tools",
    inject: ["blob"],
    apply(ctx) {
      const tools = ctx.get("tools");
      const perRun = new WeakMap<RunToolResolutionContext, ToolDefinition[]>();
      const requireScope = (run: RunToolResolutionContext) => {
        if (!run.scopeHandle)
          throw new Error("文件工具必须绑定真实Task执行作用域");
        if (run.scopeHandle.preset !== run.preset)
          throw new Error("工具工作模式与可信Task作用域不匹配");
        return run.scopeHandle;
      };
      const resolveFiles = (run: RunToolResolutionContext) => {
        const handle = requireScope(run);
        const existing = perRun.get(run);
        if (existing) return existing;
        const role = handle.role;
        const readonly =
          role === "explore" ||
          role === "review" ||
          handle.describe().sandboxMode === "read-only";
        const files = createCodeFileTools({
          backend: handle.backend,
          modelCapabilities: run.modelCapabilities ?? {
            image: false,
            pdf: false,
          },
        })
          .filter((tool) => !readonly || tool.access === "read")
          .map((tool) => ({ ...tool, scope: "shared" as const }));
        perRun.set(run, files);
        return files;
      };
      for (const name of coreNames)
        tools.registerDynamic({
          id: `code.files.${name}`,
          scope: "shared",
          resolve: (run) =>
            resolveFiles(run).find((tool) => tool.name === name) ?? null,
        });
      ctx.get("systemPrompt").register(codeModePromptSection);
      ctx.get("systemPrompt").register(taskWorkDirectoryPromptSection);
      ctx.get("capabilities").register("code-project-context", {
        id: "code-tools:project-context",
        value: loadCodeProjectContext,
      });
      tools.registerDynamic({
        id: "workspace.project-search",
        scope: "design",
        resolve: (run) => ({
          ...createProjectSearchToolDefinition({
            backend: requireScope(run).backend,
          }),
          access: "read",
          scope: "design",
        }),
      });
      tools.registerDynamic({
        id: "workspace.persist-sandbox-file",
        scope: "design",
        resolve: (run) => {
          const handle = requireScope(run);
          if (
            handle.role === "explore" ||
            handle.role === "review" ||
            handle.describe().sandboxMode === "read-only"
          )
            return null;
          const tool = createPersistSandboxFileToolDefinition({
            blob: ctx.get("blob"),
          });
          return {
            ...tool,
            access: "write",
            scope: "design",
            execute: (args, execution) =>
              runFileOperation(handle, execution.signal, async (signal) => {
                const filePath = await handle.resolvePath(
                  String(args.filePath),
                  "read",
                );
                signal.throwIfAborted();
                const result = await tool.execute(
                  { ...args, filePath },
                  execution,
                );
                signal.throwIfAborted();
                return result;
              }),
          };
        },
      });
    },
  };
}
