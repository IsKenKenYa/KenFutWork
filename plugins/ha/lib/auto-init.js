import { normalizeHaBaseUrl } from "./ha-rest.js";
import { createHaWsSession } from "./ha-ws.js";

export const HA_LOOPBACK_BASE_URL = "http://127.0.0.1:8123";
export const HA_AUTO_INIT_CLIENT_NAME = "KenFutWork";
/** bundle 独立分发，治理表不可 import；与 WS 命令超时时长同量级。 */
export const HA_AUTO_INIT_SESSION_TIMEOUT_MS = 10_000;
/** bundle 独立分发，治理表不可 import；自动签发的长期令牌有效期（天）。 */
export const HA_AUTO_INIT_TOKEN_LIFESPAN_DAYS = 3650;

function autoInitError(message, code, status = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function readPayload(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(options, pathname, init = {}) {
  const fetchImpl =
    options.fetchImpl ??
    ((input, requestInit) => globalThis.fetch(input, requestInit));
  let response;
  try {
    response = await fetchImpl(`${options.baseUrl}${pathname}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.form
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {}),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
      signal: AbortSignal.timeout(
        options.timeoutMs ?? HA_AUTO_INIT_SESSION_TIMEOUT_MS,
      ),
    });
  } catch {
    throw autoInitError(`HA 地址不可达（${options.baseUrl}）。`, "unreachable");
  }
  const payload = await readPayload(response);
  if (!response.ok) {
    throw autoInitError(
      `HA 自动初始化请求失败（${pathname}，HTTP ${response.status}）。`,
      response.status === 401 || response.status === 403
        ? "unauthorized"
        : "http_error",
      response.status,
    );
  }
  return payload;
}

/** 只读 onboarding 状态；调用方据此决定是否允许自动初始化。 */
export async function readHaOnboarding(options) {
  const baseUrl = normalizeHaBaseUrl(options.baseUrl);
  const payload = await request({ ...options, baseUrl }, "/api/onboarding");
  if (!Array.isArray(payload)) {
    throw autoInitError("HA onboarding 状态格式不正确。", "http_error");
  }
  return new Map(payload.map((entry) => [entry.step, entry.done === true]));
}

async function exchangeAccessToken(options, authCode = null) {
  const clientId = `${options.baseUrl}/`;
  const form = authCode
    ? {
        grant_type: "authorization_code",
        code: authCode,
        client_id: clientId,
      }
    : {
        grant_type: "password",
        username: options.username,
        password: options.password,
        client_id: clientId,
      };
  const payload = await request(options, "/auth/token", {
    method: "POST",
    form,
  });
  if (typeof payload?.access_token !== "string" || !payload.access_token) {
    throw autoInitError("HA 未返回访问令牌。", "http_error");
  }
  return payload.access_token;
}

/**
 * 完成一台已进入 onboarding 的 HA，并返回插件可直接保存的连接配置。
 * 已建用户时用持久密码恢复；同名长期令牌先删后建，覆盖响应丢失的重放。
 */
export async function initializeHomeAssistant(options) {
  const baseUrl = normalizeHaBaseUrl(options.baseUrl);
  const scoped = { ...options, baseUrl };
  const steps = await readHaOnboarding(scoped);
  let accessToken;
  if (steps.get("user") === true) {
    accessToken = await exchangeAccessToken(scoped);
  } else {
    let authCode;
    try {
      const created = await request(scoped, "/api/onboarding/users", {
        method: "POST",
        body: {
          name: options.displayName ?? "KenFutWork",
          username: options.username,
          password: options.password,
          client_id: `${baseUrl}/`,
          language: "zh-CN",
        },
      });
      authCode = created?.auth_code;
    } catch (error) {
      // 另一并发客户端可能已抢先建完所有者：用同一份持久密码继续，而非再建一次。
      if (error?.status !== 403) throw error;
    }
    accessToken = await exchangeAccessToken(scoped, authCode);
  }

  for (const [step, pathname] of [
    ["core_config", "/api/onboarding/core_config"],
    ["analytics", "/api/onboarding/analytics"],
  ]) {
    if (steps.get(step) !== true) {
      await request(scoped, pathname, {
        method: "POST",
        token: accessToken,
      });
    }
  }
  if (steps.get("integration") !== true) {
    await request(scoped, "/api/onboarding/integration", {
      method: "POST",
      token: accessToken,
      body: {
        client_id: `${baseUrl}/`,
        redirect_uri: `${baseUrl}/?auth_callback=1`,
      },
    });
  }

  let session;
  let timer;
  try {
    let ready;
    let fail;
    const readiness = new Promise((resolve, reject) => {
      ready = resolve;
      fail = reject;
    });
    session = (options.createSession ?? createHaWsSession)({
      baseUrl,
      token: accessToken,
      onReady: () => ready(),
      onPhaseChange: (event) => {
        if (event.phase === "failed")
          fail(new Error(event.reason ?? "HA 认证失败"));
      },
    });
    session.start();
    await Promise.race([
      readiness,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(autoInitError("HA WebSocket 初始化超时。", "timeout")),
          options.timeoutMs ?? HA_AUTO_INIT_SESSION_TIMEOUT_MS,
        );
      }),
    ]);

    const existing = await session.request("auth/refresh_tokens");
    for (const token of Array.isArray(existing) ? existing : []) {
      if (token.client_name === HA_AUTO_INIT_CLIENT_NAME && !token.is_current) {
        await session.request("auth/delete_refresh_token", {
          refresh_token_id: token.id,
        });
      }
    }
    const token = await session.request("auth/long_lived_access_token", {
      client_name: HA_AUTO_INIT_CLIENT_NAME,
      lifespan: HA_AUTO_INIT_TOKEN_LIFESPAN_DAYS,
    });
    if (typeof token !== "string" || !token) {
      throw autoInitError("HA 未返回长期访问令牌。", "http_error");
    }
    return { baseUrl, token };
  } finally {
    if (timer) clearTimeout(timer);
    session?.stop();
  }
}
