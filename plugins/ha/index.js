/**
 * 智能家居插件（Home Assistant）：把用户自建 HA 接进工作台——侧栏面板可看可控制，
 * agent 也能直接操作，配置跨服务端重启保留。
 *
 * 集成形态（《docs/插件/米家和HA插件规划.md》HA-1/HA-2）：**不碰任何厂商协议**，只对接
 * HA 的标准 REST + WebSocket。米家靠 HA 的小米集成、华为靠 HA 的华为集成，HA 里装什么
 * 集成就覆盖什么生态，本插件与面板因此**不做厂商分支**。
 *
 * 能力面：`tools`（agent 工具）+ `routes`（面板数据面）+ `ui`（侧栏入口）
 * + `storage`（HA 地址与长期令牌）。
 *
 * 与内核的约定：
 * - 路由**默认私有**：面板是同源 iframe，本机接入态由 HttpOnly 会话 cookie 携带（DEC-20），
 *   服务端解析出稳定实例；HA 令牌只存服务端，**永不经 HTTP 回显**；
 * - 实例由调用方显式传入（路由 `request.instanceId`、工具 `exec.instanceId`），
 *   插件存储按实例隔离——多用户自托管时各连各的 HA；
 * - 配置只落 `ctx.storage`（值在本机库明文保存，DEC-7 修订后的口径），卸载由 registry purge；
 * - 每实例一条 WS 会话（`state_changed` 增量 + 注册表补齐名称/区域），连不上就退回
 *   REST 轮询并在面板**如实标注**，不假装实时。
 */

import {
  buildEntityView,
  controlValue,
  toServiceCall,
} from "./lib/entity-model.js";
import {
  createHaRest,
  HA_DEFAULT_BASE_URL,
  isValidEntityId,
  normalizeHaBaseUrl,
} from "./lib/ha-rest.js";
import {
  createHaWsSession,
  WS_AREA_REGISTRY_LIST,
  WS_DEVICE_REGISTRY_LIST,
  WS_ENTITY_REGISTRY_LIST,
} from "./lib/ha-ws.js";

export const name = "kenfutwork-ha";

export const inject = ["tools", "routes", "ui", "storage"];

const CONFIG_KEY = "config";
/**
 * `ha_entities` 单次返回条数上限（治理数值属主是 `packages/shared/src/governance.ts`，
 * 插件 bundle 独立于 workspace、不能 import 它，故在此命名并注释）。
 */
const TOOL_ENTITY_LIMIT = 60;

/**
 * 错误码 → HTTP 状态。401 是「需要用户先动面板」的信号（面板据此回到配置态，
 * 与米家插件的 `not_connected` 同口径）；其余按语义给 404/400。
 */
const STATUS_BY_CODE = {
  unauthorized: 401,
  not_configured: 401,
  not_found: 404,
};

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function errorResult(error) {
  const code = typeof error?.code === "string" ? error.code : "http_error";
  return {
    status: STATUS_BY_CODE[code] ?? 400,
    body: {
      error: error instanceof Error ? error.message : String(error),
      code,
    },
  };
}

function notConfiguredError() {
  return codedError(
    "尚未配置 Home Assistant：请在工作台侧栏打开「智能家居」面板，填入 HA 地址与长期访问令牌（HA「个人资料 → 安全」创建）。",
    "not_configured",
  );
}

export function apply(ctx) {
  /** 配置内存副本（键=实例）：省掉每次面板请求的存储读取。 */
  const configs = new Map();
  /** 实例运行态（键=实例）：WS 会话 + 实体快照 + 注册表。首次用到时才建。 */
  const runtimes = new Map();

  ctx.effect(() => () => {
    for (const runtime of runtimes.values()) runtime.stop();
    runtimes.clear();
  });

  function requireInstance(instanceId, where) {
    if (typeof instanceId !== "string" || instanceId.trim() === "") {
      throw new Error(
        `${where}缺少实例上下文（路由需本机接入上下文、工具需 agent 运行上下文）——插件存储按实例隔离，不能凭空取一个。`,
      );
    }
    return instanceId;
  }

  async function readConfig(instanceId) {
    const cached = configs.get(instanceId);
    if (cached) return cached;
    const raw = await ctx.storage.get(instanceId, CONFIG_KEY);
    if (!raw) return null;
    let config;
    try {
      config = JSON.parse(raw);
    } catch {
      // 存的不是合法 JSON（手改库/旧版本残留）：按未配置处理并清掉，不让面板卡在 500
      await ctx.storage.remove(instanceId, CONFIG_KEY);
      return null;
    }
    if (
      typeof config?.baseUrl !== "string" ||
      typeof config?.token !== "string"
    ) {
      await ctx.storage.remove(instanceId, CONFIG_KEY);
      return null;
    }
    configs.set(instanceId, config);
    return config;
  }

  async function writeConfig(instanceId, config) {
    configs.set(instanceId, config);
    await ctx.storage.set(
      instanceId,
      CONFIG_KEY,
      JSON.stringify({ ...config, savedAt: new Date().toISOString() }),
    );
  }

  async function clearConfig(instanceId) {
    configs.delete(instanceId);
    await ctx.storage.remove(instanceId, CONFIG_KEY);
  }

  /** 注册表三条命令：任一失败就退回「按域分组」，不摆半套假数据。 */
  async function loadRegistries(session) {
    const [entities, areas, devices] = await Promise.all([
      session.request(WS_ENTITY_REGISTRY_LIST).catch(() => null),
      session.request(WS_AREA_REGISTRY_LIST).catch(() => null),
      session.request(WS_DEVICE_REGISTRY_LIST).catch(() => null),
    ]);
    return {
      entities: Array.isArray(entities) ? entities : [],
      areas: Array.isArray(areas) ? areas : [],
      devices: Array.isArray(devices) ? devices : [],
    };
  }

  function createRuntime(config) {
    const rest = createHaRest(config);
    /** 实体快照：REST 播种，之后由 `state_changed` 增量维护。 */
    const snapshot = new Map();
    let registries = {};
    let seeded = false;

    const session = createHaWsSession({
      baseUrl: config.baseUrl,
      token: config.token,
      logger: ctx.logger,
      onStateChange: (entityId, newState) => {
        if (!newState) snapshot.delete(entityId);
        else snapshot.set(entityId, newState);
      },
      onReady: async () => {
        // 每次认证成功都全量重播：断线期间漏掉的事件无法靠增量补齐
        const states = await rest.getStates();
        snapshot.clear();
        for (const entity of Array.isArray(states) ? states : []) {
          snapshot.set(entity.entity_id, entity);
        }
        registries = await loadRegistries(session);
        // 播种与注册表都齐了才认「实时」：否则面板会先闪一版「按域分组」再跳到「按区域」
        seeded = true;
      },
    });
    session.start();

    return {
      rest,
      stop() {
        session.stop();
      },
      realtime: () => seeded && session.phase === "ready",
      states: () => [...snapshot.values()],
      registries: () => registries,
      /** 控制读回后补进快照：面板下一轮看到的与真值一致，不等 HA 推事件。 */
      seedEntity(entity) {
        if (entity && typeof entity.entity_id === "string") {
          snapshot.set(entity.entity_id, entity);
        }
      },
    };
  }

  async function runtimeFor(instanceId) {
    const existing = runtimes.get(instanceId);
    if (existing) return existing;
    const config = await readConfig(instanceId);
    if (!config) throw notConfiguredError();
    const runtime = createRuntime(config);
    runtimes.set(instanceId, runtime);
    return runtime;
  }

  /** 配置变了或断开：旧会话与旧快照一起丢掉，下次用到时按新配置重建。 */
  function dropRuntime(instanceId) {
    const runtime = runtimes.get(instanceId);
    if (!runtime) return;
    runtime.stop();
    runtimes.delete(instanceId);
  }

  /** 面板与工具共用的一条读路径：WS 就绪走快照，否则走 REST（如实标 mode）。 */
  async function loadView(instanceId) {
    const runtime = await runtimeFor(instanceId);
    if (runtime.realtime()) {
      return {
        ...buildEntityView(runtime.states(), runtime.registries()),
        mode: "realtime",
      };
    }
    const states = await runtime.rest.getStates();
    return {
      ...buildEntityView(Array.isArray(states) ? states : []),
      mode: "polling",
    };
  }

  /** 面板与工具共用的一条控制路径：校验 → 下发 → 读回真值。 */
  async function runControl(instanceId, input) {
    const entityId = typeof input?.entityId === "string" ? input.entityId : "";
    if (!isValidEntityId(entityId)) {
      throw codedError(
        `实体 id 不合法（${entityId.slice(0, 60)}）。`,
        "bad_service",
      );
    }
    const runtime = await runtimeFor(instanceId);
    const entity = await runtime.rest.getState(entityId);
    // 参数换算与量程复核都在 entity-model：调用方只能改它看得见的控件
    const call = toServiceCall(
      entity,
      input?.key,
      input?.service,
      input?.value,
    );
    const before = controlValue(entity, input?.key);
    await runtime.rest.callService(call.domain, call.service, call.data);
    // 读回真值：HA 会「服务调用成功但设备没动」，只报 200 是假成功
    const after = await runtime.rest.getState(entityId);
    const afterValue = controlValue(after, input?.key);
    const changed = afterValue !== before;
    // 快照同步：设备真没动时 HA 不再推事件，读回值就是这一轮的真相
    runtime.seedEntity(after);
    return {
      ok: true,
      entityId,
      state: String(after?.state ?? ""),
      before,
      after: afterValue,
      changed,
      message: changed ? "已生效" : "已发出，状态未变",
    };
  }

  // === 路由（私有：面板用本机会话 cookie，实例由服务端解析）===

  ctx.routes.register({
    path: "config",
    handler: async (request) => {
      const instanceId = requireInstance(request.instanceId, "读取配置");
      const config = await readConfig(instanceId);
      return {
        status: 200,
        body: {
          configured: Boolean(config),
          // 令牌绝不出 HTTP；地址不是秘密（面板要能改）
          baseUrl: config?.baseUrl ?? null,
          defaultBaseUrl: HA_DEFAULT_BASE_URL,
          savedAt: config?.savedAt ?? null,
        },
      };
    },
  });

  ctx.routes.register({
    path: "config",
    method: "POST",
    handler: async (request) => {
      const instanceId = requireInstance(request.instanceId, "保存配置");
      const body = request.body ?? {};
      try {
        const baseUrl = normalizeHaBaseUrl(body.baseUrl);
        const previous = await readConfig(instanceId);
        const submitted =
          typeof body.token === "string" ? body.token.trim() : "";
        // 「修改配置」时令牌栏留空 = 沿用已存的那份，不必重新粘一遍
        const token = submitted || previous?.token || "";
        if (!token) {
          return {
            status: 400,
            body: { error: "请填写长期访问令牌。", code: "bad_url" },
          };
        }
        const next = { baseUrl, token };
        const rest = createHaRest(next);
        // 连得上才落库：存一个连不上的配置只会让用户以为已经好了
        await rest.ping();
        const info = await rest.getConfig();
        await writeConfig(instanceId, next);
        dropRuntime(instanceId);
        return {
          status: 200,
          body: {
            ok: true,
            version: info?.version ?? null,
            locationName: info?.location_name ?? null,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  ctx.routes.register({
    path: "test",
    method: "POST",
    handler: async (request) => {
      const instanceId = requireInstance(request.instanceId, "连接测试");
      try {
        const config = await readConfig(instanceId);
        if (!config) throw notConfiguredError();
        const info = await createHaRest(config).getConfig();
        return {
          status: 200,
          body: {
            ok: true,
            version: info?.version ?? null,
            locationName: info?.location_name ?? null,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  ctx.routes.register({
    path: "entities",
    handler: async (request) => {
      const instanceId = requireInstance(request.instanceId, "列实体");
      try {
        const view = await loadView(instanceId);
        return {
          status: 200,
          body: { ...view, updatedAt: new Date().toISOString() },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  ctx.routes.register({
    path: "control",
    method: "POST",
    handler: async (request) => {
      const instanceId = requireInstance(request.instanceId, "控制实体");
      try {
        return {
          status: 200,
          body: await runControl(instanceId, request.body),
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  ctx.routes.register({
    path: "disconnect",
    method: "POST",
    handler: async (request) => {
      const instanceId = requireInstance(request.instanceId, "清除配置");
      dropRuntime(instanceId);
      await clearConfig(instanceId);
      return { status: 200, body: { ok: true } };
    },
  });

  // === UI：侧栏入口（面板页由本插件自带，见 assets/panel.html）===
  ctx.ui.register({
    id: "ha",
    title: "智能家居",
    slot: "sidebar",
    url: "assets/panel.html",
    icon: "assets/icon.svg",
  });

  // === agent 工具：与面板共用同一条读/控制路径（同一份快照与量程口径）===

  ctx.tools.register({
    name: "ha_entities",
    // 只读：默认档不审批（声明 read 的插件工具不进危险判据）。
    access: "read",
    description:
      "列出 Home Assistant 的实体：名称、区域、状态、读数，以及每台设备能用的控件（key、服务名、量程）。控制前先用本工具确认 entityId 与控件。",
    parameters: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "按域过滤，如 light / switch / climate",
        },
        area: { type: "string", description: "区域名包含匹配，如「客厅」" },
        query: { type: "string", description: "名称或 entityId 的关键字" },
        limit: {
          type: "number",
          description: `最多返回多少条，默认 ${TOOL_ENTITY_LIMIT}`,
        },
      },
    },
    execute: async (args, exec) => {
      const instanceId = requireInstance(exec?.instanceId, "工具调用");
      const view = await loadView(instanceId);
      const query = String(args?.query ?? "")
        .trim()
        .toLowerCase();
      const area = String(args?.area ?? "").trim();
      const domain = String(args?.domain ?? "").trim();
      const matched = [];
      for (const group of view.groups) {
        for (const item of group.items) {
          if (domain && item.domain !== domain) continue;
          if (area && !item.area.includes(area)) continue;
          if (
            query &&
            !`${item.name} ${item.entityId}`.toLowerCase().includes(query)
          ) {
            continue;
          }
          matched.push({
            entityId: item.entityId,
            name: item.name,
            area: item.area,
            state: item.state,
            unavailable: item.unavailable,
            controls: item.controls.map((node) => ({
              key: node.key,
              label: node.label,
              kind: node.kind,
              ...(node.service ? { service: node.service } : {}),
              ...(node.onService ? { onService: node.onService } : {}),
              ...(node.offService ? { offService: node.offService } : {}),
              ...(node.value !== undefined ? { value: node.value } : {}),
              ...(node.unit ? { unit: node.unit } : {}),
              ...(node.min !== undefined
                ? { min: node.min, max: node.max }
                : {}),
              ...(node.options ? { options: node.options } : {}),
              ...(node.buttons
                ? { buttons: node.buttons.map((each) => each.label) }
                : {}),
            })),
          });
        }
      }
      const limit =
        Number(args?.limit) > 0
          ? Math.min(Number(args.limit), TOOL_ENTITY_LIMIT)
          : TOOL_ENTITY_LIMIT;
      return {
        mode: view.mode,
        total: matched.length,
        entities: matched.slice(0, limit),
        truncated: matched.length > limit,
        ...(matched.length === 0 ? { note: "HA 里没有匹配的实体。" } : {}),
      };
    },
  });

  ctx.tools.register({
    name: "ha_control",
    // 写设备状态：进默认档审批（名表不认识插件工具名，靠这条声明）。
    access: "write",
    description:
      "调用 Home Assistant 服务控制一个实体。先用 ha_entities 拿 entityId 与控件的 key/service（滑杆与下拉另需 value，量程见控件）；返回里带读回的真值，能看出设备到底动没动。",
    parameters: {
      type: "object",
      properties: {
        entityId: {
          type: "string",
          description: "ha_entities 返回的 entityId，如 light.bedroom",
        },
        key: {
          type: "string",
          description:
            "控件标识：power / brightness / position / temperature / hvac_mode / open / close / stop …",
        },
        service: {
          type: "string",
          description:
            "控件声明的服务名，如 turn_on / turn_off / set_cover_position",
        },
        value: {
          description:
            "滑杆与下拉的目标值（亮度、位置、风量按百分比；音量按百分比，内部换算成 0~1；模式用控件 options 里的取值）",
        },
      },
      required: ["entityId", "key", "service"],
    },
    execute: async (args, exec) => {
      const instanceId = requireInstance(exec?.instanceId, "工具调用");
      return runControl(instanceId, args);
    },
  });
}
