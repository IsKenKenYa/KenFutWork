import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createBrandKitToolDefinition } from "../features/brand-kit/brand-kit-tool.js";
import { brandKitPlugin } from "../features/brand-kit/plugin.js";
import {
  createCanvasPlugin,
  createCanvasToolsPlugin,
} from "../features/canvas/plugin.js";
import {
  createInspectCanvasToolDefinition,
  createManipulateCanvasToolDefinition,
  createScreenshotCanvasToolDefinition,
} from "../features/canvas/tools/index.js";
import { createPersistSandboxFileToolDefinition } from "../features/code-tools/persist-sandbox-file.js";
import { createCodeToolsPlugin } from "../features/code-tools/plugin.js";
import { createProjectSearchToolDefinition } from "../features/code-tools/project-search.js";
import type { DesignTasksService } from "../features/execution/design-task-types.js";
import { createDesignTasksPlugin } from "../features/execution/design-tasks-plugin.js";
import { createExecutionScopes } from "../features/execution/scope-service.js";
import { createGenerationPlugin } from "../features/generation/plugin.js";
import { createImageGenerateToolDefinition } from "../features/generation/tools/image-generate.js";
import { createVideoGenerateToolDefinition } from "../features/generation/tools/video-generate.js";
import { createConsumerLocalAccessService } from "../features/local-access/test-consumer-service.js";
import { createLocalInstanceService } from "../features/local-instance/service.js";
import type { LocalActor } from "../features/local-instance/types.js";
import type { ProjectFileService } from "../features/project-files/types.js";
import type { ProjectService } from "../features/projects/project-service.js";
import type { ProjectDetailRow } from "../features/projects/repository.js";
import { ConnectionManager } from "../ws/connection-manager.js";
import { AgentRunEventBus, ToolRegistryImpl } from "./context.js";
import type { ToolDefinition } from "./types.js";

function def(name: string, scope: ToolDefinition["scope"]): ToolDefinition {
  return {
    name,
    description: "",
    scope,
    parameters: { type: "object" },
    execute: async () => name,
  };
}

function resolutionCtx() {
  return {
    preset: "design" as const,
    backendFactory: (() => ({})) as never,
  };
}

describe("ToolRegistry 动态工具缝", () => {
  it("静态 list(preset) + 动态解析合并；scope 过滤对动态同样生效", () => {
    const registry = new ToolRegistryImpl(new AgentRunEventBus());
    registry.register(def("static_design", "design"));
    registry.register(def("static_shared", "shared"));
    registry.registerDynamic({
      id: "dyn.design",
      scope: "design",
      resolve: () => def("dyn_design_tool", "design"),
    });
    registry.registerDynamic({
      id: "dyn.shared",
      scope: "shared",
      resolve: () => def("dyn_shared_tool", "shared"),
    });

    const designNames = registry
      .resolveRunTools({ ...resolutionCtx(), preset: "design" })
      .map((tool) => tool.name);
    expect(designNames).toEqual(
      expect.arrayContaining([
        "static_design",
        "static_shared",
        "dyn_design_tool",
        "dyn_shared_tool",
      ]),
    );

    const codeNames = registry
      .resolveRunTools({ ...resolutionCtx(), preset: "code" })
      .map((tool) => tool.name);
    expect(codeNames).toEqual(["static_shared", "dyn_shared_tool"]);
  });

  it("resolve 返回 null = 本 run 不装配；重名 id fail loud；disposer 注销", () => {
    const registry = new ToolRegistryImpl(new AgentRunEventBus());
    registry.registerDynamic({
      id: "dyn.optional",
      scope: "shared",
      resolve: () => null,
    });
    expect(
      registry.resolveRunTools({ ...resolutionCtx(), preset: "code" }),
    ).toEqual([]);

    registry.registerDynamic({
      id: "dyn.dup",
      scope: "shared",
      resolve: () => null,
    });
    expect(() =>
      registry.registerDynamic({
        id: "dyn.dup",
        scope: "shared",
        resolve: () => null,
      }),
    ).toThrow(/动态工具 dyn.dup 重复注册/);

    const dispose = registry.registerDynamic({
      id: "dyn.temp",
      scope: "shared",
      resolve: () => def("dyn_temp_tool", "shared"),
    });
    dispose();
    expect(
      registry
        .resolveRunTools({ ...resolutionCtx(), preset: "code" })
        .map((tool) => tool.name),
    ).not.toContain("dyn_temp_tool");
  });

  it("executeDefinition：动态产物走 guarded 执行（tool-pre-execute 拦截生效）", async () => {
    const registry = new ToolRegistryImpl(new AgentRunEventBus());
    const bus = (registry as unknown as { events: AgentRunEventBus }).events;
    bus.on("tool-pre-execute", async (payload, next) => {
      if (payload.toolName === "dyn_dangerous") {
        return { ...payload, decision: "deny", denyReason: "测试拒绝" };
      }
      return next(payload);
    });
    registry.registerDynamic({
      id: "dyn.dangerous",
      scope: "shared",
      resolve: () => def("dyn_dangerous", "shared"),
    });
    const tool = registry
      .resolveRunTools({ ...resolutionCtx(), preset: "code" })
      .find((entry) => entry.name === "dyn_dangerous");
    if (!tool) throw new Error("Registered dynamic Consumer missing");
    await expect(registry.executeDefinition(tool, {}, {})).rejects.toThrow(
      /被 tool-pre-execute 拦截拒绝/,
    );
    // 静态 execute 路径复用同一 guarded 实现
    registry.register(def("dyn_dangerous", "shared"));
    await expect(registry.execute("dyn_dangerous", {}, {})).rejects.toThrow(
      /被 tool-pre-execute 拦截拒绝/,
    );
  });
});

/**
 * 模式工具面契约（动态缝版）：注册四家 feature 的真实贡献（canvas/brand-kit
 * 静态、generation/code-tools 动态——动态 resolve 以真实工厂实例化），
 * Code 会话工具面结构性不含画布/生图能力。
 */
describe("内置工具的模式工具面（静态+动态装配契约）", () => {
  async function registryWithBuiltins() {
    const registry = new ToolRegistryImpl(new AgentRunEventBus());
    const instanceId = "00000000-0000-4000-8000-000000000001";
    const projectId = "00000000-0000-4000-8000-000000000002";
    const designTaskId = "00000000-0000-4000-8000-000000000003";
    const codeTaskId = "00000000-0000-4000-8000-000000000004";
    const actor = { instanceId, accessClientId: null };
    const localInstance = createLocalInstanceService({
      repository: { ensure: async () => instanceId },
      dataDir: tmpdir(),
    });
    const rootDirectory = realpathSync(tmpdir());
    const makeScope = (taskId: string) => ({
      instanceId,
      projectId,
      taskId,
      generation: 1,
      rootDirectory,
      additionalDirectories: [],
      sandboxMode: "workspace-write" as const,
    });
    const designTasks: Pick<DesignTasksService, "readPolicy"> = {
      readPolicy: async (_actor, taskId) => ({
        taskId,
        projectId,
        canvasId: "canvas-1",
        rootDirectory,
        additionalDirectories: [],
        sandboxMode: "workspace-write",
        scopeGeneration: 1,
        branchGeneration: 1,
        mode: "build",
        planEnabled: false,
        planningEpoch: 0,
        activeRunId: "run-1",
        executionState: "ready",
      }),
    };
    const handleFor = async (taskId: string, preset: "code" | "design") =>
      createExecutionScopes({
        localInstance,
        repository: {
          load: async () => ({
            preset,
            scope: makeScope(taskId),
            state: "ready",
            branchGeneration: 1,
          }),
        },
      }).openTask(actor, taskId);
    registry.register(
      createInspectCanvasToolDefinition({ localInstance, designTasks }),
    );
    registry.register(
      createManipulateCanvasToolDefinition({ localInstance, designTasks }),
    );
    registry.register(
      createScreenshotCanvasToolDefinition({
        connectionManager: new ConnectionManager(),
        localInstance,
        designTasks,
        blob: {} as never,
        projectFiles: {} as never,
      }),
    );
    registry.register(
      createBrandKitToolDefinition({
        brandKitService: {} as never,
        localInstance,
      }),
    );
    // 动态四条：与各插件 apply 内同一工厂（backend/沙箱以 stub 满足签名）
    registry.registerDynamic({
      id: "generation.image",
      scope: "design",
      resolve: () => createImageGenerateToolDefinition(),
    });
    registry.registerDynamic({
      id: "generation.video",
      scope: "design",
      resolve: () => createVideoGenerateToolDefinition(),
    });
    registry.registerDynamic({
      id: "workspace.project-search",
      scope: "shared",
      resolve: () =>
        createProjectSearchToolDefinition({ backend: {} as never }),
    });
    registry.registerDynamic({
      id: "workspace.persist-sandbox-file",
      scope: "shared",
      resolve: () =>
        createPersistSandboxFileToolDefinition({ blob: {} as never }),
    });
    return {
      registry,
      designHandle: await handleFor(designTaskId, "design"),
      codeHandle: await handleFor(codeTaskId, "code"),
    };
  }

  it("code 工具面：无画布/生图（静态与动态都不出现）", async () => {
    const { registry, codeHandle } = await registryWithBuiltins();
    const names = registry
      .resolveRunTools({
        ...resolutionCtx(),
        preset: "code",
        scopeHandle: codeHandle,
      })
      .map((tool) => tool.name);

    expect(names).toEqual([]);
    for (const forbidden of [
      "inspect_canvas",
      "manipulate_canvas",
      "screenshot_canvas",
      "get_brand_kit",
      "generate_image",
      "generate_video",
    ]) {
      expect(names, `${forbidden} 不得进入 code 工具面`).not.toContain(
        forbidden,
      );
    }
  });

  it("design 工具面：画布三件+品牌+生图生频+shared 全量", async () => {
    const { registry, designHandle } = await registryWithBuiltins();
    const names = registry
      .resolveRunTools({
        ...resolutionCtx(),
        preset: "design",
        scopeHandle: designHandle,
      })
      .map((tool) => tool.name);

    // 顺序（静态先、动态按注册序）不是契约；齐全性才是
    expect(names.slice().sort()).toEqual(
      [
        "inspect_canvas",
        "manipulate_canvas",
        "screenshot_canvas",
        "get_brand_kit",
        "project_search",
        "persist_sandbox_file",
        "generate_image",
        "generate_video",
      ].sort(),
    );
  });

  it("Canvas Provider 与 Consumer 在真实 compose 中贡献齐全（漏注册即红）", async () => {
    const Fastify = (await import("fastify")).default;
    const { composePlugins } = await import("./compose.js");
    const app = Fastify();
    const blobStub = {
      bucket: () => ({
        upload: async () => {},
        resolveUrl: async () => "https://blob.test/x",
        getPublicUrl: () => "https://blob.test/x",
        createSignedUrl: async () => "https://blob.test/x",
      }),
    } as never;
    const persistenceStub = {
      execute: async () => ({ rows: [] }),
      forInstance: () => ({
        execute: async () => ({ rows: [] }),
        query: async () => [],
      }),
      query: async () => [],
    } as never;
    const env = {
      agentBackendMode: "state",
      agentModel: "test-model",
      port: 0,
      version: "test",
      webOrigin: "http://localhost:3000",
    } as never;
    const projects = {
      getProject: async (
        _actor: LocalActor,
        projectId: string,
      ): Promise<ProjectDetailRow> => ({
        id: projectId,
        kind: "design",
        enabled_modes: ["design"],
        name: "测试项目",
        slug: "test-project",
        description: null,
        instance_id: "00000000-0000-4000-8000-000000000001",
        brand_kit_id: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        work_dir: null,
        additional_directories: [],
      }),
    } satisfies Pick<ProjectService, "getProject">;
    const projectFiles = {
      describe: async () => {
        throw new Error("此工具面装配测试不查询项目文件");
      },
      prepareWrite: async () => {
        throw new Error("此工具面装配测试不写项目文件");
      },
      publish: async () => {
        throw new Error("此工具面装配测试不发布项目文件");
      },
      read: async () => {
        throw new Error("此工具面装配测试不读项目文件");
      },
      move: async () => {
        throw new Error("此工具面装配测试不移动项目文件");
      },
      remove: async () => {
        throw new Error("此工具面装配测试不删除项目文件");
      },
      inspect: async () => {
        throw new Error("工具面测试不检查素材");
      },
      relink: async () => {
        throw new Error("工具面测试不重关联素材");
      },
      restoreIndex: async () => {
        throw new Error("工具面测试不恢复索引");
      },
      namespaceProvider: {
        upload: async () => {},
        download: async () => new Uint8Array(),
        copy: async () => {},
        remove: async () => {},
      },
    } satisfies ProjectFileService;

    const kernel = composePlugins(
      env,
      [
        brandKitPlugin,
        createCanvasPlugin(),
        createDesignTasksPlugin(),
        createCanvasToolsPlugin(),
        createCodeToolsPlugin(),
        createGenerationPlugin({ env }),
      ],
      {
        app,
        overrides: {
          designGoals: {
            lifecycle: {
              claim: async () => {},
              settle: async () => {},
              pause: async () => {},
              recover: async () => {},
              rebranch: async () => {},
            },
          } as never,
          localAccess: createConsumerLocalAccessService(),
          blob: blobStub,
          persistence: persistenceStub,
          localInstance: createLocalInstanceService({
            repository: {
              ensure: async () => "00000000-0000-4000-8000-000000000001",
            },
            dataDir: tmpdir(),
          }),
          ws: { connectionManager: {} as never, eventBuffer: {} as never },
          usage: { record: async () => {} } as never,
          uploads: {} as never,
          jobs: {} as never,
          modelCatalog: { listCatalog: async () => ({ entries: [] }) } as never,
          modelProviders: {} as never,
          projects: projects as never,
          projectFiles,
        },
      },
    );
    let toolDirectory: string | undefined;
    try {
      const tools = kernel.get("tools");
      const { mkdtemp, realpath } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { createExecutionScopes } = await import(
        "../features/execution/scope-service.js"
      );
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), "kfw-tool-mode-")),
      );
      toolDirectory = directory;
      const scope = {
        instanceId: "00000000-0000-4000-8000-000000000001",
        projectId: "00000000-0000-4000-8000-000000000002",
        taskId: "00000000-0000-4000-8000-000000000003",
        generation: 1,
        rootDirectory: directory,
        additionalDirectories: [],
        sandboxMode: "workspace-write" as const,
      };
      const handle = await createExecutionScopes({
        repository: {
          load: async () => ({
            preset: "code",
            scope,
            state: "ready",
            branchGeneration: 1,
          }),
        },
        localInstance: {
          resolve: async () => ({
            instanceId: scope.instanceId,
            dataDir: directory,
          }),
        } as never,
      }).openTask(
        { instanceId: scope.instanceId, accessClientId: null },
        scope.taskId,
      );
      const designScope = {
        ...scope,
        taskId: "00000000-0000-4000-8000-000000000004",
      };
      const designHandle = await createExecutionScopes({
        repository: {
          load: async () => ({
            preset: "design",
            scope: designScope,
            state: "ready",
            branchGeneration: 1,
          }),
        },
        localInstance: {
          resolve: async () => ({
            instanceId: designScope.instanceId,
            dataDir: directory,
          }),
        } as never,
      }).openTask(
        { instanceId: designScope.instanceId, accessClientId: null },
        designScope.taskId,
      );
      const designNames = tools
        .resolveRunTools({
          ...resolutionCtx(),
          preset: "design",
          scopeHandle: designHandle,
        })
        .map((tool) => tool.name);
      expect(designNames).toEqual(
        expect.arrayContaining([
          "inspect_canvas",
          "manipulate_canvas",
          "screenshot_canvas",
          "get_brand_kit",
          "project_search",
          "persist_sandbox_file",
          "generate_image",
          "generate_video",
        ]),
      );
      // 文件工作能力共享，但实际Task/Canvas模式仍隔离。
      expect(designNames).toEqual(
        expect.arrayContaining([
          "Read",
          "Write",
          "Edit",
          "ApplyPatch",
          "Glob",
          "Grep",
          "preview_file",
          "diff_files",
        ]),
      );
      // code 面含 code 能力层工具、不含画布/生图
      const codeNames = tools
        .resolveRunTools({
          ...resolutionCtx(),
          preset: "code",
          scopeHandle: handle,
        })
        .map((tool) => tool.name);
      expect(codeNames).toEqual(
        expect.arrayContaining([
          "preview_file",
          "diff_files",
          "Read",
          "Write",
          "Edit",
          "ApplyPatch",
          "Glob",
          "Grep",
        ]),
      );
      expect(codeNames).not.toContain("inspect_canvas");
      expect(codeNames).not.toContain("generate_image");
      expect(codeNames).not.toContain("project_search");
      expect(codeNames).not.toContain("persist_sandbox_file");
    } finally {
      if (toolDirectory)
        await (await import("node:fs/promises")).rm(toolDirectory, {
          recursive: true,
          force: true,
        });
      kernel.dispose();
      await app.close();
    }
  });
});
