import { describe, expect, it } from "vitest";

import { ToolRegistryImpl } from "../../kernel/context.js";
import type { KernelEvents } from "../../kernel/types.js";
import { createBrandKitToolDefinition } from "./brand-kit.js";
import { createRunScopedTools } from "./index.js";
import { createInspectCanvasToolDefinition } from "./inspect-canvas.js";
import { createManipulateCanvasToolDefinition } from "./manipulate-canvas.js";
import { createScreenshotCanvasToolDefinition } from "./screenshot-canvas.js";

/**
 * 模式能力分离的装配契约（DEC-2 收敛）：Code 会话的工具面**结构性**不含
 * 画布/生图能力——服务型工具靠注册表 scope 过滤，运行态工具靠装配点 preset
 * 门控。任何一条通路回流画布工具，这两组断言先红。
 */

const DESIGN_ONLY_TOOLS = [
  "inspect_canvas",
  "manipulate_canvas",
  "screenshot_canvas",
  "get_brand_kit",
  "generate_image",
  "generate_video",
];

function dummyBackend() {
  // project_search 只在调用时经 backend grep；装配期不触碰
  return {} as never;
}

function blobStub() {
  return {
    bucket: () => ({
      upload: async () => {},
      resolveUrl: async () => "https://blob.test/x",
      getPublicUrl: () => "https://blob.test/x",
    }),
  } as never;
}

describe("运行态工具装配（createRunScopedTools）", () => {
  it("code preset：只有 project_search 与 persist_sandbox_file，无生图生频", () => {
    const names = createRunScopedTools(
      dummyBackend(),
      { blob: blobStub() },
      "code",
    ).map((tool) => tool.name);

    expect(names).toEqual(["project_search", "persist_sandbox_file"]);
  });

  it("design preset：追加 generate_image 与 generate_video", () => {
    const names = createRunScopedTools(
      dummyBackend(),
      { blob: blobStub() },
      "design",
    ).map((tool) => tool.name);

    expect(names).toEqual([
      "project_search",
      "persist_sandbox_file",
      "generate_image",
      "generate_video",
    ]);
  });
});

describe("服务型画布/品牌工具（内核注册表 scope）", () => {
  function registryWithBuiltIns() {
    const events = {
      emit: async () => {},
      on: () => () => {},
    } as unknown as KernelEvents;
    const registry = new ToolRegistryImpl(events);
    registry.register(createInspectCanvasToolDefinition({}));
    registry.register(createManipulateCanvasToolDefinition({}));
    registry.register(
      createScreenshotCanvasToolDefinition({
        connectionManager: {} as never,
      }),
    );
    registry.register(
      createBrandKitToolDefinition({ brandKitService: {} as never }),
    );
    return registry;
  }

  it("四个工具 scope=design：list('code') 全部排除", () => {
    const codeNames = registryWithBuiltIns()
      .list("code")
      .map((tool) => tool.name);

    for (const name of DESIGN_ONLY_TOOLS.slice(0, 4)) {
      expect(codeNames, `${name} 不得进入 code 工具面`).not.toContain(name);
    }
  });

  it("list('design') 含全部四个", () => {
    const designNames = registryWithBuiltIns()
      .list("design")
      .map((tool) => tool.name);

    expect(designNames).toEqual(
      expect.arrayContaining([
        "inspect_canvas",
        "manipulate_canvas",
        "screenshot_canvas",
        "get_brand_kit",
      ]),
    );
  });
});
