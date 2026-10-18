/**
 * Home Assistant WebSocket 客户端（零依赖，用 Node 22 的全局 `WebSocket`）。
 *
 * 协议事实（HA `docs/api/websocket.md` 与 core 源码，2026-10-18 逐条核过）：
 * - 端点 `<base>/api/websocket`；连上后服务端先回 `auth_required`，客户端发
 *   `{type:"auth", access_token}`，成功 `auth_ok`、失败 `auth_invalid` 并关闭；
 * - `subscribe_events`（`state_changed`）后服务端持续推 `{type:"event", event:{...}}`；
 * - 注册表命令 `config/entity_registry/list`、`config/area_registry/list`、
 *   `config/device_registry/list` 的 `result` 都是**裸数组**；实体条目直接带
 *   `area_id` 与 `device_id`（区域可由设备继承），所以名称/区域补齐只走 WS，REST 面没有。
 *
 * 退避重连的初值/上限/抖动是插件内命名常量：治理数值属主 `packages/shared/src/governance.ts`
 * 属于 workspace 包，bundle 独立分发、不能 import 它（规划 §4.4）。
 */

/** 首次重连等待，之后按 2 倍递增。 */
export const WS_BACKOFF_INITIAL_MS = 1000;
/** 退避上限：断久了也只是每 30 秒试一次，不打扰 HA。 */
export const WS_BACKOFF_MAX_MS = 30_000;
/** 退避抖动比例（±20%）：多实例同时重启时不齐步。 */
export const WS_BACKOFF_JITTER_RATIO = 0.2;
/** 单条命令等待 `result` 的上限。 */
export const WS_COMMAND_TIMEOUT_MS = 10_000;

export const WS_ENTITY_REGISTRY_LIST = "config/entity_registry/list";
export const WS_AREA_REGISTRY_LIST = "config/area_registry/list";
export const WS_DEVICE_REGISTRY_LIST = "config/device_registry/list";

/** http→ws、https→wss；保留 ingress 子路径前缀。 */
export function haWebSocketUrl(baseUrl) {
  const url = new URL(String(baseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/websocket`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** 下一跳等待：指数退避 + 抖动（`random` 可注入以便测试稳定断言）。 */
export function nextBackoffMs(attempt, random = Math.random) {
  const base = Math.min(
    WS_BACKOFF_INITIAL_MS * 2 ** Math.max(0, attempt - 1),
    WS_BACKOFF_MAX_MS,
  );
  const jitter = base * WS_BACKOFF_JITTER_RATIO * (random() * 2 - 1);
  return Math.max(100, Math.round(base + jitter));
}

export class HaWsError extends Error {
  constructor(message, code = "ws_error") {
    super(message);
    this.name = "HaWsError";
    this.code = code;
  }
}

/**
 * 建一条 HA WebSocket 会话。
 *
 * 生命周期：`start()` → （auth → `onReady` → 推事件）→ 断线退避重连；
 * `stop()` 幂等，收掉 socket 与定时器（插件卸载时由 `ctx.effect` 的 disposer 调用）。
 *
 * 令牌被判 `auth_invalid` 时**停止重试**：那是凭据问题，重试只会 repeatedly 撞 HA 的
 * 认证失败日志；改配置（`restart()`）才重新起。
 *
 * @param {object} options
 * @param {string} options.baseUrl HA 根地址（http/https）
 * @param {string} options.token 长期访问令牌
 * @param {(entityId: string, newState: object | null) => void} [options.onStateChange]
 * @param {() => void | Promise<void>} [options.onReady] 每次认证成功都会调用（用来补注册表）
 * @param {(event: {phase: string, reason?: string}) => void} [options.onPhaseChange]
 * @param {(url: string) => object} [options.connector] 覆盖 `new WebSocket(url)`（测试用）
 * @param {{warn?: (m: unknown, ...r: unknown[]) => void}} [options.logger]
 * @param {() => number} [options.random]
 */
export function createHaWsSession(options) {
  const url = haWebSocketUrl(options.baseUrl);
  const token = String(options.token ?? "");
  if (!token) throw new HaWsError("缺少 HA 令牌。", "not_configured");
  const logger = options.logger ?? console;
  const random = options.random ?? Math.random;
  const connect =
    options.connector ?? ((target) => new globalThis.WebSocket(target));

  let socket = null;
  let timer = null;
  let stopped = false;
  let attempt = 0;
  let nextId = 1;
  let phase = "idle";
  const pending = new Map();

  function setPhase(next, extra = {}) {
    phase = next;
    if (options.onPhaseChange) options.onPhaseChange({ phase: next, ...extra });
  }

  function send(payload) {
    if (socket?.readyState !== 1) {
      throw new HaWsError(
        "Home Assistant 的 WebSocket 还没连上。",
        "ws_closed",
      );
    }
    socket.send(JSON.stringify(payload));
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function closeSocket() {
    if (!socket) return;
    const dying = socket;
    socket = null;
    dying.onopen = null;
    dying.onmessage = null;
    dying.onerror = null;
    dying.onclose = null;
    try {
      dying.close();
    } catch {
      // 已经关了：无所谓，重连状态机继续走
    }
  }

  function scheduleReconnect(reason) {
    if (stopped || phase === "failed") return;
    attempt += 1;
    const wait = nextBackoffMs(attempt, random);
    setPhase("retrying", { reason, wait });
    clearTimer();
    timer = setTimeout(open, wait);
    // 定时器不该拖住进程退出（插件卸载后如果没有 stop() 也要能收）
    if (typeof timer?.unref === "function") timer.unref();
  }

  function handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : (raw?.data ?? ""));
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "auth_required":
        // 先落状态再发凭据：`send` 可能同步把 auth_ok/auth_invalid 送回来（假 socket 就是这么写的），
        // 顺序反了会用「authenticating」覆盖掉内层已经置好的 ready/failed
        setPhase("authenticating");
        send({ type: "auth", access_token: token });
        break;
      case "auth_ok":
        attempt = 0;
        setPhase("ready");
        send({
          id: nextId++,
          type: "subscribe_events",
          event_type: "state_changed",
        });
        if (options.onReady) {
          // 回调里可能再发命令（补注册表），异常不能把会话状态机带崩
          Promise.resolve()
            .then(() => options.onReady?.())
            .catch((error) =>
              logger.warn("HA WebSocket 就绪后的补数失败：", error),
            );
        }
        break;
      case "auth_invalid":
        setPhase("failed", { reason: message.message ?? "令牌被拒绝" });
        stopped = true;
        clearTimer();
        closeSocket();
        break;
      case "result": {
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          clearTimeout(waiter.timer);
          if (message.success === true) waiter.resolve(message.result ?? null);
          else
            waiter.reject(
              new HaWsError(
                `${String(message.message ?? "命令失败")}（${String(message.code ?? "error")}）`,
                message.code ?? "ws_command_failed",
              ),
            );
        }
        break;
      }
      case "event": {
        const event = message.event;
        if (event?.event_type === "state_changed" && event.data?.entity_id) {
          if (options.onStateChange) {
            options.onStateChange(
              event.data.entity_id,
              event.data.new_state ?? null,
            );
          }
        }
        break;
      }
      default:
        break;
    }
  }

  function open() {
    if (stopped || phase === "failed") return;
    clearTimer();
    let created;
    try {
      created = connect(url);
    } catch (error) {
      scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }
    socket = created;
    setPhase("connecting");
    // 不做「抢跑发 auth」：HA 连上必发 auth_required，凭据只在收到它之后递
    socket.onmessage = (event) => handleMessage(event?.data ?? event);
    socket.onerror = () => scheduleReconnect("socket_error");
    socket.onclose = (event) => {
      socket = null;
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(
          new HaWsError("Home Assistant 的连接已关闭。", "ws_closed"),
        );
      }
      pending.clear();
      if (stopped || phase === "failed") return;
      setPhase("closed", { reason: `code ${event?.code ?? 0}` });
      scheduleReconnect("socket_close");
    };
  }

  return {
    get phase() {
      return phase;
    },
    start: open,
    /** 配置变了（地址或令牌）：丢掉旧连接与「不再重试」的判定，重新起。 */
    restart() {
      stopped = false;
      attempt = 0;
      setPhase("idle");
      clearTimer();
      closeSocket();
      open();
    },
    stop() {
      stopped = true;
      clearTimer();
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new HaWsError("插件已停止该连接。", "ws_stopped"));
      }
      pending.clear();
      closeSocket();
      setPhase("stopped");
    },
    /** 发一条命令并等它的 `result`（注册表补齐走这里）。 */
    request(type, extra = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new HaWsError(`等待 ${type} 回应超时。`, "ws_timeout"));
        }, WS_COMMAND_TIMEOUT_MS);
        if (typeof timer?.unref === "function") timer.unref();
        // 先登记再发：响应可能在 `send` 的同一拍里回来（假 socket 就是这样），
        // 登记晚了这条 promise 就永远没人兑现
        pending.set(id, { resolve, reject, timer });
        try {
          send({ id, type, ...extra });
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
  };
}
