import { describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../../supabase/user.js";
import { BlobError } from "../blob/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import { BootstrapError } from "../bootstrap/errors.js";
import { SqlError } from "../persistence/errors.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { createUploadRepository } from "./repository.js";
import { createUploadService, UploadServiceError } from "./upload-service.js";

const USER_ID = "user-1";
const WORKSPACE_ID = "ws-1";
const ASSET_ID = "asset-1";

const USER: AuthenticatedUser = {
  accessToken: "token",
  email: "user@example.com",
  id: USER_ID,
  userMetadata: {},
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

/** 驱动形状的原始行：int8 列为字符串（repository 负责归一）。 */
const RAW_ASSET_ROW = {
  id: ASSET_ID,
  bucket: "project-assets",
  object_path: `${WORKSPACE_ID}/123-file.png`,
  mime_type: "image/png",
  byte_size: "2048",
  workspace_id: WORKSPACE_ID,
  project_id: null,
  created_at: "2026-09-13T00:00:00+00:00",
};

/** repository 归一后的记录（服务层桩按此形状返回）。 */
const ASSET_ROW = { ...RAW_ASSET_ROW, byte_size: 2048 };

describe("uploads repository", () => {
  it("插入元数据带工作区谓词，且 bigint 字节数归一为 number", async () => {
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
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });

    // 驱动对 int8 返回字符串；契约要求 number，必须归一。
    expect(asset?.byte_size).toBe(2048);
    expect(typeof asset?.byte_size).toBe("number");
    expect(calls[0]?.text.replace(/\s+/g, " ")).toContain(
      `values ($7, $1, $2, $3, $4, $5, $6)`,
    );
    expect(calls[0]?.values).toEqual([
      "project-assets",
      RAW_ASSET_ROW.object_path,
      "image/png",
      2048,
      USER_ID,
      null,
      WORKSPACE_ID,
    ]);
  });

  it("取对象位置与删除都限定工作区", async () => {
    const location = createRunner(() => ({
      rowCount: 1,
      rows: [{ bucket: "project-assets", object_path: "p/a.png" }],
    }));
    await expect(
      createUploadRepository(
        createPersistenceFromRunner(location.runner),
      ).findLocation(WORKSPACE_ID, ASSET_ID),
    ).resolves.toEqual({ bucket: "project-assets", object_path: "p/a.png" });
    expect(location.calls[0]?.text.replace(/\s+/g, " ")).toContain(
      "where workspace_id = $2 and id = $1",
    );
    expect(location.calls[0]?.values).toEqual([ASSET_ID, WORKSPACE_ID]);

    const deleted = createRunner(() => ({ rowCount: 1, rows: [] }));
    await expect(
      createUploadRepository(
        createPersistenceFromRunner(deleted.runner),
      ).deleteById(WORKSPACE_ID, ASSET_ID),
    ).resolves.toBe(1);
    expect(deleted.calls[0]?.text.replace(/\s+/g, " ")).toContain(
      "delete from public.asset_objects",
    );
    expect(deleted.calls[0]?.values).toEqual([ASSET_ID, WORKSPACE_ID]);
  });
});

describe("upload service", () => {
  const buildService = (options: {
    repository: Partial<ReturnType<typeof createUploadRepository>>;
    storage?: ReturnType<typeof createStorageStub>;
    viewerService?: ViewerService;
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
        viewerService: options.viewerService ?? VIEWER_STUB,
      }),
      storage,
    };
  };

  it("上传成功返回资产与公开 URL，且工作区由服务内部解析", async () => {
    const { service, storage } = buildService({
      repository: { insert: async () => ASSET_ROW },
    });

    const result = await service.uploadFile(USER, {
      bucket: "project-assets",
      fileName: "shot.png",
      fileBuffer: Buffer.alloc(2048),
      mimeType: "image/png",
    });

    expect(result.asset.id).toBe(ASSET_ID);
    expect(result.asset.byteSize).toBe(2048);
    expect(result.url).toContain("https://blob.test/project-assets/");
    expect(storage.calls[0]).toContain(
      `upload:project-assets:${WORKSPACE_ID}/`,
    );
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
      service.uploadFile(USER, {
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
      service.uploadFile(USER, {
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
      missing.service.getAssetUrl(USER, ASSET_ID),
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
      publicAsset.service.getAssetUrl(USER, ASSET_ID),
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
      privateAsset.service.getAssetUrl(USER, ASSET_ID),
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
    await expect(service.deleteAsset(USER, ASSET_ID)).resolves.toBeUndefined();
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
      race.service.deleteAsset(USER, ASSET_ID),
    ).rejects.toMatchObject({ code: "asset_not_found", statusCode: 404 });
  });

  it("工作区解析失败按 upload_failed 报错，不泄露内部错误", async () => {
    const { service } = buildService({
      repository: {},
      viewerService: {
        ...VIEWER_STUB,
        resolveWorkspace: async () => {
          throw new BootstrapError();
        },
      },
    });

    const error = await service
      .getAssetUrl(USER, ASSET_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadServiceError);
    expect(error).toMatchObject({ code: "upload_failed", statusCode: 500 });
  });
});
