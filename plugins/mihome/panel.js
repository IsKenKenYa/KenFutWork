/**
 * 米家面板页（插件自带，无构建、无外部依赖）。
 *
 * 登录态来源：宿主工作台在 iframe 加载完成/令牌刷新时用 `postMessage` 递
 * `{type:"kenfutwork:plugin-panel-token", accessToken}`（见 lib/plugin-panels.tsx）。
 * 只接受**同源**来的这条消息——面板页由服务端托管，宿主与它同源。
 *
 * 数据面：本插件自己的私有路由（`/api/plugins/<id>/…`），带 `Authorization` 调，
 * 因此拿得到 `request.workspaceId`（插件存储按工作区隔离）。
 *
 * 模块脚本：二维码的刷新判定从 `lib/qr-refresh.js` 静态引入，与宿主侧单测共用同一份逻辑
 * （小米二维码约 2 分钟过期——过期要自动换新码，不能让用户手动点）。
 */

import { decideQrAction } from "./lib/qr-refresh.js";

const BASE = location.pathname.replace(/\/assets\/[^/]*$/, "");
const POLL_MS = 5000;
const TOKEN_MESSAGE_TYPE = "kenfutwork:plugin-panel-token";

const state = {
  token: null,
  devices: [],
  total: 0,
  specErrors: [],
  pollTimer: null,
  busy: false,
  renderQr: null,
  /** 当前二维码的过期时刻与已自动刷新次数（决定过期后是再换一张还是停下来）。 */
  deadline: 0,
  autoRefreshes: 0,
  /** 空设备列表时的确诊文案（服务端给：真没设备 vs 会话没被云端认出来）。 */
  authHint: null,
};

const els = {
  state: document.getElementById("state"),
  body: document.getElementById("body"),
  footer: document.getElementById("footer"),
  refresh: document.getElementById("refresh"),
  disconnect: document.getElementById("disconnect"),
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function setState(text) {
  els.state.textContent = text || "";
}

/** 页脚统一出口：错误红字与提示灰字互斥，避免消息堆叠。 */
function setNote(text, isError) {
  clear(els.footer);
  if (!text) return;
  els.footer.appendChild(el("p", isError ? "error" : "hint", text));
}

function showError(message) {
  setNote(message, true);
}

function showHint(message) {
  setNote(message, false);
}

function clearFooter() {
  clear(els.footer);
}

function setHeaderButtons(connected) {
  els.refresh.hidden = !connected;
  els.disconnect.hidden = !connected;
}

function api(path, options) {
  const opts = options || {};
  const headers = {};
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${BASE}/${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }).then((response) =>
    response
      .json()
      .catch(() => ({}))
      .then((payload) => {
        if (!response.ok) {
          const error = new Error(
            payload?.error ?? `请求失败（HTTP ${response.status}）`,
          );
          error.status = response.status;
          error.code = payload?.code;
          throw error;
        }
        return payload;
      }),
  );
}

// === 登录（扫码） ===

/** 出码：`auto` = 过期后的自动换码（累计次数、不清页脚），否则是用户手点（重置计数）。 */
function startLogin(options) {
  const auto = options?.auto === true;
  if (state.busy) return;
  state.busy = true;
  if (auto) {
    showHint("二维码已过期，正在自动换新码…");
  } else {
    clearFooter();
  }
  api("login/qr")
    .then((payload) => {
      state.busy = false;
      state.autoRefreshes = auto ? state.autoRefreshes + 1 : 0;
      state.deadline = Date.now() + (Number(payload.timeout) || 120) * 1000;
      if (state.renderQr) state.renderQr(payload.qrUrl);
      if (auto) {
        showHint(`二维码已自动刷新（第 ${state.autoRefreshes} 次）。`);
      } else {
        clearFooter();
      }
      pollQr(payload.sessionId);
    })
    .catch((error) => {
      state.busy = false;
      showError(error.message);
    });
}

/** 过期后隔一拍再换：给「用户正好在扫」留个窗口，也避免打得太急。 */
function refreshQr() {
  if (state.busy) return;
  setTimeout(() => startLogin({ auto: true }), 1000);
}

function pollQr(sessionId) {
  const tick = () => {
    api(`login/poll?sessionId=${encodeURIComponent(sessionId)}`)
      .then((payload) => {
        const status =
          payload.status === "ok"
            ? "ok"
            : payload.status === "expired"
              ? "expired"
              : "pending";
        const action = decideQrAction({
          now: Date.now(),
          deadline: state.deadline,
          status,
          autoRefreshes: state.autoRefreshes,
        });
        if (action === "scanned") {
          state.autoRefreshes = 0;
          loadDevices(true);
          return;
        }
        if (action === "refresh") {
          refreshQr();
          return;
        }
        if (action === "give-up") {
          showError("二维码多次过期，请点「获取二维码」重试。");
          return;
        }
        setTimeout(tick, Math.max(1000, Number(payload.wait) || 2000));
      })
      .catch((error) => {
        // 长轮询会断线：过期了就换新码，没过期就重试一轮（别把用户卡在错误上）
        if (Date.now() >= state.deadline) {
          refreshQr();
          return;
        }
        showError(`${error.message}（正在重试…）`);
        setTimeout(tick, 2000);
      });
  };
  setTimeout(tick, 1200);
}

function renderLogin(message) {
  stopPolling();
  setHeaderButtons(false);
  setState("未连接");
  clear(els.body);
  const card = el("div", "card login");
  card.appendChild(el("p", "hint", "用米家 App 扫描二维码登录"));
  const qrBox = el("div", "hint", "正在获取二维码…");
  card.appendChild(qrBox);
  const button = el("button", null, "刷新二维码");
  button.type = "button";
  button.addEventListener("click", () => {
    startLogin();
  });
  card.appendChild(button);
  if (message) card.appendChild(el("p", "error", message));
  els.body.appendChild(card);
  state.renderQr = (qrUrl) => {
    clear(qrBox);
    const img = document.createElement("img");
    img.alt = "米家登录二维码";
    img.src = qrUrl;
    qrBox.appendChild(img);
  };
}

// === 设备列表 ===

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") loadDevices(false);
  }, POLL_MS);
}

function formatValue(property) {
  if (property.value === undefined || property.value === null) return "—";
  if (typeof property.value === "boolean") return property.value ? "开" : "关";
  if (property.valueList) {
    const hit = property.valueList.filter(
      (item) => item.value === property.value,
    )[0];
    return hit ? hit.label : String(property.value);
  }
  return String(property.value);
}

function applyValue(did, siid, piid, value) {
  for (const device of state.devices) {
    if (device.did !== did) continue;
    for (const property of device.properties || []) {
      if (property.siid === siid && property.piid === piid) {
        property.value = value;
      }
    }
  }
}

function control(did, siid, piid, value) {
  clearFooter();
  setState("下发中…");
  api("control", {
    method: "POST",
    body: { did, siid, piid, value },
  })
    .then((payload) => {
      applyValue(did, siid, piid, payload.value);
      renderDevices();
      if (!payload.ok) {
        showError(payload.message || "米家云未接受这次写入。");
      }
    })
    .catch((error) => {
      setState("下发失败");
      showError(error.message);
    });
}

function controlNode(device, property) {
  const row = el("div", "row");
  row.appendChild(el("span", "label", property.name));

  if (!device.online) {
    row.appendChild(el("span", "value", "离线"));
    return row;
  }
  if (property.kind === "toggle") {
    const toggle = el("button", "switch");
    toggle.type = "button";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", property.name);
    const on = property.value === true;
    toggle.setAttribute("data-on", on ? "1" : "0");
    toggle.appendChild(el("i"));
    toggle.addEventListener("click", () => {
      control(device.did, property.siid, property.piid, !on);
    });
    row.appendChild(toggle);
    return row;
  }
  if (property.kind === "slider" && Array.isArray(property.valueRange)) {
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(Number(property.valueRange[0]));
    slider.max = String(Number(property.valueRange[1]));
    slider.step = String(Number(property.valueRange[2]) || 1);
    slider.value = String(
      typeof property.value === "number"
        ? property.value
        : Number(property.valueRange[0]),
    );
    slider.addEventListener("change", () => {
      control(device.did, property.siid, property.piid, Number(slider.value));
    });
    row.appendChild(slider);
    row.appendChild(el("span", "value", formatValue(property)));
    return row;
  }
  if (property.kind === "select" && Array.isArray(property.valueList)) {
    const select = document.createElement("select");
    for (const item of property.valueList) {
      const option = document.createElement("option");
      option.value = String(item.value);
      option.textContent = item.label;
      if (item.value === property.value) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener("change", () => {
      const numeric = Number(select.value);
      control(
        device.did,
        property.siid,
        property.piid,
        Number.isNaN(numeric) ? select.value : numeric,
      );
    });
    row.appendChild(select);
    return row;
  }
  row.appendChild(el("span", "value", formatValue(property)));
  return row;
}

function deviceCard(device) {
  const card = el("div", `device${device.online ? "" : " offline"}`);
  const title = el("h2");
  title.appendChild(el("span", null, device.name || device.did));
  title.appendChild(el("span", "badge", device.online ? "在线" : "离线"));
  if (device.room) title.appendChild(el("span", "badge", device.room));
  card.appendChild(title);
  if (!device.hasSpec) {
    card.appendChild(
      el("p", "hint", "规格解析失败：仅显示在线状态（可用顶部刷新重试）。"),
    );
    return card;
  }
  for (const property of device.properties || []) {
    card.appendChild(controlNode(device, property));
  }
  return card;
}

function renderDevices() {
  setHeaderButtons(true);
  // 网格每 5 秒整格重建：先记住滚动位置，重建后还原（否则滚动条每次都跳回顶部/抖动）
  const scrollTop = els.body.scrollTop;
  clear(els.body);
  const truncated =
    state.total > state.devices.length
      ? `（本次只读前 ${state.devices.length} 台）`
      : "";
  setState(`${state.devices.length} / ${state.total} 台设备${truncated}`);
  if (state.devices.length === 0) {
    els.body.appendChild(
      el("div", "card hint", state.authHint ?? "账号下没有设备。"),
    );
    return;
  }
  const grid = el("div", "grid");
  for (const device of state.devices) {
    grid.appendChild(deviceCard(device));
  }
  els.body.appendChild(grid);
  els.body.scrollTop = scrollTop;
  if (state.specErrors.length > 0) {
    const list = el("div", "card");
    list.appendChild(
      el("p", "hint", "规格解析失败（这些设备只显示在线状态）："),
    );
    // 同一型号失败原因相同，按原因合并计数（5 台同名空调各报一条是纯噪音）
    const byMessage = new Map();
    for (const item of state.specErrors) {
      const message = String(item.error ?? "未知原因");
      byMessage.set(message, (byMessage.get(message) ?? 0) + 1);
    }
    for (const [message, count] of byMessage) {
      list.appendChild(
        el("p", "error", count > 1 ? `${message}（${count} 台）` : message),
      );
    }
    els.footer.appendChild(list);
  }
}

function loadDevices(refresh) {
  clearFooter();
  return api(`devices${refresh ? "?refresh=1" : ""}`)
    .then((payload) => {
      state.devices = payload.devices || [];
      state.total = payload.total || state.devices.length;
      state.specErrors = payload.specErrors || [];
      state.authHint = payload.authHint ?? null;
      renderDevices();
      startPolling();
    })
    .catch((error) => {
      stopPolling();
      if (error.code === "not_connected" || error.status === 401) {
        renderLogin(error.message);
        return;
      }
      setHeaderButtons(true);
      showError(error.message);
    });
}

function boot() {
  setState("连接中…");
  api("status")
    .then((payload) => {
      if (!payload.connected) {
        renderLogin();
        return;
      }
      loadDevices(false);
    })
    .catch((error) => {
      showError(error.message);
    });
}

els.refresh.addEventListener("click", () => {
  loadDevices(true);
});

els.disconnect.addEventListener("click", () => {
  stopPolling();
  api("disconnect", { method: "POST" })
    .then(() => {
      renderLogin("已断开米家账号。");
    })
    .catch((error) => {
      showError(error.message);
    });
});

// 宿主握手：只接受同源、且带我们约定类型的消息
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.type !== TOKEN_MESSAGE_TYPE) return;
  if (typeof data.accessToken !== "string" || data.accessToken === "") return;
  state.token = data.accessToken;
  boot();
});
