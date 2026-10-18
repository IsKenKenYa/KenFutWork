/**
 * 智能家居面板页（插件自带，无构建、无外部依赖）。
 *
 * 本机接入由浏览器 HttpOnly cookie 持有，面板不接收也不保管宿主令牌；数据面请求带
 * credentials，由服务端解析稳定实例。HA 令牌只存在服务端插件存储里，面板写入一次后
 * 只显示「已配置」。
 *
 * 数据面：本插件自己的私有路由（`/api/plugins/<id>/…`）。控件由服务端按「域 + 属性」
 * 算好（`lib/entity-model.js`），面板只渲染并回传 `{entityId, key, service, value}`——
 * 量程与换算都在服务端复核，面板改不动服务契约。
 *
 * 加载方式：**本文件不是 ES module**（无 import/export），由 panel.html 以经典脚本注入。
 */

const BASE = location.pathname.replace(/\/assets\/[^/]*$/, "");
/** 面板自取增量的间隔（WS 断时这是唯一的新鲜度来源，如实标「轮询」）。 */
const POLL_MS = 5000;

const state = {
  baseUrl: "",
  defaultBaseUrl: "",
  version: null,
  groups: [],
  total: 0,
  truncated: false,
  mode: "polling",
  busy: false,
  pollTimer: null,
};

const els = {
  state: document.getElementById("state"),
  body: document.getElementById("body"),
  note: document.getElementById("note"),
  refresh: document.getElementById("refresh"),
  retest: document.getElementById("retest"),
  edit: document.getElementById("edit"),
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
 * 轮询每 5 秒要清一次瞬时消息，若把它和网格挤进同一容器，清空会让页面矮一截、
 * 滚动条每轮抖一次（米家面板实测过的同一现象）。
 */
function setNote(text, isError) {
  els.note.textContent = text || "";
  els.note.className = isError ? "error" : "hint";
  els.note.hidden = !text;
}

function showError(message) {
  setNote(message, true);
}

function setHeaderButtons(connected) {
  els.refresh.hidden = !connected;
  els.retest.hidden = !connected;
  els.edit.hidden = !connected;
  els.disconnect.hidden = !connected;
}

function api(path, options) {
  const opts = options || {};
  const headers = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${BASE}/${path}`, {
    method: opts.method || "GET",
    headers,
    credentials: "include",
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }).then((response) =>
    response
      .json()
      .catch(() => ({}))
      .then((payload) => {
        if (!response.ok) {
          const error = new Error(
            payload?.error?.message ??
              payload?.error ??
              `请求失败（HTTP ${response.status}）`,
          );
          error.status = response.status;
          error.code = payload?.code ?? payload?.error?.code;
          throw error;
        }
        return payload;
      }),
  );
}

// === 未配置 / 修改配置 ===

function renderConfigForm(message) {
  stopPolling();
  setHeaderButtons(false);
  setState("未配置");
  clear(els.body);
  const card = el("div", "card");
  const address = el("input");
  address.type = "url";
  address.value = state.baseUrl;
  address.placeholder = state.defaultBaseUrl || "http://192.168.1.20:8123";
  const token = el("input");
  token.type = "password";
  token.placeholder = state.baseUrl ? "留空则沿用已存令牌" : "长期访问令牌";

  const field = (label, control) => {
    const line = el("div", "field");
    line.appendChild(el("label", null, label));
    line.appendChild(control);
    return line;
  };
  card.appendChild(field("地址", address));
  card.appendChild(field("令牌", token));

  const button = el("button", null, "连接");
  button.type = "button";
  button.addEventListener("click", () => {
    if (state.busy) return;
    state.busy = true;
    button.disabled = true;
    button.textContent = "连接中…";
    api("config", {
      method: "POST",
      body: { baseUrl: address.value.trim(), token: token.value.trim() },
    })
      .then((payload) => {
        state.busy = false;
        state.version = payload.version ?? null;
        setNote("", false);
        loadEntities();
      })
      .catch((error) => {
        state.busy = false;
        button.disabled = false;
        button.textContent = "连接";
        showError(error.message);
      });
  });
  const actions = el("div", "actions");
  actions.appendChild(button);
  card.appendChild(actions);
  if (message) card.appendChild(el("p", "error", message));
  els.body.appendChild(card);
}

// === 实体网格 ===

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") loadEntities();
  }, POLL_MS);
}

/** 下发控制：成功后重取一轮，让服务端读回的真值上屏（不本地假更新）。 */
function control(entityId, key, service, value) {
  const body = { entityId, key, service };
  if (value !== undefined) body.value = value;
  api("control", { method: "POST", body })
    .then((payload) => {
      // 「已发出，状态未变」是读回校验的结论，必须原样透出，不报假成功
      setNote(payload.changed ? "" : payload.message, false);
      return loadEntities();
    })
    .catch((error) => showError(error.message));
}

/**
 * 一行控件：**建一次**，之后只更新数值（`apply`）。
 *
 * 网格每 5 秒刷一轮，整块重建会让滚动位置、正在拖的滑杆、展开中的下拉全部被重置
 * （沿用米家面板同一口径）。`current` 让事件处理器始终读到本轮的服务名与量程。
 */
function controlRow(entity, node) {
  let current = node;
  const row = el("div", "row");
  row.appendChild(el("span", "label", node.label));

  if (node.kind === "toggle") {
    const toggle = el("button", "switch");
    toggle.type = "button";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", node.label);
    toggle.appendChild(el("i"));
    const apply = (item) => {
      const isOn = current.isOn === true;
      toggle.setAttribute("data-on", isOn ? "1" : "0");
      toggle.disabled = item.unavailable === true;
      // 用 onclick 换处理器（不是 addEventListener）：每轮 apply 覆盖旧的，不累积监听
      toggle.onclick = () =>
        control(
          item.entityId,
          "power",
          isOn ? current.offService : current.onService,
          undefined,
        );
    };
    apply(entity);
    row.appendChild(toggle);
    return { key: node.key, apply, update: (next) => (current = next) };
  }

  if (node.kind === "slider") {
    const input = el("input");
    input.type = "range";
    input.min = String(node.min);
    input.max = String(node.max);
    input.step = String(node.step);
    const valueEl = el("span", "value");
    const apply = (item) => {
      // 拖动中不打断（否则会被上一轮的旧值弹回去）
      if (document.activeElement !== input) input.value = String(current.value);
      valueEl.textContent = `${current.value ?? "—"}${current.unit ? ` ${current.unit}` : ""}`;
      input.disabled = item.unavailable === true;
    };
    input.addEventListener("change", () => {
      control(
        entity.entityId,
        current.key,
        current.service,
        Number(input.value),
      );
    });
    apply(entity);
    row.appendChild(input);
    row.appendChild(valueEl);
    return { key: node.key, apply, update: (next) => (current = next) };
  }

  if (node.kind === "select") {
    const select = el("select");
    for (const option of node.options || []) {
      const item = el("option");
      item.value = String(option.value);
      item.textContent = option.label;
      select.appendChild(item);
    }
    const apply = (item) => {
      // 下拉展开中不打断
      if (document.activeElement !== select)
        select.value = String(current.value);
      select.disabled = item.unavailable === true;
    };
    select.addEventListener("change", () => {
      control(entity.entityId, current.key, current.service, select.value);
    });
    apply(entity);
    row.appendChild(select);
    return { key: node.key, apply, update: (next) => (current = next) };
  }

  if (node.kind === "buttons") {
    const box = el("div", "buttons");
    for (const button of node.buttons || []) {
      const item = el("button", null, button.label);
      item.type = "button";
      item.addEventListener("click", () => {
        control(entity.entityId, button.key, button.service, undefined);
      });
      box.appendChild(item);
    }
    const apply = (item) => {
      for (const child of Array.from(box.children)) {
        child.disabled = item.unavailable === true;
      }
    };
    apply(entity);
    row.appendChild(box);
    return { key: node.key, apply, update: () => {} };
  }

  // 只读读数（服务端把无控件的实体包成一个 `read` 控件）
  const valueEl = el("span", "value");
  const apply = (item) => {
    valueEl.textContent = `${current.value ?? "—"}${current.unit ? ` ${current.unit}` : ""}`;
    valueEl.className = item.unavailable === true ? "value off" : "value";
  };
  apply(entity);
  row.appendChild(valueEl);
  return { key: node.key, apply, update: (next) => (current = next) };
}

function entityCard(entity) {
  const card = el("div", `device${entity.unavailable ? " offline" : ""}`);
  const title = el("h2");
  title.appendChild(el("span", null, entity.name || entity.entityId));
  title.appendChild(el("span", "badge", entity.domain));
  if (entity.unavailable) title.appendChild(el("span", "badge", "离线"));
  card.appendChild(title);

  const rows = (entity.controls ?? []).map((node) => {
    const item = controlRow(entity, node);
    card.appendChild(item.row);
    return item;
  });
  const apply = (next) => {
    const controls = next.controls ?? [];
    for (const item of rows) {
      const node = controls.find((each) => each.key === item.key);
      if (!node) continue;
      item.update(node);
      item.apply(next);
    }
  };
  return { card, apply };
}

/**
 * 结构签名：分组、实体集、离线态与控件表（种类/量程/选项）——这些变了才值得重建 DOM；
 * 只变数值时走原地更新（廉价字符串比较，每轮一次）。
 */
function viewSignature(groups) {
  return groups
    .map((group) =>
      [
        group.name,
        group.items
          .map((item) =>
            [
              item.entityId,
              item.name,
              item.unavailable ? 1 : 0,
              (item.controls ?? [])
                .map((node) =>
                  [
                    node.key,
                    node.kind,
                    node.label,
                    node.min ?? "",
                    node.max ?? "",
                    (node.options ?? []).map((each) => each.value).join(","),
                  ].join(":"),
                )
                .join("|"),
            ].join("~"),
          )
          .join(";"),
      ].join("#"),
    )
    .join("@");
}

/** 上一轮渲染的账：签名 + 更新器（更新器与扁平化的实体顺序对齐）。 */
const rendered = { signature: null, applies: [] };

function renderEntities() {
  setHeaderButtons(true);
  // 刷新不动滚动位置：先记后还原（整页滚动，滚动条在 document 上）
  const scroller = document.scrollingElement ?? document.documentElement;
  const scrollTop = scroller.scrollTop;
  const shown = state.groups.reduce(
    (sum, group) => sum + group.items.length,
    0,
  );
  const version = state.version ? `HA ${state.version}` : "智能家居";
  const mode = state.mode === "realtime" ? "实时" : "轮询";
  setState(
    `${version} · ${mode} · ${state.total} 实体${state.truncated ? `（只显示前 ${shown} 条）` : ""}`,
  );

  if (shown === 0) {
    clear(els.body);
    rendered.signature = null;
    rendered.applies = [];
    els.body.appendChild(el("div", "card hint", "HA 里没有实体。"));
    return;
  }

  const signature = viewSignature(state.groups);
  if (signature === rendered.signature) {
    // 结构没变：只把新值灌进已有控件（滚动条、拖动中的滑杆、展开的下拉都不受影响）
    let index = 0;
    for (const group of state.groups) {
      for (const item of group.items) {
        rendered.applies[index]?.(item);
        index += 1;
      }
    }
  } else {
    clear(els.body);
    const applies = [];
    for (const group of state.groups) {
      els.body.appendChild(el("h3", "group", group.name));
      const grid = el("div", "grid");
      for (const item of group.items) {
        const { card, apply } = entityCard(item);
        applies.push(apply);
        grid.appendChild(card);
      }
      els.body.appendChild(grid);
    }
    rendered.signature = signature;
    rendered.applies = applies;
  }
  scroller.scrollTop = scrollTop;
}

function loadEntities() {
  return api("entities")
    .then((payload) => {
      state.groups = payload.groups || [];
      state.total = payload.total || 0;
      state.truncated = payload.truncated === true;
      state.mode = payload.mode || "polling";
      // 成功这一拍才清瞬时消息：与重渲染同一任务，不出现「页面矮一截」的中间帧
      setNote("", false);
      renderEntities();
      startPolling();
    })
    .catch((error) => {
      stopPolling();
      if (error.code === "not_configured" || error.status === 401) {
        renderConfigForm(error.message);
        return;
      }
      setHeaderButtons(true);
      showError(error.message);
    });
}

els.refresh.addEventListener("click", () => loadEntities());

els.retest.addEventListener("click", () => {
  setState("连接中…");
  api("test", { method: "POST" })
    .then((payload) => {
      state.version = payload.version ?? null;
      setNote("", false);
      loadEntities();
    })
    .catch((error) => showError(error.message));
});

els.edit.addEventListener("click", () => {
  setNote("", false);
  renderConfigForm();
});

els.disconnect.addEventListener("click", () => {
  api("disconnect", { method: "POST" })
    .then(() => {
      state.baseUrl = "";
      state.version = null;
      renderConfigForm("已清除本机保存的 HA 地址与令牌。");
    })
    .catch((error) => showError(error.message));
});

function boot() {
  setState("加载中…");
  api("config")
    .then((payload) => {
      state.baseUrl = payload.baseUrl || "";
      state.defaultBaseUrl = payload.defaultBaseUrl || "";
      if (!payload.configured) {
        renderConfigForm();
        return;
      }
      // 版本取自连接测试（一次），之后每轮只取实体
      return api("test", { method: "POST" })
        .then((info) => {
          state.version = info.version ?? null;
          return loadEntities();
        })
        .catch((error) => {
          if (error.code === "not_configured" || error.status === 401) {
            renderConfigForm(error.message);
            return;
          }
          setHeaderButtons(true);
          showError(error.message);
        });
    })
    .catch((error) => showError(error.message));
}

boot();
