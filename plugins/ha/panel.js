/**
 * 智能家居面板页（插件自带，无构建、无外部依赖）。
 *
 * 本机接入由浏览器 HttpOnly cookie 持有，面板不接收也不保管宿主令牌；数据面请求带
 * credentials，由服务端解析稳定实例。HA 令牌只存在服务端插件存储里，面板写入一次后
 * 只显示「已配置」。
 *
 * 数据面：本插件自己的私有路由（`/api/plugins/<id>/…`）。
 *
 * 加载方式：**本文件不是 ES module**（无 import/export），由 panel.html 以经典脚本注入。
 */

const BASE = location.pathname.replace(/\/assets\/[^/]*$/, "");

const state = {
  baseUrl: "",
  defaultBaseUrl: "",
  busy: false,
};

const els = {
  state: document.getElementById("state"),
  body: document.getElementById("body"),
  note: document.getElementById("note"),
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

function setNote(text, isError) {
  els.note.textContent = text || "";
  els.note.className = isError ? "error" : "hint";
  els.note.hidden = !text;
}

function showError(message) {
  setNote(message, true);
}

function setHeaderButtons(configured) {
  els.retest.hidden = !configured;
  els.edit.hidden = !configured;
  els.disconnect.hidden = !configured;
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

  const row = (label, control) => {
    const line = el("div", "field");
    const name = el("label");
    name.textContent = label;
    line.appendChild(name);
    line.appendChild(control);
    return line;
  };
  card.appendChild(row("地址", address));
  card.appendChild(row("令牌", token));

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
        setNote("", false);
        showConnected(payload);
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

// === 已连接 ===

function showConnected(info) {
  setHeaderButtons(true);
  setState(`HA ${info?.version ?? "已连接"}`);
  clear(els.body);
  els.body.appendChild(
    el(
      "div",
      "card hint",
      `已连接：${state.baseUrl || info?.locationName || ""}`,
    ),
  );
}

function loadConfig() {
  return api("config")
    .then((payload) => {
      state.baseUrl = payload.baseUrl || "";
      state.defaultBaseUrl = payload.defaultBaseUrl || "";
      if (!payload.configured) {
        renderConfigForm();
        return;
      }
      setState("连接中…");
      return api("test", { method: "POST" })
        .then(showConnected)
        .catch((error) => {
          showError(error.message);
          setHeaderButtons(true);
        });
    })
    .catch((error) => {
      showError(error.message);
    });
}

els.retest.addEventListener("click", () => {
  setState("连接中…");
  api("test", { method: "POST" })
    .then((payload) => {
      setNote("", false);
      showConnected(payload);
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
      showError("已清除本机保存的 HA 地址与令牌。");
      renderConfigForm();
    })
    .catch((error) => showError(error.message));
});

loadConfig();
