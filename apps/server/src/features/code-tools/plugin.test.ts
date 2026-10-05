import { expect, it } from "vitest";
import { loadServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import { createScopedBackend } from "../execution/scoped-filesystem.js";
import { createCodeToolsPlugin } from "./plugin.js";

function scope(role: ExecutionScopeHandle["role"]): ExecutionScopeHandle {
  const input = {
    role,
    agentId: role,
    describe: () => ({
      instanceId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000002",
      taskId: "00000000-0000-4000-8000-000000000003",
      generation: 0,
      rootDirectory: "/tmp/code-plugin-test",
      additionalDirectories: [],
      sandboxMode: "workspace-write" as const,
    }),
    resolvePath: async (path: string) => path,
    derive: () => {
      throw new Error("本用例不派生作用域");
    },
  };
  return { ...input, backend: createScopedBackend(input) };
}

it("profiles mount core file tools by actual Task scope and readonly roles receive no mutation tools", () => {
  const kernel = composePlugins(
    loadServerEnv({}, {}),
    [createCodeToolsPlugin()],
    {
      overrides: {
        blob: {
          bucket: () => {
            throw new Error("Code 文件工具不能上传");
          },
        },
      },
    },
  );
  try {
    const tools = kernel.get("tools");
    expect(() =>
      tools.resolveRunTools({
        preset: "code",
        backendFactory: () => scope("main").backend,
      }),
    ).toThrow(/作用域|scope/i);
    const main = tools.resolveRunTools({
      preset: "code",
      backendFactory: () => scope("main").backend,
      scopeHandle: scope("main"),
      modelCapabilities: { image: false, pdf: false },
    });
    expect(main.map((tool) => tool.name)).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Write",
      "Edit",
      "ApplyPatch",
      "preview_file",
      "diff_files",
    ]);
    expect(main.every((tool) => tool.exposure === "core")).toBe(true);
    const readonly = tools.resolveRunTools({
      preset: "code",
      backendFactory: () => scope("review").backend,
      scopeHandle: scope("review"),
    });
    expect(readonly.map((tool) => tool.name)).toEqual([
      "Read",
      "Glob",
      "Grep",
      "preview_file",
      "diff_files",
    ]);
    expect(readonly.every((tool) => tool.access === "read")).toBe(true);
    const planned = scope("main");
    const describe = planned.describe;
    planned.describe = () => ({ ...describe(), sandboxMode: "read-only" });
    const plan = tools.resolveRunTools({
      preset: "code",
      backendFactory: () => planned.backend,
      scopeHandle: planned,
    });
    expect(plan.map((tool) => tool.name)).toEqual([
      "Read",
      "Glob",
      "Grep",
      "preview_file",
      "diff_files",
    ]);
    const design = tools.resolveRunTools({
      preset: "design",
      backendFactory: () => scope("main").backend,
    });
    expect(design.map((tool) => tool.name)).toEqual([
      "project_search",
      "persist_sandbox_file",
    ]);
  } finally {
    kernel.dispose();
  }
});
