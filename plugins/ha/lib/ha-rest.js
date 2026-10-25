/**
 * Home Assistant REST 原语（零依赖，只用全局 `fetch`）。
 *
 * 事实来源：HA REST API 文档 <https://developers.home-assistant.io/docs/api/rest/>
 * ——`GET /api/` 探活、`GET /api/config` 取版本、`GET /api/states` 全量实体、
 * `POST /api/services/<domain>/<service>` 调服务；鉴权统一 `Authorization: Bearer <长期令牌>`。
 *
 * 为什么手写而不引库：插件 bundle 安装期不跑包管理器、不能带 npm 依赖
 * （`apps/server/src/features/plugins/bundle-source.ts` 的文本白名单），
 * 而 REST 与 WS 都是平台内建能力（fetch + Node 22 全局 WebSocket）。
 */

/** 面板「连接测试」与错误提示里给的默认地址（HA 官方 mDNS 主机名）。 */
export const HA_DEFAULT_BASE_URL = "http://homeassistant.local:8123";

/**
 * 单次请求超时。治理数值（DEC-18）的属主是 `packages/shared/src/governance.ts`，
 * 但插件 bundle 独立于 workspace、不能 import 它，故在本文件内命名并注释。
 */
export const HA_REQUEST_TIMEOUT_MS = 8000;

/** 错误消息里带出的 HA 原话最大长度（HA 的 400 体会把整个 schema 打印出来）。 */
const HA_MESSAGE_MAX_CHARS = 200;

/** HA 实体 id：`<domain>.<object_id>`；服务名只允许小写字母/数字/下划线。 */
const ENTITY_ID_PATTERN = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const SERVICE_NAME_PATTERN = /^[a-z0-9_]+$/;

/**
 * 统一错误：`code` 是给面板与工具分支用的稳定标识，`message` 是直接给用户看的一句话
 * （说清「哪里不对、去哪改」）。
 */
export class HaError extends Error {
  /**
   * @param {string} message 面向用户的中文说明
   * @param {string} code 稳定标识：bad_url / unauthorized / not_found / bad_service /
   *   unreachable / timeout / server_error / http_error
   * @param {number | null} status HTTP 状态（网络层失败为 null）
   */
  constructor(message, code, status = null) {
    super(message);
    this.name = "HaError";
    this.code = code;
    this.status = status;
  }
}

export function isValidEntityId(value) {
  return typeof value === "string" && ENTITY_ID_PATTERN.test(value);
}

export function isValidServiceName(value) {
  return typeof value === "string" && SERVICE_NAME_PATTERN.test(value);
}

function badUrlError(input) {
  return new HaError(
    `HA 地址不合法（${String(input).slice(0, 60)}）：形如 http://192.168.1.20:8123。`,
    "bad_url",
  );
}

/**
 * 地址归一：补协议、去尾斜杠、剥掉用户常粘的 `/api…` 尾巴。
 *
 * 只接受 http/https（HA 的 REST 面就这两种；`ws://` 由 `lib/ha-ws.js` 自己换算），
 * 并拒绝 URL 里内嵌用户名/密码——那会把令牌泄进地址字符串并被日志带走。
 *
 * @param {string} input 用户填的地址
 * @returns {string} 不含尾斜杠的根地址（可带 ingress 子路径前缀）
 */
export function normalizeHaBaseUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return HA_DEFAULT_BASE_URL;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw badUrlError(raw);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badUrlError(raw);
  }
  if (url.username || url.password) {
    throw new HaError(
      "HA 地址不能带用户名或密码：长期访问令牌请填在「令牌」一栏。",
      "bad_url",
    );
  }
  if (!url.host) throw badUrlError(raw);
  // 粘成 `http://ha.local:8123/api/states` 是最常见误填：把 API 尾巴剥掉而不是报错
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/api(\/.*)?$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function clipMessage(text) {
  const oneLine = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length > HA_MESSAGE_MAX_CHARS
    ? `${oneLine.slice(0, HA_MESSAGE_MAX_CHARS)}…`
    : oneLine;
}

/** 把 HA 的错误体（`{message}` / `{error}` / 纯字符串）压成一句人话。 */
function readErrorMessage(payload, fallback) {
  if (typeof payload === "string") return clipMessage(payload) || fallback;
  const record = payload && typeof payload === "object" ? payload : null;
  const text = record ? (record.message ?? record.error ?? "") : "";
  if (typeof text === "string" && text.trim()) {
    // HA 的 400 常是「Failing because: …」这种英文整句，原样带出比编一句中文更准
    return clipMessage(text);
  }
  return fallback;
}

/** HTTP 错误 → 面向用户的一句话（401 是令牌问题，其余带上地址便于辨认是哪台 HA）。 */
export function mapHttpError(status, payload, baseUrl) {
  const fallback = `HA（${baseUrl}）返回 HTTP ${status}。`;
  if (status === 401 || status === 403) {
    return new HaError(
      "Home Assistant 拒绝了这次令牌：请在 HA「个人资料 → 安全」确认长期访问令牌是否仍然有效。",
      "unauthorized",
      status,
    );
  }
  if (status === 404) {
    return new HaError(
      readErrorMessage(
        payload,
        "HA 里找不到这个对象：实体可能已被删除或改名。",
      ),
      "not_found",
      status,
    );
  }
  if (status === 400) {
    return new HaError(
      readErrorMessage(payload, "服务调用参数不对。"),
      "bad_service",
      status,
    );
  }
  if (status >= 500) {
    return new HaError(
      readErrorMessage(payload, "Home Assistant 内部错误，稍后重试。"),
      "server_error",
      status,
    );
  }
  return new HaError(readErrorMessage(payload, fallback), "http_error", status);
}

/**
 * 建一个 HA REST 客户端。
 *
 * @param {object} options
 * @param {string} options.baseUrl 已归一的根地址
 * @param {string} options.token HA 长期访问令牌
 * @param {(input: string | URL, init?: RequestInit) => Promise<Response>} [options.fetchImpl]
 *   可注入的 fetch（测试用假 HA；缺省取全局，避免在模块加载期就把实现钉死）
 * @param {number} [options.timeoutMs]
 */
export function createHaRest(options) {
  const baseUrl = String(options?.baseUrl ?? "").replace(/\/+$/, "");
  const token = String(options?.token ?? "");
  const callFetch = options?.fetchImpl;
  const timeoutMs = Number(options?.timeoutMs) || HA_REQUEST_TIMEOUT_MS;

  if (!baseUrl) {
    throw new HaError("缺少 HA 地址：请在面板里先完成配置。", "not_configured");
  }
  if (!token) {
    throw new HaError(
      "缺少 HA 令牌：请在面板「令牌」一栏填入长期访问令牌。",
      "not_configured",
    );
  }

  /**
   * @param {string} pathname `/api` 之后的路径，如 `/states/light.bedroom`
   * @param {object} [init] `{ method, query, body }`
   */
  async function api(pathname, init = {}) {
    const url = new URL(`${baseUrl}/api${pathname}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const headers = { authorization: `Bearer ${token}` };
    let body;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    let response;
    try {
      const fetchImpl =
        callFetch ??
        ((input, requestInit) => globalThis.fetch(input, requestInit));
      response = await fetchImpl(url, {
        method: init.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new HaError(
          `HA 没有在 ${Math.round(timeoutMs / 1000)} 秒内应答（${baseUrl}）。`,
          "timeout",
        );
      }
      throw new HaError(
        `HA 地址不可达（${baseUrl}）：确认 HA 正在运行，且服务端能访问该地址。`,
        "unreachable",
      );
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) throw mapHttpError(response.status, payload, baseUrl);
    return payload;
  }

  return {
    baseUrl,
    /** `GET /api/`：探活（HA 回 `{"message":"API running."}`）。 */
    ping: () => api("/"),
    /** `GET /api/config`：版本、单位、区域等。 */
    getConfig: () => api("/config"),
    /** `GET /api/states`：全量实体状态。 */
    getStates: () => api("/states"),
    /** 单实体读值（控制后的读回校验用）。 */
    getState: (entityId) => {
      if (!isValidEntityId(entityId)) {
        throw new HaError(
          `实体 id 不合法（${String(entityId).slice(0, 60)}）。`,
          "bad_service",
        );
      }
      return api(`/states/${encodeURIComponent(entityId)}`);
    },
    /** `POST /api/services/<domain>/<service>`。 */
    callService: (domain, service, data, extra = {}) => {
      if (!isValidServiceName(domain) || !isValidServiceName(service)) {
        throw new HaError(
          `服务名不合法（${String(domain)}.${String(service)}）：只允许小写字母、数字与下划线。`,
          "bad_service",
        );
      }
      return api(`/services/${domain}/${service}`, {
        method: "POST",
        ...(extra.returnResponse ? { query: { return_response: "true" } } : {}),
        body: data ?? {},
      });
    },
    /**
     * `POST /api/config/config_entries/flow`：开一个集成配置流（面板「添加集成」用）。
     * handler 是集成的 domain（如 xiaomi_home）；集成未安装时 HA 回 404。
     */
    startFlow: (handler) => {
      if (!isValidServiceName(handler)) {
        throw new HaError(
          `集成标识不合法（${String(handler).slice(0, 60)}）。`,
          "bad_service",
        );
      }
      return api("/config/config_entries/flow", {
        method: "POST",
        body: { handler },
      });
    },
    /** 流程/实体 id 的形状（HA 的 flow_id 与 entry_id 都是短横线/字母数字串）。 */
    isValidObjectId: (value) =>
      typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value),
    /** `GET /api/config/config_entries/flow/<flow_id>`：流程进度（external 步轮询用）。 */
    getFlow: (flowId) => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(flowId))) {
        throw new HaError(
          `流程 id 不合法（${String(flowId).slice(0, 40)}）。`,
          "bad_service",
        );
      }
      return api(`/config/config_entries/flow/${encodeURIComponent(flowId)}`);
    },
    /** `POST /api/config/config_entries/flow/<flow_id>`：提交当前步骤的字段。 */
    submitFlow: (flowId, fields) => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(flowId))) {
        throw new HaError(
          `流程 id 不合法（${String(flowId).slice(0, 40)}）。`,
          "bad_service",
        );
      }
      return api(`/config/config_entries/flow/${encodeURIComponent(flowId)}`, {
        method: "POST",
        body: fields ?? {},
      });
    },
    /**
     * `DELETE /api/config/config_entries/<entry_id>`：卸载一个集成实例（HA 源码
     * `ConfigManagerEntryResourceView.delete`；组件文件不动，只删配置条目）。
     */
    deleteEntry: (entryId) => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(entryId))) {
        throw new HaError(
          `集成条目 id 不合法（${String(entryId).slice(0, 40)}）。`,
          "bad_service",
        );
      }
      return api(
        `/config/config_entries/${encodeURIComponent(entryId)}`,
        { method: "DELETE" },
      );
    },
  };
}
