import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../../../kernel/types.js";
import { createLocalInstanceService } from "../../local-instance/service.js";
import type { CanvasRepository, CanvasRow } from "../repository.js";
import { createInspectCanvasToolDefinition } from "./inspect-canvas.js";
import { createManipulateCanvasToolDefinition } from "./manipulate-canvas.js";

const CANVAS_ID = "canvas-1";
const INSTANCE_ID = "instance-1";
const ACTOR = { instanceId: INSTANCE_ID, accessClientId: "client-1" };
const localInstance = createLocalInstanceService({
  repository: { ensure: async () => INSTANCE_ID },
  dataDir: "/tmp/canvas-tool-test",
});

function canvasRow(elements: unknown[]): CanvasRow {
  return {
    id: CANVAS_ID,
    name: "画布",
    project_id: "project-1",
    content: { appState: { viewBackgroundColor: "#fafafa" }, elements },
  };
}

function rect(id: string, x: number, y: number, w = 100, h = 50) {
  return {
    id,
    type: "rectangle",
    x,
    y,
    width: w,
    height: h,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
  };
}

function videoEl(id: string) {
  return {
    id,
    type: "image",
    x: 0,
    y: 0,
    width: 320,
    height: 180,
    customData: {
      isVideo: true,
      durationSeconds: 5,
      mimeType: "video/mp4",
      videoUrl: "https://cdn.test/v.mp4",
    },
  };
}

type RepoOptions = {
  findById?: CanvasRepository["findById"];
  saveContent?: CanvasRepository["saveContent"];
};

function repo(overrides: RepoOptions = {}): CanvasRepository {
  return {
    findById: async () => null,
    findProjectBrandKitId: async () => null,
    saveContent: async () => 1,
    appendContent: async () => 1,
    ...overrides,
  };
}

async function invokeInspect(
  repository: CanvasRepository | undefined,
  execCtx: ToolExecutionContext,
  input: Record<string, unknown> = {},
) {
  const definition = createInspectCanvasToolDefinition({
    localInstance,
    ...(repository ? { canvasRepository: repository } : {}),
  });
  const result = await definition.execute(input, {
    actor: ACTOR,
    instanceId: INSTANCE_ID,
    ...execCtx,
  });
  return JSON.parse(result as string);
}

async function invokeManipulate(
  repository: CanvasRepository | undefined,
  input: Record<string, unknown>,
) {
  const definition = createManipulateCanvasToolDefinition({
    localInstance,
    ...(repository ? { canvasRepository: repository } : {}),
  });
  const result = await definition.execute(input, {
    actor: ACTOR,
    instanceId: INSTANCE_ID,
    canvasId: CANVAS_ID,
  });
  return JSON.parse(result as string);
}

describe("inspect_canvas：内容读取经 canvas repository（不再直连 SDK）", () => {
  it("未知画布上下文 → no_canvas_context（不发任何查询）", async () => {
    const findById = vi.fn();
    const output = await invokeInspect(repo({ findById }), {});

    expect(output.error).toBe("no_canvas_context");
    expect(findById).not.toHaveBeenCalled();
  });

  it("数据访问未接线 → 说清原因，不伪装成画布不存在", async () => {
    const output = await invokeInspect(undefined, { canvasId: CANVAS_ID });

    expect(output.error).toBe("canvas_context_unavailable");
  });

  it("经 projects 父链解析实例后再取内容（回归锁：实例必须传进 findById）", async () => {
    const seen: Array<[string, string]> = [];
    const output = await invokeInspect(
      repo({
        findById: async (instanceId, canvasId) => {
          seen.push([instanceId, canvasId]);
          return canvasRow([rect("r1", 10, 20)]);
        },
      }),
      { canvasId: CANVAS_ID, instanceId: INSTANCE_ID, actor: ACTOR },
    );

    expect(seen).toEqual([[INSTANCE_ID, CANVAS_ID]]);
    expect(output.canvasId).toBe(CANVAS_ID);
    expect(output.elementCount).toBe(1);
    expect(output.viewport).toEqual({ backgroundColor: "#fafafa" });
    expect(output.elements).toEqual([
      {
        id: "r1",
        type: "rectangle",
        x: 10,
        y: 20,
        width: 100,
        height: 50,
      },
    ]);
  });

  it("画布不属本实例（findById 回 null）→ canvas_not_found", async () => {
    const output = await invokeInspect(repo({ findById: async () => null }), {
      canvasId: CANVAS_ID,
    });

    expect(output.error).toBe("canvas_not_found");
  });

  it("存储故障原样传播，不伪装成资源不存在", async () => {
    const failure = new Error("db down");
    await expect(
      invokeInspect(
        repo({
          findById: async () => {
            throw failure;
          },
        }),
        { canvasId: CANVAS_ID },
      ),
    ).rejects.toBe(failure);
  });

  it("已删除元素不进统计，但保留在原始计数之外（elementCount = 存活数）", async () => {
    const output = await invokeInspect(
      repo({
        findById: async () =>
          canvasRow([
            rect("alive", 0, 0),
            { ...rect("dead", 0, 0), isDeleted: true },
          ]),
      }),
      { canvasId: CANVAS_ID, instanceId: INSTANCE_ID, actor: ACTOR },
    );

    expect(output.elementCount).toBe(1);
    expect(output.elements.map((e: { id: string }) => e.id)).toEqual(["alive"]);
  });

  it("element_id 命中给单个元素；未命中给 element_not_found", async () => {
    const hit = await invokeInspect(
      repo({ findById: async () => canvasRow([rect("r1", 1, 2)]) }),
      { canvasId: CANVAS_ID },
      { element_id: "r1" },
    );
    const miss = await invokeInspect(
      repo({ findById: async () => canvasRow([rect("r1", 1, 2)]) }),
      { canvasId: CANVAS_ID },
      { element_id: "nope" },
    );

    expect(hit.id).toBe("r1");
    expect(miss.error).toBe("element_not_found");
  });

  it("filter_type 用逻辑类型：customData.isVideo 的图片元素按 video 匹配", async () => {
    const output = await invokeInspect(
      repo({
        findById: async () => canvasRow([rect("r1", 0, 0), videoEl("v1")]),
      }),
      { canvasId: CANVAS_ID },
      { filter_type: ["video"] },
    );

    expect(output.matchedCount).toBe(1);
    expect(output.elements[0].type).toBe("video");
    expect(output.elements[0].videoUrl).toBe("https://cdn.test/v.mp4");
  });

  it("filter_region 只留与区域相交的元素", async () => {
    const output = await invokeInspect(
      repo({
        findById: async () =>
          canvasRow([rect("inside", 10, 10), rect("outside", 900, 900)]),
      }),
      { canvasId: CANVAS_ID },
      {
        filter_region: { min_x: 0, min_y: 0, max_x: 200, max_y: 200 },
      },
    );

    expect(output.elements.map((e: { id: string }) => e.id)).toEqual([
      "inside",
    ]);
  });
});

describe("manipulate_canvas：读写经 canvas repository", () => {
  it("移动元素后按解析出的实例覆盖写，不回退直连客户端", async () => {
    const saved: Array<[string, string, unknown]> = [];
    const output = await invokeManipulate(
      repo({
        findById: async () => canvasRow([rect("r1", 0, 0)]),
        saveContent: async (instanceId, canvasId, content) => {
          saved.push([instanceId, canvasId, content]);
          return 1;
        },
      }),
      { operations: [{ action: "move", element_id: "r1", x: 33, y: 44 }] },
    );

    expect(output.success).toBe(true);
    expect(output.applied).toBe(1);
    expect(saved).toHaveLength(1);
    const [instanceId, canvasId, content] = saved.at(0) ?? [];
    expect(instanceId).toBe(INSTANCE_ID);
    expect(canvasId).toBe(CANVAS_ID);
    // 写回内容保留原 appState，仅替换 elements
    expect(content).toMatchObject({
      appState: { viewBackgroundColor: "#fafafa" },
      elements: [{ id: "r1", x: 33, y: 44 }],
    });
  });

  it("未知画布上下文 → no_canvas_context（不读写）", async () => {
    const saveContent = vi.fn();
    const definition = createManipulateCanvasToolDefinition({
      localInstance,
      canvasRepository: repo({ saveContent: saveContent as never }),
    });

    const result = await definition.execute(
      { operations: [{ action: "move", element_id: "r1", x: 1, y: 1 }] },
      {},
    );

    expect(JSON.parse(result as string).error).toBe("no_canvas_context");
    expect(saveContent).not.toHaveBeenCalled();
  });

  it("画布不可见 → canvas_not_found，且不发起写入", async () => {
    const saveContent = vi.fn();
    const output = await invokeManipulate(
      repo({ findById: async () => null, saveContent: saveContent as never }),
      { operations: [{ action: "move", element_id: "r1", x: 1, y: 1 }] },
    );

    expect(output.error).toBe("canvas_not_found");
    expect(saveContent).not.toHaveBeenCalled();
  });

  it("失败操作进 errors、不阻断其余操作（部分成功仍写回）", async () => {
    const saved: unknown[] = [];
    const output = await invokeManipulate(
      repo({
        findById: async () => canvasRow([rect("r1", 0, 0)]),
        saveContent: async (_w, _c, content) => {
          saved.push(content);
          return 1;
        },
      }),
      {
        operations: [
          { action: "move", element_id: "missing", x: 1, y: 1 },
          { action: "move", element_id: "r1", x: 5, y: 6 },
        ],
      },
    );

    expect(output.applied).toBe(1);
    expect(output.errors).toEqual(["[skip] element missing not found"]);
    expect(saved).toHaveLength(1);
  });

  it("写入影响 0 行 → write_failed（不谎报成功）", async () => {
    const output = await invokeManipulate(
      repo({
        findById: async () => canvasRow([rect("r1", 0, 0)]),
        saveContent: async () => 0,
      }),
      { operations: [{ action: "move", element_id: "r1", x: 7, y: 8 }] },
    );

    expect(output.error).toBe("write_failed");
  });
});
