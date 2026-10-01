import { describe, expect, it } from "vitest";
import { createBrandKitToolDefinition } from "../features/brand-kit/brand-kit-tool.js";
import { brandKitPlugin } from "../features/brand-kit/plugin.js";
import { createCanvasPlugin } from "../features/canvas/plugin.js";
import {
  createInspectCanvasToolDefinition,
  createManipulateCanvasToolDefinition,
  createScreenshotCanvasToolDefinition,
} from "../features/canvas/tools/index.js";
import { createPersistSandboxFileToolDefinition } from "../features/code-tools/persist-sandbox-file.js";
import { createCodeToolsPlugin } from "../features/code-tools/plugin.js";
import { createProjectSearchToolDefinition } from "../features/code-tools/project-search.js";
import { createGenerationPlugin } from "../features/generation/plugin.js";
import { createImageGenerateToolDefinition } from "../features/generation/tools/image-generate.js";
import { createVideoGenerateToolDefinition } from "../features/generation/tools/video-generate.js";
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
    const tool = def("dyn_dangerous", "shared");
    await expect(registry.executeDefinition(tool, {}, {})).rejects.toThrow(
      /dyn_dangerous/,
    );
    // 静态 execute 路径复用同一 guarded 实现
    registry.register(tool);
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
  function registryWithBuiltins() {
    const registry = new ToolRegistryImpl(new AgentRunEventBus());
    registry.register(createInspectCanvasToolDefinition({}));
    registry.register(createManipulateCanvasToolDefinition({}));
    registry.register(
      createScreenshotCanvasToolDefinition({ connectionManager: {} as never }),
    );
    registry.register(
      createBrandKitToolDefinition({ brandKitService: {} as never }),
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
    return registry;
  }

  it("code 工具面：无画布/生图（静态与动态都不出现）", () => {
    const names = registryWithBuiltins()
      .resolveRunTools({ ...resolutionCtx(), preset: "code" })
      .map((tool) => tool.name);

    expect(names).toEqual(["project_search", "persist_sandbox_file"]);
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

  it("design 工具面：画布三件+品牌+生图生频+shared 全量", () => {
    const names = registryWithBuiltins()
      .resolveRunTools({ ...resolutionCtx(), preset: "design" })
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

  it("四家插件在真实 compose 中贡献齐全（装配缝：漏注册即红）", async () => {
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
      forWorkspace: () => ({
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

    const kernel = composePlugins(
      env,
      [
        brandKitPlugin,
        createCanvasPlugin(),
        createCodeToolsPlugin(),
        createGenerationPlugin({ env }),
      ],
      {
        app,
        overrides: {
          auth: { authenticate: async () => null } as never,
          blob: blobStub,
          persistence: persistenceStub,
          viewer: { resolveWorkspace: async () => null } as never,
          ws: { connectionManager: {} as never, eventBuffer: {} as never },
          credits: {} as never,
          tierGuard: { guard: async () => {} } as never,
          uploads: {} as never,
          jobs: {} as never,
          modelCatalog: { listCatalog: async () => ({ entries: [] }) } as never,
          modelProviders: {} as never,
        },
      },
    );
    try {
      const tools = kernel.get("tools");
      const designNames = tools
        .resolveRunTools({ ...resolutionCtx(), preset: "design" })
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
      // code 能力层工具（preview/diff）不进 design 面
      expect(designNames).not.toContain("preview_file");
      // code 面含 code 能力层工具、不含画布/生图
      const codeNames = tools
        .resolveRunTools({ ...resolutionCtx(), preset: "code" })
        .map((tool) => tool.name);
      expect(codeNames).toEqual(
        expect.arrayContaining([
          "preview_file",
          "diff_files",
          "project_search",
          "persist_sandbox_file",
        ]),
      );
      expect(codeNames).not.toContain("inspect_canvas");
      expect(codeNames).not.toContain("generate_image");
    } finally {
      kernel.dispose();
      await app.close();
    }
  });
});
