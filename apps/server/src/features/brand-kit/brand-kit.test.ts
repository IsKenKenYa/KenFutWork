import { describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../auth/types.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import {
  BrandKitServiceError,
  createBrandKitService,
} from "./brand-kit-service.js";
import {
  type BrandKitRepository,
  createBrandKitRepository,
} from "./repository.js";

const USER_ID = "user-1";
const KIT_ID = "kit-1";
const ASSET_ID = "asset-1";

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
    runner,
    sqls: () => calls.map((c) => c.text.replace(/\s+/g, " ").trim()),
  };
}

const KIT_ROW = {
  id: KIT_ID,
  name: "品牌 A",
  is_default: false,
  guidance_text: null,
  cover_url: null,
  created_at: "2026-09-13T00:00:00+00:00",
  updated_at: "2026-09-13T00:00:00+00:00",
};

describe("brand-kit repository（brand_kits 走 :user，assets 走父链）", () => {
  it("套件读写把用户绑定为末位参数（:user 谓词）", async () => {
    const list = createRunner(() => ({ rowCount: 1, rows: [KIT_ROW] }));
    await createBrandKitRepository(
      createPersistenceFromRunner(list.runner),
    ).listKits(USER_ID);
    expect(list.sqls()[0]).toContain(
      "from public.brand_kits where user_id = $1 order by created_at asc",
    );
    expect(list.calls[0]?.values).toEqual([USER_ID]);

    const find = createRunner(() => ({ rowCount: 1, rows: [KIT_ROW] }));
    await createBrandKitRepository(
      createPersistenceFromRunner(find.runner),
    ).findKit(USER_ID, KIT_ID);
    expect(find.sqls()[0]).toContain("where user_id = $2 and id = $1");
    expect(find.calls[0]?.values).toEqual([KIT_ID, USER_ID]);

    const del = createRunner(() => ({ rowCount: 1, rows: [] }));
    await createBrandKitRepository(
      createPersistenceFromRunner(del.runner),
    ).deleteKit(USER_ID, KIT_ID);
    expect(del.sqls()[0]).toContain("where user_id = $2 and id = $1");
  });

  it("资产的每条语句都带父链归属校验（exists … k.user_id = :user）", async () => {
    const list = createRunner();
    await createBrandKitRepository(
      createPersistenceFromRunner(list.runner),
    ).listAssets(USER_ID, KIT_ID);
    const listSql = list.sqls()[0] ?? "";
    expect(listSql).toContain("from public.brand_kit_assets a");
    expect(listSql).toContain(
      "exists (select 1 from public.brand_kits k where k.id = a.kit_id and k.user_id = $2)",
    );
    expect(listSql).toContain("order by a.sort_order asc, a.created_at asc");

    const insert = createRunner(() => ({ rowCount: 1, rows: [KIT_ROW] }));
    await createBrandKitRepository(
      createPersistenceFromRunner(insert.runner),
    ).insertAsset(USER_ID, KIT_ID, {
      asset_type: "color",
      display_name: "主色",
      sort_order: 0,
      text_content: "#123456",
    });
    const insertSql = insert.sqls()[0] ?? "";
    // 归属校验内联在 insert…select 的 WHERE 里：归属与写入是同一条语句
    expect(insertSql).toContain("insert into public.brand_kit_assets");
    expect(insertSql).toContain(
      "where exists (select 1 from public.brand_kits k where k.id = $1 and k.user_id = $9)",
    );
    expect(insert.calls[0]?.values.at(-1)).toBe(USER_ID);

    const del = createRunner(() => ({ rowCount: 1, rows: [] }));
    await createBrandKitRepository(
      createPersistenceFromRunner(del.runner),
    ).deleteAsset(USER_ID, KIT_ID, ASSET_ID);
    expect(del.sqls()[0]).toContain(
      "where a.id = $1 and a.kit_id = $2 and exists (select 1 from public.brand_kits k where k.id = a.kit_id and k.user_id = $3)",
    );
  });

  it("批量插入是单条语句且带归属校验（复制套件用）", async () => {
    const { calls, runner } = createRunner(() => ({ rowCount: 2, rows: [] }));

    await createBrandKitRepository(
      createPersistenceFromRunner(runner),
    ).insertAssets(USER_ID, KIT_ID, [
      {
        asset_type: "color",
        display_name: "a",
        sort_order: 0,
        text_content: "#000",
      },
      {
        asset_type: "font",
        display_name: "b",
        sort_order: 0,
        text_content: "Inter",
      },
    ]);

    expect(calls).toHaveLength(1);
    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("from (values");
    expect(sql).toContain("::public.brand_kit_asset_type");
    expect(sql).toContain(
      "where exists (select 1 from public.brand_kits k where k.id = $1 and k.user_id = $16)",
    );
  });

  it("补丁只写显式给出的列，metadata 走 jsonb cast", async () => {
    const { calls, runner } = createRunner(() => ({ rowCount: 1, rows: [] }));
    await createBrandKitRepository(
      createPersistenceFromRunner(runner),
    ).updateAsset(USER_ID, KIT_ID, ASSET_ID, {
      display_name: "新名",
      metadata: { weight: "700" },
      role: undefined,
    });

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("set display_name = $3, metadata = $4::jsonb");
    // role 出现在 RETURNING 列表里属正常；只断言 SET 未写它
    expect(sql).not.toContain("role = ");
    expect(calls[0]?.values).toEqual([
      ASSET_ID,
      KIT_ID,
      "新名",
      JSON.stringify({ weight: "700" }),
      USER_ID,
    ]);
  });
});

function createFakeRepository(
  overrides: Partial<BrandKitRepository> = {},
): BrandKitRepository {
  return {
    clearDefault: async () => 1,
    deleteAsset: async () => 1,
    deleteKit: async () => 1,
    findAsset: async () => null,
    findAssetRef: async () => ({ file_url: null, id: ASSET_ID }),
    findKit: async () => KIT_ROW,
    findKitRef: async () => KIT_ID,
    findKitSource: async () => ({ guidance_text: "指南", name: "品牌 A" }),
    insertAsset: async (_userId, _kitId, input) => ({
      asset_type: input.asset_type,
      created_at: KIT_ROW.created_at,
      display_name: input.display_name,
      file_url: input.file_url ?? null,
      id: ASSET_ID,
      metadata: input.metadata ?? {},
      role: input.role ?? null,
      sort_order: input.sort_order,
      text_content: input.text_content ?? null,
      updated_at: KIT_ROW.updated_at,
    }),
    insertAssets: async () => 1,
    insertKit: async () => KIT_ID,
    listAssetCounts: async () => [],
    listAssetFilePaths: async () => [],
    listAssets: async () => [],
    listKits: async () => [KIT_ROW],
    maxAssetSortOrder: async () => null,
    updateAsset: async () => null,
    updateKit: async () => 1,
    ...overrides,
  };
}

function createStorageStub() {
  const calls: string[] = [];
  // blob 缝替身：只记录调用，不断言 Provider 细节
  const blob = {
    bucket: (bucket: string) => ({
      isPublic: async () => false,
      resolveUrl: async (path: string) => {
        calls.push(`resolveUrl:${bucket}:${path}`);
        return `https://signed.test/${path}`;
      },
      copy: async (from: string, to: string) => {
        calls.push(`copy:${bucket}:${from}->${to}`);
      },
      createSignedUrls: async (paths: string[]) => {
        calls.push(`signedMany:${bucket}:${paths.join(",")}`);
        return [] as Array<{ path: string; signedUrl: string | null }>;
      },
      remove: async (paths: string[]) => {
        calls.push(`remove:${bucket}:${paths.join(",")}`);
      },
      upload: async (path: string) => {
        calls.push(`upload:${bucket}:${path}`);
      },
    }),
  };
  return { calls, blob: blob as never };
}

function buildService(options: {
  repository?: Partial<BrandKitRepository>;
  storage?: ReturnType<typeof createStorageStub>;
}) {
  const storage = options.storage ?? createStorageStub();
  return {
    service: createBrandKitService({
      blob: storage.blob,
      repository: createFakeRepository(options.repository),
    }),
    storage,
  };
}

describe("brand-kit service（校验与错误码保持）", () => {
  it("列表按套件计数挂上 asset_counts", async () => {
    const { service } = buildService({
      repository: {
        listAssetCounts: async () => [
          { asset_type: "color", kit_id: KIT_ID },
          { asset_type: "color", kit_id: KIT_ID },
          { asset_type: "logo", kit_id: KIT_ID },
        ],
      },
    });

    const kits = await service.listKits(USER);
    expect(kits[0]?.asset_counts).toEqual({
      color: 2,
      font: 0,
      image: 0,
      logo: 1,
    });
  });

  it("读取：缺少行 404、数据访问失败 500（两种码都保持）", async () => {
    const missing = buildService({ repository: { findKit: async () => null } });
    await expect(missing.service.getKit(USER, KIT_ID)).rejects.toMatchObject({
      code: "brand_kit_not_found",
      statusCode: 404,
    });

    const failing = buildService({
      repository: {
        findKit: async () => {
          throw new Error("connection reset");
        },
      },
    });
    const error = await failing.service
      .getKit(USER, KIT_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrandKitServiceError);
    expect(error).toMatchObject({ statusCode: 500 });
  });

  it("建套件：名称空则落「未命名」", async () => {
    const seen: string[] = [];
    const { service } = buildService({
      repository: {
        insertKit: async (_userId, input) => {
          seen.push(input.name);
          return KIT_ID;
        },
      },
    });

    await service.createKit(USER, { name: "   " } as never);
    expect(seen).toEqual(["未命名"]);
  });

  it("设默认前先清掉其它默认；空补丁直接回读", async () => {
    let cleared = 0;
    const { service } = buildService({
      repository: {
        clearDefault: async () => {
          cleared += 1;
          return 1;
        },
      },
    });

    await service.updateKit(USER, KIT_ID, { is_default: true });
    expect(cleared).toBe(1);

    await service.updateKit(USER, KIT_ID, {});
    expect(cleared).toBe(1);
  });

  it("删除套件：未命中 404；命中时先清对象存储再删行", async () => {
    const missing = buildService({
      repository: { findKitRef: async () => null },
    });
    await expect(missing.service.deleteKit(USER, KIT_ID)).rejects.toMatchObject(
      {
        code: "brand_kit_not_found",
        statusCode: 404,
      },
    );

    const { service, storage } = buildService({
      repository: { listAssetFilePaths: async () => ["u/k/a.png"] },
    });
    await service.deleteKit(USER, KIT_ID);
    expect(storage.calls).toContain("remove:brand-kit-assets:u/k/a.png");
  });

  it("建资产：套件不存在 404、存在则续接 sort_order", async () => {
    const missing = buildService({
      repository: { findKitRef: async () => null },
    });
    await expect(
      missing.service.createAsset(USER, KIT_ID, {
        asset_type: "color",
        display_name: "x",
      } as never),
    ).rejects.toMatchObject({ code: "brand_kit_not_found", statusCode: 404 });

    const orders: number[] = [];
    const { service } = buildService({
      repository: {
        insertAsset: async (_userId, _kitId, input) => {
          orders.push(input.sort_order);
          return null;
        },
        maxAssetSortOrder: async () => 4,
      },
    });
    await expect(
      service.createAsset(USER, KIT_ID, {
        asset_type: "color",
        display_name: "x",
      } as never),
    ).rejects.toMatchObject({ code: "brand_kit_asset_create_failed" });
    expect(orders).toEqual([5]);
  });

  it("上传资产：落库失败时清掉已上传对象", async () => {
    const { service, storage } = buildService({
      repository: { insertAsset: async () => null },
    });

    await expect(
      service.uploadAsset(
        USER,
        KIT_ID,
        "logo",
        "logo.png",
        Buffer.from("x"),
        "image/png",
      ),
    ).rejects.toMatchObject({ code: "brand_kit_asset_create_failed" });

    expect(storage.calls.some((call) => call.startsWith("upload:"))).toBe(true);
    expect(storage.calls.some((call) => call.startsWith("remove:"))).toBe(true);
  });

  it("复制套件：不复制 is_default，文件资产复制对象并按新套件归属批量插入", async () => {
    const inserted: Array<{ kitId: string; rows: readonly unknown[] }> = [];
    const kitInserts: string[] = [];
    const { service, storage } = buildService({
      repository: {
        insertAssets: async (_userId, kitId, rows) => {
          inserted.push({ kitId, rows });
          return rows.length;
        },
        insertKit: async (_userId, input) => {
          kitInserts.push(input.name);
          return "kit-2";
        },
        listAssets: async () => [
          {
            asset_type: "logo",
            created_at: KIT_ROW.created_at,
            display_name: "标志",
            file_url: "u/kit-1/logo.png",
            id: "a1",
            metadata: {},
            role: null,
            sort_order: 0,
            text_content: null,
            updated_at: KIT_ROW.updated_at,
          },
        ],
      },
    });

    await service.duplicateKit(USER, KIT_ID);

    expect(kitInserts).toEqual(["品牌 A (副本)"]);
    expect(storage.calls.some((call) => call.startsWith("copy:"))).toBe(true);
    expect(inserted[0]?.kitId).toBe("kit-2");
    expect(inserted[0]?.rows).toHaveLength(1);
  });

  it("复制套件：源套件不存在 404", async () => {
    const { service } = buildService({
      repository: { findKitSource: async () => null },
    });
    await expect(service.duplicateKit(USER, KIT_ID)).rejects.toMatchObject({
      code: "brand_kit_not_found",
      statusCode: 404,
    });
  });
});
