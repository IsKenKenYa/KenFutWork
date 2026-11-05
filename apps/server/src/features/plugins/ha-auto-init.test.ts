import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const HA_ENTRY = pathToFileURL(
  path.resolve(process.cwd(), "..", "..", "plugins", "ha", "index.js"),
).href;
const { apply } = (await import(/* @vite-ignore */ HA_ENTRY)) as {
  apply: (ctx: unknown) => void;
};

const INSTANCE = "instance-local";
const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;

type Step = "user" | "core_config" | "analytics" | "integration";

function fakeHomeAssistant() {
  const state = {
    steps: new Map<Step, boolean>([
      ["user", false],
      ["core_config", false],
      ["analytics", false],
      ["integration", false],
    ]),
    credentials: null as null | { username: string; password: string },
    userWrites: 0,
    passwordGrants: 0,
    tokenRecords: [] as Array<Record<string, unknown>>,
    loseUserResponseOnce: false,
    loseLongTokenOnce: false,
    trustedNetworksEnabled: true,
    onboardingUnavailable: false,
    loginFlowHandlers: [] as unknown[],
    calls: [] as string[],
  };
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    state.calls.push(`${method} ${url}`);
    const body = typeof init?.body === "string" ? init.body : "";
    if (url.endsWith("/api/onboarding") && method === "GET") {
      // 本机 8123 实况：已完成 onboarding 的 HA 对该端点返回 404。
      if (state.onboardingUnavailable)
        return Response.json({ message: "not found" }, { status: 404 });
      return Response.json(
        [...state.steps].map(([step, done]) => ({ step, done })),
      );
    }
    if (url.endsWith("/auth/login_flow") && method === "POST") {
      const payload = JSON.parse(body) as { handler?: unknown };
      state.loginFlowHandlers.push(payload.handler);
      // 让 HA 自选 handler 会返回 500（本机实测），锁死「必须显式指定」。
      const explicit =
        Array.isArray(payload.handler) &&
        payload.handler.length === 2 &&
        payload.handler[0] === "trusted_networks" &&
        payload.handler[1] === null;
      if (!explicit)
        return Response.json({ message: "handler required" }, { status: 500 });
      if (!state.trustedNetworksEnabled)
        return Response.json({ type: "form", flow_id: "login-form" });
      return Response.json({
        type: "create_entry",
        flow_id: "trusted-flow",
        handler: ["trusted_networks", null],
        result: "trusted-code",
      });
    }
    if (url.endsWith("/api/onboarding/users") && method === "POST") {
      state.userWrites += 1;
      const payload = JSON.parse(body) as {
        username: string;
        password: string;
      };
      state.credentials = {
        username: payload.username,
        password: payload.password,
      };
      state.steps.set("user", true);
      if (state.loseUserResponseOnce) {
        state.loseUserResponseOnce = false;
        throw new TypeError("response lost");
      }
      return Response.json({ auth_code: "onboarding-code" });
    }
    if (url.endsWith("/auth/token") && method === "POST") {
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "password") {
        state.passwordGrants += 1;
        if (
          params.get("username") !== state.credentials?.username ||
          params.get("password") !== state.credentials.password
        ) {
          return Response.json({ error: "invalid_grant" }, { status: 401 });
        }
      }
      return Response.json({
        access_token: `access-${state.passwordGrants + 1}`,
        token_type: "Bearer",
      });
    }
    const onboardingStep = ["/core_config", "/analytics", "/integration"]
      .map((suffix) => ({ suffix, step: suffix.slice(1) as Step }))
      .find(({ suffix }) => url.endsWith(`/api/onboarding${suffix}`));
    if (onboardingStep && method === "POST") {
      state.steps.set(onboardingStep.step, true);
      return Response.json({ auth_code: "integration-code" });
    }
    if (url.endsWith("/api/"))
      return Response.json({ message: "API running." });
    if (url.endsWith("/api/config"))
      return Response.json({ version: "2026.10.3" });
    return Response.json({ message: "not found" }, { status: 404 });
  });

  class FakeSocket {
    readyState = 1;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onopen: (() => void) | null = null;

    constructor() {
      queueMicrotask(() =>
        this.onmessage?.({ data: JSON.stringify({ type: "auth_required" }) }),
      );
    }

    send(raw: string) {
      const message = JSON.parse(raw) as {
        id?: number;
        type: string;
        access_token?: string;
        client_name?: string;
      };
      if (message.type === "auth") {
        this.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
        return;
      }
      const result = (payload: unknown) =>
        this.onmessage?.({
          data: JSON.stringify({
            id: message.id,
            type: "result",
            success: true,
            result: payload,
          }),
        });
      if (message.type === "subscribe_events") return result(null);
      if (message.type === "auth/refresh_tokens")
        return result(state.tokenRecords);
      if (message.type === "auth/delete_refresh_token") {
        const id = (message as unknown as { refresh_token_id: string })
          .refresh_token_id;
        state.tokenRecords = state.tokenRecords.filter((row) => row.id !== id);
        return result({});
      }
      if (message.type === "auth/long_lived_access_token") {
        const id = `token-${state.tokenRecords.length + 1}`;
        state.tokenRecords.push({
          id,
          client_name: message.client_name,
          type: "long_lived_access_token",
        });
        if (state.loseLongTokenOnce) {
          state.loseLongTokenOnce = false;
          this.onclose?.({ code: 1006 });
          return;
        }
        return result(`long-${id}`);
      }
      throw new Error(`unexpected socket command ${message.type}`);
    }

    close() {
      this.readyState = 3;
    }
  }

  return { state, fetchImpl, FakeSocket };
}

type FakeHa = ReturnType<typeof fakeHomeAssistant>;
type Rows = Map<string, string>;

function createHarness(shared: { rows: Rows; fake: FakeHa }) {
  const routes = new Map<string, (request: unknown) => Promise<unknown>>();
  const storage = {
    async get(instanceId: string, key: string) {
      return shared.rows.get(JSON.stringify([instanceId, key])) ?? null;
    },
    async set(instanceId: string, key: string, value: string) {
      shared.rows.set(JSON.stringify([instanceId, key]), value);
    },
    async remove(instanceId: string, key: string) {
      return shared.rows.delete(JSON.stringify([instanceId, key]));
    },
  };
  apply({
    routes: {
      register(route: {
        path: string;
        method?: string;
        handler: (request: unknown) => Promise<unknown>;
      }) {
        routes.set(`${route.method ?? "GET"} ${route.path}`, route.handler);
      },
    },
    tools: { register: () => undefined },
    ui: { register: () => undefined },
    storage,
    effect: () => undefined,
    logger: { warn: () => undefined },
  });
  globalThis.fetch = shared.fake.fetchImpl as typeof fetch;
  globalThis.WebSocket = shared.fake.FakeSocket as unknown as typeof WebSocket;
  const config = routes.get("GET config");
  if (!config) throw new Error("config route missing");
  return {
    readConfig: () =>
      config({ instanceId: INSTANCE }) as Promise<{
        status: number;
        body: {
          configured?: boolean;
          baseUrl?: string | null;
          token?: string;
          error?: string;
          code?: string;
        };
      }>,
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = realWebSocket;
});

describe("HA 本机自动初始化", () => {
  it("默认地址自动完成 onboarding，并发读取只建一个用户与令牌", async () => {
    const shared = {
      rows: new Map<string, string>(),
      fake: fakeHomeAssistant(),
    };
    const harness = createHarness(shared);

    const [first, second] = await Promise.all([
      harness.readConfig(),
      harness.readConfig(),
    ]);

    for (const result of [first, second]) {
      expect(result.status).toBe(200);
      expect(result.body.configured).toBe(true);
      expect(result.body.baseUrl).toBe("http://127.0.0.1:8123");
      expect(result.body.token).toBeUndefined();
    }
    expect(shared.fake.state.userWrites).toBe(1);
    expect(shared.fake.state.tokenRecords).toHaveLength(1);
    expect([...shared.fake.state.steps.values()]).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("建用户响应丢失后按持久凭据恢复，不重复创建", async () => {
    const shared = {
      rows: new Map<string, string>(),
      fake: fakeHomeAssistant(),
    };
    shared.fake.state.loseUserResponseOnce = true;
    const harness = createHarness(shared);

    const failed = await harness.readConfig();
    expect(failed.status).not.toBe(200);
    expect(failed.body.configured).toBeUndefined();
    expect(failed.body.error).toBeTruthy();
    expect((await harness.readConfig()).body.configured).toBe(true);

    expect(shared.fake.state.userWrites).toBe(1);
    expect(shared.fake.state.passwordGrants).toBe(1);
    expect(shared.fake.state.tokenRecords).toHaveLength(1);
  });

  it("令牌响应丢失后重放先替换同名旧令牌，不累积凭据", async () => {
    const shared = {
      rows: new Map<string, string>(),
      fake: fakeHomeAssistant(),
    };
    shared.fake.state.loseLongTokenOnce = true;
    const harness = createHarness(shared);

    const failed = await harness.readConfig();
    expect(failed.status).not.toBe(200);
    expect(failed.body.configured).toBeUndefined();
    expect(failed.body.error).toBeTruthy();
    expect((await harness.readConfig()).body.configured).toBe(true);

    expect(shared.fake.state.userWrites).toBe(1);
    expect(shared.fake.state.tokenRecords).toHaveLength(1);
  });

  it("重启后直接复用已存配置，不再访问 HA 或重建令牌", async () => {
    const shared = {
      rows: new Map<string, string>(),
      fake: fakeHomeAssistant(),
    };
    await createHarness(shared).readConfig();
    const callsBeforeRestart = shared.fake.state.calls.length;

    const restarted = createHarness(shared);
    expect((await restarted.readConfig()).body.configured).toBe(true);

    expect(shared.fake.state.calls).toHaveLength(callsBeforeRestart);
    expect(shared.fake.state.userWrites).toBe(1);
    expect(shared.fake.state.tokenRecords).toHaveLength(1);
  });

  it("已完成 onboarding 的既有 HA 经可信网段免登录自动签发令牌，不改号", async () => {
    const shared = {
      rows: new Map<string, string>(),
      fake: fakeHomeAssistant(),
    };
    for (const step of shared.fake.state.steps.keys())
      shared.fake.state.steps.set(step, true);
    const harness = createHarness(shared);

    const result = await harness.readConfig();
    expect(result.status).toBe(200);
    expect(result.body.configured).toBe(true);
    expect(result.body.baseUrl).toBe("http://127.0.0.1:8123");
    expect(result.body.token).toBeUndefined();
    expect(shared.fake.state.userWrites).toBe(0);
    expect(shared.fake.state.passwordGrants).toBe(0);
    expect(shared.fake.state.tokenRecords).toHaveLength(1);
    // 回归锁死：handler 必须显式指定 trusted_networks，不能让 HA 自选（实测 500）。
    expect(shared.fake.state.loginFlowHandlers).toEqual([
      ["trusted_networks", null],
    ]);
  });

  it("onboarding 端点返回 404（本机 8123 实况）仍自动接入", async () => {
    const shared = {
      rows: new Map<string, string>(),
      fake: fakeHomeAssistant(),
    };
    shared.fake.state.onboardingUnavailable = true;
    const harness = createHarness(shared);

    const result = await harness.readConfig();
    expect(result.status).toBe(200);
    expect(result.body.configured).toBe(true);
    expect(shared.fake.state.userWrites).toBe(0);
    expect(shared.fake.state.tokenRecords).toHaveLength(1);
  });

  it("未开启可信网段时以错误态抛出，不回落成「未配置」", async () => {
    const shared = {
      rows: new Map<string, string>(),
      fake: fakeHomeAssistant(),
    };
    for (const step of shared.fake.state.steps.keys())
      shared.fake.state.steps.set(step, true);
    shared.fake.state.trustedNetworksEnabled = false;
    const harness = createHarness(shared);

    const failed = await harness.readConfig();
    expect(failed.status).toBe(503);
    expect(failed.body.configured).toBeUndefined();
    expect(failed.body.code).toBe("trusted_network_unavailable");
    expect(failed.body.error).toContain("可信网段");
    expect(shared.fake.state.tokenRecords).toHaveLength(0);
  });

  it("可信网段路径并发读取只签发一份令牌", async () => {
    const shared = {
      rows: new Map<string, string>(),
      fake: fakeHomeAssistant(),
    };
    for (const step of shared.fake.state.steps.keys())
      shared.fake.state.steps.set(step, true);
    const harness = createHarness(shared);

    const [first, second] = await Promise.all([
      harness.readConfig(),
      harness.readConfig(),
    ]);
    expect(first.body.configured).toBe(true);
    expect(second.body.configured).toBe(true);
    expect(shared.fake.state.loginFlowHandlers).toHaveLength(1);
    expect(shared.fake.state.tokenRecords).toHaveLength(1);
  });
});
