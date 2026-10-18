import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import { createLocalInstanceService } from "../local-instance/service.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import { createPluginRegistryService } from "./plugin-registry-service.js";
import { createPersistentPluginStorage } from "./plugin-storage.test-fixture.js";

/**
 * 智能家居（Home Assistant）插件测试。分两层：
 *
 * 1. **纯函数**：地址归一、HTTP 错误→人话、实体 id/服务名校验。
 * 2. **全链路**：真的走门禁安装到临时目录，再用**假 HA**（本机 HTTP 桩，校验
 *    `Authorization` 头）跑通 配置 → 连接测试 → 断开，以及坏令牌 / 地址不可达 /
 *     跨实例隔离 / 重启后免重填等错误面。
 *
 * 假 HA 只证明**收发一致性**（鉴权头、URL 拼法、错误分支），不构成对真实 HA 的验证；
 * 真机走查配方见插件 README 与《米家和HA插件规划》§6。
 */

const REPO_ROOT = path.resolve(process.cwd(), "..", "..");
const HA_DIR = path.join(REPO_ROOT, "plugins", "ha");
const INSTANCE_ID = "0f6f0a1e-6e1a-4f2b-9b7f-2a1c9d3e4b51";
const INSTANCE_A = "7b2c1d3e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const INSTANCE_B = "3e4d5c6b-7a89-4b0c-9d8e-7f6a5b4c3d2e";
const FAKE_TOKEN = "ha-long-lived-token-1";
const STORAGE_FILE = "test-ha-storage.json";

interface HaRestModule {
  HA_DEFAULT_BASE_URL: string;
  HA_REQUEST_TIMEOUT_MS: number;
  HaError: new (
    message: string,
    code: string,
    status?: number | null,
  ) => Error & { code: string; status: number | null };
  normalizeHaBaseUrl: (input: string) => string;
  isValidEntityId: (value: unknown) => boolean;
  isValidServiceName: (value: unknown) => boolean;
  mapHttpError: (
    status: number,
    payload: unknown,
    baseUrl: string,
  ) => Error & { code: string; status: number | null };
  createHaRest: (options: {
    baseUrl: string;
    token: string;
    fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
    timeoutMs?: number;
  }) => {
    baseUrl: string;
    ping: () => Promise<unknown>;
    getConfig: () => Promise<unknown>;
    getStates: () => Promise<unknown>;
    getState: (entityId: string) => Promise<unknown>;
    callService: (
      domain: string,
      service: string,
      data?: Record<string, unknown>,
      extra?: { returnResponse?: boolean },
    ) => Promise<unknown>;
  };
}

async function loadPluginModule<ModuleShape>(
  relative: string,
): Promise<ModuleShape> {
  const url = pathToFileURL(path.join(HA_DIR, relative)).href;
  return (await import(/* @vite-ignore */ url)) as ModuleShape;
}

function makeEnv(): ServerEnv {
  return {
    agentBackendMode: "state",
    agentModel: "test-model",
    port: 0,
    version: "test",
    webOrigin: "http://localhost:3000",
  } as ServerEnv;
}

// === 假 HA（本机 HTTP 桩） ===

interface FakeHaCall {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

interface FakeHaOptions {
  /** 认这个令牌；请求头不符即 401。 */
  token?: string;
  version?: string;
  locationName?: string;
  /** 直接抛错（模拟地址不可达）。 */
  throwOnRequest?: boolean;
  /** 挂起不返回（配合极短超时模拟超时分支）。 */
  neverRespond?: boolean;
}

function fakeHomeAssistant(options: FakeHaOptions = {}) {
  const expected = `Bearer ${options.token ?? FAKE_TOKEN}`;
  const calls: FakeHaCall[] = [];
  const fetchImpl = async (
    input: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authorization =
      headers.authorization ?? headers.Authorization ?? undefined;
    calls.push({
      method: init?.method ?? "GET",
      url,
      authorization,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (options.throwOnRequest) {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }
    if (options.neverRespond) {
      // 与真实 fetch 同形：signal 到期时以 TimeoutError 拒绝
      return await new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        const onAbort = () => {
          const error = new Error("The operation was aborted");
          error.name = "TimeoutError";
          reject(error);
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (authorization !== expected) {
      return Response.json(
        { message: "Unauthorized", error: "unauthorized" },
        { status: 401 },
      );
    }
    const pathname = new URL(url).pathname;
    if (pathname === "/api/") {
      return Response.json({ message: "API running." });
    }
    if (pathname === "/api/config") {
      return Response.json({
        version: options.version ?? "2026.10.1",
        location_name: options.locationName ?? "我的家",
        unit_system: { temperature: "°C" },
      });
    }
    return Response.json({ message: "not found" }, { status: 404 });
  };
  return { fetchImpl, calls };
}

let pluginsDir: string;
let storageFile: string;
let localInstances: Map<string, LocalInstanceService>;
const kernels: Array<{ dispose(): void }> = [];
const realFetch = globalThis.fetch;

function installPlugin(options: FakeHaOptions = {}) {
  const kernel = composePlugins(makeEnv(), []);
  kernels.push(kernel);
  const fake = fakeHomeAssistant(options);
  globalThis.fetch = fake.fetchImpl as typeof fetch;
  const store = createPersistentPluginStorage(storageFile);
  const service = createPluginRegistryService({
    pluginsDir,
    tools: kernel.get("tools"),
    subscribe: () => () => {},
    hostNodeMajor: 22,
    builtinCatalog: [],
    storage: store.storage,
  });
  return { kernel, service, fake, store };
}

async function dispatch(
  service: ReturnType<typeof createPluginRegistryService>,
  pluginId: string,
  request: {
    method?: "GET" | "POST";
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    instanceId?: string;
    isAuthenticated?: boolean;
  },
) {
  const instance = request.instanceId
    ? localInstances.get(request.instanceId)
    : undefined;
  if (request.instanceId && !instance) {
    throw new Error("夹具未定义该本地实例。");
  }
  const actor = instance ? await instance.serviceActor() : null;
  const context = actor && instance ? await instance.resolve(actor) : null;
  return service.dispatchRoute({
    pluginId,
    method: request.method ?? "GET",
    path: request.path,
    query: request.query ?? {},
    body: request.body ?? null,
    headers: {},
    isAuthenticated: request.isAuthenticated ?? true,
    ...(context ? { instanceId: context.instanceId } : {}),
  });
}

/** 取派发结果的 body（先断言 status，再取字段；避免「可选链后直接访问」）。 */
function bodyOf<T>(result: { body?: unknown } | undefined): T {
  return (result?.body ?? {}) as T;
}

async function installFromRepo(options: FakeHaOptions = {}) {
  const harness = installPlugin(options);
  const { installed, report } = await harness.service.install({
    url: HA_DIR,
    allowLifecycleScripts: false,
  });
  return { ...harness, installed, report };
}

async function configureConnected(
  service: ReturnType<typeof createPluginRegistryService>,
  pluginId: string,
  instanceId = INSTANCE_ID,
  baseUrl = "http://ha.test.local:8123",
) {
  const result = await dispatch(service, pluginId, {
    method: "POST",
    path: "config",
    body: { baseUrl, token: FAKE_TOKEN },
    instanceId,
  });
  return result;
}

beforeEach(async () => {
  pluginsDir = await mkdtemp(path.join(tmpdir(), "kenfutwork-ha-"));
  storageFile = path.join(pluginsDir, STORAGE_FILE);
  localInstances = new Map();
  for (const instanceId of [INSTANCE_ID, INSTANCE_A, INSTANCE_B]) {
    localInstances.set(
      instanceId,
      createLocalInstanceService({
        repository: { ensure: async () => instanceId },
        dataDir: path.join(pluginsDir, "instances", instanceId),
      }),
    );
  }
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const kernel of kernels.splice(0)) {
    kernel.dispose();
  }
  await rm(pluginsDir, { recursive: true, force: true });
});

describe("HA 插件：REST 原语", () => {
  it("地址归一：补协议、去尾斜杠、剥掉误粘的 /api 尾巴，坏地址给可读原因", async () => {
    const rest = await loadPluginModule<HaRestModule>("lib/ha-rest.js");
    expect(rest.normalizeHaBaseUrl("http://192.168.1.20:8123/")).toBe(
      "http://192.168.1.20:8123",
    );
    expect(rest.normalizeHaBaseUrl("192.168.1.20:8123")).toBe(
      "http://192.168.1.20:8123",
    );
    expect(rest.normalizeHaBaseUrl("https://ha.example.com/api/states")).toBe(
      "https://ha.example.com",
    );
    // ingress 子路径前缀要保留（只剥掉末尾的 /api…）
    expect(rest.normalizeHaBaseUrl("http://ha.local/home/")).toBe(
      "http://ha.local/home",
    );
    expect(rest.normalizeHaBaseUrl("")).toBe(rest.HA_DEFAULT_BASE_URL);
    expect(() => rest.normalizeHaBaseUrl("ftp://ha.local")).toThrow(
      /地址不合法/,
    );
    expect(() => rest.normalizeHaBaseUrl("http://")).toThrow(/地址不合法/);
    // 令牌塞进地址里 = 会被日志带走，必须拒
    expect(() =>
      rest.normalizeHaBaseUrl("http://admin:secret@ha.local:8123"),
    ).toThrow(/不能带用户名或密码/);
  });

  it("HTTP 错误映射成「哪里不对、去哪改」的一句话", async () => {
    const rest = await loadPluginModule<HaRestModule>("lib/ha-rest.js");
    expect(rest.mapHttpError(401, null, "http://ha:8123").code).toBe(
      "unauthorized",
    );
    expect(rest.mapHttpError(401, null, "").message).toContain("个人资料");
    expect(
      rest.mapHttpError(404, { message: "Entity not found" }, "").code,
    ).toBe("not_found");
    // HA 的 400 原话比我们自己编的中文更准，带出但截断
    const badService = rest.mapHttpError(
      400,
      { message: `Failing because: ${"x".repeat(400)}` },
      "",
    );
    expect(badService.code).toBe("bad_service");
    expect(badService.message.startsWith("Failing because:")).toBe(true);
    expect(badService.message.length).toBeLessThan(230);
    expect(rest.mapHttpError(500, "Internal Server Error", "").code).toBe(
      "server_error",
    );
    expect(rest.mapHttpError(418, null, "http://ha.local:8123").code).toBe(
      "http_error",
    );
    expect(rest.mapHttpError(418, null, "http://ha.local:8123").message).toBe(
      "HA（http://ha.local:8123）返回 HTTP 418。",
    );
    expect(rest.mapHttpError(418, null, "").status).toBe(418);
  });

  it("实体 id 与服务名校验：挡住能拼进 URL 的脏值", async () => {
    const rest = await loadPluginModule<HaRestModule>("lib/ha-rest.js");
    expect(rest.isValidEntityId("light.bedroom_lights")).toBe(true);
    expect(rest.isValidEntityId("input_boolean.1")).toBe(true);
    for (const bad of [
      "",
      "light",
      "light.a.b",
      "light/../config",
      "LIGHT.a",
    ]) {
      expect(rest.isValidEntityId(bad)).toBe(false);
    }
    for (const bad of ["", "turn on", "turn/on", "TURN_ON", "a?b"]) {
      expect(rest.isValidServiceName(bad)).toBe(false);
    }
    expect(rest.isValidServiceName("set_cover_position")).toBe(true);
  });

  it("请求带 Bearer 头、路径拼在 /api 之后；401 与断网分别归到 unauthorized 与 unreachable", async () => {
    const rest = await loadPluginModule<HaRestModule>("lib/ha-rest.js");
    const fake = fakeHomeAssistant();
    const client = rest.createHaRest({
      baseUrl: "http://ha.test.local:8123",
      token: FAKE_TOKEN,
      fetchImpl: fake.fetchImpl,
    });
    await expect(client.ping()).resolves.toMatchObject({
      message: "API running.",
    });
    await expect(client.getConfig()).resolves.toMatchObject({
      version: "2026.10.1",
    });
    expect(fake.calls[0]?.url).toBe("http://ha.test.local:8123/api/");
    expect(fake.calls[0]?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);

    const wrongToken = rest.createHaRest({
      baseUrl: "http://ha.test.local:8123",
      token: "revoked",
      fetchImpl: fake.fetchImpl,
    });
    const unauthorized = await wrongToken.ping().then(
      () => null,
      (error: Error & { code?: string }) => error,
    );
    expect(unauthorized?.code).toBe("unauthorized");

    const down = rest.createHaRest({
      baseUrl: "http://offline.local:8123",
      token: FAKE_TOKEN,
      fetchImpl: fakeHomeAssistant({ throwOnRequest: true }).fetchImpl,
    });
    const unreachable = await down.ping().then(
      () => null,
      (error: Error & { code?: string; message: string }) => error,
    );
    expect(unreachable?.code).toBe("unreachable");
    expect(unreachable?.message).toContain("http://offline.local:8123");
  });

  it("HA 不应答时按超时收口，不吊住调用方", async () => {
    const rest = await loadPluginModule<HaRestModule>("lib/ha-rest.js");
    const client = rest.createHaRest({
      baseUrl: "http://ha.test.local:8123",
      token: FAKE_TOKEN,
      fetchImpl: fakeHomeAssistant({ neverRespond: true }).fetchImpl,
      timeoutMs: 50,
    });
    const error = await client.ping().then(
      () => null,
      (caught: Error & { code?: string }) => caught,
    );
    expect(error?.code).toBe("timeout");
  });

  it("缺地址或缺令牌时不发出请求，直接给「未配置」", async () => {
    const rest = await loadPluginModule<HaRestModule>("lib/ha-rest.js");
    const fake = fakeHomeAssistant();
    expect(() =>
      rest.createHaRest({
        baseUrl: "",
        token: FAKE_TOKEN,
        fetchImpl: fake.fetchImpl,
      }),
    ).toThrow(/HA 地址/);
    expect(() =>
      rest.createHaRest({
        baseUrl: "http://ha:8123",
        token: "",
        fetchImpl: fake.fetchImpl,
      }),
    ).toThrow(/令牌/);
    expect(fake.calls).toEqual([]);
  });
});

describe("HA 插件：安装与门禁", () => {
  it("通过门禁安装：能力面 routes/ui/storage，侧栏入口标题「智能家居」", async () => {
    const { kernel, service, installed, report } = await installFromRepo();
    expect(report.compatible).toBe(true);
    expect(report.supportedCapabilities).toEqual(["routes", "ui", "storage"]);
    expect(installed.name).toBe("kenfutwork-ha");
    expect(
      kernel
        .get("tools")
        .list()
        .map((tool) => tool.name),
    ).toEqual([]);
    expect(
      service.listUiEntries().filter((entry) => entry.slot === "sidebar"),
    ).toEqual([
      {
        pluginId: installed.id,
        id: "ha",
        title: "智能家居",
        slot: "sidebar",
        url: "assets/panel.html",
        icon: "assets/icon.svg",
      },
    ]);
  });

  it("静态资源按「bundle 根 + assets 前缀」口径托管", async () => {
    const { service, installed } = await installFromRepo();
    const panel = await service.readAsset({
      pluginId: installed.id,
      relativePath: "panel.html",
    });
    expect(panel?.contentType).toContain("text/html");
    expect(panel?.content.toString("utf8")).toContain("智能家居");
    const script = await service.readAsset({
      pluginId: installed.id,
      relativePath: "panel.js",
    });
    expect(script?.contentType).toContain("text/javascript");
    // 写进 assets/ 子目录会 404（assets/ 是路由前缀，不是目录）
    expect(
      await service.readAsset({
        pluginId: installed.id,
        relativePath: "assets/panel.html",
      }),
    ).toBeUndefined();
    expect(
      await service.readAsset({
        pluginId: installed.id,
        relativePath: "../package.json",
      }),
    ).toBeUndefined();
  });

  it("私有路由：未登录一律 401", async () => {
    const { service, installed } = await installFromRepo();
    const anonymous = await dispatch(service, installed.id, {
      path: "config",
      instanceId: INSTANCE_ID,
      isAuthenticated: false,
    });
    expect(anonymous?.status).toBe(401);
  });

  it("缺实例上下文时报错可读（存储按实例隔离，不凭空兜底）", async () => {
    const { service, installed } = await installFromRepo();
    const result = await dispatch(service, installed.id, { path: "config" });
    expect(result?.status).toBe(500);
    expect(JSON.stringify(result?.body)).toContain("缺少实例上下文");
  });
});

describe("HA 插件：配置 → 连接 → 断开（假 HA 全链路）", () => {
  it("连得上才落库；令牌只存服务端，HTTP 面不回显", async () => {
    const { service, installed, fake, store } = await installFromRepo();
    const empty = await dispatch(service, installed.id, {
      path: "config",
      instanceId: INSTANCE_ID,
    });
    expect(bodyOf<{ configured: boolean }>(empty).configured).toBe(false);

    const saved = await configureConnected(service, installed.id);
    expect(saved?.status).toBe(200);
    expect(bodyOf<{ version: string }>(saved).version).toBe("2026.10.1");

    const status = await dispatch(service, installed.id, {
      path: "config",
      instanceId: INSTANCE_ID,
    });
    const view = bodyOf<Record<string, unknown>>(status);
    expect(view).toMatchObject({
      configured: true,
      baseUrl: "http://ha.test.local:8123",
    });
    // 令牌绝不出 HTTP
    expect(JSON.stringify(view)).not.toContain(FAKE_TOKEN);
    const stored = [...store.rows.values()].join("");
    expect(stored).toContain(FAKE_TOKEN);
    expect(fake.calls.length).toBeGreaterThan(0);
  });

  it("地址归一在保存时就完成：存进去的是干净地址", async () => {
    const { service, installed, store } = await installFromRepo();
    const saved = await configureConnected(
      service,
      installed.id,
      INSTANCE_ID,
      "ha.test.local:8123/api/states/",
    );
    expect(saved?.status).toBe(200);
    const stored = JSON.parse([...store.rows.values()][0] ?? "{}") as {
      baseUrl?: string;
    };
    expect(stored.baseUrl).toBe("http://ha.test.local:8123");
  });

  it("坏令牌：401 原话可读且不落库（不存一个连不上的配置）", async () => {
    const { service, installed, store } = await installFromRepo();
    const result = await dispatch(service, installed.id, {
      method: "POST",
      path: "config",
      body: { baseUrl: "http://ha.test.local:8123", token: "revoked" },
      instanceId: INSTANCE_ID,
    });
    expect(result?.status).toBe(401);
    expect(bodyOf<{ error: string; code: string }>(result)).toMatchObject({
      code: "unauthorized",
    });
    expect(bodyOf<{ error: string }>(result).error).toContain("个人资料");
    expect([...store.rows.values()].join("")).toBe("");
  });

  it("HA 不可达：保存失败并说清地址；令牌留空且无历史配置时报错", async () => {
    const { service, installed, store } = await installFromRepo({
      throwOnRequest: true,
    });
    const result = await dispatch(service, installed.id, {
      method: "POST",
      path: "config",
      body: { baseUrl: "http://offline.local:8123", token: FAKE_TOKEN },
      instanceId: INSTANCE_ID,
    });
    expect(result?.status).toBe(400);
    expect(bodyOf<{ error: string; code: string }>(result)).toMatchObject({
      code: "unreachable",
    });
    expect(bodyOf<{ error: string }>(result).error).toContain(
      "http://offline.local:8123",
    );
    expect([...store.rows.keys()]).toEqual([]);

    const noToken = await dispatch(service, installed.id, {
      method: "POST",
      path: "config",
      body: { baseUrl: "http://ha.test.local:8123" },
      instanceId: INSTANCE_ID,
    });
    expect(noToken?.status).toBe(400);
    expect(bodyOf<{ error: string }>(noToken).error).toContain("令牌");
  });

  it("已配置后令牌留空 = 沿用已存令牌（改地址不必重新粘）", async () => {
    const { service, installed, fake } = await installFromRepo();
    await configureConnected(service, installed.id);
    fake.calls.length = 0;
    const edited = await dispatch(service, installed.id, {
      method: "POST",
      path: "config",
      body: { baseUrl: "http://ha-new.test.local:8123", token: "" },
      instanceId: INSTANCE_ID,
    });
    expect(edited?.status).toBe(200);
    expect(fake.calls[0]?.url).toBe("http://ha-new.test.local:8123/api/");
    expect(fake.calls[0]?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it("未配置时连接测试报 not_configured；断开即清库", async () => {
    const { service, installed, store } = await installFromRepo();
    const test = await dispatch(service, installed.id, {
      method: "POST",
      path: "test",
      instanceId: INSTANCE_ID,
    });
    expect(test?.status).toBe(401);
    expect(bodyOf<{ code: string }>(test).code).toBe("not_configured");

    await configureConnected(service, installed.id);
    expect([...store.rows.keys()].length).toBe(1);
    const done = await dispatch(service, installed.id, {
      method: "POST",
      path: "disconnect",
      instanceId: INSTANCE_ID,
    });
    expect(bodyOf<{ ok: boolean }>(done).ok).toBe(true);
    expect([...store.rows.keys()]).toEqual([]);
    const after = await dispatch(service, installed.id, {
      path: "config",
      instanceId: INSTANCE_ID,
    });
    expect(bodyOf<{ configured: boolean }>(after).configured).toBe(false);
  });

  it("按实例隔离：A 实例的配置不会被 B 实例读到", async () => {
    const { service, installed } = await installFromRepo();
    await configureConnected(service, installed.id, INSTANCE_A);
    const other = await dispatch(service, installed.id, {
      path: "config",
      instanceId: INSTANCE_B,
    });
    expect(bodyOf<{ configured: boolean }>(other).configured).toBe(false);
    const own = await dispatch(service, installed.id, {
      path: "config",
      instanceId: INSTANCE_A,
    });
    expect(bodyOf<{ configured: boolean }>(own).configured).toBe(true);
  });

  it("服务端重启后（新进程、内存为空）配置仍在，直接可连接测试", async () => {
    const { service, installed } = await installFromRepo();
    await configureConnected(service, installed.id);

    globalThis.fetch = realFetch;
    const second = installPlugin();
    await second.service.restore();
    const restored = second.service
      .listUiEntries()
      .find((entry) => entry.id === "ha");
    expect(restored).toBeDefined();

    const status = await dispatch(second.service, installed.id, {
      path: "config",
      instanceId: INSTANCE_ID,
    });
    expect(bodyOf<{ configured: boolean }>(status).configured).toBe(true);
    const test = await dispatch(second.service, installed.id, {
      method: "POST",
      path: "test",
      instanceId: INSTANCE_ID,
    });
    expect(bodyOf<{ version: string }>(test).version).toBe("2026.10.1");
  });

  it("卸载清干净：purgePlugin 被调、配置随插件消失", async () => {
    const { service, installed, store } = await installFromRepo();
    await configureConnected(service, installed.id);
    await service.uninstall(installed.id);
    expect(store.purged).toContain(installed.id);
    expect([...store.rows.keys()]).toEqual([]);
  });
});
