import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import { createLocalInstanceService } from "../local-instance/service.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
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

interface HaControlNode {
  key: string;
  label?: string;
  kind: string;
  value?: unknown;
  unit?: string | null;
  min?: number;
  max?: number;
  isOn?: boolean;
  options?: Array<{ value: string; label: string }>;
  buttons?: Array<{ key: string; label: string; service: string }>;
}

interface EntityModelModule {
  AREA_FALLBACK: string;
  MAX_ENTITIES_PER_VIEW: number;
  entityDomain: (entityId: unknown) => string;
  displayName: (
    entity: { entity_id?: string; attributes?: Record<string, unknown> },
    registryEntry: Record<string, unknown> | null,
  ) => string;
  buildControls: (entity: {
    entity_id: string;
    state: string;
    attributes: Record<string, unknown>;
  }) => HaControlNode[];
  readDisplay: (entity: {
    entity_id: string;
    state: string;
    attributes: Record<string, unknown>;
  }) => { text: string; unit: string | null };
  toServiceCall: (
    entity: unknown,
    key: unknown,
    service: unknown,
    value?: unknown,
  ) => { domain: string; service: string; data: Record<string, unknown> };
  controlValue: (entity: unknown, key: string) => unknown;
  buildEntityView: (
    states: Array<{
      entity_id: string;
      state: string;
      attributes: Record<string, unknown>;
    }>,
    registries?: {
      entities?: Array<Record<string, unknown>>;
      devices?: Array<Record<string, unknown>>;
      areas?: Array<{ area_id: string; name: string }>;
    },
  ) => {
    grouping: string;
    groups: Array<{
      name: string;
      items: Array<{
        entityId: string;
        name: string;
        controls: HaControlNode[];
      }>;
    }>;
    total: number;
    truncated: boolean;
  };
}

interface HaWsSession {
  readonly phase: string;
  start(): void;
  stop(): void;
  restart(): void;
  request(type: string, extra?: Record<string, unknown>): Promise<unknown>;
}

interface HaWsModule {
  WS_BACKOFF_INITIAL_MS: number;
  WS_BACKOFF_MAX_MS: number;
  WS_ENTITY_REGISTRY_LIST: string;
  HaWsError: new (message: string, code?: string) => Error & { code: string };
  haWebSocketUrl: (baseUrl: string) => string;
  nextBackoffMs: (attempt: number, random?: () => number) => number;
  createHaWsSession: (options: {
    baseUrl: string;
    token: string;
    onStateChange?: (entityId: string, newState: HaEntityState | null) => void;
    onReady?: () => void | Promise<void>;
    onPhaseChange?: (event: { phase: string; reason?: string }) => void;
    logger?: { warn: (message: unknown, ...rest: unknown[]) => void };
    random?: () => number;
  }) => HaWsSession;
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

interface HaEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
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
  /** 覆盖初始实体（默认给一套跨域的样例行）。 */
  states?: HaEntityState[];
  /** 服务调用「成功但设备没动」：用于验证读回校验不报假成功。 */
  serviceIsNoop?: boolean;
  /** 集成配置流：POST /flow 的开流返回（缺省给一个 boolean 表单步）。 */
  flowStart?: Record<string, unknown>;
  /** 集成配置流：GET/POST /flow/<id> 的进度返回（缺省给 external 授权步）。 */
  flowProgress?: Record<string, unknown>;
}

/** 跨域样例：灯/开关/窗帘/空调/风扇/媒体播放器/传感器/坏设备各一条。 */
function sampleStates(): HaEntityState[] {
  return [
    {
      entity_id: "light.bedroom",
      state: "on",
      attributes: {
        friendly_name: "卧室灯",
        brightness: 128,
        color_temp: 300,
        min_mireds: 153,
        max_mireds: 454,
      },
    },
    {
      entity_id: "light.kitchen",
      state: "off",
      // 与真机 demo 灯同形：off 时没有 brightness，但能力表还在
      attributes: {
        friendly_name: "厨房灯",
        supported_color_modes: ["color_temp", "hs"],
      },
    },
    {
      entity_id: "switch.plug",
      state: "on",
      attributes: { friendly_name: "插座" },
    },
    {
      entity_id: "input_boolean.guest_mode",
      state: "off",
      attributes: { friendly_name: "访客模式" },
    },
    {
      entity_id: "cover.window",
      state: "closed",
      attributes: { friendly_name: "客厅窗帘", current_position: 0 },
    },
    {
      entity_id: "climate.ac",
      state: "heat",
      attributes: {
        friendly_name: "客厅空调",
        temperature: 22,
        min_temp: 16,
        max_temp: 30,
        hvac_mode: "heat",
        hvac_modes: ["off", "heat", "eco"],
      },
    },
    {
      entity_id: "fan.desk",
      state: "on",
      attributes: { friendly_name: "桌面风扇", percentage: 40 },
    },
    {
      entity_id: "media_player.tv",
      state: "playing",
      attributes: { friendly_name: "电视", volume_level: 0.4 },
    },
    {
      entity_id: "sensor.temperature",
      state: "21.5",
      attributes: {
        friendly_name: "室温",
        unit_of_measurement: "°C",
        device_class: "temperature",
      },
    },
    {
      entity_id: "binary_sensor.door",
      state: "off",
      attributes: { friendly_name: "门磁", device_class: "door" },
    },
    {
      entity_id: "light.dead",
      state: "unavailable",
      attributes: { friendly_name: "离线的灯" },
    },
    {
      entity_id: "sun.sun",
      state: "above_horizon",
      attributes: { friendly_name: "太阳" },
    },
  ];
}

/** HA 的服务语义（够用即可：只实现本插件会下发的这几个）。 */
function applyService(
  entity: HaEntityState,
  service: string,
  data: Record<string, unknown>,
): void {
  const attributes = entity.attributes;
  switch (`${entity.entity_id.split(".")[0]}.${service}`) {
    case "light.turn_on":
      entity.state = "on";
      if (typeof data.brightness_pct === "number") {
        attributes.brightness = Math.round((data.brightness_pct / 100) * 255);
      } else if (typeof attributes.brightness !== "number") {
        attributes.brightness = 255;
      }
      if (typeof data.color_temp === "number")
        attributes.color_temp = data.color_temp;
      break;
    case "light.turn_off":
      entity.state = "off";
      delete attributes.brightness;
      break;
    case "cover.open_cover":
      entity.state = "open";
      attributes.current_position = 100;
      break;
    case "cover.close_cover":
      entity.state = "closed";
      attributes.current_position = 0;
      break;
    case "cover.stop_cover":
      entity.state = "closed";
      break;
    case "cover.set_cover_position":
      entity.state = Number(data.position) >= 100 ? "open" : "closed";
      attributes.current_position = Number(data.position);
      break;
    case "climate.set_temperature":
      attributes.temperature = Number(data.temperature);
      break;
    case "climate.set_hvac_mode":
      entity.state = String(data.hvac_mode);
      attributes.hvac_mode = String(data.hvac_mode);
      break;
    case "fan.turn_on":
      entity.state = "on";
      break;
    case "fan.turn_off":
      entity.state = "off";
      break;
    case "fan.set_percentage":
      entity.state = "on";
      attributes.percentage = Number(data.percentage);
      break;
    case "media_player.turn_on":
      entity.state = "idle";
      break;
    case "media_player.turn_off":
      entity.state = "off";
      break;
    case "media_player.volume_set":
      attributes.volume_level = Number(data.volume_level);
      break;
    default:
      if (service === "turn_on") {
        entity.state = "on";
        break;
      }
      if (service === "turn_off") {
        entity.state = "off";
        break;
      }
      throw new Error(`Service not found: ${entity.entity_id}.${service}`);
  }
}

function fakeHomeAssistant(options: FakeHaOptions = {}) {
  const expected = `Bearer ${options.token ?? FAKE_TOKEN}`;
  const calls: FakeHaCall[] = [];
  /** 真值表：服务调用改它，`GET /api/states` 读它——读回校验因此有对象可对。 */
  const states = new Map<string, HaEntityState>();
  for (const entity of options.states ?? sampleStates()) {
    states.set(entity.entity_id, entity);
  }
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
    const parsed = new URL(url);
    const pathname = parsed.pathname;
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
    if (pathname === "/api/states") {
      return Response.json([...states.values()]);
    }
    const single = pathname.match(/^\/api\/states\/(.+)$/);
    if (single) {
      const entityId = decodeURIComponent(single[1] as string);
      const entity = states.get(entityId);
      if (!entity) {
        return Response.json(
          { message: `Entity not found: ${entityId}` },
          { status: 404 },
        );
      }
      return Response.json(entity);
    }
    const service = pathname.match(/^\/api\/services\/([^/]+)\/([^/]+)$/);
    if (service) {
      const domain = decodeURIComponent(service[1] as string);
      const serviceName = decodeURIComponent(service[2] as string);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      const entityId = String(body.entity_id ?? "");
      const target = states.get(entityId);
      if (!target || !entityId.startsWith(`${domain}.`)) {
        return Response.json(
          { message: `Entity not found: ${entityId}` },
          { status: 404 },
        );
      }
      if (!options.serviceIsNoop) {
        try {
          applyService(target, serviceName, body);
        } catch (error) {
          return Response.json(
            { message: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          );
        }
      }
      return Response.json([
        { entity_id: target.entity_id, state: target.state },
      ]);
    }
    const flowStart = pathname.match(
      /^\/api\/config\/config_entries\/flow$/,
    );
    if (flowStart && init?.method === "POST") {
      return Response.json(
        options.flowStart ?? {
          type: "form",
          flow_id: "flow-test-1",
          handler: "xiaomi_home",
          step_id: "user",
          data_schema: [
            { name: "agree", type: "boolean", required: true, default: false },
          ],
        },
      );
    }
    const flowStep = pathname.match(
      /^\/api\/config\/config_entries\/flow\/([^/]+)$/,
    );
    if (flowStep) {
      if ((init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        return Response.json(
          options.flowProgress ?? {
            type: "external",
            flow_id: String(flowStep[1]),
            step_id: "oauth",
            description_placeholders: {
              link_left:
                '<a href="https://account.xiaomi.com/oauth2/authorize?x=1" target="_blank">',
              link_right: "</a>",
            },
            ...(Object.keys(body).length > 0 ? { submitted: body } : {}),
          },
        );
      }
      return Response.json(options.flowProgress ?? { type: "progress", flow_id: flowStep[1] });
    }
    const entryDelete = pathname.match(
      /^\/api\/config\/config_entries\/entry\/([^/]+)$/,
    );
    if (entryDelete && init?.method === "DELETE") {
      return Response.json({ entry_id: decodeURIComponent(String(entryDelete[1])) });
    }
    return Response.json({ message: "not found" }, { status: 404 });
  };
  return { fetchImpl, calls, states };
}

let pluginsDir: string;
let storageFile: string;
let localInstances: Map<string, LocalInstanceService>;
const kernels: Array<{ dispose(): void }> = [];
/** 与生产同一收口路径：`preClose` 先 `registry.shutdown()`，插件的 effect disposer 才跑到。 */
const services: Array<{ shutdown(): Promise<void> }> = [];
const realFetch = globalThis.fetch;
const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

// === 假 HA 的 WebSocket（可脚本化的握手 / 订阅 / 注册表 / 断线） ===

interface SocketHubOptions {
  /** 连上就以 1006 断开（模拟「HA 没开 WS / 地址不通」，走 REST 兜底）。 */
  refuse?: boolean;
  /** 令牌被判无效：会话必须停止重试。 */
  authInvalid?: boolean;
  entities?: unknown[];
  areas?: unknown[];
  devices?: unknown[];
  /** 集成管理：WS config_entries/get 返回的配置条目（缺省空）。 */
  configEntries?: unknown[];
  /** 集成配置流：POST /flow 的开流返回（缺省给一个 boolean 表单步）。 */
  flowStart?: Record<string, unknown>;
  /** 集成配置流：GET/POST /flow/<id> 的进度返回（缺省给 external 授权步）。 */
  flowProgress?: Record<string, unknown>;
}

interface FakeSocket {
  url: string;
  readyState: number;
  onopen: null | (() => void);
  onmessage: null | ((event: { data: string }) => void);
  onclose: null | ((event: { code: number }) => void);
  onerror: null | (() => void);
  sent: Array<Record<string, unknown>>;
  emit(message: Record<string, unknown>): void;
  pushState(entityId: string, newState: HaEntityState | null): void;
  closeAbruptly(): void;
  kill(): void;
}

function createSocketHub(options: SocketHubOptions = {}) {
  const instances: FakeSocket[] = [];

  class Socket {
    url: string;
    readyState = 1;
    onopen: null | (() => void) = null;
    onmessage: null | ((event: { data: string }) => void) = null;
    onclose: null | ((event: { code: number }) => void) = null;
    onerror: null | (() => void) = null;
    sent: Array<Record<string, unknown>> = [];

    constructor(url: string) {
      this.url = url;
      instances.push(this as unknown as FakeSocket);
      setTimeout(() => {
        if (options.refuse) {
          this.readyState = 3;
          this.onclose?.({ code: 1006 });
          return;
        }
        this.onopen?.();
        this.emit({ type: "auth_required", ha_version: "2026.10.1" });
      }, 0);
    }

    emit(message: Record<string, unknown>) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }

    pushState(entityId: string, newState: HaEntityState | null) {
      this.emit({
        id: 1,
        type: "event",
        event: {
          event_type: "state_changed",
          data: { entity_id: entityId, new_state: newState },
        },
      });
    }

    send(text: string) {
      const message = JSON.parse(text) as Record<string, unknown>;
      this.sent.push(message);
      const type = String(message.type);
      if (type === "auth") {
        if (options.authInvalid) {
          this.emit({ type: "auth_invalid", message: "Broken access token" });
          this.kill();
          return;
        }
        this.emit({ type: "auth_ok", ha_version: "2026.10.1" });
        return;
      }
      if (type === "subscribe_events") {
        this.emit({ id: message.id, type: "result", success: true });
        return;
      }
      if (
        type === "config/entity_registry/list" ||
        type === "config/area_registry/list" ||
        type === "config/device_registry/list"
      ) {
        const result =
          type === "config/entity_registry/list"
            ? (options.entities ?? [])
            : type === "config/area_registry/list"
              ? (options.areas ?? [])
              : (options.devices ?? []);
        this.emit({ id: message.id, type: "result", success: true, result });
        return;
      }
      if (type === "config_entries/get") {
        this.emit({
          id: message.id,
          type: "result",
          success: true,
          result: options.configEntries ?? [],
        });
      }
    }

    /** 插件主动 stop() 时会先把回调置空，所以这里不再触发重连。 */
    kill() {
      this.readyState = 3;
    }

    closeAbruptly() {
      this.readyState = 3;
      setTimeout(() => this.onclose?.({ code: 1006 }), 0);
    }
  }

  const SocketCtor = Socket as unknown as new (url: string) => FakeSocket;
  return {
    instances,
    install() {
      (globalThis as { WebSocket?: unknown }).WebSocket = SocketCtor;
    },
    last() {
      const socket = instances[instances.length - 1];
      if (!socket) throw new Error("假 socket 还没被建过。");
      return socket;
    },
  };
}

function installSocketHub(options: SocketHubOptions = {}) {
  const hub = createSocketHub(options);
  hub.install();
  return hub;
}

/** 等某件事在预算内成立（假 socket 与 REST 都是宏任务，轮询比猜延时可靠）。 */
async function until(assertion: () => boolean, hint = "条件未成立") {
  // 预算给到 5 秒：退避本身要 1 秒，全仓并行跑时（turbo 多包）不能卡在毫秒级余量上
  const deadline = Date.now() + 5000;
  for (;;) {
    if (assertion()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${hint}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
  services.push(service);
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

async function fixtureActor(instanceId: string): Promise<LocalActor> {
  const service = localInstances.get(instanceId);
  if (!service) throw new Error("夹具未定义该本地实例。");
  return service.serviceActor();
}

type TestKernel = ReturnType<typeof composePlugins>;

function installedToolNames(kernel: TestKernel) {
  return kernel
    .get("tools")
    .list()
    .map((tool) => tool.name)
    .sort();
}

/** 以 agent 的调用上下文执行插件工具。 */
async function runTool<T>(
  kernel: TestKernel,
  name: string,
  args: Record<string, unknown>,
  instanceId: string,
): Promise<T> {
  const tool = kernel.get("tools").require(name);
  return (await tool.execute(args, {
    actor: await fixtureActor(instanceId),
    instanceId,
  })) as T;
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
  // 默认没有可用的 WS：走 REST 轮询兜底（要测实时态的用例自己换成假 socket）
  installSocketHub({ refuse: true });
});

afterEach(async () => {
  // 先按生产路径收插件（registry.shutdown → 插件 effect disposer → WS 会话与重连定时器一起停），
  // 再恢复全局：否则留着退避定时器的会话会带着上一个用例的 fetch 活到下一个用例里
  for (const service of services.splice(0)) {
    await service.shutdown();
  }
  globalThis.fetch = realFetch;
  (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
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
  it("通过门禁安装：能力面 tools/routes/ui/storage，侧栏入口标题「智能家居」", async () => {
    const { kernel, service, installed, report } = await installFromRepo();
    expect(report.compatible).toBe(true);
    expect(report.supportedCapabilities).toEqual([
      "tools",
      "routes",
      "ui",
      "storage",
    ]);
    expect(installed.name).toBe("kenfutwork-ha");
    expect(installedToolNames(kernel)).toEqual(["ha_control", "ha_entities"]);
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

  it("地址归一在保存时就完成：存进去的是干净地址，响应回同一份（原生视图 iframe 用）", async () => {
    const { service, installed, store } = await installFromRepo();
    const saved = await configureConnected(
      service,
      installed.id,
      INSTANCE_ID,
      "ha.test.local:8123/api/states/",
    );
    expect(saved?.status).toBe(200);
    expect(bodyOf<{ baseUrl?: string }>(saved).baseUrl).toBe(
      "http://ha.test.local:8123",
    );
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

describe("HA 插件：域 + 属性 → 控件模型", () => {
  it("灯：开关 + 亮度（百分比）+ 色温（mired 量程取自属性）", async () => {
    const model = await loadPluginModule<EntityModelModule>(
      "lib/entity-model.js",
    );
    const controls = model.buildControls({
      entity_id: "light.bedroom",
      state: "on",
      attributes: {
        brightness: 128,
        color_temp: 300,
        min_mireds: 153,
        max_mireds: 454,
      },
    });
    expect(controls).toEqual([
      {
        key: "power",
        label: "开关",
        kind: "toggle",
        isOn: true,
        onService: "turn_on",
        offService: "turn_off",
      },
      {
        key: "brightness",
        label: "亮度",
        kind: "slider",
        service: "turn_on",
        value: 50,
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
      },
      {
        key: "color_temp",
        label: "色温",
        kind: "slider",
        service: "turn_on",
        value: 300,
        min: 153,
        max: 454,
        step: 1,
        unit: "mired",
      },
    ]);
  });

  it("属性里没有量程就不放控件：灭了且没亮度属性的灯只给开关", async () => {
    const model = await loadPluginModule<EntityModelModule>(
      "lib/entity-model.js",
    );
    expect(
      model.buildControls({
        entity_id: "light.kitchen",
        state: "off",
        attributes: {},
      }),
    ).toEqual([
      {
        key: "power",
        label: "开关",
        kind: "toggle",
        isOn: false,
        onService: "turn_on",
        offService: "turn_off",
      },
    ]);
    // 离线/未知：不给任何可写控件（前端置灰）
    expect(
      model.buildControls({
        entity_id: "light.dead",
        state: "unavailable",
        attributes: { brightness: 10 },
      }),
    ).toEqual([]);
  });

  it("关着的灯仍可设亮度：能力判据取 supported_color_modes，不取当前属性（真机缺陷回归）", async () => {
    const model = await loadPluginModule<EntityModelModule>(
      "lib/entity-model.js",
    );
    // 真机取证：demo 灯 off 时 HA 不再报 brightness 属性，但 supported_color_modes 仍在
    const offDimmable = {
      entity_id: "light.kitchen_lights",
      state: "off",
      attributes: {
        friendly_name: "厨房灯",
        supported_color_modes: ["color_temp", "hs"],
      },
    };
    const controls = model.buildControls(offDimmable);
    expect(controls.map((node) => node.key)).toEqual(["power", "brightness"]);
    // 没有当前值就如实给 null（面板显示「—」，不编一个数上去）
    expect(controls[1]).toMatchObject({
      kind: "slider",
      value: null,
      min: 0,
      max: 100,
    });
    // 「把关着的灯调到 30%」= turn_on + brightness_pct，HA 的语义正是开灯并给亮度
    expect(
      model.toServiceCall(offDimmable, "brightness", "turn_on", 30),
    ).toEqual({
      domain: "light",
      service: "turn_on",
      data: { brightness_pct: 30, entity_id: "light.kitchen_lights" },
    });
    // 只支持 onoff 的灯：不放亮度（不放点了没用的控件）
    expect(
      model
        .buildControls({
          entity_id: "light.dumb",
          state: "off",
          attributes: { supported_color_modes: ["onoff"] },
        })
        .map((node) => node.key),
    ).toEqual(["power"]);
  });

  it("窗帘：开/合/停三个按钮 + 位置滑杆；空调：目标温度 + 模式下拉", async () => {
    const model = await loadPluginModule<EntityModelModule>(
      "lib/entity-model.js",
    );
    const cover = model.buildControls({
      entity_id: "cover.window",
      state: "closed",
      attributes: { current_position: 20 },
    });
    expect(cover[0]?.kind).toBe("buttons");
    expect(cover[0]?.buttons?.map((item) => item.service)).toEqual([
      "open_cover",
      "close_cover",
      "stop_cover",
    ]);
    expect(cover[1]).toMatchObject({
      key: "position",
      kind: "slider",
      service: "set_cover_position",
      value: 20,
    });
    const climate = model.buildControls({
      entity_id: "climate.ac",
      state: "heat",
      attributes: {
        temperature: 22,
        min_temp: 16,
        max_temp: 30,
        hvac_mode: "heat",
        hvac_modes: ["off", "heat", "eco"],
      },
    });
    expect(climate[0]).toMatchObject({
      key: "temperature",
      kind: "slider",
      service: "set_temperature",
      min: 16,
      max: 30,
      step: 0.5,
    });
    expect(climate[1]?.options).toEqual([
      { value: "off", label: "off" },
      { value: "heat", label: "heat" },
      { value: "eco", label: "eco" },
    ]);
  });

  it("媒体播放器按状态判开关，音量说百分比、下发 0~1", async () => {
    const model = await loadPluginModule<EntityModelModule>(
      "lib/entity-model.js",
    );
    const controls = model.buildControls({
      entity_id: "media_player.tv",
      state: "playing",
      attributes: { volume_level: 0.4 },
    });
    expect(controls[0]).toMatchObject({ kind: "toggle", isOn: true });
    expect(controls[1]).toMatchObject({
      key: "volume",
      value: 40,
      min: 0,
      max: 100,
    });
    const call = model.toServiceCall(
      {
        entity_id: "media_player.tv",
        state: "playing",
        attributes: { volume_level: 0.4 },
      },
      "volume",
      "volume_set",
      65,
    );
    expect(call.data).toEqual({
      volume_level: 0.65,
      entity_id: "media_player.tv",
    });
  });

  it("只读品类给读数：传感器带单位，二值与状态词翻成中文", async () => {
    const model = await loadPluginModule<EntityModelModule>(
      "lib/entity-model.js",
    );
    expect(
      model.readDisplay({
        entity_id: "sensor.temperature",
        state: "21.5",
        attributes: { unit_of_measurement: "°C" },
      }),
    ).toEqual({ text: "21.5", unit: "°C" });
    expect(
      model.readDisplay({
        entity_id: "binary_sensor.door",
        state: "off",
        attributes: {},
      }),
    ).toEqual({ text: "关", unit: null });
    expect(
      model.readDisplay({
        entity_id: "sun.sun",
        state: "above_horizon",
        attributes: {},
      }),
    ).toEqual({ text: "above_horizon", unit: null });
    // 视图里：没有可写控件的实体被包成一个 read 控件（面板一行渲染）
    const view = model.buildEntityView([
      {
        entity_id: "sensor.temperature",
        state: "21.5",
        attributes: { unit_of_measurement: "°C" },
      },
    ]);
    expect(view.groups[0]?.items[0]?.controls).toEqual([
      {
        key: "readout",
        label: "状态",
        kind: "read",
        value: "21.5",
        unit: "°C",
      },
    ]);
  });

  it("参数换算与量程都在服务端：entity_id 必带、越界与改服务名一律拒", async () => {
    const model = await loadPluginModule<EntityModelModule>(
      "lib/entity-model.js",
    );
    const light = {
      entity_id: "light.bedroom",
      state: "on",
      attributes: {
        brightness: 128,
        color_temp: 300,
        min_mireds: 153,
        max_mireds: 454,
      },
    };
    expect(model.toServiceCall(light, "brightness", "turn_on", 75)).toEqual({
      domain: "light",
      service: "turn_on",
      data: { brightness_pct: 75, entity_id: "light.bedroom" },
    });
    expect(
      model.toServiceCall(light, "power", "turn_off", undefined).data,
    ).toEqual({
      entity_id: "light.bedroom",
    });
    // 漏 entity_id 会打给该域全部实体——这条必须锁死
    expect(model.toServiceCall(light, "power", "turn_on").data.entity_id).toBe(
      "light.bedroom",
    );
    expect(() =>
      model.toServiceCall(light, "brightness", "turn_on", 120),
    ).toThrow(/亮度超出量程：需要 0~100/);
    expect(() =>
      model.toServiceCall(light, "brightness", "turn_on", "abc"),
    ).toThrow(/要一个数字/);
    expect(() => model.toServiceCall(light, "power", "turn_up")).toThrow(
      /不支持服务/,
    );
    expect(() => model.toServiceCall(light, "readout", "turn_on")).toThrow(
      /没有「readout」控件/,
    );
    expect(() =>
      model.toServiceCall({ entity_id: "" }, "power", "turn_on"),
    ).toThrow(/实体 id 不合法/);
    const climate = {
      entity_id: "climate.ac",
      state: "heat",
      attributes: {
        temperature: 22,
        min_temp: 16,
        max_temp: 30,
        hvac_mode: "heat",
        hvac_modes: ["off", "heat"],
      },
    };
    expect(() =>
      model.toServiceCall(climate, "hvac_mode", "set_hvac_mode", "turbo"),
    ).toThrow(/模式没有「turbo」这个取值：可选 off \/ heat/);
    expect(
      model.controlValue(
        { ...climate, attributes: { ...climate.attributes, temperature: 25 } },
        "temperature",
      ),
    ).toBe(25);
  });

  it("分组：没注册表按域，有注册表按区域且未分区排最后", async () => {
    const model = await loadPluginModule<EntityModelModule>(
      "lib/entity-model.js",
    );
    const states = [
      {
        entity_id: "light.a",
        state: "on",
        attributes: { friendly_name: "A 灯" },
      },
      {
        entity_id: "switch.b",
        state: "on",
        attributes: { friendly_name: "B 开关" },
      },
      {
        entity_id: "light.c",
        state: "on",
        attributes: { friendly_name: "C 灯" },
      },
    ];
    const byDomain = model.buildEntityView(states);
    expect(byDomain.grouping).toBe("domain");
    expect(byDomain.groups.map((group) => group.name)).toEqual([
      "light",
      "switch",
    ]);
    expect(byDomain.groups[0]?.items.map((item) => item.entityId)).toEqual([
      "light.a",
      "light.c",
    ]);

    const byArea = model.buildEntityView(states, {
      entities: [
        // 区域可挂在实体上，也可经设备继承
        { entity_id: "light.a", name: "改名灯", area_id: "living" },
        { entity_id: "switch.b", device_id: "dev-1" },
      ],
      devices: [{ id: "dev-1", area_id: "bed" }],
      areas: [
        { area_id: "living", name: "客厅" },
        { area_id: "bed", name: "卧室" },
      ],
    });
    expect(byArea.grouping).toBe("area");
    expect(byArea.groups.map((group) => group.name)).toEqual([
      "客厅",
      "卧室",
      "未分区",
    ]);
    // 注册表里的自定义名优先于属性里的 friendly_name
    expect(byArea.groups[0]?.items[0]?.name).toBe("改名灯");
  });

  it("超上限如实标 truncated（不静默丢实体）", async () => {
    const model = await loadPluginModule<EntityModelModule>(
      "lib/entity-model.js",
    );
    const states = Array.from(
      { length: model.MAX_ENTITIES_PER_VIEW + 5 },
      (_, i) => ({
        entity_id: `sensor.s_${i}`,
        state: String(i),
        attributes: {},
      }),
    );
    const view = model.buildEntityView(states);
    expect(view.total).toBe(model.MAX_ENTITIES_PER_VIEW + 5);
    expect(view.truncated).toBe(true);
    expect(view.groups[0]?.items.length).toBe(model.MAX_ENTITIES_PER_VIEW);
  });
});

describe("HA 插件：实体网格与控制（假 HA 全链路）", () => {
  it("未配置时报可读错误，面板据此回到配置态", async () => {
    const { service, installed } = await installFromRepo();
    const result = await dispatch(service, installed.id, {
      path: "entities",
      instanceId: INSTANCE_ID,
    });
    expect(result?.status).toBe(401);
    expect(bodyOf<{ code: string }>(result).code).toBe("not_configured");
  });

  it("列实体：按域分组、轮询态如实标注、控件齐全", async () => {
    const { service, installed } = await installFromRepo();
    await configureConnected(service, installed.id);
    const result = await dispatch(service, installed.id, {
      path: "entities",
      instanceId: INSTANCE_ID,
    });
    expect(result?.status).toBe(200);
    const view = bodyOf<{
      mode: string;
      grouping: string;
      total: number;
      truncated: boolean;
      groups: Array<{
        name: string;
        items: Array<{
          entityId: string;
          name: string;
          state: string;
          unavailable: boolean;
          controls: HaControlNode[];
        }>;
      }>;
    }>(result);
    expect(view.mode).toBe("polling");
    expect(view.grouping).toBe("domain");
    expect(view.total).toBe(12);
    expect(view.truncated).toBe(false);
    const light = view.groups.find((group) => group.name === "light");
    // 组内按显示名排序（中文按拼音），这里只断集合本身
    expect(light?.items.map((item) => item.entityId).sort()).toEqual([
      "light.bedroom",
      "light.dead",
      "light.kitchen",
    ]);
    const bedroom = light?.items.find(
      (item) => item.entityId === "light.bedroom",
    );
    expect(bedroom).toMatchObject({
      name: "卧室灯",
      state: "on",
      unavailable: false,
    });
    expect((bedroom?.controls ?? []).map((node) => node.key)).toEqual([
      "power",
      "brightness",
      "color_temp",
    ]);
    const dead = view.groups
      .flatMap((group) => group.items)
      .find((item) => item.entityId === "light.dead");
    expect(dead).toMatchObject({ unavailable: true });
    expect((dead?.controls ?? []).map((node) => node.kind)).toEqual(["read"]);
  });

  it("控制走通并读回真值：改完假 HA 的真值真的变了", async () => {
    const { service, installed, fake } = await installFromRepo();
    await configureConnected(service, installed.id);
    const result = await dispatch(service, installed.id, {
      method: "POST",
      path: "control",
      body: { entityId: "light.kitchen", key: "power", service: "turn_on" },
      instanceId: INSTANCE_ID,
    });
    expect(result?.status).toBe(200);
    expect(bodyOf<Record<string, unknown>>(result)).toMatchObject({
      ok: true,
      before: false,
      after: true,
      changed: true,
      state: "on",
      message: "已生效",
    });
    expect(fake.states.get("light.kitchen")?.state).toBe("on");
    const call = fake.calls.find((item) => item.method === "POST");
    expect(call?.url).toBe(
      "http://ha.test.local:8123/api/services/light/turn_on",
    );
    expect(call?.body).toEqual({ entity_id: "light.kitchen" });
  });

  it("亮度换算在线上：面板说百分比，HA 收到 brightness_pct", async () => {
    const { service, installed, fake } = await installFromRepo();
    await configureConnected(service, installed.id);
    const result = await dispatch(service, installed.id, {
      method: "POST",
      path: "control",
      body: {
        entityId: "light.bedroom",
        key: "brightness",
        service: "turn_on",
        value: 75,
      },
      instanceId: INSTANCE_ID,
    });
    expect(result?.status).toBe(200);
    expect(
      fake.calls.find((item) => item.url.endsWith("/services/light/turn_on"))
        ?.body,
    ).toEqual({ brightness_pct: 75, entity_id: "light.bedroom" });
    // 128 → 75% 是真变化：亮度读数跟着变
    expect(bodyOf<{ after: number }>(result).after).toBe(75);
  });

  it("设备没动时如实说「已发出，状态未变」，不报假成功", async () => {
    const { service, installed } = await installFromRepo({
      serviceIsNoop: true,
    });
    await configureConnected(service, installed.id);
    const result = await dispatch(service, installed.id, {
      method: "POST",
      path: "control",
      body: { entityId: "light.bedroom", key: "power", service: "turn_off" },
      instanceId: INSTANCE_ID,
    });
    expect(bodyOf<Record<string, unknown>>(result)).toMatchObject({
      ok: true,
      changed: false,
      before: true,
      after: true,
      message: "已发出，状态未变",
    });
  });

  it("控制面的错误面：脏 id、越界、只读实体、HA 里不存在的实体", async () => {
    const { service, installed } = await installFromRepo();
    await configureConnected(service, installed.id);

    const dirty = await dispatch(service, installed.id, {
      method: "POST",
      path: "control",
      body: { entityId: "light/../config", key: "power", service: "turn_on" },
      instanceId: INSTANCE_ID,
    });
    expect(dirty?.status).toBe(400);
    expect(bodyOf<{ code: string }>(dirty).code).toBe("bad_service");

    const outOfRange = await dispatch(service, installed.id, {
      method: "POST",
      path: "control",
      body: {
        entityId: "cover.window",
        key: "position",
        service: "set_cover_position",
        value: 300,
      },
      instanceId: INSTANCE_ID,
    });
    expect(outOfRange?.status).toBe(400);
    expect(bodyOf<{ error: string }>(outOfRange).error).toContain(
      "位置超出量程",
    );

    const readOnly = await dispatch(service, installed.id, {
      method: "POST",
      path: "control",
      body: {
        entityId: "sensor.temperature",
        key: "readout",
        service: "turn_on",
        value: 1,
      },
      instanceId: INSTANCE_ID,
    });
    expect(readOnly?.status).toBe(400);
    expect(bodyOf<{ error: string }>(readOnly).error).toContain(
      "没有「readout」控件",
    );

    const missing = await dispatch(service, installed.id, {
      method: "POST",
      path: "control",
      body: { entityId: "light.gone", key: "power", service: "turn_on" },
      instanceId: INSTANCE_ID,
    });
    expect(missing?.status).toBe(404);
    expect(bodyOf<{ code: string }>(missing).code).toBe("not_found");
  });

  it("HA 令牌被吊销：列实体回 401 原话，面板据此回配置态", async () => {
    const { service, installed } = await installFromRepo();
    await configureConnected(service, installed.id);
    // 换掉假 HA 认的那个令牌 = 用户在 HA 侧吊销/重建了令牌，库里这份已失效
    globalThis.fetch = fakeHomeAssistant({
      token: "rotated-by-ha",
    }).fetchImpl as typeof fetch;
    const result = await dispatch(service, installed.id, {
      path: "entities",
      instanceId: INSTANCE_ID,
    });
    expect(result?.status).toBe(401);
    expect(bodyOf<{ code: string }>(result).code).toBe("unauthorized");
    expect(bodyOf<{ error: string }>(result).error).toContain("个人资料");
  });
});

interface EntitiesPayload {
  mode: string;
  grouping: string;
  total: number;
  truncated: boolean;
  ecosystems: { mijia: number; huawei: number } | null;
  groups: Array<{
    name: string;
    items: Array<{
      entityId: string;
      name: string;
      area: string;
      state: string;
      unavailable: boolean;
      controls: HaControlNode[];
    }>;
  }>;
}

function entitiesOf(result: { body?: unknown } | undefined): EntitiesPayload {
  return bodyOf<EntitiesPayload>(result);
}

/** 取实体视图，直到 WS 把状态从 polling 翻成 realtime（没翻成就把最后一版返回）。 */
async function waitRealtime(
  service: ReturnType<typeof createPluginRegistryService>,
  pluginId: string,
): Promise<EntitiesPayload> {
  let payload = entitiesOf(
    await dispatch(service, pluginId, {
      path: "entities",
      instanceId: INSTANCE_ID,
    }),
  );
  for (let i = 0; i < 40 && payload.mode !== "realtime"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    payload = entitiesOf(
      await dispatch(service, pluginId, {
        path: "entities",
        instanceId: INSTANCE_ID,
      }),
    );
  }
  return payload;
}

describe("HA 插件：WebSocket 状态机", () => {
  it("端点换算：http→ws、https→wss、保留 ingress 子路径", async () => {
    const ws = await loadPluginModule<HaWsModule>("lib/ha-ws.js");
    expect(ws.haWebSocketUrl("http://192.168.1.20:8123")).toBe(
      "ws://192.168.1.20:8123/api/websocket",
    );
    expect(ws.haWebSocketUrl("https://ha.example.com/home/")).toBe(
      "wss://ha.example.com/home/api/websocket",
    );
  });

  it("退避：1 秒起步、翻倍、封顶 30 秒，抖动按注入的随机数可复现", async () => {
    const ws = await loadPluginModule<HaWsModule>("lib/ha-ws.js");
    const half = () => 0.5;
    expect(ws.nextBackoffMs(0, half)).toBe(ws.WS_BACKOFF_INITIAL_MS);
    expect(ws.nextBackoffMs(1, half)).toBe(1000);
    expect(ws.nextBackoffMs(2, half)).toBe(2000);
    expect(ws.nextBackoffMs(3, half)).toBe(4000);
    expect(ws.nextBackoffMs(12, half)).toBe(ws.WS_BACKOFF_MAX_MS);
    // 抖动是 ±20%：两端值可复现，多实例重启才不齐步
    expect(ws.nextBackoffMs(1, () => 0)).toBe(800);
    expect(ws.nextBackoffMs(1, () => 1)).toBe(1200);
  });

  it("握手：auth_required → auth → auth_ok → 订阅 state_changed，命令拿到裸数组结果", async () => {
    const hub = installSocketHub({
      entities: [{ entity_id: "light.bedroom", area_id: "living" }],
      areas: [{ area_id: "living", name: "客厅" }],
    });
    const ws = await loadPluginModule<HaWsModule>("lib/ha-ws.js");
    let readyCount = 0;
    const session = ws.createHaWsSession({
      baseUrl: "http://ha.test.local:8123",
      token: FAKE_TOKEN,
      onReady: () => {
        readyCount += 1;
      },
    });
    session.start();
    await until(() => session.phase === "ready", "会话未进入 ready");
    expect(readyCount).toBe(1);
    const socket = hub.last();
    expect(socket.url).toBe("ws://ha.test.local:8123/api/websocket");
    expect(socket.sent.map((message) => message.type)).toEqual([
      "auth",
      "subscribe_events",
    ]);
    expect(socket.sent[0]?.access_token).toBe(FAKE_TOKEN);
    expect(await session.request(ws.WS_ENTITY_REGISTRY_LIST)).toMatchObject([
      { entity_id: "light.bedroom" },
    ]);
    session.stop();
  });

  it("令牌被判 auth_invalid：如实 failed 且不再重试（不撞 HA 的认证日志）", async () => {
    const hub = installSocketHub({ authInvalid: true });
    const ws = await loadPluginModule<HaWsModule>("lib/ha-ws.js");
    const phases: string[] = [];
    const session = ws.createHaWsSession({
      baseUrl: "http://ha.test.local:8123",
      token: "revoked",
      onPhaseChange: (event) => phases.push(event.phase),
    });
    session.start();
    await until(() => session.phase === "failed", "会话没有判失败");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(hub.instances.length).toBe(1);
    expect(phases).toContain("failed");
    session.stop();
  });

  it("断线后重连并重新握手；stop() 之后不再重连", async () => {
    const hub = installSocketHub();
    const ws = await loadPluginModule<HaWsModule>("lib/ha-ws.js");
    const session = ws.createHaWsSession({
      baseUrl: "http://ha.test.local:8123",
      token: FAKE_TOKEN,
    });
    session.start();
    await until(() => session.phase === "ready", "首次握手没完成");
    hub.last().closeAbruptly();
    await until(() => hub.instances.length === 2, "没有起第二条连接");
    await until(() => session.phase === "ready", "重连后没有恢复 ready");
    expect(hub.instances[1]?.sent.map((message) => message.type)).toContain(
      "auth",
    );
    session.stop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(hub.instances.length).toBe(2);
  });

  it("缺令牌时直接报错，不去建连接", async () => {
    const hub = installSocketHub();
    const ws = await loadPluginModule<HaWsModule>("lib/ha-ws.js");
    expect(() =>
      ws.createHaWsSession({ baseUrl: "http://ha.test.local:8123", token: "" }),
    ).toThrow(/令牌/);
    expect(hub.instances.length).toBe(0);
  });
});

describe("HA 插件：实时态（WS 快照 + 注册表补齐区域）", () => {
  it("就绪后走快照：按区域分组、增量跟随、不再打 REST 全量", async () => {
    const hub = installSocketHub({
      entities: [
        {
          entity_id: "light.bedroom",
          area_id: "living",
          name: null,
          original_name: "卧室灯（注册表名）",
        },
        { entity_id: "switch.plug", device_id: "dev-1" },
      ],
      devices: [{ id: "dev-1", area_id: "bed" }],
      areas: [
        { area_id: "living", name: "客厅" },
        { area_id: "bed", name: "卧室" },
      ],
    });
    const { service, installed, fake } = await installFromRepo();
    await configureConnected(service, installed.id);
    const view = await waitRealtime(service, installed.id);
    expect(view.mode).toBe("realtime");
    expect(view.grouping).toBe("area");
    expect(view.groups.map((group) => group.name)).toEqual([
      "客厅",
      "卧室",
      "未分区",
    ]);
    // 注册表里的名字优先于 REST 属性里的 friendly_name
    const bedroom = view.groups
      .flatMap((group) => group.items)
      .find((item) => item.entityId === "light.bedroom");
    expect(bedroom?.name).toBe("卧室灯（注册表名）");
    expect(
      view.groups
        .flatMap((group) => group.items)
        .find((item) => item.entityId === "switch.plug")?.area,
    ).toBe("卧室");

    const statesCalls = fake.calls.filter((call) =>
      call.url.endsWith("/api/states"),
    ).length;
    hub.last().pushState("light.kitchen", {
      entity_id: "light.kitchen",
      state: "on",
      attributes: { friendly_name: "厨房灯", brightness: 255 },
    });
    const after = entitiesOf(
      await dispatch(service, installed.id, {
        path: "entities",
        instanceId: INSTANCE_ID,
      }),
    );
    const kitchen = after.groups
      .flatMap((group) => group.items)
      .find((item) => item.entityId === "light.kitchen");
    expect(kitchen).toMatchObject({ state: "on", unavailable: false });
    expect(kitchen?.controls.map((node) => node.key)).toEqual([
      "power",
      "brightness",
    ]);
    // 增量来自 WS：这一轮没有再打 REST 全量
    expect(
      fake.calls.filter((call) => call.url.endsWith("/api/states")).length,
    ).toBe(statesCalls);
  });

  it("实体被删除（new_state 为 null）时从快照消失，不留在面板上", async () => {
    const hub = installSocketHub();
    const { service, installed } = await installFromRepo();
    await configureConnected(service, installed.id);
    await waitRealtime(service, installed.id);
    hub.last().pushState("sensor.temperature", null);
    const view = entitiesOf(
      await dispatch(service, installed.id, {
        path: "entities",
        instanceId: INSTANCE_ID,
      }),
    );
    expect(
      view.groups.flatMap((group) => group.items).map((item) => item.entityId),
    ).not.toContain("sensor.temperature");
  });

  it("控制后把读回真值同步进快照（实时态下面板下一轮就是真相）", async () => {
    installSocketHub();
    const { service, installed } = await installFromRepo();
    await configureConnected(service, installed.id);
    await waitRealtime(service, installed.id);
    const result = await dispatch(service, installed.id, {
      method: "POST",
      path: "control",
      body: {
        entityId: "cover.window",
        key: "position",
        service: "set_cover_position",
        value: 40,
      },
      instanceId: INSTANCE_ID,
    });
    expect(bodyOf<Record<string, unknown>>(result)).toMatchObject({
      changed: true,
      before: 0,
      after: 40,
    });
    const view = entitiesOf(
      await dispatch(service, installed.id, {
        path: "entities",
        instanceId: INSTANCE_ID,
      }),
    );
    const cover = view.groups
      .flatMap((group) => group.items)
      .find((item) => item.entityId === "cover.window");
    expect(cover?.state).toBe("closed");
    expect(cover?.controls.find((node) => node.key === "position")?.value).toBe(
      40,
    );
  });

  it("WS 连不上时整条链路仍可用：REST 轮询 + 面板如实标注", async () => {
    installSocketHub({ refuse: true });
    const { service, installed } = await installFromRepo();
    await configureConnected(service, installed.id);
    const view = entitiesOf(
      await dispatch(service, installed.id, {
        path: "entities",
        instanceId: INSTANCE_ID,
      }),
    );
    expect(view.mode).toBe("polling");
    expect(view.total).toBeGreaterThan(0);
    expect(view.grouping).toBe("domain");
  });
});

describe("HA 插件：接入引导与生态识别", () => {
  interface GuideItem {
    kind: string;
    text?: string;
    url?: string;
  }
  interface GuideBrand {
    id: string;
    title: string;
    subtitle: string;
    open: boolean;
    items: GuideItem[];
  }
  interface GuideStep {
    id: string;
    title: string;
    open: boolean;
    items: GuideItem[];
  }

  it("guide 路由：品牌卡米家/华为默认展开，通用步骤收起，仓库链接与 HACS、Docker 命令逐字核对", async () => {
    const { service, installed } = await installFromRepo();
    const result = await dispatch(service, installed.id, {
      path: "guide",
      instanceId: INSTANCE_ID,
    });
    expect(result?.status).toBe(200);
    const body = bodyOf<{ brands: GuideBrand[]; steps: GuideStep[] }>(result);
    // 默认支持的两个生态 = 教程里「选择品牌或集成」的两张品牌卡，都默认展开
    expect(body.brands.map((brand) => brand.id)).toEqual(["xiaomi", "huawei"]);
    for (const brand of body.brands) {
      expect(brand.open).toBe(true);
      expect(brand.subtitle).toBeTruthy();
    }
    expect(body.steps.map((step) => step.id)).toEqual([
      "ha",
      "hacs",
      "embed",
      "autologin",
      "token",
    ]);
    for (const step of body.steps) {
      expect(step.open).toBe(false);
    }
    const brandItems = body.brands.flatMap((brand) => brand.items);
    // 装错仓库是引导最大的事故面：品牌卡里的仓库链接逐字核对
    expect(
      brandItems.filter((item) => item.kind === "link").map((item) => item.url),
    ).toEqual(
      expect.arrayContaining([
        "https://github.com/XiaoMi/ha_xiaomi_home",
        "https://github.com/xiasi0/ha-huawei-smarthome",
        "https://github.com/xiasi0/ha-huawei-smarthome/blob/main/docs/supported-devices.md",
      ]),
    );
    // 米家 OAuth 跳转地址坑（教程第一大翻车点）写进品牌卡
    expect(brandItems.map((item) => item.text ?? "").join("\n")).toContain(
      "homeassistant.local",
    );
    // 华为登录三要素在场
    expect(brandItems.map((item) => item.text ?? "").join("\n")).toContain(
      "挑战码",
    );
    const commands = body.steps
      .flatMap((step) => step.items)
      .filter((item) => item.kind === "command")
      .map((item) => item.text ?? "")
      .join("\n");
    expect(commands).toContain("get.hacs.xyz");
    expect(commands).toContain("ghcr.io/home-assistant/home-assistant:stable");
    // 内嵌步（2026-10-24 拍板「要教程里一样的界面」）：旧版关 X-Frame-Options 的 yaml 在场
    expect(commands).toContain("use_x_frame_options: false");
    // 引导终点把用户带回自己的连接表单：令牌步骤指回面板
    expect(
      body.steps
        .flatMap((step) => step.items)
        .map((item) => item.text ?? "")
        .join("\n"),
    ).toContain("长期访问令牌");
    // 免登陆步（2026-10-25 用户口径「自动关联本地用户」）：trusted_networks 在场
    expect(commands).toContain("allow_bypass_login: true");
    expect(commands).toContain("172.17.0.1");
  });

  it("guide 路由私有：未登录 401", async () => {
    const { service, installed } = await installFromRepo();
    const anonymous = await dispatch(service, installed.id, {
      path: "guide",
      instanceId: INSTANCE_ID,
      isAuthenticated: false,
    });
    expect(anonymous?.status).toBe(401);
  });

  it("生态识别：注册表 platform 计数（xiaomi_home/xiaomi_miot → 米家、huawei_smarthome → 华为）", async () => {
    installSocketHub({
      entities: [
        {
          entity_id: "light.bedroom",
          platform: "xiaomi_home",
          area_id: "living",
        },
        { entity_id: "switch.plug", platform: "xiaomi_miot" },
        { entity_id: "sensor.temp", platform: "huawei_smarthome" },
        { entity_id: "sun.sun" },
      ],
      areas: [{ area_id: "living", name: "客厅" }],
    });
    const { service, installed } = await installFromRepo();
    await configureConnected(service, installed.id);
    const view = await waitRealtime(service, installed.id);
    expect(view.mode).toBe("realtime");
    expect(view.ecosystems).toEqual({ mijia: 2, huawei: 1 });
  });

  it("轮询态（WS 不通、无注册表）不带生态计数：识别不了就不显示", async () => {
    installSocketHub({ refuse: true });
    const { service, installed } = await installFromRepo();
    await configureConnected(service, installed.id);
    const view = entitiesOf(
      await dispatch(service, installed.id, {
        path: "entities",
        instanceId: INSTANCE_ID,
      }),
    );
    expect(view.mode).toBe("polling");
    expect(view.ecosystems).toBeNull();
  });

  it("集成管理：列表只含默认两生态，WS 未就绪如实标 ready=false", async () => {
    installSocketHub({
      configEntries: [
        {
          entry_id: "entry-xiaomi-1",
          domain: "xiaomi_home",
          title: "羊刀仙",
          state: "loaded",
        },
        { entry_id: "entry-hue", domain: "hue", title: "Hue", state: "loaded" },
      ],
    });
    const { service, installed } = await installFromRepo();
    await configureConnected(service, installed.id);
    const view = bodyOf<{
      ready: boolean;
      integrations: Array<{
        entryId: string;
        domain: string;
        title: string;
        state: string;
      }>;
    }>(
      await dispatch(service, installed.id, {
        path: "integrations",
        instanceId: INSTANCE_ID,
      }),
    );
    expect(view.ready).toBe(true);
    // Hue 这类非默认生态被滤掉：面板只管默认两家的生命周期
    expect(view.integrations).toEqual([
      {
        entryId: "entry-xiaomi-1",
        domain: "xiaomi_home",
        title: "羊刀仙",
        state: "loaded",
      },
    ]);
  });

  it("集成管理：添加走配置流（白名单外拒绝）、external 步带授权链接、卸载打 DELETE", async () => {
    installSocketHub({ configEntries: [] });
    const { service, installed, fake } = await installFromRepo();
    await configureConnected(service, installed.id);
    const bad = await dispatch(service, installed.id, {
      path: "integrations/start",
      method: "POST",
      body: { brand: "tuya" },
      instanceId: INSTANCE_ID,
    });
    expect(bad?.status).toBe(400);
    const start = bodyOf<{ flowId: string; step: { type: string } }>(
      await dispatch(service, installed.id, {
        path: "integrations/start",
        method: "POST",
        body: { brand: "xiaomi" },
        instanceId: INSTANCE_ID,
      }),
    );
    expect(start.flowId).toBe("flow-test-1");
    expect(start.step.type).toBe("form");
    const external = bodyOf<{
      step: { type: string; description_placeholders: Record<string, string> };
    }>(
      await dispatch(service, installed.id, {
        path: "integrations/flow",
        method: "POST",
        body: { flowId: start.flowId, fields: { agree: true } },
        instanceId: INSTANCE_ID,
      }),
    );
    expect(external.step.type).toBe("external");
    expect(external.step.description_placeholders.link_left).toContain(
      "account.xiaomi.com",
    );
    const removed = await dispatch(service, installed.id, {
      path: "integrations/remove",
      method: "POST",
      body: { entryId: "entry-x" },
      instanceId: INSTANCE_ID,
    });
    expect(removed?.status).toBe(200);
    expect(
      fake.calls.some(
        (call) =>
          call.method === "DELETE" && String(call.url).includes("entry-x"),
      ),
    ).toBe(true);
  });

  it("在途配置流复用：重复 start 返回同一个 flow，不再新起一个（HA 会 already_in_progress）", async () => {
    installSocketHub({ configEntries: [] });
    const { service, installed, fake } = await installFromRepo();
    await configureConnected(service, installed.id);
    const starts = () =>
      fake.calls.filter(
        (call) =>
          call.method === "POST" &&
          String(call.url).endsWith("/api/config/config_entries/flow"),
      ).length;

    const first = bodyOf<{ flowId: string; step: { type: string } }>(
      await dispatch(service, installed.id, {
        path: "integrations/start",
        method: "POST",
        body: { brand: "xiaomi" },
        instanceId: INSTANCE_ID,
      }),
    );
    expect(starts()).toBe(1);
    const second = bodyOf<{ flowId: string; step: { type: string } }>(
      await dispatch(service, installed.id, {
        path: "integrations/start",
        method: "POST",
        body: { brand: "xiaomi" },
        instanceId: INSTANCE_ID,
      }),
    );
    // 同一个 flow：拿到的是在途进度（不是新开的 form 步），且没有再次 POST 开流
    expect(second.flowId).toBe(first.flowId);
    expect(second.step.type).not.toBe("form");
    expect(starts()).toBe(1);
  });

  it("注册表条目全都没有 platform（注册表形状变了）：返回 null，不把「识别不出」当「未接入」", async () => {
    const model = await loadPluginModule<{
      buildEcosystemSummary: (registries: unknown) => unknown;
    }>("lib/entity-model.js");
    expect(
      model.buildEcosystemSummary({ entities: [{ entity_id: "light.a" }] }),
    ).toBeNull();
    expect(model.buildEcosystemSummary({})).toBeNull();
  });
});

describe("HA 插件：agent 工具", () => {
  it("未配置时 fail loud：报「去面板配置」，不假装成功", async () => {
    const { kernel } = await installFromRepo();
    await expect(
      runTool(kernel, "ha_entities", {}, INSTANCE_ID),
    ).rejects.toThrow(/尚未配置 Home Assistant/);
    await expect(
      runTool(
        kernel,
        "ha_control",
        { entityId: "light.a", key: "power", service: "turn_on" },
        INSTANCE_ID,
      ),
    ).rejects.toThrow(/尚未配置 Home Assistant/);
  });

  it("ha_entities：按域/区域/关键字过滤，超限如实标 truncated", async () => {
    installSocketHub({
      entities: [
        {
          entity_id: "light.bedroom",
          area_id: "living",
          name: null,
          original_name: "卧室灯",
        },
      ],
      areas: [{ area_id: "living", name: "客厅" }],
    });
    const { kernel, service, installed } = await installFromRepo();
    await configureConnected(service, installed.id);
    await waitRealtime(service, installed.id);
    const listed = await runTool<{
      mode: string;
      total: number;
      truncated: boolean;
      entities: Array<Record<string, unknown>>;
    }>(kernel, "ha_entities", { domain: "light" }, INSTANCE_ID);
    expect(listed.mode).toBe("realtime");
    expect(listed.total).toBe(3);
    expect(listed.entities.map((item) => item.entityId).sort()).toEqual([
      "light.bedroom",
      "light.dead",
      "light.kitchen",
    ]);
    expect(
      listed.entities.find((item) => item.entityId === "light.bedroom"),
    ).toMatchObject({ name: "卧室灯", area: "客厅", state: "on" });
    const byArea = await runTool<{ total: number }>(
      kernel,
      "ha_entities",
      { area: "客厅" },
      INSTANCE_ID,
    );
    expect(byArea.total).toBe(1);
    const limited = await runTool<{ entities: unknown[]; truncated: boolean }>(
      kernel,
      "ha_entities",
      { limit: 2 },
      INSTANCE_ID,
    );
    expect(limited.entities.length).toBe(2);
    expect(limited.truncated).toBe(true);
    const none = await runTool<{ entities: unknown[]; note?: string }>(
      kernel,
      "ha_entities",
      { query: "根本没有这台设备" },
      INSTANCE_ID,
    );
    expect(none.entities).toEqual([]);
    expect(none.note).toBe("HA 里没有匹配的实体。");
  });

  it("ha_control：下发后读回真值，未变化时如实说「已发出，状态未变」", async () => {
    const { kernel, service, installed, fake } = await installFromRepo();
    await configureConnected(service, installed.id);
    const written = await runTool<{
      ok: boolean;
      changed: boolean;
      state: string;
      message: string;
    }>(
      kernel,
      "ha_control",
      { entityId: "light.kitchen", key: "power", service: "turn_on" },
      INSTANCE_ID,
    );
    expect(written).toMatchObject({
      ok: true,
      changed: true,
      state: "on",
      message: "已生效",
    });
    expect(fake.states.get("light.kitchen")?.state).toBe("on");
    const again = await runTool<{ changed: boolean; message: string }>(
      kernel,
      "ha_control",
      { entityId: "light.kitchen", key: "power", service: "turn_on" },
      INSTANCE_ID,
    );
    expect(again).toMatchObject({
      changed: false,
      message: "已发出，状态未变",
    });
    await expect(
      runTool(
        kernel,
        "ha_control",
        {
          entityId: "light.kitchen",
          key: "temperature",
          service: "set_temperature",
          value: 22,
        },
        INSTANCE_ID,
      ),
    ).rejects.toThrow(/没有「temperature」控件/);
    await expect(
      runTool(
        kernel,
        "ha_control",
        {
          entityId: "sensor.temperature",
          key: "readout",
          service: "turn_on",
          value: 1,
        },
        INSTANCE_ID,
      ),
    ).rejects.toThrow(/没有「readout」控件/);
  });

  it("工具的效果声明：读工具 read、写工具 write（默认档审批靠它）", async () => {
    const { kernel } = await installFromRepo();
    expect(kernel.get("tools").require("ha_entities").access).toBe("read");
    expect(kernel.get("tools").require("ha_control").access).toBe("write");
  });

  it("调用者与执行作用域必须同实例：拿别人的 instanceId 直接拒", async () => {
    const { kernel } = await installFromRepo();
    const tool = kernel.get("tools").require("ha_entities");
    await expect(
      tool.execute(
        {},
        { actor: await fixtureActor(INSTANCE_ID), instanceId: INSTANCE_B },
      ),
    ).rejects.toThrow(/不属于同一本地实例/);
  });
});
