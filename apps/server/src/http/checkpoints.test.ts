import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { RequestAuthenticator } from "../features/auth/types.js";
import {
  type CheckpointService,
  CodeCheckpointError,
} from "../features/checkpoints/checkpoint-service.js";
import type { CheckpointRow } from "../features/checkpoints/repository.js";
import { registerCheckpointsRoutes } from "./checkpoints.js";

/**
 * 检查点路由薄测试：鉴权、入参检查、在途守卫与错误映射（归属校验在 service，
 * 由 checkpoint-service.test.ts 锁）。服务用替身——真实 git 行为不在这里重复测。
 */

const user = {
  accessToken: "token",
  email: "u@example.com",
  id: "user-1",
  userMetadata: {},
};

const auth = {
  authenticate: async () => user,
} as unknown as RequestAuthenticator;

const authFailing = {
  authenticate: async () => null,
} as unknown as RequestAuthenticator;

const viewerService = {
  resolveWorkspace: async () => ({
    id: "ws-1",
    name: "我的工作区",
    type: "personal" as const,
    ownerUserId: "user-1",
  }),
};

const row = (overrides: Partial<CheckpointRow> = {}): CheckpointRow => ({
  id: "ck-1",
  workspaceId: "ws-1",
  canvasId: "canvas-1",
  runId: null,
  kind: "turn",
  label: "轮次开始快照",
  shadowCommit: "a".repeat(40),
  filesChanged: 1,
  insertions: 1,
  deletions: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

function makeService(
  overrides: Partial<CheckpointService> = {},
): CheckpointService {
  const base = {
    beforeTurn: async () => null,
    afterTurn: async () => null,
    list: async () => [row()],
    diffFor: async () => ({
      text: "diff --git a/a.txt b/a.txt\n",
      from: "0".repeat(40),
      to: "a".repeat(40),
      files: [
        { path: "a.txt", added: 1, deleted: 0 },
        { path: "logo.png", added: null, deleted: null },
      ],
    }),
    previewRestore: async () => ({
      targetSha: "b".repeat(40),
      files: [{ path: "a.txt", added: 2, deleted: 1 }],
      filesChanged: 1,
      insertions: 2,
      deletions: 1,
    }),
    restore: async () => row({ kind: "restore", label: "回滚恢复点" }),
  };
  return { ...base, ...overrides } as CheckpointService;
}

async function buildApp(input: {
  service?: CheckpointService;
  agentRuns?: { hasActiveRunForCanvas: (canvasId: string) => boolean };
  authenticator?: RequestAuthenticator;
}) {
  const app = Fastify();
  await app.register(registerCheckpointsRoutes, {
    auth: input.authenticator ?? auth,
    viewerService,
    checkpointsService: input.service ?? makeService(),
    ...(input.agentRuns ? { agentRuns: input.agentRuns } : {}),
  });
  return app;
}

describe("GET /api/code/checkpoints", () => {
  afterEach(async () => {
    await Fastify().close();
  });

  it("未鉴权 401；缺 canvasId 400", async () => {
    const app = await buildApp({});
    const noCanvas = await app.inject({
      method: "GET",
      url: "/api/code/checkpoints",
    });
    expect(noCanvas.statusCode).toBe(400);

    const failing = await buildApp({ authenticator: authFailing });
    const denied = await failing.inject({
      method: "GET",
      url: "/api/code/checkpoints?canvasId=canvas-1",
    });
    expect(denied.statusCode).toBe(401);
  });

  it("200 返回时间线，且服务行的 workspaceId/canvasId 不外发", async () => {
    const app = await buildApp({});
    const response = await app.inject({
      method: "GET",
      url: "/api/code/checkpoints?canvasId=canvas-1",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.checkpoints).toHaveLength(1);
    expect(body.checkpoints[0]).toMatchObject({
      id: "ck-1",
      kind: "turn",
      runId: null,
      shadowCommit: "a".repeat(40),
    });
    expect(body.checkpoints[0]).not.toHaveProperty("workspaceId");
    expect(body.checkpoints[0]).not.toHaveProperty("canvasId");
  });

  it("服务抛 CodeCheckpointError 按状态码映射（503 git_unavailable）", async () => {
    const app = await buildApp({
      service: makeService({
        list: async () => {
          throw new CodeCheckpointError(
            "git_unavailable",
            "运行环境没有 git，检查点功能不可用。",
            503,
          );
        },
      }),
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/code/checkpoints?canvasId=canvas-1",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({
      code: "git_unavailable",
    });
  });
});

describe("GET /api/code/checkpoints/:id/diff", () => {
  it("200：服务 text 字段映射为 diff，files 原样透出（二进制行数 null）", async () => {
    const app = await buildApp({});
    const response = await app.inject({
      method: "GET",
      url: "/api/code/checkpoints/ck-1/diff",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.diff).toContain("diff --git");
    expect(body.files).toEqual([
      { path: "a.txt", added: 1, deleted: 0 },
      { path: "logo.png", added: null, deleted: null },
    ]);
  });

  it("检查点不存在映射 404", async () => {
    const app = await buildApp({
      service: makeService({
        diffFor: async () => {
          throw new CodeCheckpointError(
            "not_found",
            "检查点不存在或不属于当前工作区。",
            404,
          );
        },
      }),
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/code/checkpoints/missing/diff",
    });
    expect(response.statusCode).toBe(404);
    // 服务内部语义码 not_found 在路由映射成 feature 专属码（枚举不含裸 not_found）
    expect(response.json().error.code).toBe("checkpoint_not_found");
  });
});

describe("POST /api/code/checkpoints/:id/preview", () => {
  it("200：目标 sha + 受影响清单与汇总", async () => {
    const app = await buildApp({});
    const response = await app.inject({
      method: "POST",
      url: "/api/code/checkpoints/ck-1/preview",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      targetSha: "b".repeat(40),
      filesChanged: 1,
      insertions: 2,
      deletions: 1,
    });
  });
});

describe("POST /api/code/checkpoints/:id/restore", () => {
  it("画布有在途 run：409 且不触达服务", async () => {
    let asked = 0;
    const app = await buildApp({
      agentRuns: {
        hasActiveRunForCanvas: (canvasId) => {
          asked += 1;
          return canvasId === "canvas-1";
        },
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/code/checkpoints/ck-1/restore?canvasId=canvas-1",
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("run_in_progress");
    expect(response.json().error.message).toContain("正在运行");
    expect(asked).toBe(1);
  });

  it("无在途 run：200 返回恢复后的检查点；缺 canvasId 400", async () => {
    const app = await buildApp({
      agentRuns: { hasActiveRunForCanvas: () => false },
    });
    const ok = await app.inject({
      method: "POST",
      url: "/api/code/checkpoints/ck-1/restore?canvasId=canvas-1",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().checkpoint).toMatchObject({
      kind: "restore",
      label: "回滚恢复点",
    });

    const missing = await app.inject({
      method: "POST",
      url: "/api/code/checkpoints/ck-1/restore",
    });
    expect(missing.statusCode).toBe(400);
  });
});
