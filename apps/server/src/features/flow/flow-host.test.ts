import type { ProviderInstanceResponse } from "@kenfutwork/shared";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerFlowHostRoutes } from "../../http/flow-host.js";
import type { AuthenticatedUser, RequestAuthenticator } from "../auth/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import type { ModelProviderService } from "../model-providers/model-provider-service.js";

const SECRET = "flow-embed-secret-0123456789";
const HOST_TOKEN = "host-session-token";

function createAuth(options: {
  user?: AuthenticatedUser | null;
  throwOnCall?: boolean;
  seen?: Array<string | undefined>;
}): RequestAuthenticator {
  return {
    async authenticate(request) {
      options.seen?.push(request.headers.authorization);
      if (options.throwOnCall) throw new Error("数据库炸了");
      return options.user === undefined ? null : options.user;
    },
  };
}

function createViewer(options: {
  displayName?: string;
  throwOnCall?: boolean;
}): ViewerService {
  return {
    async ensureViewer() {
      if (options.throwOnCall) throw new Error("BootstrapError");
      return {
        profile: { displayName: options.displayName ?? "" },
      } as unknown as Awaited<ReturnType<ViewerService["ensureViewer"]>>;
    },
    async resolveWorkspace() {
      throw new Error("本测试用不到");
    },
    async updateProfile() {
      throw new Error("本测试用不到");
    },
  };
}

/**
 * BYOK 供应商缝的记录型替身：实例清单按 scope 分开存，
 * `resolveCredentials` 按 id 给明文（真实实现里明文只在解密边界出现）。
 */
function createProviders(options: {
  workspace?: ProviderInstanceResponse[];
  system?: ProviderInstanceResponse[];
  credentials?: Record<string, { baseUrl?: string; apiKey: string }>;
  throwOnResolve?: boolean;
}) {
  const resolved: string[] = [];
  const providers = {
    async listInstances() {
      return options.workspace ?? [];
    },
    async listSystemInstances() {
      return options.system ?? [];
    },
    async resolveCredentials(
      _user: unknown,
      instanceId: string,
    ): Promise<{ baseUrl?: string; apiKey: string }> {
      resolved.push(instanceId);
      if (options.throwOnResolve) throw new Error("解密失败");
      return options.credentials?.[instanceId] ?? { apiKey: "" };
    },
  } as unknown as Pick<
    ModelProviderService,
    "listInstances" | "listSystemInstances" | "resolveCredentials"
  >;
  return { providers, resolved };
}

function difyInstance(overrides: Partial<ProviderInstanceResponse> = {}) {
  return {
    id: "dify-1",
    scope: "workspace" as const,
    name: "本地 Dify",
    protocol: "dify-engine",
    baseUrl: "http://127.0.0.1:5001",
    hasCredential: true,
    models: [],
    headerKeys: [],
    enabled: true,
    ...overrides,
  } satisfies ProviderInstanceResponse;
}

async function createApp(options: {
  secret?: string | undefined;
  frontendUrl?: string | undefined;
  auth?: RequestAuthenticator;
  viewer?: ViewerService;
  providers?: Pick<
    ModelProviderService,
    "listInstances" | "listSystemInstances" | "resolveCredentials"
  >;
}) {
  const app = Fastify();
  await registerFlowHostRoutes(app, {
    auth: options.auth ?? createAuth({ user: null }),
    viewer: options.viewer ?? createViewer({}),
    providers: options.providers ?? createProviders({}).providers,
    secret: options.secret,
    frontendUrl: options.frontendUrl,
  });
  return app;
}

const USER: AuthenticatedUser = {
  id: "user-123",
  // 宿主会话令牌：**不得**出现在响应里（下面的 200 用例按整体形状断言）
  accessToken: HOST_TOKEN,
  email: "ken@example.com",
  userMetadata: {},
};

function post(
  app: Awaited<ReturnType<typeof createApp>>,
  options: {
    authorization?: string;
    protocol?: string;
    payload?: unknown;
  } = {},
) {
  return app.inject({
    method: "POST",
    url: "/api/flow/host/identity",
    headers: {
      ...(options.authorization
        ? { authorization: options.authorization }
        : {}),
      ...(options.protocol ? { "x-ff-embed-protocol": options.protocol } : {}),
    },
    payload: options.payload ?? { token: HOST_TOKEN },
  });
}

describe("flow 宿主能力探针（/api/flow/host/status）", () => {
  it("未配置任何 flow 变量 → 200 + disabled，reasons 点名两个缺失项（不是 404/503）", async () => {
    const app = await createApp({
      secret: undefined,
      auth: createAuth({ user: USER }),
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/flow/host/status",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.enabled).toBe(false);
    expect(body.frontendUrl).toBeNull();
    expect(body.reasons).toHaveLength(2);
    expect(body.reasons.join(" ")).toContain("KENFUTWORK_FLOW_EMBED_SECRET");
    expect(body.reasons.join(" ")).toContain("KENFUTWORK_FLOW_FRONTEND_URL");
  });

  it("只配密钥缺前端地址 → disabled 且只缺一项", async () => {
    const app = await createApp({
      secret: SECRET,
      auth: createAuth({ user: USER }),
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/flow/host/status",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      enabled: false,
      frontendUrl: null,
      reasons: [expect.stringContaining("KENFUTWORK_FLOW_FRONTEND_URL")],
    });
  });

  it("两项都配齐 → enabled 且透出 frontendUrl（不要求共享密钥头，走会话鉴权）", async () => {
    const app = await createApp({
      secret: SECRET,
      frontendUrl: "http://127.0.0.1:8080",
      auth: createAuth({ user: USER }),
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/flow/host/status",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      enabled: true,
      frontendUrl: "http://127.0.0.1:8080",
      reasons: [],
    });
  });

  it("未登录 → 401（探针也不给匿名看配置面）", async () => {
    const app = await createApp({
      secret: SECRET,
      frontendUrl: "http://127.0.0.1:8080",
      auth: createAuth({ user: null }),
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/flow/host/status",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("flow 宿主身份交换（/api/flow/host/identity）", () => {
  it("未配置共享密钥 → 503 且点名环境变量（不假装能用）", async () => {
    const app = await createApp({ secret: undefined });
    const response = await post(app, { authorization: `Bearer ${SECRET}` });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.message).toContain(
      "KENFUTWORK_FLOW_EMBED_SECRET",
    );
  });

  it("共享密钥不匹配（缺 / 错 / 超长）→ 401，且不进入会话验签", async () => {
    const seen: Array<string | undefined> = [];
    const app = await createApp({
      secret: SECRET,
      auth: createAuth({ user: USER, seen }),
    });

    for (const authorization of [
      undefined,
      "Bearer wrong-secret",
      `Bearer ${SECRET}x`,
      `Bearer ${SECRET.slice(0, 10)}`,
    ]) {
      const response = await post(app, {
        ...(authorization ? { authorization } : {}),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("unauthorized");
    }
    expect(seen).toEqual([]);
  });

  it("协议版本不匹配 → 400 且把两端版本都写在原因里", async () => {
    const app = await createApp({
      secret: SECRET,
      auth: createAuth({ user: USER }),
    });
    const response = await post(app, {
      authorization: `Bearer ${SECRET}`,
      protocol: "v2",
      payload: { token: HOST_TOKEN, protocolVersion: "v2" },
    });
    expect(response.statusCode).toBe(400);
    const message = response.json().error.message as string;
    expect(message).toContain("v1");
    expect(message).toContain("v2");
  });

  it("请求体缺 token / token 非字符串 → 400", async () => {
    const app = await createApp({
      secret: SECRET,
      auth: createAuth({ user: USER }),
    });
    for (const payload of [{}, { token: "" }, { token: 42 }]) {
      const response = await post(app, {
        authorization: `Bearer ${SECRET}`,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("请求体不是合法 JSON → 400（解析层就挡住，不落到业务）", async () => {
    const app = await createApp({
      secret: SECRET,
      auth: createAuth({ user: USER }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/flow/host/identity",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      payload: "{ not json",
    });
    expect(response.statusCode).toBe(400);
  });

  it("宿主会话令牌无效 → 401（且验的是 body 里的令牌，不是共享密钥）", async () => {
    const seen: Array<string | undefined> = [];
    const app = await createApp({
      secret: SECRET,
      auth: createAuth({ user: null, seen }),
    });
    const response = await post(app, { authorization: `Bearer ${SECRET}` });
    expect(response.statusCode).toBe(401);
    expect(seen).toEqual([`Bearer ${HOST_TOKEN}`]);
    expect(seen[0]).not.toContain(SECRET);
  });

  it("正常交换 → 200 返回 subject / displayName / email", async () => {
    const app = await createApp({
      secret: SECRET,
      auth: createAuth({ user: USER }),
      viewer: createViewer({ displayName: "肯肯" }),
    });
    const response = await post(app, { authorization: `Bearer ${SECRET}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      subject: "user-123",
      displayName: "肯肯",
      email: "ken@example.com",
    });
  });

  it("viewer 档案缺失（抛错）→ 仍 200，只省略 displayName", async () => {
    const app = await createApp({
      secret: SECRET,
      auth: createAuth({ user: USER }),
      viewer: createViewer({ throwOnCall: true }),
    });
    const response = await post(app, { authorization: `Bearer ${SECRET}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      subject: "user-123",
      email: "ken@example.com",
    });
  });
});

describe("flow 宿主凭证下发（/api/flow/host/credentials，P3 凭证缝）", () => {
  function postCredentials(
    app: Awaited<ReturnType<typeof createApp>>,
    options: { authorization?: string; payload?: unknown } = {},
  ) {
    return app.inject({
      method: "POST",
      url: "/api/flow/host/credentials",
      headers: options.authorization
        ? { authorization: options.authorization }
        : {},
      payload: options.payload ?? { token: HOST_TOKEN },
    });
  }

  it("未配置共享密钥 → 503；密钥不匹配 → 401（与身份交换同一道门）", async () => {
    const app = await createApp({
      secret: undefined,
      auth: createAuth({ user: USER }),
    });
    const unavailable = await postCredentials(app, {
      authorization: `Bearer ${SECRET}`,
    });
    expect(unavailable.statusCode).toBe(503);

    const configured = await createApp({
      secret: SECRET,
      auth: createAuth({ user: USER }),
    });
    const wrong = await postCredentials(configured, {
      authorization: "Bearer nope",
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("工作区与平台池都没有 dify-engine 实例 → 404 且指路（配实例或撤 HOST_CREDENTIALS_URL）", async () => {
    const { providers } = createProviders({
      workspace: [
        difyInstance({ protocol: "openai-compatible", id: "chat-1" }),
      ],
    });
    const app = await createApp({
      secret: SECRET,
      auth: createAuth({ user: USER }),
      providers,
    });
    const response = await postCredentials(app, {
      authorization: `Bearer ${SECRET}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("dify-engine");
    expect(response.json().error.message).toContain("HOST_CREDENTIALS_URL");
  });

  it("工作区实例命中 → 200 下发 apiBase/apiKey/label（明文 Key 只经这条双门通道）", async () => {
    const { providers, resolved } = createProviders({
      workspace: [difyInstance()],
      credentials: {
        "dify-1": { baseUrl: "http://127.0.0.1:5001/", apiKey: "app-secret" },
      },
    });
    const app = await createApp({
      secret: SECRET,
      auth: createAuth({ user: USER }),
      providers,
    });
    const response = await postCredentials(app, {
      authorization: `Bearer ${SECRET}`,
    });
    expect(response.statusCode).toBe(200);
    // 尾斜杠归一（与 flow 侧 HostCredentialsPayload 的 apiBase 口径一致）
    expect(response.json()).toEqual({
      apiBase: "http://127.0.0.1:5001",
      apiKey: "app-secret",
      label: "本地 Dify",
    });
    expect(resolved).toEqual(["dify-1"]);
  });

  it("工作区没有 → 平台池（scope=system）兜底；禁用的实例被跳过", async () => {
    const { providers } = createProviders({
      system: [
        difyInstance({ id: "off", scope: "system", enabled: false }),
        difyInstance({ id: "pool", scope: "system", name: "平台 Dify" }),
      ],
      credentials: {
        pool: { baseUrl: "http://10.0.0.8:5001", apiKey: "pool-key" },
      },
    });
    const app = await createApp({
      secret: SECRET,
      auth: createAuth({ user: USER }),
      providers,
    });
    const response = await postCredentials(app, {
      authorization: `Bearer ${SECRET}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      apiBase: "http://10.0.0.8:5001",
      apiKey: "pool-key",
      label: "平台 Dify",
    });
  });

  it("实例缺 base_url / 非 http(s) → 409 可读原因（不静默下发半截凭证）", async () => {
    const missing = createProviders({
      workspace: [difyInstance({ baseUrl: undefined })],
      credentials: { "dify-1": { apiKey: "k" } },
    });
    const appMissing = await createApp({
      secret: SECRET,
      auth: createAuth({ user: USER }),
      providers: missing.providers,
    });
    const responseMissing = await postCredentials(appMissing, {
      authorization: `Bearer ${SECRET}`,
    });
    expect(responseMissing.statusCode).toBe(409);
    expect(responseMissing.json().error.message).toContain("base_url");

    const bad = createProviders({
      workspace: [difyInstance({ baseUrl: "ftp://x" })],
      credentials: { "dify-1": { baseUrl: "ftp://x", apiKey: "k" } },
    });
    const appBad = await createApp({
      secret: SECRET,
      auth: createAuth({ user: USER }),
      providers: bad.providers,
    });
    const responseBad = await postCredentials(appBad, {
      authorization: `Bearer ${SECRET}`,
    });
    expect(responseBad.statusCode).toBe(409);
  });

  it("宿主会话令牌无效 → 401（验的是 body 令牌，不是共享密钥）", async () => {
    const seen: Array<string | undefined> = [];
    const { providers } = createProviders({ workspace: [difyInstance()] });
    const app = await createApp({
      secret: SECRET,
      auth: createAuth({ user: null, seen }),
      providers,
    });
    const response = await postCredentials(app, {
      authorization: `Bearer ${SECRET}`,
    });
    expect(response.statusCode).toBe(401);
    expect(seen).toEqual([`Bearer ${HOST_TOKEN}`]);
  });
});
