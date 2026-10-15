import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { canvasContentSchema } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../../../kernel/types.js";
import { ConnectionManager } from "../../../ws/connection-manager.js";
import { createExecutionScopes } from "../../execution/scope-service.js";
import { createLocalInstanceService } from "../../local-instance/service.js";
import type { LocalActor } from "../../local-instance/types.js";
import type { ProjectFileWrite } from "../../project-files/types.js";
import type { CanvasDocumentAccess } from "../document-access.js";
import type { CanvasRow } from "../repository.js";
import { createInspectCanvasToolDefinition } from "./inspect-canvas.js";
import { createManipulateCanvasToolDefinition } from "./manipulate-canvas.js";
import { createScreenshotCanvasToolDefinition } from "./screenshot-canvas.js";

const CANVAS_ID = "canvas-1";
const INSTANCE_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const TASK_ID = "00000000-0000-4000-8000-000000000003";
const ACTOR = { instanceId: INSTANCE_ID, accessClientId: "client-1" };
const localInstance = createLocalInstanceService({
  repository: { ensure: async () => INSTANCE_ID },
  dataDir: "/tmp/canvas-tool-test",
});
const scope = {
  instanceId: INSTANCE_ID,
  projectId: PROJECT_ID,
  taskId: TASK_ID,
  generation: 1,
  rootDirectory: realpathSync(tmpdir()),
  additionalDirectories: [],
  sandboxMode: "workspace-write" as const,
};
const scopes = createExecutionScopes({
  localInstance,
  repository: {
    load: async () => ({
      preset: "design",
      scope,
      state: "ready",
      branchGeneration: 1,
    }),
  },
});
const documentAccess: Pick<CanvasDocumentAccess, "authorize"> = {
  authorize: async (context, canvasId, operation) => {
    if (!context.scopeHandle || !context.runId) throw new Error("缺少真实Task");
    if (
      context.canvasId !== context.workContext?.canvasId ||
      context.runId !== "run-1" ||
      (canvasId && canvasId !== CANVAS_ID)
    )
      throw new Error("画布与冻结Run不匹配");
    if (
      operation === "write" &&
      ["explore", "review"].includes(context.scopeHandle.role)
    )
      throw new Error("只读");
    return ACTOR;
  },
};

function canvasRow(elements: unknown[]): CanvasRow {
  return {
    id: CANVAS_ID,
    name: "画布",
    project_id: PROJECT_ID,
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

type TestRepository = {
  findById(instanceId: string, canvasId: string): Promise<CanvasRow | null>;
  saveContent(
    instanceId: string,
    canvasId: string,
    content: unknown,
  ): Promise<number>;
};
function canvasService(repository: TestRepository) {
  return {
    getCanvas: async (actor: LocalActor, id: string) => {
      const row = await repository.findById(actor.instanceId, id);
      return row
        ? {
            id: row.id,
            name: row.name,
            projectId: row.project_id,
            content: canvasContentSchema.parse(row.content),
            revision: "0".repeat(64),
          }
        : (null as never);
    },
    saveCanvasContent: async (
      actor: LocalActor,
      id: string,
      content: unknown,
    ) => {
      if (!(await repository.saveContent(actor.instanceId, id, content)))
        throw new Error("write_failed");
      return { revision: "1".repeat(64), fileReferences: {} };
    },
  };
}

type RepoOptions = {
  findById?: TestRepository["findById"];
  saveContent?: TestRepository["saveContent"];
};

function repo(overrides: RepoOptions = {}): TestRepository {
  return {
    findById: async () => null,
    saveContent: async () => 1,
    ...overrides,
  };
}

async function invokeInspect(
  repository: TestRepository | undefined,
  execCtx: ToolExecutionContext,
  input: Record<string, unknown> = {},
) {
  const definition = createInspectCanvasToolDefinition({
    localInstance,
    documentAccess,
    ...(repository ? { canvasService: canvasService(repository) } : {}),
  });
  const result = await definition.execute(input, {
    actor: ACTOR,
    instanceId: INSTANCE_ID,
    scopeHandle: await scopes.openTask(ACTOR, TASK_ID),
    runId: "run-1",
    workContext: { preset: "design", canvasId: CANVAS_ID },
    ...execCtx,
  });
  return JSON.parse(result as string);
}

async function invokeManipulate(
  repository: TestRepository | undefined,
  input: Record<string, unknown>,
) {
  const definition = createManipulateCanvasToolDefinition({
    localInstance,
    documentAccess,
    ...(repository ? { canvasService: canvasService(repository) } : {}),
  });
  const result = await definition.execute(input, {
    actor: ACTOR,
    instanceId: INSTANCE_ID,
    canvasId: CANVAS_ID,
    scopeHandle: await scopes.openTask(ACTOR, TASK_ID),
    runId: "run-1",
    workContext: { preset: "design", canvasId: CANVAS_ID },
  });
  return JSON.parse(result as string);
}

describe("inspect_canvas：内容读取经 canvas repository（不再直连 SDK）", () => {
  it("缺真实Task、借用其他画布或迟到Run时拒绝，不读取素材", async () => {
    const findById = vi.fn();
    const definition = createInspectCanvasToolDefinition({
      localInstance,
      documentAccess,
      canvasService: canvasService(repo({ findById })),
    });
    await expect(
      definition.execute(
        {},
        {
          actor: ACTOR,
          instanceId: INSTANCE_ID,
          canvasId: CANVAS_ID,
          runId: "run-1",
          workContext: { preset: "design", canvasId: CANVAS_ID },
        },
      ),
    ).rejects.toThrow("真实Task");
    await expect(
      invokeInspect(repo({ findById }), { canvasId: "other-canvas" }),
    ).rejects.toThrow("不匹配");
    await expect(
      invokeInspect(repo({ findById }), {
        canvasId: CANVAS_ID,
        runId: "late-run",
      }),
    ).rejects.toThrow("不匹配");
    expect(findById).not.toHaveBeenCalled();
  });
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
      documentAccess,
      canvasService: canvasService(repo({ saveContent: saveContent as never })),
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

describe("画布截图的真实 Task 文件发布", () => {
  async function fixture() {
    const upload = vi.fn(async () => {});
    const prepareWrite = vi.fn(
      async (_actor: LocalActor, input: ProjectFileWrite) => ({
        assetId: input.assetId,
        bucket: "project-assets" as const,
        objectPath: "task-file",
        relativePath: input.relativePath,
      }),
    );
    const connectionManager = new ConnectionManager();
    const rpc = vi.spyOn(connectionManager, "rpcCanvas").mockResolvedValue({
      url: "data:image/png;base64,aW1hZ2U=",
      width: 10,
      height: 20,
    });
    let activeRunId = "run-1";
    const definition = createScreenshotCanvasToolDefinition({
      localInstance,
      documentAccess: {
        authorize: async (context, canvasId, operation) => {
          if (context.runId !== activeRunId)
            throw new Error("画布任务或运行授权已改变，请重新提交。");
          return documentAccess.authorize(context, canvasId, operation);
        },
      },
      connectionManager,
      projectFiles: { prepareWrite },
      blob: {
        registerNamespace: () => {},
        resolveNamespace: () => null,
        bucket: () => ({
          upload,
          resolveUrl: async () => "https://local.test/image.png",
          isPublic: async () => false,
          getPublicUrl: () => "",
          createSignedUrl: async () => "",
          createSignedUrls: async () => [],
          download: async () => new Uint8Array(),
          copy: async () => {},
          remove: async () => {},
        }),
      },
    });
    const context: ToolExecutionContext = {
      actor: ACTOR,
      instanceId: INSTANCE_ID,
      canvasId: CANVAS_ID,
      scopeHandle: await scopes.openTask(ACTOR, TASK_ID),
      runId: "run-1",
      workContext: { preset: "design", canvasId: CANVAS_ID },
    };
    return {
      upload,
      prepareWrite,
      rpc,
      revoke: () => {
        activeRunId = "other-run";
      },
      execute: () => definition.execute({ mode: "full" }, context),
    };
  }
  it("拒绝布尔回执且不登记或写入文件", async () => {
    const f = await fixture();
    f.rpc.mockResolvedValue(true);
    await expect(f.execute()).rejects.toThrow("画布截图失败");
    expect(f.prepareWrite).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
  });
  it("登记真实 Task 并返回短文件引用，不返回 dataURL", async () => {
    const f = await fixture();
    const result = JSON.parse(String(await f.execute()));
    expect(f.prepareWrite).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({
        target: { kind: "task", taskId: TASK_ID },
        mimeType: "image/png",
        writeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(result).toMatchObject({
      screenshotUrl: "https://local.test/image.png",
      width: 10,
      height: 20,
    });
    expect(JSON.stringify(result)).not.toContain("data:image");
  });
  it("存储失败不能返回截图成功", async () => {
    const f = await fixture();
    f.upload.mockRejectedValue(new Error("disk unavailable"));
    await expect(f.execute()).rejects.toThrow("disk unavailable");
  });
  it("RPC 等待中更换 Run 后不发布文件", async () => {
    const f = await fixture();
    f.rpc.mockImplementation(async () => {
      f.revoke();
      return { url: "data:image/png;base64,aW1hZ2U=", width: 10, height: 20 };
    });
    await expect(f.execute()).rejects.toThrow(
      "画布截图失败：画布任务或运行授权已改变",
    );
    expect(f.prepareWrite).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
  });
});
