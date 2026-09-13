import { describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../../supabase/user.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import { BootstrapError } from "../bootstrap/errors.js";
import { SqlError } from "../persistence/errors.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { CanvasServiceError, createCanvasService } from "./canvas-service.js";
import { type CanvasRepository, createCanvasRepository } from "./repository.js";

const USER_ID = "user-1";
const WORKSPACE_ID = "ws-1";
const CANVAS_ID = "canvas-1";

const USER: AuthenticatedUser = {
  accessToken: "token",
  email: "user@example.com",
  id: USER_ID,
  userMetadata: {},
};

type FakeResult = { rowCount: number | null; rows: unknown[] } | Error;

function createRunner(
  respond: (text: string, values: unknown[]) => FakeResult = () => ({
    rowCount: 0,
    rows: [],
  }),
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];

  const run = (text: string, values: unknown[]) => {
    calls.push({ text, values });
    const result = respond(text, values);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };

  const runner: PostgresQueryRunner = {
    async query(text, values) {
      return run(text, values);
    },
    async acquire() {
      return {
        query: async (text, values) => run(text, values),
        release: () => {},
      };
    },
    async end() {},
  };

  return {
    calls,
    sqls: () => calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
    runner,
  };
}

const VIEWER_STUB: ViewerService = {
  ensureViewer: async () => {
    throw new Error("not used");
  },
  resolveWorkspace: async () => ({
    id: WORKSPACE_ID,
    name: "Personal Workspace",
    ownerUserId: USER_ID,
    type: "personal",
  }),
  updateProfile: async () => {
    throw new Error("not used");
  },
};

function createStorageStub(
  options: {
    downloadBytes?: Buffer | null;
    uploadError?: { message: string };
  } = {},
) {
  const calls: string[] = [];

  const client = {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => {
          calls.push(`upload:${bucket}:${path}`);
          return { error: options.uploadError ?? null };
        },
        download: async (path: string) => {
          calls.push(`download:${bucket}:${path}`);
          // 注意用 === undefined 判定：null 是「下载失败」的显式夹具。
          const bytes =
            options.downloadBytes === undefined
              ? Buffer.from("png-bytes")
              : options.downloadBytes;
          return bytes === null
            ? { data: null, error: { message: "not found" } }
            : {
                data: {
                  arrayBuffer: async () =>
                    bytes.buffer.slice(
                      bytes.byteOffset,
                      bytes.byteOffset + bytes.byteLength,
                    ),
                },
                error: null,
              };
        },
        getPublicUrl: (path: string) => {
          calls.push(`publicUrl:${bucket}:${path}`);
          return { data: { publicUrl: `https://blob.test/${bucket}/${path}` } };
        },
      }),
    },
  };

  return { calls, client: client as never };
}

const CANVAS_ROW = {
  id: CANVAS_ID,
  name: "Main Canvas",
  project_id: "project-1",
  content: { elements: [], appState: {} },
};

describe("canvas repository（canvases 无 workspace_id 列 → JOIN projects）", () => {
  it("读取画布经项目父链施加工作区谓词", async () => {
    const { calls, runner } = createRunner(() => ({
      rowCount: 1,
      rows: [CANVAS_ROW],
    }));

    const row = await createCanvasRepository(
      createPersistenceFromRunner(runner),
    ).findById(WORKSPACE_ID, CANVAS_ID);

    expect(row?.id).toBe(CANVAS_ID);
    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("from public.canvases c");
    expect(sql).toContain("join public.projects p on p.id = c.project_id");
    expect(sql).toContain("where c.id = $1 and p.workspace_id = $2");
    expect(calls[0]?.values).toEqual([CANVAS_ID, WORKSPACE_ID]);
  });

  it("写入画布同样带父链谓词，jsonb 显式序列化", async () => {
    const { calls, runner } = createRunner(() => ({ rowCount: 1, rows: [] }));
    const content = { appState: {}, elements: [{ id: "el-1", type: "image" }] };

    await expect(
      createCanvasRepository(createPersistenceFromRunner(runner)).saveContent(
        WORKSPACE_ID,
        CANVAS_ID,
        content,
      ),
    ).resolves.toBe(1);

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("update public.canvases c set content = $2::jsonb");
    expect(sql).toContain("from public.projects p");
    expect(sql).toContain("and p.workspace_id = $3");
    expect(calls[0]?.values).toEqual([
      CANVAS_ID,
      JSON.stringify(content),
      WORKSPACE_ID,
    ]);
  });

  it("0 行受影响即未命中（不属本工作区或不存在）", async () => {
    const { runner } = createRunner();
    await expect(
      createCanvasRepository(createPersistenceFromRunner(runner)).saveContent(
        WORKSPACE_ID,
        CANVAS_ID,
        { elements: [] },
      ),
    ).resolves.toBe(0);
  });
});

function createFakeRepository(
  overrides: Partial<CanvasRepository> = {},
): CanvasRepository {
  return {
    findById: async () => CANVAS_ROW,
    saveContent: async () => 1,
    ...overrides,
  };
}

function buildService(options: {
  repository?: Partial<CanvasRepository>;
  storage?: ReturnType<typeof createStorageStub>;
  viewerService?: ViewerService;
}) {
  const storage = options.storage ?? createStorageStub();
  return {
    service: createCanvasService({
      createUserClient: () => storage.client,
      repository: createFakeRepository(options.repository),
      viewerService: options.viewerService ?? VIEWER_STUB,
    }),
    storage,
  };
}

describe("canvas service", () => {
  it("读画布返回契约形状，并把 oss:// 标记解析成存储 URL", async () => {
    const { service, storage } = buildService({
      repository: {
        findById: async () => ({
          ...CANVAS_ROW,
          content: {
            appState: {},
            elements: [],
            files: {
              "f-inline": {
                id: "f-inline",
                dataURL: "data:image/png;base64,AA",
              },
              "f-oss": {
                id: "f-oss",
                dataURL: "oss://project-assets/canvas-files/c1/f-oss.png",
              },
            },
          },
        }),
      },
    });

    const detail = await service.getCanvas(USER, CANVAS_ID);

    expect(detail.id).toBe(CANVAS_ID);
    expect(detail.projectId).toBe("project-1");
    const files = (detail.content as { files: Record<string, any> }).files;
    expect(files["f-inline"]?.dataURL).toBe("data:image/png;base64,AA");
    expect(files["f-oss"]?.storageUrl).toBe(
      "https://blob.test/project-assets/canvas-files/c1/f-oss.png",
    );
    expect(files["f-oss"]?.dataURL).toBeUndefined();
    expect(
      storage.calls.some((call) =>
        call.startsWith("publicUrl:project-assets:canvas-files/c1/f-oss.png"),
      ),
    ).toBe(true);
  });

  it("画布不存在（或不属本工作区）返回 404", async () => {
    const { service } = buildService({
      repository: { findById: async () => null },
    });
    await expect(service.getCanvas(USER, CANVAS_ID)).rejects.toMatchObject({
      code: "canvas_not_found",
      statusCode: 404,
    });
  });

  it("保存时把 base64 文件抽到对象存储并写回 oss:// 标记", async () => {
    let writtenContent: unknown;
    const { service, storage } = buildService({
      repository: {
        saveContent: async (_workspaceId, _canvasId, content) => {
          writtenContent = content;
          return 1;
        },
      },
    });

    await service.saveCanvasContent(USER, CANVAS_ID, {
      appState: {},
      elements: [],
      files: {
        "f-1": { id: "f-1", dataURL: "data:image/webp;base64,AAAA" },
      },
    } as never);

    expect(
      storage.calls.some((call) =>
        call.startsWith("upload:project-assets:canvas-files/"),
      ),
    ).toBe(true);
    const files = (writtenContent as { files: Record<string, any> }).files;
    expect(files["f-1"]?.dataURL).toBe(
      "oss://project-assets/canvas-files/canvas-1/f-1.webp",
    );
  });

  it("上传失败时保留原始 base64（优雅降级，不阻断保存）", async () => {
    let writtenContent: unknown;
    const { service } = buildService({
      repository: {
        saveContent: async (_workspaceId, _canvasId, content) => {
          writtenContent = content;
          return 1;
        },
      },
      storage: createStorageStub({
        uploadError: { message: "quota exceeded" },
      }),
    });

    await service.saveCanvasContent(USER, CANVAS_ID, {
      appState: {},
      elements: [],
      files: { "f-1": { id: "f-1", dataURL: "data:image/png;base64,AAAA" } },
    } as never);

    const files = (writtenContent as { files: Record<string, any> }).files;
    expect(files["f-1"]?.dataURL).toBe("data:image/png;base64,AAAA");
  });

  it("保存未命中（0 行）返回 404；仓库异常返回 500 canvas_save_failed", async () => {
    const notFound = buildService({
      repository: { saveContent: async () => 0 },
    });
    await expect(
      notFound.service.saveCanvasContent(USER, CANVAS_ID, {
        appState: {},
        elements: [],
      } as never),
    ).rejects.toMatchObject({ code: "canvas_not_found", statusCode: 404 });

    const failing = buildService({
      repository: {
        saveContent: async () => {
          throw new SqlError("connection reset", { code: "08006" });
        },
      },
    });
    const error = await failing.service
      .saveCanvasContent(USER, CANVAS_ID, {
        appState: {},
        elements: [],
      } as never)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CanvasServiceError);
    expect(error).toMatchObject({
      code: "canvas_save_failed",
      statusCode: 500,
    });
  });

  it("工作区解析失败时不落到画布数据访问（fail loud）", async () => {
    let reads = 0;
    const { service } = buildService({
      repository: {
        findById: async () => {
          reads += 1;
          return CANVAS_ROW;
        },
      },
      viewerService: {
        ...VIEWER_STUB,
        resolveWorkspace: async () => {
          throw new BootstrapError();
        },
      },
    });

    await expect(service.getCanvas(USER, CANVAS_ID)).rejects.toMatchObject({
      code: "canvas_not_found",
    });
    expect(reads).toBe(0);
  });

  it("插入图片元素：下载对象→内联 dataURL→追加元素与 files 条目", async () => {
    let written: any;
    const { service, storage } = buildService({
      repository: {
        findById: async () => ({
          ...CANVAS_ROW,
          content: {
            appState: {},
            elements: [{ id: "el-old", x: 0, width: 10 }],
          },
        }),
        saveContent: async (_workspaceId, _canvasId, content) => {
          written = content;
          return 1;
        },
      },
      storage: createStorageStub({ downloadBytes: Buffer.from("img") }),
    });

    const { elementId } = await service.insertImageElement(
      { accessToken: "token", id: USER_ID },
      {
        canvasId: CANVAS_ID,
        mimeType: "image/png",
        objectPath: "gen/shot.png",
        height: 512,
        width: 512,
        title: "生成图",
      },
    );

    expect(storage.calls[0]).toBe("download:project-assets:gen/shot.png");
    expect(written.elements).toHaveLength(2);
    const element = written.elements[1];
    expect(element).toMatchObject({ type: "image", id: elementId, angle: 0 });
    expect(element.customData).toEqual({
      title: "生成图",
      source: "generated",
    });
    // 图片以 base64 内联进 files，Excalidraw 才能原生渲染
    expect(written.files[element.fileId].dataURL).toBe(
      `data:image/png;base64,${Buffer.from("img").toString("base64")}`,
    );
    // 新元素排在原有元素右侧
    expect(element.x).toBeGreaterThan(0);
  });

  it("插入图片：对象下载失败即中止，不写画布", async () => {
    let writes = 0;
    const { service } = buildService({
      repository: {
        saveContent: async () => {
          writes += 1;
          return 1;
        },
      },
      storage: createStorageStub({ downloadBytes: null }),
    });

    await expect(
      service.insertImageElement(
        { accessToken: "token", id: USER_ID },
        {
          canvasId: CANVAS_ID,
          mimeType: "image/png",
          objectPath: "gen/missing.png",
          height: 10,
          width: 10,
        },
      ),
    ).rejects.toThrow(/Failed to download image from storage/);
    expect(writes).toBe(0);
  });

  it("插入视频元素：embeddable 类型 + link 指向签名 URL，无 files 条目", async () => {
    let written: any;
    const { service } = buildService({
      repository: {
        findById: async () => CANVAS_ROW,
        saveContent: async (_workspaceId, _canvasId, content) => {
          written = content;
          return 1;
        },
      },
    });

    const { elementId } = await service.insertVideoElement(
      { accessToken: "token", id: USER_ID },
      {
        canvasId: CANVAS_ID,
        mimeType: "video/mp4",
        signedUrl: "https://blob.test/v.mp4",
        durationSeconds: 5,
        height: 720,
        width: 1280,
        prompt: "海浪",
      },
    );

    expect(written.elements).toHaveLength(1);
    const element = written.elements[0];
    expect(element).toMatchObject({
      type: "embeddable",
      id: elementId,
      link: "https://blob.test/v.mp4",
    });
    expect(element.customData).toMatchObject({
      isVideo: true,
      mimeType: "video/mp4",
      durationSeconds: 5,
      prompt: "海浪",
    });
    expect(written.files).toBeUndefined();
  });

  it("插入元素时写入未命中（0 行）抛错，不再静默成功", async () => {
    const { service } = buildService({
      repository: { saveContent: async () => 0 },
    });

    await expect(
      service.insertVideoElement(
        { accessToken: "token", id: USER_ID },
        {
          canvasId: CANVAS_ID,
          mimeType: "video/mp4",
          signedUrl: "https://blob.test/v.mp4",
          height: 10,
          width: 10,
        },
      ),
    ).rejects.toThrow(/Failed to write canvas/);
  });
});
