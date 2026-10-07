import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { composePlugins } from "../../kernel/compose.js";
import { createConsumerLocalAccessService } from "../local-access/test-consumer-service.js";
import { createLocalInstanceService } from "../local-instance/service.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { createAssetWriter } from "./asset-writer.js";
import { createUploadsPlugin } from "./plugin.js";
import { createUploadRepository } from "./repository.js";

const INSTANCE_ID = "instance-1";
const CLIENT_ID = "client-1";

function createRunner(
  respond: () => { rowCount: number; rows: unknown[] } = () => ({
    rowCount: 1,
    rows: [
      {
        bucket: "project-assets",
        byte_size: 12,
        created_at: "2026-09-13T00:00:00.000Z",
        id: "asset-1",
        mime_type: "image/png",
        object_path: "instance-1/generated/1.png",
        project_id: null,
        instance_id: INSTANCE_ID,
      },
    ],
  }),
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];

  const run = (text: string, values: unknown[]) => {
    calls.push({ text, values });
    return respond();
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
    runner,
    sqls: () => calls.map((c) => c.text.replace(/\s+/g, " ").trim()),
  };
}

describe("assetWriter：生成物元数据写入（实例口径）", () => {
  it("按实例写 asset_objects，并带上创建者", async () => {
    const { calls, runner } = createRunner();
    const writer = createAssetWriter(
      createUploadRepository(createPersistenceFromRunner(runner)),
    );

    const assetId = await writer.recordGeneratedAsset({
      byteSize: 12,
      mimeType: "image/png",
      objectPath: "instance-1/generated/1.png",
      createdByClientId: CLIENT_ID,
      instanceId: INSTANCE_ID,
    });

    expect(assetId).toBe("asset-1");
    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("insert into public.asset_objects");
    // `:instance` 必须出现在语句里（FORM-9 第二道防线：漏写即 InstanceIsolationError）
    expect(sql).toContain("select $7, $1, $2, $3, $4, $5::uuid, $6::uuid");
    expect(sql).toContain("p.id = $6::uuid and p.instance_id = $7");
    // bucket 固定为 project-assets（生成物桶），实例 id 由标记绑定为末位参数
    expect(calls[0]?.values).toEqual([
      "project-assets",
      "instance-1/generated/1.png",
      "image/png",
      12,
      CLIENT_ID,
      null,
      INSTANCE_ID,
    ]);
  });

  it("后台没有接入客户端时 created_by_client_id 落 NULL（列可空，不伪造客户端）", async () => {
    const { calls, runner } = createRunner();
    const writer = createAssetWriter(
      createUploadRepository(createPersistenceFromRunner(runner)),
    );

    await writer.recordGeneratedAsset({
      byteSize: 12,
      mimeType: "video/mp4",
      objectPath: "instance-1/generated/1.mp4",
      instanceId: INSTANCE_ID,
    });

    expect(calls[0]?.values).toEqual([
      "project-assets",
      "instance-1/generated/1.mp4",
      "video/mp4",
      12,
      null,
      null,
      INSTANCE_ID,
    ]);
  });

  it("插入未回行 → 抛错（不静默返回空 id）", async () => {
    const { runner } = createRunner(() => ({ rowCount: 0, rows: [] }));
    const writer = createAssetWriter(
      createUploadRepository(createPersistenceFromRunner(runner)),
    );

    await expect(
      writer.recordGeneratedAsset({
        byteSize: 1,
        mimeType: "image/png",
        objectPath: "p",
        instanceId: INSTANCE_ID,
      }),
    ).rejects.toThrow(/no row/);
  });
});

describe("uploads 插件：两条路径的装配形状", () => {
  function kernel(withRoutes: boolean) {
    return composePlugins(
      {
        agentBackendMode: "state" as const,
        agentModel: "m",
        port: 0,
        version: "t",
        webOrigin: "http://x",
      },
      [createUploadsPlugin(withRoutes ? {} : { withRoutes: false })],
      {
        app: Fastify({ logger: false }),
        overrides: {
          localAccess: createConsumerLocalAccessService(),
          // 路由形态的 uploads 服务依赖 blob 缝
          blob: { bucket: () => ({}) } as never,
          persistence: {
            forInstance: () => ({}) as never,
            close: async () => {},
            ping: async () => {},
            query: async () => [],
            queryOne: async () => null,
            execute: async () => 0,
            transaction: async (fn: never) => fn as never,
          } as never,
          localInstance: createLocalInstanceService({
            repository: { ensure: async () => INSTANCE_ID },
            dataDir: "/tmp/asset-writer-test",
          }),
        },
      },
    );
  }

  it("worker 形态（withRoutes: false）：只注册 assetWriter，不注册 uploads", () => {
    const k = kernel(false);

    expect(k.get("assetWriter").recordGeneratedAsset).toBeTypeOf("function");
    expect(() => k.get("uploads")).toThrow();
  });

  it("路由形态：assetWriter 与 uploads 都注册", () => {
    const k = kernel(true);

    expect(k.get("assetWriter").recordGeneratedAsset).toBeTypeOf("function");
    expect(k.get("uploads").uploadFile).toBeTypeOf("function");
  });
});
