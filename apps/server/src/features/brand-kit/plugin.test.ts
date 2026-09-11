import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../../supabase/user.js";
import type { BrandKitService } from "./brand-kit-service.js";
import { brandKitPlugin } from "./plugin.js";

const testEnv: ServerEnv = {
  agentBackendMode: "state",
  agentModel: "test-model",
  port: 0,
  version: "test",
  webOrigin: "http://localhost:3000",
};

const fakeUser: AuthenticatedUser = {
  accessToken: "token",
  email: "user@example.com",
  id: "user-1",
  userMetadata: {},
};

function fakeBrandKitService(listResult: unknown[]): BrandKitService {
  return {
    listKits: async () => listResult,
  } as unknown as BrandKitService;
}

describe("brandKitPlugin（P2 插件化试点）", () => {
  it("经内核装配后注册 /api/brand-kits 路由并消费 overrides 的服务实例", async () => {
    const app = Fastify({ logger: false });
    const auth: RequestAuthenticator = {
      authenticate: async () => fakeUser,
    };
    const brandKit = fakeBrandKitService([]);
    const kernel = composePlugins(testEnv, [brandKitPlugin], {
      app,
      overrides: { auth, brandKit },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/brand-kits",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ brandKits: [] });

    await app.close();
    kernel.dispose();
  });

  it("认证失败返回 401，不触达服务", async () => {
    const app = Fastify({ logger: false });
    const auth: RequestAuthenticator = {
      authenticate: async () => null,
    };
    const listKitsCalls: number[] = [];
    const brandKit = {
      listKits: async () => {
        listKitsCalls.push(1);
        return [];
      },
    } as unknown as BrandKitService;
    const kernel = composePlugins(testEnv, [brandKitPlugin], {
      app,
      overrides: { auth, brandKit },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/brand-kits",
    });
    expect(response.statusCode).toBe(401);
    expect(listKitsCalls).toHaveLength(0);

    await app.close();
    kernel.dispose();
  });

  it("未提供 auth 依赖时装配 fail loud（能力缝三元组不完整即拒绝启动）", () => {
    const app = Fastify({ logger: false });
    expect(() =>
      composePlugins(testEnv, [brandKitPlugin], {
        app,
        overrides: { brandKit: fakeBrandKitService([]) },
      }),
    ).toThrow(/服务 key auth 未注册/);
    return app.close();
  });
});
