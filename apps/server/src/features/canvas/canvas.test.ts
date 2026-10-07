import { describe, expect, it } from "vitest";
import { BlobError } from "../blob/types.js";
import { createLocalInstanceService } from "../local-instance/service.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import { SqlError } from "../persistence/errors.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { CanvasServiceError, createCanvasService } from "./canvas-service.js";
import { type CanvasRepository, createCanvasRepository } from "./repository.js";

const CLIENT_ID = "client-1";
const INSTANCE_ID = "instance-1";
const CANVAS_ID = "canvas-1";

const ACTOR: LocalActor = {
  instanceId: INSTANCE_ID,
  accessClientId: CLIENT_ID,
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
    async acquireSession() {
      throw new Error("此查询夹具不提供真实执行宿主会话。");
    },
    async end() {},
  };

  return {
    calls,
    sqls: () => calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
    runner,
  };
}

const LOCAL_INSTANCE = createLocalInstanceService({
  repository: { ensure: async () => INSTANCE_ID },
  dataDir: "/tmp/canvas-instance-test",
});

/** 未知值的对象收窄：repository 的 content 参数与 elements 元素都是 unknown。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从 saveContent 收到的内容里取 files 表（取不到时返回空表，断言照常失败）。 */
function filesOf(content: unknown): Record<string, unknown> {
  const files = isRecord(content) ? content.files : undefined;
  return isRecord(files) ? files : {};
}

function createStorageStub(
  options: {
    downloadBytes?: Buffer | null;
    uploadError?: { message: string };
  } = {},
) {
  const calls: string[] = [];

  // blob 缝替身：不是 Provider 细节的复刻，只记录调用并提供夹具数据
  const blob = {
    bucket: (bucket: string) => ({
      upload: async (path: string) => {
        calls.push(`upload:${bucket}:${path}`);
        if (options.uploadError) {
          throw new BlobError(
            "upload",
            bucket,
            path,
            options.uploadError.message,
          );
        }
      },
      download: async (path: string) => {
        calls.push(`download:${bucket}:${path}`);
        // 注意用 === undefined 判定：null 是「下载失败」的显式夹具。
        const bytes =
          options.downloadBytes === undefined
            ? Buffer.from("png-bytes")
            : options.downloadBytes;
        if (bytes === null) {
          throw new BlobError("download", bucket, path, "not found");
        }
        return new Uint8Array(bytes);
      },
      isPublic: async () => true,
      resolveUrl: async (path: string) => {
        calls.push(`resolveUrl:${bucket}:${path}`);
        return `https://blob.test/${bucket}/${path}`;
      },
    }),
  };

  return { calls, blob: blob as never };
}

const CANVAS_ROW = {
  id: CANVAS_ID,
  name: "Main Canvas",
  project_id: "project-1",
  content: { elements: [], appState: {} },
};

describe("canvas repository（canvases 无 instance_id 列 → JOIN projects）", () => {
  it("读取画布经项目父链施加实例谓词", async () => {
    const { calls, runner } = createRunner(() => ({
      rowCount: 1,
      rows: [CANVAS_ROW],
    }));

    const row = await createCanvasRepository(
      createPersistenceFromRunner(runner),
    ).findById(INSTANCE_ID, CANVAS_ID);

    expect(row?.id).toBe(CANVAS_ID);
    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("from public.canvases c");
    expect(sql).toContain("join public.projects p on p.id = c.project_id");
    expect(sql).toContain("where c.id = $1 and p.instance_id = $2");
    expect(calls[0]?.values).toEqual([CANVAS_ID, INSTANCE_ID]);
  });

  it("写入画布同样带父链谓词，jsonb 显式序列化", async () => {
    const { calls, runner } = createRunner(() => ({ rowCount: 1, rows: [] }));
    const content = { appState: {}, elements: [{ id: "el-1", type: "image" }] };

    await expect(
      createCanvasRepository(createPersistenceFromRunner(runner)).saveContent(
        INSTANCE_ID,
        CANVAS_ID,
        content,
      ),
    ).resolves.toBe(1);

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("update public.canvases c set content = $2::jsonb");
    expect(sql).toContain("from public.projects p");
    expect(sql).toContain("and p.instance_id = $3");
    expect(calls[0]?.values).toEqual([
      CANVAS_ID,
      JSON.stringify(content),
      INSTANCE_ID,
    ]);
  });

  it("按实例读取画布绑定品牌套件：走同一父链，且用实例谓词", async () => {
    const brandKit = createRunner(() => ({
      rowCount: 1,
      rows: [{ brand_kit_id: "kit-1" }],
    }));
    await expect(
      createCanvasRepository(
        createPersistenceFromRunner(brandKit.runner),
      ).findProjectBrandKitId(INSTANCE_ID, CANVAS_ID),
    ).resolves.toBe("kit-1");
    expect(brandKit.sqls()[0]).toContain(
      "where c.id = $1 and p.instance_id = $2",
    );
    expect(brandKit.calls[0]?.values).toEqual([CANVAS_ID, INSTANCE_ID]);

    const empty = createRunner();
    await expect(
      createCanvasRepository(
        createPersistenceFromRunner(empty.runner),
      ).findProjectBrandKitId(INSTANCE_ID, CANVAS_ID),
    ).resolves.toBeNull();
  });

  it("0 行受影响即未命中（不属本实例或不存在）", async () => {
    const { runner } = createRunner();
    await expect(
      createCanvasRepository(createPersistenceFromRunner(runner)).saveContent(
        INSTANCE_ID,
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
    findProjectBrandKitId: async () => null,
    saveContent: async () => 1,
    appendContent: async () => 1,
    ...overrides,
  };
}

function buildService(options: {
  repository?: Partial<CanvasRepository>;
  storage?: ReturnType<typeof createStorageStub>;
  localInstance?: LocalInstanceService;
}) {
  const storage = options.storage ?? createStorageStub();
  return {
    service: createCanvasService({
      blob: storage.blob,
      repository: createFakeRepository(options.repository),
      localInstance: options.localInstance ?? LOCAL_INSTANCE,
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

    const detail = await service.getCanvas(ACTOR, CANVAS_ID);

    expect(detail.id).toBe(CANVAS_ID);
    expect(detail.projectId).toBe("project-1");
    const files = detail.content.files;
    expect(files["f-inline"]?.dataURL).toBe("data:image/png;base64,AA");
    expect(files["f-oss"]?.storageUrl).toBe(
      "https://blob.test/project-assets/canvas-files/c1/f-oss.png",
    );
    expect(files["f-oss"]?.dataURL).toBeUndefined();
    // 走 blob 缝的 resolveUrl（公开性由存储侧回答），不再自己判公开桶
    expect(
      storage.calls.some((call) =>
        call.startsWith("resolveUrl:project-assets:canvas-files/c1/f-oss.png"),
      ),
    ).toBe(true);
  });

  it("画布不存在（或不属本实例）返回 404", async () => {
    const { service } = buildService({
      repository: { findById: async () => null },
    });
    await expect(service.getCanvas(ACTOR, CANVAS_ID)).rejects.toMatchObject({
      code: "canvas_not_found",
      statusCode: 404,
    });
  });

  it("保存时把 base64 文件抽到对象存储并写回 oss:// 标记", async () => {
    let writtenContent: unknown;
    const { service, storage } = buildService({
      repository: {
        saveContent: async (_instanceId, _canvasId, content) => {
          writtenContent = content;
          return 1;
        },
      },
    });

    await service.saveCanvasContent(ACTOR, CANVAS_ID, {
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
    expect(filesOf(writtenContent)["f-1"]).toMatchObject({
      dataURL: "oss://project-assets/canvas-files/canvas-1/f-1.webp",
    });
  });

  it("上传失败时保留原始 base64（优雅降级，不阻断保存）", async () => {
    let writtenContent: unknown;
    const { service } = buildService({
      repository: {
        saveContent: async (_instanceId, _canvasId, content) => {
          writtenContent = content;
          return 1;
        },
      },
      storage: createStorageStub({
        uploadError: { message: "quota exceeded" },
      }),
    });

    await service.saveCanvasContent(ACTOR, CANVAS_ID, {
      appState: {},
      elements: [],
      files: { "f-1": { id: "f-1", dataURL: "data:image/png;base64,AAAA" } },
    } as never);

    expect(filesOf(writtenContent)["f-1"]).toMatchObject({
      dataURL: "data:image/png;base64,AAAA",
    });
  });

  it("保存未命中（0 行）返回 404；仓库异常返回 500 canvas_save_failed", async () => {
    const notFound = buildService({
      repository: { saveContent: async () => 0 },
    });
    await expect(
      notFound.service.saveCanvasContent(ACTOR, CANVAS_ID, {
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
      .saveCanvasContent(ACTOR, CANVAS_ID, {
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

  it("实例解析失败时不落到画布数据访问（fail loud）", async () => {
    let reads = 0;
    const { service } = buildService({
      repository: {
        findById: async () => {
          reads += 1;
          return CANVAS_ROW;
        },
      },
      localInstance: {
        ...LOCAL_INSTANCE,
        resolve: async () => {
          throw new Error("本地实例暂不可用");
        },
      },
    });

    await expect(service.getCanvas(ACTOR, CANVAS_ID)).rejects.toThrow(
      "本地实例暂不可用",
    );
    expect(reads).toBe(0);
  });

  it("插入图片元素：下载对象→内联 dataURL→**原子追加**元素与 files 条目", async () => {
    let appended: Parameters<CanvasRepository["appendContent"]>[2] | undefined;
    const { service, storage } = buildService({
      repository: {
        findById: async () => ({
          ...CANVAS_ROW,
          content: {
            appState: {},
            elements: [{ id: "el-old", x: 0, width: 10 }],
          },
        }),
        appendContent: async (_instanceId, _canvasId, input) => {
          appended = input;
          return 1;
        },
      },
      storage: createStorageStub({ downloadBytes: Buffer.from("img") }),
    });

    const { elementId } = await service.insertImageElement(ACTOR, {
      canvasId: CANVAS_ID,
      mimeType: "image/png",
      objectPath: "gen/shot.png",
      height: 512,
      width: 512,
      title: "生成图",
    });

    expect(storage.calls[0]).toBe("download:project-assets:gen/shot.png");
    if (!appended) {
      throw new Error("未记录到 appendContent 调用");
    }
    // 只追加新元素（不是整份元素表）——覆盖写会在并发落图时丢元素
    expect(appended.elements).toHaveLength(1);
    const element = appended.elements[0];
    if (!isRecord(element)) {
      throw new Error("追加的元素不是对象");
    }
    expect(element).toMatchObject({ type: "image", id: elementId, angle: 0 });
    expect(element.customData).toEqual({
      title: "生成图",
      source: "generated",
    });
    const { fileId } = element;
    if (typeof fileId !== "string") {
      throw new Error("追加的元素未带 fileId");
    }
    // 图片以 base64 内联进 files，Excalidraw 才能原生渲染
    expect(appended.files?.[fileId]).toMatchObject({
      dataURL: `data:image/png;base64,${Buffer.from("img").toString("base64")}`,
    });
    // 新元素排在原有元素右侧（读回的元素表参与落点计算）
    expect(element.x).toBeGreaterThan(0);
  });

  it("插入图片：对象下载失败即中止，不写画布", async () => {
    let writes = 0;
    const { service } = buildService({
      repository: {
        appendContent: async () => {
          writes += 1;
          return 1;
        },
      },
      storage: createStorageStub({ downloadBytes: null }),
    });

    await expect(
      service.insertImageElement(ACTOR, {
        canvasId: CANVAS_ID,
        mimeType: "image/png",
        objectPath: "gen/missing.png",
        height: 10,
        width: 10,
      }),
    ).rejects.toThrow(/Failed to download image from storage/);
    expect(writes).toBe(0);
  });

  it("插入视频元素：embeddable 类型 + link 指向签名 URL，无 files 条目", async () => {
    let written: Parameters<CanvasRepository["appendContent"]>[2] | undefined;
    const { service } = buildService({
      repository: {
        findById: async () => CANVAS_ROW,
        appendContent: async (_instanceId, _canvasId, input) => {
          written = input;
          return 1;
        },
      },
    });

    const { elementId } = await service.insertVideoElement(ACTOR, {
      canvasId: CANVAS_ID,
      mimeType: "video/mp4",
      signedUrl: "https://blob.test/v.mp4",
      durationSeconds: 5,
      height: 720,
      width: 1280,
      prompt: "海浪",
    });

    if (!written) {
      throw new Error("未记录到 appendContent 调用");
    }
    expect(written.elements).toHaveLength(1);
    const element = written.elements[0];
    if (!isRecord(element)) {
      throw new Error("追加的元素不是对象");
    }
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
      repository: { appendContent: async () => 0 },
    });

    await expect(
      service.insertVideoElement(ACTOR, {
        canvasId: CANVAS_ID,
        mimeType: "video/mp4",
        signedUrl: "https://blob.test/v.mp4",
        height: 10,
        width: 10,
      }),
    ).rejects.toThrow(/Failed to append to canvas/);
  });
});

it("画布服务的实例 Actor 在内容读取和写入前复验", async () => {
  let reads = 0;
  let writes = 0;
  const { service } = buildService({
    repository: {
      findById: async () => {
        reads += 1;
        return CANVAS_ROW;
      },
      saveContent: async () => {
        writes += 1;
        return 1;
      },
    },
  });
  const actor = { instanceId: "foreign", accessClientId: ACTOR.accessClientId };
  await expect(service.getCanvas(actor, CANVAS_ID)).rejects.toMatchObject({
    code: "instance_forbidden",
    statusCode: 403,
  });
  await expect(
    service.saveCanvasContent(actor, CANVAS_ID, {
      elements: [],
      files: {},
      appState: {},
    }),
  ).rejects.toMatchObject({ code: "instance_forbidden" });
  expect([reads, writes]).toEqual([0, 0]);
});
