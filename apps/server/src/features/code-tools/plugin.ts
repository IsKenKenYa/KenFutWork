import type { BackendProtocolV2 } from "deepagents";
import type {
  PluginDefinition,
  RunToolResolutionContext,
  ToolDefinition,
} from "../../kernel/types.js";
import { createPersistSandboxFileToolDefinition } from "./persist-sandbox-file.js";
import { loadCodeProjectContext } from "./project-instructions.js";
import { createProjectSearchToolDefinition } from "./project-search.js";
import { codeModePromptSection } from "./prompt.js";
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
      const resolveFiles = (run: RunToolResolutionContext) => {
        if (!run.scopeHandle)
          throw new Error("Code 文件工具必须绑定真实 Task 执行作用域");
        const existing = perRun.get(run);
        if (existing) return existing;
        const role = run.scopeHandle.role;
        const readonly =
          role === "explore" ||
          role === "review" ||
          run.scopeHandle.describe().sandboxMode === "read-only";
        const files = createCodeFileTools({
          backend: run.scopeHandle.backend,
          modelCapabilities: run.modelCapabilities ?? {
            image: false,
            pdf: false,
          },
        }).filter((tool) => !readonly || tool.access === "read");
        perRun.set(run, files);
        return files;
      };
      for (const name of coreNames)
        tools.registerDynamic({
          id: `code.files.${name}`,
          scope: "code",
          resolve: (run) =>
            resolveFiles(run).find((tool) => tool.name === name) ?? null,
        });
      ctx.get("systemPrompt").register(codeModePromptSection);
      ctx.get("capabilities").register("code-project-context", {
        id: "code-tools:project-context",
        value: loadCodeProjectContext,
      });
      tools.registerDynamic({
        id: "workspace.project-search",
        scope: "design",
        resolve: (run) => ({
          ...createProjectSearchToolDefinition({
            backend: run.backendFactory({
              ...(run.store ? { store: run.store } : {}),
              state: {},
            } as never) as BackendProtocolV2,
          }),
          scope: "design",
        }),
      });
      tools.registerDynamic({
        id: "workspace.persist-sandbox-file",
        scope: "design",
        resolve: (run) => ({
          ...createPersistSandboxFileToolDefinition({
            blob: ctx.get("blob"),
            ...(run.sandboxDir ? { sandboxDir: run.sandboxDir } : {}),
          }),
          scope: "design",
        }),
      });
    },
  };
}
