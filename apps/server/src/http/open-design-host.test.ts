import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { LocalInstanceService } from "../features/local-instance/types.js";
import type { ResolvedInstanceCredentials } from "../features/model-providers/model-provider-service.js";
import { registerOpenDesignHostRoutes } from "./open-design-host.js";

/**
 * OpenDesign 宿主路由（O3 / OD-4 凭证下发）的端到端边界。
 *
 * 这条缝含明文 Key，所以每个入口都要钉死：
 * - 没配密钥 → 503（缝没开，不是「没有」）；
 * - 密钥错 → 401（timingSafeEqual，错一个字符都不行）；
 * - 协议版本错 → 400（版本协商不过就不下发）；
 * - 没有可用实例 → 404；Key 读不到 / 地址非法 → 409 且消息不含 Key 明文；
 * - 全部就绪 → 200 下发清单（明文 Key 是这条缝的目的，daemon 才拿得到）。
 */

const SECRET = "od-embed-secret";
const PROVIDER_ID = "11111111-1111-4111-8111-111111111111";
const actor = {
  instanceId: "22222222-2222-4222-8222-222222222222",
  accessClientId: null,
};

const localInstance = {
  serviceActor: async () => actor,
} as unknown as LocalInstanceService;

function fixture(
  options: {
    secret?: string;
    configured?: boolean;
    baseUrl?: string;
    keyReadable?: boolean;
    authorized?: boolean;
  } = {},
) {
  const app = Fastify();
  const instance = {
    id: PROVIDER_ID,
    scope: "local" as const,
    name: "DeepSeek",
    protocol: "openai-compatible" as const,
    ...(options.baseUrl === null
      ? {}
      : { baseUrl: options.baseUrl ?? "https://api.deepseek.com" }),
    hasCredential: true,
    configRevision: 1,
    models: [],
    headerKeys: [],
    enabled: true,
  };
  const credentials: ResolvedInstanceCredentials = {
    instanceId: PROVIDER_ID,
    name: "DeepSeek",
    protocol: "openai-compatible",
    apiKey: "sk-byok-secret",
    baseUrl: options.baseUrl ?? "https://api.deepseek.com",
    configRevision: 1,
    models: [],
  };
  const listInstances = vi.fn(async () =>
    options.configured === false ? [] : [instance],
  );
  const resolveCredentialsById = vi.fn(async () => {
    if (options.keyReadable === false)
      throw new Error("凭据文件读取失败（不应把此消息透出）");
    return credentials;
  });
  void registerOpenDesignHostRoutes(app, {
    localAccess: {
      authenticate: async () => (options.authorized === false ? null : actor),
    },
    localInstance,
    providers: {
      listInstances,
      resolveCredentialsById,
    } as never,
    ...(options.secret === undefined ? {} : { secret: options.secret }),
  });
  return { app, listInstances, resolveCredentialsById };
}

const post = (app: Fastify.FastifyInstance, token?: string, version?: string) =>
  app.inject({
    method: "POST",
    url: "/api/open-design/host/credentials",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(version ? { "x-od-embed-protocol": version } : {}),
    },
    payload: {},
  });

describe("POST /api/open-design/host/credentials", () => {
  it("未配共享密钥 → 503 service_unavailable（缝没开，不说成「没有」）", async () => {
    const { app } = fixture();
    const response = await post(app, "whatever");
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("service_unavailable");
    expect(response.json().error.message).toContain(
      "KENFUTWORK_OPEN_DESIGN_EMBED_SECRET",
    );
  });

  it("密钥缺失 / 不匹配 → 401（错一个字符都不行）", async () => {
    const { app } = fixture({ secret: SECRET });
    const noToken = await post(app);
    expect(noToken.statusCode).toBe(401);
    const wrongToken = await post(app, `${SECRET}-x`);
    expect(wrongToken.statusCode).toBe(401);
  });

  it("密钥对但协议版本带错 → 400（版本协商不过就不下发）", async () => {
    const { app } = fixture({ secret: SECRET });
    const response = await post(app, SECRET, "v2");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("版本");
  });

  it("全部就绪 → 200 下发清单（明文 Key 是这条缝的目的）", async () => {
    const { app, resolveCredentialsById } = fixture({ secret: SECRET });
    const response = await post(app, SECRET);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      protocolVersion: "v1",
      credentials: [
        {
          providerId: PROVIDER_ID,
          name: "DeepSeek",
          protocol: "openai-compatible",
          apiBase: "https://api.deepseek.com",
          apiKey: "sk-byok-secret",
        },
      ],
    });
    expect(resolveCredentialsById).toHaveBeenCalledWith(PROVIDER_ID);
  });

  it("没有可用实例 → 404 open_design_not_configured", async () => {
    const { app } = fixture({ secret: SECRET, configured: false });
    const response = await post(app, SECRET);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("open_design_not_configured");
    expect(response.json().error.message).toContain("供应商设置");
  });

  it("Key 读不到 → 409 且失败消息不含 Key 明文 / 不含服务层错误细节", async () => {
    const { app } = fixture({ secret: SECRET, keyReadable: false });
    const response = await post(app, SECRET);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(
      "open_design_credential_unavailable",
    );
    expect(response.json().error.message).toContain("DeepSeek");
    expect(response.body).not.toContain("sk-byok-secret");
    expect(response.body).not.toContain("凭据文件读取失败");
  });

  it("地址非法 → 409 open_design_credential_unavailable", async () => {
    const { app } = fixture({
      secret: SECRET,
      baseUrl: "ftp://127.0.0.1:9000",
    });
    const response = await post(app, SECRET);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(
      "open_design_credential_unavailable",
    );
  });

  it("status 探针不受凭证缝影响：未接入 → 401；接入后如实 disabled", async () => {
    const denied = fixture({ secret: SECRET, authorized: false });
    const unauthorized = await denied.app.inject({
      method: "GET",
      url: "/api/open-design/host/status",
    });
    expect(unauthorized.statusCode).toBe(401);

    const { app } = fixture({ secret: SECRET });
    const authorized = await app.inject({
      method: "GET",
      url: "/api/open-design/host/status",
    });
    // localAccess 假实现恒过；未配 frontendUrl → 如实 disabled + 原因
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().enabled).toBe(false);
    expect(authorized.json().reasons.join("")).toContain("未配置");
  });
});

/**
 * 桌面承载配置读写（§205 设置页写入口）：本机接入门 + origin 校验 + 文件往返。
 */
describe("GET/PUT /api/open-design/host/config", () => {
  const configFixture = (
    options: { authorized?: boolean; withDir?: boolean } = {},
  ) => {
    const app = Fastify();
    const dataDir =
      options.withDir === false
        ? undefined
        : mkdtempSync(join(tmpdir(), "kfw-od-route-"));
    void registerOpenDesignHostRoutes(app, {
      localAccess: {
        authenticate: async () => (options.authorized === false ? null : actor),
      },
      localInstance,
      ...(dataDir ? { dataDir } : {}),
    });
    return { app, dataDir };
  };

  it("空目录 GET → 全空 + source=none；PUT 合法 origin 后 GET 回读（file + 待重启）", async () => {
    const { app, dataDir } = configFixture();
    const empty = await app.inject({
      method: "GET",
      url: "/api/open-design/host/config",
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({
      frontendUrl: null,
      embedSecret: null,
      restartRequired: false,
      source: "none",
    });

    const put = await app.inject({
      method: "PUT",
      url: "/api/open-design/host/config",
      payload: {
        frontendUrl: "http://127.0.0.1:7456",
        embedSecret: "paired-value",
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({
      frontendUrl: "http://127.0.0.1:7456",
      embedSecret: "paired-value",
      restartRequired: true,
      source: "file",
    });
    // 落盘的是 Tauri 认识的白名单文件格式
    const raw = readFileSync(
      join(dataDir!, "config", "open-design.env"),
      "utf8",
    );
    expect(raw).toContain(
      "KENFUTWORK_OPEN_DESIGN_FRONTEND_URL=http://127.0.0.1:7456",
    );
    expect(raw).toContain("KENFUTWORK_OPEN_DESIGN_EMBED_SECRET=paired-value");
  });

  it("origin 校验三拒：坏 URL / 带路径 / 非 http(s)——都不落盘", async () => {
    const { app, dataDir } = configFixture();
    for (const bad of [
      "not a url",
      "http://127.0.0.1:7456/some/path",
      "ftp://h/p",
    ]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/open-design/host/config",
        payload: { frontendUrl: bad },
      });
      expect(res.statusCode, bad).toBe(400);
    }
    expect(existsSync(join(dataDir!, "config", "open-design.env"))).toBe(false);
  });

  it("两键全 null → 清除文件内容（回到 none）", async () => {
    const { app } = configFixture();
    await app.inject({
      method: "PUT",
      url: "/api/open-design/host/config",
      payload: { frontendUrl: "http://localhost:7456", embedSecret: "x" },
    });
    const cleared = await app.inject({
      method: "PUT",
      url: "/api/open-design/host/config",
      payload: { frontendUrl: null, embedSecret: null },
    });
    expect(cleared.json()).toMatchObject({
      frontendUrl: null,
      embedSecret: null,
      source: "none",
    });
  });

  it("本机接入未授权 → GET/PUT 都 401；未配 dataDir → 路由不注册（404）", async () => {
    const denied = configFixture({ authorized: false });
    expect(
      (
        await denied.app.inject({
          method: "GET",
          url: "/api/open-design/host/config",
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await denied.app.inject({
          method: "PUT",
          url: "/api/open-design/host/config",
          payload: {},
        })
      ).statusCode,
    ).toBe(401);

    const noDir = configFixture({ withDir: false });
    expect(
      (
        await noDir.app.inject({
          method: "GET",
          url: "/api/open-design/host/config",
        })
      ).statusCode,
    ).toBe(404);
  });
});
