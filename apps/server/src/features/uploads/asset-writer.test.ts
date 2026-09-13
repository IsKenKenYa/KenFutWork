import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { composePlugins } from "../../kernel/compose.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { createAssetWriter } from "./asset-writer.js";
import { createUploadsPlugin } from "./plugin.js";
import { createUploadRepository } from "./repository.js";

const WORKSPACE_ID = "ws-1";
const USER_ID = "user-1";

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
        object_path: "ws-1/generated/1.png",
        project_id: null,
        workspace_id: WORKSPACE_ID,
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
    async end() {},
  };

  return {
    calls,
    runner,
    sqls: () => calls.map((c) => c.text.replace(/\s+/g, " ").trim()),
  };
}

describe("assetWriter：生成物元数据写入（工作区口径）", () => {
  it("按工作区写 asset_objects，并带上创建者", async () => {
    const { calls, runner } = createRunner();
    const writer = createAssetWriter(
      createUploadRepository(createPersistenceFromRunner(runner)),
    );

    const assetId = await writer.recordGeneratedAsset({
      byteSize: 12,
      mimeType: "image/png",
      objectPath: "ws-1/generated/1.png",
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });

    expect(assetId).toBe("asset-1");
    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("insert into public.asset_objects");
    // `:workspace` 必须出现在语句里（FORM-9 第二道防线：漏写即 WorkspaceIsolationError）
    expect(sql).toContain("values ($7, $1, $2, $3, $4, $5, $6)");
    // bucket 固定为 project-assets（生成物桶），工作区 id 由标记绑定为末位参数
    expect(calls[0]?.values).toEqual([
      "project-assets",
      "ws-1/generated/1.png",
      "image/png",
      12,
      USER_ID,
      null,
      WORKSPACE_ID,
    ]);
  });

  it("无用户身份时 created_by 落 NULL（列可空，不伪造用户）", async () => {
    const { calls, runner } = createRunner();
    const writer = createAssetWriter(
      createUploadRepository(createPersistenceFromRunner(runner)),
    );

    await writer.recordGeneratedAsset({
      byteSize: 12,
      mimeType: "video/mp4",
      objectPath: "ws-1/generated/1.mp4",
      workspaceId: WORKSPACE_ID,
    });

    expect(calls[0]?.values).toEqual([
      "project-assets",
      "ws-1/generated/1.mp4",
      "video/mp4",
      12,
      null,
      null,
      WORKSPACE_ID,
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
        workspaceId: WORKSPACE_ID,
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
      [
        createUploadsPlugin(
          withRoutes
            ? { createUserClient: (() => ({})) as never }
            : { withRoutes: false },
        ),
      ],
      {
        app: Fastify({ logger: false }),
        overrides: {
          auth: { authenticate: async () => null },
          persistence: {
            forUser: () => ({}) as never,
            forWorkspace: () => ({}) as never,
            close: async () => {},
            ping: async () => {},
            query: async () => [],
            queryOne: async () => null,
            execute: async () => 0,
            transaction: async (fn: never) => fn as never,
          } as never,
          viewer: {} as never,
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

  it("路由形态缺 createUserClient → fail loud（不静默降级）", () => {
    expect(() =>
      composePlugins(
        {
          agentBackendMode: "state" as const,
          agentModel: "m",
          port: 0,
          version: "t",
          webOrigin: "http://x",
        },
        [createUploadsPlugin({})],
        {
          app: Fastify({ logger: false }),
          overrides: {
            auth: { authenticate: async () => null },
            persistence: {
              forUser: () => ({}) as never,
              forWorkspace: () => ({}) as never,
            } as never,
            viewer: {} as never,
          },
        },
      ),
    ).toThrow(/路由形态必须提供用户客户端工厂/);
  });
});
