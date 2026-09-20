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
  note: document.getElementById("note"),
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

/**
 * 页脚**瞬时消息**（错误红字/提示灰字，互斥）——单独一个 `#note` 节点。
 *
 * 与「规格解析失败」卡片分开的理由：轮询每 5 秒要清一次瞬时消息，若把它和失败卡片挤在同一
 * 容器里，清空会让页面矮一截、滚动条每轮抖一次（实测页面高度在 3174/3075/3204 之间摆动）。
 */
function setNote(text, isError) {
  els.note.textContent = text || "";
  els.note.className = isError ? "error" : "hint";
  els.note.hidden = !text;
}

function showError(message) {
  setNote(message, true);
}

function showHint(message) {
  setNote(message, false);
}

/** 清「瞬时消息」——不碰规格失败卡片（见 setNote 的注释）。 */
function clearNote() {
  setNote("", false);
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
    clearNote();
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
        clearNote();
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
  clearNote();
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

/**
 * 控件行：**建一次**，之后只更新数值（`apply`）。
 *
 * 为什么不做整块重建：网格每 5 秒刷一轮，重建会让整页高度与文本宽度整轮变化——
 * 滚动条因此抖动（用户点名过），正在拖的滑杆、展开中的下拉也会被重置。
 */
function controlNode(device, property) {
  const row = el("div", "row");
  row.appendChild(el("span", "label", property.name));

  if (!device.online) {
    row.appendChild(el("span", "value", "离线"));
    return { row, apply: () => {} };
  }
  if (property.kind === "toggle") {
    const toggle = el("button", "switch");
    toggle.type = "button";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", property.name);
    toggle.appendChild(el("i"));
    const apply = (value) => {
      const on = value === true;
      toggle.setAttribute("data-on", on ? "1" : "0");
      // 用 onclick 换处理器（不是 addEventListener）：每轮 apply 覆盖旧的，不累积监听
      toggle.onclick = () =>
        control(device.did, property.siid, property.piid, !on);
    };
    apply(property.value);
    row.appendChild(toggle);
    return { row, apply };
  }
  if (property.kind === "slider" && Array.isArray(property.valueRange)) {
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(Number(property.valueRange[0]));
    slider.max = String(Number(property.valueRange[1]));
    slider.step = String(Number(property.valueRange[2]) || 1);
    const valueEl = el("span", "value");
    const apply = (value) => {
      // 拖动中不打断（否则会被云端旧值弹回去）
      if (document.activeElement !== slider) {
        slider.value = String(
          typeof value === "number" ? value : Number(property.valueRange[0]),
        );
      }
      valueEl.textContent = formatValue({ ...property, value });
    };
    slider.addEventListener("change", () => {
      control(device.did, property.siid, property.piid, Number(slider.value));
    });
    apply(property.value);
    row.appendChild(slider);
    row.appendChild(valueEl);
    return { row, apply };
  }
  if (property.kind === "select" && Array.isArray(property.valueList)) {
    const select = document.createElement("select");
    for (const item of property.valueList) {
      const option = document.createElement("option");
      option.value = String(item.value);
      option.textContent = item.label;
      select.appendChild(option);
    }
    const apply = (value) => {
      // 下拉展开中不打断
      if (document.activeElement !== select) select.value = String(value);
    };
    select.addEventListener("change", () => {
      const numeric = Number(select.value);
      control(
        device.did,
        property.siid,
        property.piid,
        Number.isNaN(numeric) ? select.value : numeric,
      );
    });
    apply(property.value);
    row.appendChild(select);
    return { row, apply };
  }
  const valueEl = el("span", "value");
  const apply = (value) => {
    valueEl.textContent = formatValue({ ...property, value });
  };
  apply(property.value);
  row.appendChild(valueEl);
  return { row, apply };
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
    return { card, apply: () => {} };
  }
  const rows = [];
  for (const property of device.properties || []) {
    const { row, apply } = controlNode(device, property);
    rows.push({ key: `${property.siid}.${property.piid}`, apply });
    card.appendChild(row);
  }
  const apply = (next) => {
    const values = new Map(
      (next.properties ?? []).map((item) => [
        `${item.siid}.${item.piid}`,
        item.value,
      ]),
    );
    for (const row of rows) row.apply(values.get(row.key));
  };
  return { card, apply };
}

/**
 * 结构签名：设备集、在线态、规格与属性表（控件种类/名称）——这些变了才值得重建 DOM；
 * 只变数值时走原地更新（签名是廉价的字符串比较，每轮一次）。
 */
function deviceSignature(devices) {
  return devices
    .map((device) =>
      [
        device.did,
        device.name,
        device.online ? 1 : 0,
        device.room ?? "",
        device.hasSpec ? 1 : 0,
        (device.properties ?? [])
          .map((item) => `${item.siid}.${item.piid}:${item.kind}:${item.name}`)
          .join("|"),
      ].join("~"),
    )
    .join(";");
}

/** 上一轮渲染的账：签名 + 更新器 + 节点（节点被别处清掉时以 isConnected 重判）。 */
const rendered = {
  signature: null,
  applies: [],
  grid: null,
  specCard: null,
  specSignature: null,
};

function renderSpecErrors() {
  const byMessage = new Map();
  for (const item of state.specErrors) {
    const message = String(item.error ?? "未知原因");
    byMessage.set(message, (byMessage.get(message) ?? 0) + 1);
  }
  const signature = [...byMessage]
    .map(([message, count]) => `${count}×${message}`)
    .join("|");
  // 幂等：消息没变且卡片还在就别动 DOM（高度稳定才不抖；页脚的其它消息可能刚清过它）
  if (signature === rendered.specSignature && rendered.specCard?.isConnected) {
    return;
  }
  rendered.specSignature = signature;
  rendered.specCard?.remove();
  rendered.specCard = null;
  if (byMessage.size === 0) return;
  const list = el("div", "card");
  list.appendChild(el("p", "hint", "规格解析失败（这些设备只显示在线状态）："));
  // 同一型号失败原因相同，按原因合并计数（5 台同名空调各报一条是纯噪音）
  for (const [message, count] of byMessage) {
    list.appendChild(
      el("p", "error", count > 1 ? `${message}（${count} 台）` : message),
    );
  }
  els.footer.appendChild(list);
  rendered.specCard = list;
}

function renderDevices() {
  setHeaderButtons(true);
  // 刷新不动滚动位置：先记后还原（整页滚动，滚动条在 document 上）
  const scroller = document.scrollingElement ?? document.documentElement;
  const scrollTop = scroller.scrollTop;
  const truncated =
    state.total > state.devices.length
      ? `（本次只读前 ${state.devices.length} 台）`
      : "";
  setState(`${state.devices.length} / ${state.total} 台设备${truncated}`);
  if (state.devices.length === 0) {
    clear(els.body);
    rendered.signature = null;
    rendered.applies = [];
    rendered.grid = null;
    els.body.appendChild(
      el("div", "card hint", state.authHint ?? "账号下没有设备。"),
    );
    renderSpecErrors();
    return;
  }
  const signature = deviceSignature(state.devices);
  if (signature === rendered.signature && rendered.grid?.isConnected) {
    // 结构没变：只把新数值灌进已有控件（滚动条、拖动中的滑杆、展开的下拉都不受影响）。
    // 更新器与 state.devices 按位置对齐——签名（含 did 顺序）相同即同一批设备同一顺序。
    for (let index = 0; index < rendered.applies.length; index += 1) {
      rendered.applies[index](state.devices[index]);
    }
  } else {
    clear(els.body);
    const grid = el("div", "grid");
    const applies = [];
    for (const device of state.devices) {
      const { card, apply } = deviceCard(device);
      applies.push(apply);
      grid.appendChild(card);
    }
    els.body.appendChild(grid);
    rendered.signature = signature;
    rendered.applies = applies;
    rendered.grid = grid;
  }
  scroller.scrollTop = scrollTop;
  renderSpecErrors();
}

function loadDevices(refresh) {
  return api(`devices${refresh ? "?refresh=1" : ""}`)
    .then((payload) => {
      state.devices = payload.devices || [];
      state.total = payload.total || state.devices.length;
      state.specErrors = payload.specErrors || [];
      state.authHint = payload.authHint ?? null;
      // 成功这一拍才清瞬时消息：与重渲染同一任务，不会出现「页面矮一截」的中间帧
      // （在 fetch 之前清会让整页高度每轮摆动 → 滚动条抽搐，实测过）
      clearNote();
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
