import type { ProviderInstanceResponse } from "@kenfutwork/shared";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerFlowHostRoutes } from "../../http/flow-host.js";
import type { AuthenticatedUser, RequestAuthenticator } from "../auth/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import {
  type CreditService,
  CreditServiceError,
} from "../credits/credit-service.js";
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
 * BYOK 供应商缝的记录型替身：平台池实例清单 + 按 id 给明文
 * （真实实现里明文只在解密边界出现）。
 */
function createProviders(options: {
  system?: ProviderInstanceResponse[];
  credentials?: Record<string, { baseUrl?: string; apiKey: string }>;
}) {
  const resolved: string[] = [];
  const providers = {
    async listSystemInstances() {
      return options.system ?? [];
    },
    async resolveCredentialsById(
      instanceId: string,
    ): Promise<{ baseUrl?: string; apiKey: string }> {
      resolved.push(instanceId);
      return options.credentials?.[instanceId] ?? { apiKey: "" };
    },
  } as unknown as Pick<
    ModelProviderService,
    "listSystemInstances" | "resolveCredentialsById"
  >;
  return { providers, resolved };
}

function difyInstance(overrides: Partial<ProviderInstanceResponse> = {}) {
  return {
    id: "dify-1",
    scope: "system" as const,
    name: "平台 Dify",
    protocol: "dify-engine",
    baseUrl: "http://127.0.0.1:5001",
    hasCredential: true,
    configRevision: 1,
    models: [],
    headerKeys: [],
    enabled: true,
    ...overrides,
  } satisfies ProviderInstanceResponse;
}

/** credits 缝的记录型替身：记录调用参数并按脚本返回结果或抛错。 */
function createCredits(
  script: { reserve?: unknown; settle?: unknown; refund?: unknown } = {},
) {
  const calls: Array<{ op: string; input: unknown }> = [];
  const credits = {
    async flowReserveCredits(input: unknown) {
      calls.push({ op: "reserve", input });
      const value = script.reserve;
      if (value instanceof Error) throw value;
      return value ?? { holdId: "hold-1", frozenAmount: 0, replayed: false };
    },
    async flowSettleCredits(input: unknown) {
      calls.push({ op: "settle", input });
      const value = script.settle;
      if (value instanceof Error) throw value;
      return (
        value ?? {
          txId: "tx-1",
          settledAmount: 0,
          uncoveredAmount: 0,
          replayed: false,
        }
      );
    },
    async flowRefundCredits(input: unknown) {
      calls.push({ op: "refund", input });
      const value = script.refund;
      if (value instanceof Error) throw value;
      return value ?? { txId: "tx-2", releasedAmount: 0, replayed: false };
    },
  } as unknown as Pick<
    CreditService,
    "flowReserveCredits" | "flowSettleCredits" | "flowRefundCredits"
  >;
  return { credits, calls };
}

const ACCOUNT = { userId: "user-123", workspaceId: "ws-1" };

/** WS 缝替身：记录 pushToUser 的调用（事件缝透出的观测点）。 */
function createWs() {
  const pushed: Array<{ userId: string; event: { type: string } }> = [];
  return {
    pushed,
    ws: {
      connectionManager: {
        pushToUser(userId: string, event: unknown) {
          pushed.push({ userId, event: event as { type: string } });
        },
      },
    } as never,
  };
}

async function createApp(options: {
  secret?: string | undefined;
  frontendUrl?: string | undefined;
  auth?: RequestAuthenticator;
  viewer?: ViewerService;
  providers?: Pick<
    ModelProviderService,
    "listSystemInstances" | "resolveCredentialsById"
  >;
  credits?: Pick<
    CreditService,
    "flowReserveCredits" | "flowSettleCredits" | "flowRefundCredits"
  >;
  account?: { userId: string; workspaceId: string | null } | null;
  /** 自定义 subject 查找（默认：只认 user-123，其余返回 null——认不出即跳过）。 */
  findSubject?: (
    subject: string,
  ) => Promise<{ userId: string; workspaceId: string | null } | null>;
  ws?: ReturnType<typeof createWs>["ws"];
  engine?: { probe(): Promise<unknown> };
}) {
  const app = Fastify();
  await registerFlowHostRoutes(app, {
    auth: options.auth ?? createAuth({ user: null }),
    viewer: options.viewer ?? createViewer({}),
    providers: options.providers ?? createProviders({}).providers,
    credits: options.credits ?? createCredits().credits,
    accounts: {
      async findBySubject(subject: string) {
        if (options.findSubject) return options.findSubject(subject);
        if (options.account !== undefined) return options.account;
        return subject === ACCOUNT.userId ? ACCOUNT : null;
      },
    },
    ws: options.ws ?? createWs().ws,
    engine:
      (options.engine as never) ??
      ({
        async probe() {
          return {
            platform: "win32",
            paths: [
              {
                id: "wsl2",
                label: "WSL2",
                available: false,
                reason: "测试替身",
              },
            ],
            recommended: null,
          };
        },
      } as never),
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

  it("viewer 档案缺失（抛错）→ 仍 200，displayName 回退邮箱前缀（账号互通显示）", async () => {
    const app = await createApp({
      secret: SECRET,
      auth: createAuth({ user: USER }),
      viewer: createViewer({ throwOnCall: true }),
    });
    const response = await post(app, { authorization: `Bearer ${SECRET}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      subject: "user-123",
      displayName: "ken",
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
      payload: options.payload ?? {},
    });
  }

  it("未配置共享密钥 → 503；密钥不匹配 → 401（部署级缝只需这一道门）", async () => {
    const app = await createApp({ secret: undefined });
    const unavailable = await postCredentials(app, {
      authorization: `Bearer ${SECRET}`,
    });
    expect(unavailable.statusCode).toBe(503);

    const configured = await createApp({ secret: SECRET });
    const wrong = await postCredentials(configured, {
      authorization: "Bearer nope",
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("平台池没有 dify-engine 实例 → 404 且指路（管理后台配实例或撤 HOST_CREDENTIALS_URL）", async () => {
    const { providers } = createProviders({
      system: [difyInstance({ protocol: "openai-compatible", id: "chat-1" })],
    });
    const app = await createApp({ secret: SECRET, providers });
    const response = await postCredentials(app, {
      authorization: `Bearer ${SECRET}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("flow_engine_not_configured");
    expect(response.json().error.message).toContain("dify-engine");
    expect(response.json().error.message).toContain("HOST_CREDENTIALS_URL");
  });

  it("平台池命中 → 200 下发 apiBase/apiKey/label（尾斜杠归一）；禁用的实例被跳过", async () => {
    const { providers, resolved } = createProviders({
      system: [
        difyInstance({ id: "off", enabled: false }),
        difyInstance({ id: "pool", name: "平台 Dify" }),
      ],
      credentials: {
        pool: { baseUrl: "http://10.0.0.8:5001/", apiKey: "pool-key" },
      },
    });
    const app = await createApp({ secret: SECRET, providers });
    const response = await postCredentials(app, {
      authorization: `Bearer ${SECRET}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      apiBase: "http://10.0.0.8:5001",
      apiKey: "pool-key",
      label: "平台 Dify",
    });
    expect(resolved).toEqual(["pool"]);
  });

  it("实例缺 base_url / 非 http(s) → 409 可读原因（不静默下发半截凭证）", async () => {
    const missing = createProviders({
      system: [difyInstance({ baseUrl: undefined })],
      credentials: { "dify-1": { apiKey: "k" } },
    });
    const appMissing = await createApp({
      secret: SECRET,
      providers: missing.providers,
    });
    const responseMissing = await postCredentials(appMissing, {
      authorization: `Bearer ${SECRET}`,
    });
    expect(responseMissing.statusCode).toBe(409);
    expect(responseMissing.json().error.code).toBe("flow_engine_invalid");
    expect(responseMissing.json().error.message).toContain("base_url");

    const bad = createProviders({
      system: [difyInstance({ baseUrl: "ftp://x" })],
      credentials: { "dify-1": { baseUrl: "ftp://x", apiKey: "k" } },
    });
    const appBad = await createApp({
      secret: SECRET,
      providers: bad.providers,
    });
    const responseBad = await postCredentials(appBad, {
      authorization: `Bearer ${SECRET}`,
    });
    expect(responseBad.statusCode).toBe(409);
  });
});

describe("flow 宿主计费三段事务（/api/flow/host/billing，P4 计费缝）", () => {
  function postBilling(
    app: Awaited<ReturnType<typeof createApp>>,
    body: unknown,
    authorization: string | undefined = `Bearer ${SECRET}`,
  ) {
    return app.inject({
      method: "POST",
      url: "/api/flow/host/billing",
      headers: authorization ? { authorization } : {},
      payload: body as Record<string, unknown>,
    });
  }

  const base = { runId: "run-1", hostSubject: "user-123" };

  it("未配置共享密钥 → 503；密钥不匹配 → 401", async () => {
    const app = await createApp({ secret: undefined });
    expect(
      (await postBilling(app, { ...base, op: "reserve", amount: 5 }))
        .statusCode,
    ).toBe(503);

    const configured = await createApp({ secret: SECRET });
    expect(
      (
        await postBilling(
          configured,
          { ...base, op: "reserve", amount: 5 },
          "Bearer nope",
        )
      ).statusCode,
    ).toBe(401);
  });

  it("reserve：金额向上取整（不低估占用），归属取宿主 subject 的个人工作区", async () => {
    const { credits, calls } = createCredits({
      reserve: { holdId: "hold-9", frozenAmount: 6, replayed: false },
    });
    const app = await createApp({ secret: SECRET, credits });
    const response = await postBilling(app, {
      ...base,
      op: "reserve",
      amount: 5.2,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      op: "reserve",
      replayed: false,
      amount: 6,
    });
    expect(calls).toEqual([
      {
        op: "reserve",
        input: {
          amount: 6,
          runId: "run-1",
          userId: "user-123",
          workspaceId: "ws-1",
        },
      },
    ]);
  });

  it("settle：实扣 + 超出冻结上限的部分如实回报（uncoveredAmount）", async () => {
    const { credits, calls } = createCredits({
      settle: {
        txId: "tx-9",
        settledAmount: 5,
        uncoveredAmount: 3,
        replayed: false,
      },
    });
    const app = await createApp({ secret: SECRET, credits });
    const response = await postBilling(app, {
      ...base,
      op: "settle",
      frozenAmount: 5,
      actualCost: 7.6,
      usage: { totalTokens: 1000 },
      remark: "Token: 1000",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      op: "settle",
      replayed: false,
      settledAmount: 5,
      uncoveredAmount: 3,
    });
    expect(calls).toEqual([
      {
        op: "settle",
        input: {
          actualCost: 8,
          runId: "run-1",
          userId: "user-123",
          workspaceId: "ws-1",
        },
      },
    ]);
  });

  it("refund：释放冻结；replayed 原样透传（同键重放不重复动账）", async () => {
    const { credits } = createCredits({
      refund: { txId: "tx-3", releasedAmount: 6, replayed: true },
    });
    const app = await createApp({ secret: SECRET, credits });
    const response = await postBilling(app, {
      ...base,
      op: "refund",
      amount: 6,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      op: "refund",
      replayed: true,
      amount: 6,
    });
  });

  it("额度不足 → 402 insufficient_credits（透传 credits 缝的错误码与状态）", async () => {
    const { credits } = createCredits({
      reserve: new CreditServiceError(
        "insufficient_credits",
        "flow 预扣失败：可用额度不足。",
        402,
      ),
    });
    const app = await createApp({ secret: SECRET, credits });
    const response = await postBilling(app, {
      ...base,
      op: "reserve",
      amount: 100,
    });
    expect(response.statusCode).toBe(402);
    expect(response.json().error.code).toBe("insufficient_credits");
  });

  it("hold 状态冲突（无 hold / 已结算 / 已退款）→ 409 flow_billing_conflict", async () => {
    const { credits } = createCredits({
      settle: new CreditServiceError(
        "flow_billing_conflict",
        "flow 结算失败：NO_HOLD: no flow credit hold for run run-1",
        409,
      ),
    });
    const app = await createApp({ secret: SECRET, credits });
    const response = await postBilling(app, {
      ...base,
      op: "settle",
      frozenAmount: 5,
      actualCost: 5,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("flow_billing_conflict");
  });

  it("未知 op / 缺字段 / 负金额 → 400（zod 判别联合在边界挡住）", async () => {
    const app = await createApp({ secret: SECRET });
    for (const body of [
      { ...base, op: "capture", amount: 5 },
      { ...base, op: "reserve" },
      { ...base, op: "reserve", amount: -1 },
      { op: "reserve", amount: 5 },
      { ...base, op: "settle", frozenAmount: 5 },
    ]) {
      const response = await postBilling(app, body);
      expect(response.statusCode).toBe(400);
    }
  });

  it("宿主 subject 认不出 / 没有个人工作区 → 409 flow_billing_conflict（归属必须可解析）", async () => {
    const unknown = await createApp({ secret: SECRET, account: null });
    const responseUnknown = await postBilling(unknown, {
      ...base,
      op: "reserve",
      amount: 5,
    });
    expect(responseUnknown.statusCode).toBe(409);
    expect(responseUnknown.json().error.code).toBe("flow_billing_conflict");
    expect(responseUnknown.json().error.message).toContain("不存在");

    const noWorkspace = await createApp({
      secret: SECRET,
      account: { userId: "user-123", workspaceId: null },
    });
    const responseNoWs = await postBilling(noWorkspace, {
      ...base,
      op: "reserve",
      amount: 5,
    });
    expect(responseNoWs.statusCode).toBe(409);
    expect(responseNoWs.json().error.message).toContain("个人工作区");
  });
});

describe("flow 宿主事件透出（/api/flow/host/events，P5 事件缝）", () => {
  function postEvents(
    app: Awaited<ReturnType<typeof createApp>>,
    body: unknown,
    authorization: string | undefined = `Bearer ${SECRET}`,
  ) {
    return app.inject({
      method: "POST",
      url: "/api/flow/host/events",
      headers: authorization ? { authorization } : {},
      payload: body as Record<string, unknown>,
    });
  }

  const event = (overrides: Record<string, unknown> = {}) => ({
    runId: "run-1",
    seq: 1,
    type: "workflow_started",
    payload: { node: "start" },
    at: "2026-09-24T12:00:00.000Z",
    hostSubject: "user-123",
    ...overrides,
  });

  it("未配置共享密钥 → 503；密钥不匹配 → 401", async () => {
    const app = await createApp({ secret: undefined });
    expect((await postEvents(app, { events: [event()] })).statusCode).toBe(503);

    const configured = await createApp({ secret: SECRET });
    expect(
      (await postEvents(configured, { events: [event()] }, "Bearer nope"))
        .statusCode,
    ).toBe(401);
  });

  it("合法批次 → 按 hostSubject 投给该用户的 WS 连接，事件包成 flowRun.event", async () => {
    const fake = createWs();
    const app = await createApp({ secret: SECRET, ws: fake.ws });
    const response = await postEvents(app, {
      protocolVersion: "v1",
      events: [
        event(),
        event({
          seq: 2,
          type: "node_finished",
          at: "2026-09-24T12:00:01.000Z",
        }),
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 2, skipped: 0 });
    expect(fake.pushed).toHaveLength(2);
    expect(fake.pushed[0]?.userId).toBe("user-123");
    expect(fake.pushed[0]?.event).toMatchObject({
      type: "flowRun.event",
      runId: "run-1",
      seq: 1,
      eventType: "workflow_started",
      timestamp: "2026-09-24T12:00:00.000Z",
    });
  });

  it("归属认不出 / 时间戳非法 → 逐条跳过并计数（旁路事件不拖垮整批）", async () => {
    const fake = createWs();
    const app = await createApp({ secret: SECRET, ws: fake.ws });
    const response = await postEvents(app, {
      events: [
        event(),
        event({ hostSubject: "unknown-subject" }),
        event({ seq: 3, at: "不是时间" }),
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 1, skipped: 2 });
    expect(fake.pushed).toHaveLength(1);
  });

  it("请求形状不合法（空批 / 缺字段 / seq 非正）→ 400", async () => {
    const app = await createApp({ secret: SECRET });
    for (const body of [
      { events: [] },
      { events: [{ runId: "run-1" }] },
      { events: [event({ seq: 0 })] },
      {},
    ]) {
      expect((await postEvents(app, body)).statusCode).toBe(400);
    }
  });

  it("同一批次里两个 subject → 各自投给各自用户；同 subject 只查一次（批内记忆）", async () => {
    const fake = createWs();
    const lookups: string[] = [];
    const app = await createApp({
      secret: SECRET,
      ws: fake.ws,
      findSubject: async (subject) => {
        lookups.push(subject);
        return { userId: `account-of-${subject}`, workspaceId: "ws-1" };
      },
    });
    const response = await postEvents(app, {
      events: [
        event(),
        event({ seq: 2 }),
        event({ seq: 3, hostSubject: "user-456" }),
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 3, skipped: 0 });
    expect(fake.pushed.map((entry) => entry.userId)).toEqual([
      "account-of-user-123",
      "account-of-user-123",
      "account-of-user-456",
    ]);
    // 三条事件、两个 subject：批内按 subject 记忆，只查两次
    expect(lookups).toEqual(["user-123", "user-456"]);
  });
});

describe("flow 引擎承载路径探测（/api/flow/host/engine，P6 探测层）", () => {
  it("未登录 → 401（探测结果也需会话，不暴露宿主能力面给匿名）", async () => {
    const app = await createApp({ auth: createAuth({ user: null }) });
    const response = await app.inject({
      method: "GET",
      url: "/api/flow/host/engine",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("登录 → 200 原样回探测报告（三条路径 + 首选）", async () => {
    const app = await createApp({
      auth: createAuth({ user: USER }),
      engine: {
        async probe() {
          return {
            platform: "win32",
            paths: [
              {
                id: "wsl2",
                label: "WSL2",
                available: true,
                detail: "发行版 Ubuntu（WSL2，Running）",
              },
              {
                id: "container",
                label: "本机容器",
                available: false,
                reason: "未检测到 Docker / Podman",
              },
              {
                id: "remote",
                label: "指向自管地址",
                available: false,
                reason: "未配置自管 Dify 地址",
              },
            ],
            recommended: "wsl2",
          };
        },
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/flow/host/engine",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      platform: "win32",
      paths: [
        {
          id: "wsl2",
          label: "WSL2",
          available: true,
          detail: "发行版 Ubuntu（WSL2，Running）",
        },
        {
          id: "container",
          label: "本机容器",
          available: false,
          reason: "未检测到 Docker / Podman",
        },
        {
          id: "remote",
          label: "指向自管地址",
          available: false,
          reason: "未配置自管 Dify 地址",
        },
      ],
      recommended: "wsl2",
    });
  });
});
