/**
 * 智能家居插件（Home Assistant）：把用户自建 HA 接进工作台——侧栏面板可看可控制，
 * agent 也能直接操作，配置跨服务端重启保留。
 *
 * 集成形态（《docs/插件/米家和HA插件规划.md》HA-1/HA-2）：**不碰任何厂商协议**，只对接
 * HA 的标准 REST（+ WebSocket）。米家靠 HA 的小米集成、华为靠 HA 的华为集成，HA 里装什么
 * 集成就覆盖什么生态，本插件与面板因此**不做厂商分支**。
 *
 * 能力面：`routes`（面板数据面）+ `ui`（侧栏入口）+ `storage`（HA 地址与长期令牌）。
 *
 * 与内核的约定：
 * - 路由**默认私有**：面板是同源 iframe，本机接入态由 HttpOnly 会话 cookie 携带（DEC-20），
 *   服务端解析出稳定实例；HA 令牌只存服务端，**永不经 HTTP 回显**；
 * - 实例由调用方显式传入（路由 `request.instanceId`、工具 `exec.instanceId`），
 *   插件存储按实例隔离——多用户自托管时各连各的 HA；
 * - 配置只落 `ctx.storage`（值在本机库明文保存，DEC-7 修订后的口径），卸载由 registry purge。
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

export const name = "kenfutwork-ha";

export const inject = ["routes", "ui", "storage"];

const CONFIG_KEY = "config";

/**
 * 错误码 → HTTP 状态。401 是「需要用户先动面板」的信号（面板据此回到配置态，
 * 与米家插件的 `not_connected` 同口径）；其余按语义给 404/400。
 */
const STATUS_BY_CODE = {
  unauthorized: 401,
  not_configured: 401,
  not_found: 404,
};

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

export function apply(ctx) {
  /** 配置内存副本（键=实例）：省掉每次面板请求的存储读取。 */
  const configs = new Map();

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

  /** 按实例配置建 REST 客户端；未配置时抛 `not_configured`。 */
  async function restFor(instanceId) {
    const config = await readConfig(instanceId);
    if (!config) {
      const error = new Error(
        "尚未配置 Home Assistant：请在本面板填入 HA 地址与长期访问令牌。",
      );
      error.code = "not_configured";
      throw error;
    }
    return createHaRest({ baseUrl: config.baseUrl, token: config.token });
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
        const rest = await restFor(instanceId);
        const info = await rest.getConfig();
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
        const rest = await restFor(instanceId);
        const states = await rest.getStates();
        const view = buildEntityView(Array.isArray(states) ? states : []);
        return {
          status: 200,
          body: {
            ...view,
            // 实时态由 WebSocket 决定（P3）；REST 轮询期如实标 polling
            mode: "polling",
            updatedAt: new Date().toISOString(),
          },
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
      const body = request.body ?? {};
      const entityId = typeof body.entityId === "string" ? body.entityId : "";
      if (!isValidEntityId(entityId)) {
        return {
          status: 400,
          body: {
            error: `实体 id 不合法（${entityId.slice(0, 60)}）。`,
            code: "bad_service",
          },
        };
      }
      try {
        const rest = await restFor(instanceId);
        const entity = await rest.getState(entityId);
        // 参数换算与量程复核都在 entity-model 里：面板只能点亮它看得见的控件
        const call = toServiceCall(entity, body.key, body.service, body.value);
        const before = controlValue(entity, body.key);
        await rest.callService(call.domain, call.service, call.data);
        // 读回真值：HA 会「服务调用成功但设备没动」，只报 200 是假成功
        const after = await rest.getState(entityId);
        const afterValue = controlValue(after, body.key);
        const changed = afterValue !== before;
        return {
          status: 200,
          body: {
            ok: true,
            entityId,
            state: String(after?.state ?? ""),
            before,
            after: afterValue,
            changed,
            message: changed ? "已生效" : "已发出，状态未变",
          },
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
}
