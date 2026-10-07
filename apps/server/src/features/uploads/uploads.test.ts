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
import { createUploadRepository } from "./repository.js";
import { createUploadService } from "./upload-service.js";

const CLIENT_ID = "client-1";
const INSTANCE_ID = "instance-1";
const ASSET_ID = "asset-1";

const ACTOR: LocalActor = {
  instanceId: INSTANCE_ID,
  accessClientId: CLIENT_ID,
};

type FakeResult = { rowCount: number | null; rows: unknown[] } | Error;

function createRunner(
  respond: (text: string) => FakeResult = () => ({ rowCount: 0, rows: [] }),
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];

  const run = (text: string, values: unknown[]) => {
    calls.push({ text, values });
    const result = respond(text);
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

  return { calls, runner };
}

function createStorageStub(
  options: { uploadError?: { message: string } } = {},
) {
  const calls: string[] = [];

  // blob 缝替身：只记录「哪个桶做了什么」，与 Provider 实现无关
  const blob = {
    bucket: (bucket: string) => ({
      isPublic: async () => bucket === "project-assets",
      resolveUrl: async (path: string) => {
        calls.push(`resolveUrl:${bucket}:${path}`);
        return bucket === "project-assets"
          ? `https://blob.test/${bucket}/${path}`
          : `https://signed.test/${bucket}/${path}`;
      },
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
      remove: async (paths: string[]) => {
        calls.push(`remove:${bucket}:${paths.join(",")}`);
      },
    }),
  };

  return { blob: blob as never, calls };
}

const LOCAL_INSTANCE = createLocalInstanceService({
  repository: { ensure: async () => INSTANCE_ID },
  dataDir: "/tmp/uploads-instance-test",
});

/** 驱动形状的原始行：int8 列为字符串（repository 负责归一）。 */
const RAW_ASSET_ROW = {
  id: ASSET_ID,
  bucket: "project-assets",
  object_path: `${INSTANCE_ID}/123-file.png`,
  mime_type: "image/png",
  byte_size: "2048",
  instance_id: INSTANCE_ID,
  project_id: null,
  created_at: "2026-09-13T00:00:00+00:00",
};

/** repository 归一后的记录（服务层桩按此形状返回）。 */
const ASSET_ROW = { ...RAW_ASSET_ROW, byte_size: 2048 };

describe("uploads repository", () => {
  it("插入元数据带实例谓词，且 bigint 字节数归一为 number", async () => {
    const { calls, runner } = createRunner(() => ({
      rowCount: 1,
      rows: [RAW_ASSET_ROW],
    }));

    const asset = await createUploadRepository(
      createPersistenceFromRunner(runner),
    ).insert({
      bucket: "project-assets",
      byteSize: 2048,
      mimeType: "image/png",
      objectPath: RAW_ASSET_ROW.object_path,
      createdByClientId: CLIENT_ID,
      instanceId: INSTANCE_ID,
    });

    // 驱动对 int8 返回字符串；契约要求 number，必须归一。
    expect(asset?.byte_size).toBe(2048);
    expect(typeof asset?.byte_size).toBe("number");
    expect(calls[0]?.text.replace(/\s+/g, " ")).toContain(
      "select $7, $1, $2, $3, $4, $5::uuid, $6::uuid",
    );
    expect(calls[0]?.text.replace(/\s+/g, " ")).toContain(
      "p.id = $6::uuid and p.instance_id = $7",
    );
    expect(calls[0]?.values).toEqual([
      "project-assets",
      RAW_ASSET_ROW.object_path,
      "image/png",
      2048,
      CLIENT_ID,
      null,
      INSTANCE_ID,
    ]);
  });

  it("取对象位置与删除都限定实例", async () => {
    const location = createRunner(() => ({
      rowCount: 1,
      rows: [{ bucket: "project-assets", object_path: "p/a.png" }],
    }));
    await expect(
      createUploadRepository(
        createPersistenceFromRunner(location.runner),
      ).findLocation(INSTANCE_ID, ASSET_ID),
    ).resolves.toEqual({ bucket: "project-assets", object_path: "p/a.png" });
    expect(location.calls[0]?.text.replace(/\s+/g, " ")).toContain(
      "where instance_id = $2 and id = $1",
    );
    expect(location.calls[0]?.values).toEqual([ASSET_ID, INSTANCE_ID]);

    const deleted = createRunner(() => ({ rowCount: 1, rows: [] }));
    await expect(
      createUploadRepository(
        createPersistenceFromRunner(deleted.runner),
      ).deleteById(INSTANCE_ID, ASSET_ID),
    ).resolves.toBe(1);
    expect(deleted.calls[0]?.text.replace(/\s+/g, " ")).toContain(
      "delete from public.asset_objects",
    );
    expect(deleted.calls[0]?.values).toEqual([ASSET_ID, INSTANCE_ID]);
  });
});

describe("upload service", () => {
  const buildService = (options: {
    repository: Partial<ReturnType<typeof createUploadRepository>>;
    storage?: ReturnType<typeof createStorageStub>;
    localInstance?: LocalInstanceService;
  }) => {
    const storage = options.storage ?? createStorageStub();
    return {
      service: createUploadService({
        blob: storage.blob,
        repository: {
          deleteById: async () => 1,
          findLocation: async () => null,
          insert: async () => null,
          ...options.repository,
        } as ReturnType<typeof createUploadRepository>,
        localInstance: options.localInstance ?? LOCAL_INSTANCE,
      }),
      storage,
    };
  };

  it("上传成功返回资产与公开 URL，且实例由服务内部解析", async () => {
    const { service, storage } = buildService({
      repository: { insert: async () => ASSET_ROW },
    });

    const result = await service.uploadFile(ACTOR, {
      bucket: "project-assets",
      fileName: "shot.png",
      fileBuffer: Buffer.alloc(2048),
      mimeType: "image/png",
    });

    expect(result.asset.id).toBe(ASSET_ID);
    expect(result.asset.byteSize).toBe(2048);
    expect(result.url).toContain("https://blob.test/project-assets/");
    expect(storage.calls[0]).toContain(`upload:project-assets:${INSTANCE_ID}/`);
    // 公开性由存储侧回答，服务只调 resolveUrl（不再自己判公开桶）
    expect(storage.calls.at(-1)).toContain("resolveUrl:project-assets:");
  });

  it("存储上传失败即中止，不写元数据", async () => {
    let inserts = 0;
    const { service } = buildService({
      repository: {
        insert: async () => {
          inserts += 1;
          return ASSET_ROW;
        },
      },
      storage: createStorageStub({
        uploadError: { message: "quota exceeded" },
      }),
    });

    await expect(
      service.uploadFile(ACTOR, {
        bucket: "project-assets",
        fileName: "shot.png",
        fileBuffer: Buffer.alloc(8),
        mimeType: "image/png",
      }),
    ).rejects.toMatchObject({ code: "upload_failed", statusCode: 500 });
    expect(inserts).toBe(0);
  });

  it("元数据落库失败时清掉已上传对象，避免孤儿文件", async () => {
    const { service, storage } = buildService({
      repository: {
        insert: async () => {
          throw new SqlError("permission denied", { code: "42501" });
        },
      },
    });

    await expect(
      service.uploadFile(ACTOR, {
        bucket: "project-assets",
        fileName: "shot.png",
        fileBuffer: Buffer.alloc(8),
        mimeType: "image/png",
      }),
    ).rejects.toMatchObject({ code: "upload_failed" });
    expect(storage.calls.some((call) => call.startsWith("remove:"))).toBe(true);
  });

  it("资产不存在返回 404；存在则按桶类型签发 URL", async () => {
    const missing = buildService({ repository: {} });
    await expect(
      missing.service.getAssetUrl(ACTOR, ASSET_ID),
    ).rejects.toMatchObject({ code: "asset_not_found", statusCode: 404 });

    const publicAsset = buildService({
      repository: {
        findLocation: async () => ({
          bucket: "project-assets",
          object_path: "p/a.png",
        }),
      },
    });
    await expect(
      publicAsset.service.getAssetUrl(ACTOR, ASSET_ID),
    ).resolves.toContain("https://blob.test/project-assets/p/a.png");

    const privateAsset = buildService({
      repository: {
        findLocation: async () => ({
          bucket: "user-avatars",
          object_path: "u/a.png",
        }),
      },
    });
    await expect(
      privateAsset.service.getAssetUrl(ACTOR, ASSET_ID),
    ).resolves.toContain("https://signed.test/user-avatars/u/a.png");
  });

  it("删除资产先删对象再删元数据；元数据缺失即 404", async () => {
    const { service, storage } = buildService({
      repository: {
        findLocation: async () => ({
          bucket: "project-assets",
          object_path: "p/a.png",
        }),
      },
    });
    await expect(service.deleteAsset(ACTOR, ASSET_ID)).resolves.toBeUndefined();
    expect(storage.calls).toEqual(["remove:project-assets:p/a.png"]);

    const race = buildService({
      repository: {
        deleteById: async () => 0,
        findLocation: async () => ({
          bucket: "project-assets",
          object_path: "p/a.png",
        }),
      },
    });
    await expect(
      race.service.deleteAsset(ACTOR, ASSET_ID),
    ).rejects.toMatchObject({ code: "asset_not_found", statusCode: 404 });
  });

  it("实例解析故障原样传播，不伪装成资源或凭据错误", async () => {
    const { service } = buildService({
      repository: {},
      localInstance: {
        ...LOCAL_INSTANCE,
        resolve: async () => {
          throw new Error("本地实例暂不可用");
        },
      },
    });

    const error = await service
      .getAssetUrl(ACTOR, ASSET_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "本地实例暂不可用" });
  });
  it("资产查询拒绝伪造实例，存储故障不伪装成资产不存在", async () => {
    let queries = 0;
    const failure = new Error("磁盘或数据库暂不可用");
    const { service } = buildService({
      repository: {
        findLocation: async () => {
          queries += 1;
          throw failure;
        },
      },
    });
    await expect(
      service.getAssetUrl(
        { instanceId: "foreign", accessClientId: ACTOR.accessClientId },
        ASSET_ID,
      ),
    ).rejects.toMatchObject({ code: "instance_forbidden" });
    expect(queries).toBe(0);
    await expect(service.getAssetUrl(ACTOR, ASSET_ID)).rejects.toBe(failure);
  });
});
