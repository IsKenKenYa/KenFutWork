import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { RequestAuthenticator } from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import { registerCodeWorkDirRoutes } from "./code-work-dir.js";

/**
 * 工作目录的生效绑定路由：鉴权 / 工作区失败 / 「没有载体画布或没有映射」回 none /
 * 命中映射回 env + 路径。归属口径是「本工作区的 Code 工作台画布」，没有可枚举的输入。
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
} as unknown as ViewerService;

const viewerFailing = {
  resolveWorkspace: async () => {
    throw new Error("boom");
  },
} as unknown as ViewerService;

async function buildApp(input: {
  workbenchCanvas?: string | null;
  canvasWorkDirs?: Record<string, string>;
  authenticator?: RequestAuthenticator;
  viewer?: ViewerService;
}) {
  const app = Fastify();
  await app.register(registerCodeWorkDirRoutes, {
    auth: input.authenticator ?? auth,
    viewerService: input.viewer ?? viewerService,
    projectRepository: {
      findCodeWorkbenchCanvas: async () => input.workbenchCanvas ?? null,
    },
    ...(input.canvasWorkDirs ? { canvasWorkDirs: input.canvasWorkDirs } : {}),
  });
  return app;
}

describe("GET /api/code/work-dir", () => {
  it("未鉴权 401", async () => {
    const app = await buildApp({ authenticator: authFailing });
    const response = await app.inject({
      method: "GET",
      url: "/api/code/work-dir",
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("工作区解析失败：降级为 none（与 runs/activity 同一只读口径）", async () => {
    const app = await buildApp({
      viewer: viewerFailing,
      workbenchCanvas: "canvas-1",
      canvasWorkDirs: { "canvas-1": "D:/somewhere" },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/code/work-dir",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ binding: { source: "none" } });
    await app.close();
  });

  it("没有载体画布 / 画布没有映射 / 映射的是别的画布：一律 none", async () => {
    const cases = [
      {},
      { workbenchCanvas: "canvas-1" },
      {
        workbenchCanvas: "canvas-1",
        canvasWorkDirs: { "canvas-other": "D:/somewhere" },
      },
    ];
    for (const input of cases) {
      const app = await buildApp(input);
      const response = await app.inject({
        method: "GET",
        url: "/api/code/work-dir",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ binding: { source: "none" } });
      await app.close();
    }
  });

  it("载体画布有映射：返回 env + 路径（空白映射值当没有）", async () => {
    const app = await buildApp({
      workbenchCanvas: "canvas-1",
      canvasWorkDirs: { "canvas-1": "  D:\\Desktop\\test  " },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/code/work-dir",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      binding: { source: "env", path: "D:\\Desktop\\test" },
    });
    await app.close();
  });
});
