import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerFlowHostRoutes } from "../../http/flow-host.js";
import type { AuthenticatedUser, RequestAuthenticator } from "../auth/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";

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

async function createApp(options: {
  secret?: string | undefined;
  frontendUrl?: string | undefined;
  auth?: RequestAuthenticator;
  viewer?: ViewerService;
}) {
  const app = Fastify();
  await registerFlowHostRoutes(app, {
    auth: options.auth ?? createAuth({ user: null }),
    viewer: options.viewer ?? createViewer({}),
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
