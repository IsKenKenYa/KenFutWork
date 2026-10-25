/**
 * 智能家居面板页（插件自带，无构建、无外部依赖）。
 *
 * 两种视图：未配置（欢迎页 + 「选择品牌或集成」品牌卡引导 + 连接表单——按教程里 HA
 * 集成流程的形状，2026-10-25）、**已连接 = HA 原生界面（iframe 直接内嵌 HA 自己的前端
 * ——用户拍板「要教程里一样的界面」，2026-10-24）**。已连接态头部只有状态行（版本 +
 * 实体实况，2026-10-25 用户要求去掉精简面板/重新测试/修改配置/断开四个按钮——连接
 * 生命周期由自动初始化接管，不再有手工入口），并带「集成管理」（默认小米/华为，
 * 可添加/卸载，添加走 HA 配置流：表单步渲染 + OAuth 授权链接 + 自动轮询）。
 *
 * 本机接入由浏览器 HttpOnly cookie 持有，面板不接收也不保管宿主令牌；数据面请求带
 * credentials，由服务端解析稳定实例。HA 令牌只存在服务端插件存储里。内嵌的 HA 前端
 * 用 HA 自己的登录态；免登陆（自动关联本地用户）由 HA 侧 trusted_networks 提供
 * （通用步骤里有配置）。
 *
 * 数据面：本插件自己的私有路由（`/api/plugins/<id>/…`）。控件与流程字段都由服务端或
 * HA 的 schema 驱动，面板只渲染。
 *
 * 加载方式：**本文件不是 ES module**（无 import/export），由 panel.html 以经典脚本注入。
 */

const BASE = location.pathname.replace(/\/assets\/[^/]*$/, "");
/** 面板自取增量的间隔（仅喂状态行的实况计数）。 */
const POLL_MS = 5000;

const state = {
  baseUrl: "",
  defaultBaseUrl: "",
  version: null,
  view: "config",
  busy: false,
  pollTimer: null,
};

const els = {
  state: document.getElementById("state"),
  body: document.getElementById("body"),
  note: document.getElementById("note"),
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
 * 轮询每轮要清一次瞬时消息，若把它和内容挤进同一容器，清空会让页面矮一截、
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

// === 未配置：欢迎页 + 品牌卡引导 + 连接表单 ===

/** 引导数据只拉一次；失败不缓存（下一轮配置态重试），也绝不影响连接表单。 */
let guidePromise = null;
function loadGuide() {
  if (guidePromise) return guidePromise;
  guidePromise = api("guide")
    .then((payload) => ({
      brands: Array.isArray(payload.brands) ? payload.brands : [],
      steps: Array.isArray(payload.steps) ? payload.steps : [],
    }))
    .catch(() => {
      guidePromise = null;
      return { brands: [], steps: [] };
    });
  return guidePromise;
}

function copyText(text, button) {
  const done = () => {
    button.textContent = "已复制";
    setTimeout(() => {
      if (button.isConnected) button.textContent = "复制";
    }, 1200);
  };
  // 剪贴板 API 可能被 iframe 权限策略挡住：挡住就退回隐藏 textarea 选中复制
  if (navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(done)
      .catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
    done();
  } catch {
    /* 复制失败不打断：命令文本本来就完整可见，可手动选中 */
  }
  area.remove();
}

function commandRow(item) {
  const row = el("div", "command");
  row.appendChild(el("pre", null, item.text));
  const copy = el("button", null, "复制");
  copy.type = "button";
  copy.addEventListener("click", () => copyText(item.text, copy));
  row.appendChild(copy);
  return row;
}

function guideItemsInto(box, items) {
  for (const item of items ?? []) {
    if (item.kind === "command") {
      box.appendChild(commandRow(item));
      continue;
    }
    if (item.kind === "link") {
      const line = el("p", "step-text");
      const link = el("a", null, item.label);
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener";
      line.appendChild(link);
      box.appendChild(line);
      continue;
    }
    box.appendChild(el("p", "step-text", item.text));
  }
}

/**
 * 品牌卡：教程里「选择品牌或集成」的一行——图标 + 名称 + 一行说明，点开是接入步骤。
 * 数据来自服务端 `guide` 路由（`lib/setup-guide.js` 一处属主，测试锁死仓库链接）。
 */
function buildBrandCard(brand) {
  const details = el("details", "brand");
  details.open = brand.open === true;
  const summary = el("summary");
  summary.appendChild(
    el("span", `brand-icon ${brand.id}`, (brand.title || "?").charAt(0)),
  );
  const meta = el("span", "brand-meta");
  meta.appendChild(el("span", "brand-name", brand.title));
  meta.appendChild(el("span", "brand-sub", brand.subtitle));
  summary.appendChild(meta);
  summary.appendChild(el("span", "chev", "›"));
  details.appendChild(summary);
  const body = el("div", "step-body");
  guideItemsInto(body, brand.items);
  details.appendChild(body);
  return details;
}

function buildStepCard(step) {
  const details = el("details", "step");
  details.open = step.open === true;
  details.appendChild(el("summary", null, step.title));
  const box = el("div", "step-body");
  guideItemsInto(box, step.items);
  details.appendChild(box);
  return details;
}

/**
 * 引导区：品牌卡（米家/华为，默认展开）在上，通用步骤收在下——先选生态照着做，
 * 再到表单连接。
 */
function buildGuideSection(brands, steps) {
  const section = el("div", "guide");
  if (brands.length > 0) {
    section.appendChild(el("h3", "group", "选择品牌或集成"));
    for (const brand of brands) section.appendChild(buildBrandCard(brand));
  }
  if (steps.length > 0) {
    section.appendChild(el("h3", "group", "通用步骤"));
    for (const step of steps) section.appendChild(buildStepCard(step));
  }
  return section;
}

/** 欢迎页：教程里 HA 首启欢迎屏的形状（用户创建在 HA 自己的初始化里，这里没有）。 */
function buildHero() {
  const hero = el("div", "card hero");
  const img = document.createElement("img");
  img.src = "icon.svg";
  img.alt = "";
  hero.appendChild(img);
  hero.appendChild(el("h1", null, "欢迎使用智能家居"));
  hero.appendChild(el("p", "hint", "接入米家与华为设备"));
  return hero;
}

function renderConfigForm(message, guideFirst = true) {
  stopPolling();
  state.view = "config";
  setState(guideFirst ? "未配置" : "修改配置");
  clear(els.body);
  if (guideFirst) els.body.appendChild(buildHero());

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
        if (typeof payload.baseUrl === "string" && payload.baseUrl) {
          state.baseUrl = payload.baseUrl;
        }
        setNote("", false);
        renderNative();
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
  // 引导区与表单同一页：首用引导在上（照着做）、表单在最后（终点）；
  // 「修改配置」时表单在上（直接改）。异步插入前先确认表单还在页上
  // （期间可能已连上并切到原生界面）
  loadGuide().then((guide) => {
    if (!els.body.contains(card)) return;
    const section = buildGuideSection(guide.brands, guide.steps);
    if (section.childElementCount === 0) return;
    if (guideFirst) els.body.insertBefore(section, card);
    else els.body.appendChild(section);
  });
}

// === 已连接：HA 原生界面（iframe）+ 集成管理 ===

/**
 * 原生视图状态行：版本与（拿得到时的）实体实况——连接成功后拉一轮实体灌进来，
 * 就是教程里「成功 · 已发现设备」那一拍。计数与生态识别同一口径，识别不了就不显示。
 */
function nativeStateText(counts) {
  const version = state.version ? ` · ${state.version}` : "";
  const total = counts ? ` · ${counts.total} 实体` : "";
  const eco = counts?.ecosystems
    ? ` · 米家 ${counts.ecosystems.mijia} · 华为 ${counts.ecosystems.huawei}`
    : "";
  return `HA 原生界面${version}${total}${eco}`;
}

/** 状态行实况轮询：只喂数字，不动 DOM 结构（iframe 与集成管理不受打扰）。 */
function pollCounts() {
  api("entities")
    .then((view) => {
      setState(
        nativeStateText({ total: view.total ?? 0, ecosystems: view.ecosystems }),
      );
      setNote("", false);
    })
    .catch((error) => showError(error.message));
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") pollCounts();
  }, POLL_MS);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

/** 面板里默认支持的两个品牌（与服务端 integrations 路由同一张表）。 */
const BRAND_LABELS = {
  xiaomi: "米家",
  huawei: "华为（HUAWEI HiLink）",
};
const BRAND_DOMAINS = {
  xiaomi: "xiaomi_home",
  huawei: "huawei_smarthome",
};

/**
 * 集成管理：两张默认品牌卡各带状态与动作——未添加「添加」（走 HA 配置流：
 * 表单步渲染 + OAuth 授权链接 + 自动轮询到完成），已添加「卸载」。
 * 列表来自 WS 的 config_entries/get（实时链路未就绪时如实标注）。
 */
function buildIntegrationsBar() {
  const box = el("details", "integrations");
  box.appendChild(el("summary", null, "集成管理"));
  const body = el("div", "integrations-body");
  box.appendChild(body);
  box.addEventListener("toggle", () => {
    if (box.open) loadIntegrations(body);
  });
  return box;
}

function integrationRow(body, brand) {
  const row = el("div", "int-row");
  row.appendChild(el("span", "int-name", BRAND_LABELS[brand]));
  const status = el("span", "int-status", "…");
  row.appendChild(status);
  const action = el("button");
  action.type = "button";
  row.appendChild(action);
  body.appendChild(row);
  const slot = el("div", "int-flow");
  body.appendChild(slot);
  return { status, action, slot };
}

function loadIntegrations(body) {
  api("integrations")
    .then((payload) => {
      clear(body);
      if (payload.ready === false) {
        body.appendChild(
          el("p", "int-status", "实时连接未就绪，稍后再试。"),
        );
        return;
      }
      for (const brand of Object.keys(BRAND_LABELS)) {
        const domain = BRAND_DOMAINS[brand];
        const entry = (payload.integrations ?? []).find(
          (item) => item.domain === domain,
        );
        const { status, action, slot } = integrationRow(body, brand);
        if (entry) {
          status.textContent = `已添加（${entry.state}）`;
          action.textContent = "卸载";
          action.addEventListener("click", () => {
            action.disabled = true;
            api("integrations/remove", {
              method: "POST",
              body: { entryId: entry.entryId },
            })
              .then(() => loadIntegrations(body))
              .catch((error) => {
                action.disabled = false;
                showError(error.message);
              });
          });
        } else {
          status.textContent = "未添加";
          action.textContent = "添加";
          action.addEventListener("click", () => {
            action.disabled = true;
            api("integrations/start", { method: "POST", body: { brand } })
              .then((payload) =>
                runFlowDialog(
                  slot,
                  body,
                  payload.flowId,
                  payload.step,
                  () => loadIntegrations(body),
                ),
              )
              .catch((error) => {
                action.disabled = false;
                showError(error.message);
              });
          });
        }
      }
    })
    .catch((error) => {
      clear(body);
      body.appendChild(el("p", "int-status", error.message));
    });
}

/** 从 external 步的描述占位里抠授权链接（HA 的占位是 `<a href="…" target="_blank">`）。 */
function authLinkOf(step) {
  const raw = String(step?.description_placeholders?.link_left ?? "");
  return /href="([^"]+)"/.exec(raw)?.[1] ?? null;
}

/** 单个字段：boolean→勾选、select→下拉、其余→输入框（密码名猜成密码框）。 */
function flowFieldInput(field) {
  if (field.type === "boolean") {
    const box = el("input");
    box.type = "checkbox";
    box.checked = field.default === true;
    return box;
  }
  if (field.type === "select") {
    const select = el("select");
    for (const option of field.options ?? []) {
      const value = Array.isArray(option) ? option[0] : option;
      const label = Array.isArray(option)
        ? String(option[1]?.label ?? option[1] ?? option[0])
        : String(option);
      const item = el("option");
      item.value = String(value);
      item.textContent = label;
      select.appendChild(item);
    }
    if (field.default !== undefined) select.value = String(field.default);
    return select;
  }
  const input = el("input");
  input.type = /pass|secret|token/i.test(field.name ?? "") ? "password" : "text";
  if (field.default !== undefined) input.value = String(field.default);
  return input;
}

/**
 * 集成配置流对话框：按 HA 返回的步型渲染——表单（schema 驱动）、OAuth 授权链接
 * （新开页授权，hosts 修复后回跳直达）、进行中轮询、完成/中止。
 */
function runFlowDialog(slot, listBody, flowId, step, onDone) {
  let polling = null;
  const stopPolling = () => {
    if (polling) {
      clearInterval(polling);
      polling = null;
    }
  };
  const render = (current) => {
    stopPolling();
    clear(slot);
    if (current.type === "create_entry") {
      slot.appendChild(el("p", "int-status", `已添加（${current.title ?? ""}）`));
      onDone();
      return;
    }
    if (current.type === "abort") {
      slot.appendChild(
        el("p", "error", `已中止：${current.reason ?? "未知原因"}`),
      );
      return;
    }
    if (current.type === "external") {
      slot.appendChild(el("p", "int-status", "等待授权完成…"));
      const url = authLinkOf(current);
      if (url) {
        const open = el("button", null, "打开授权页");
        open.type = "button";
        open.addEventListener("click", () => window.open(url, "_blank"));
        slot.appendChild(open);
      }
      polling = setInterval(() => {
        api("integrations/flow", { method: "POST", body: { flowId } })
          .then((payload) => {
            if (payload.step.type !== current.type) render(payload.step);
          })
          .catch(() => {});
      }, 2000);
      return;
    }
    if (current.type === "progress") {
      slot.appendChild(el("p", "int-status", "进行中…"));
      polling = setInterval(() => {
        api("integrations/flow", { method: "POST", body: { flowId } })
          .then((payload) => {
            if (payload.step.type !== current.type) render(payload.step);
          })
          .catch(() => {});
      }, 2000);
      return;
    }
    // form：按 data_schema 渲染字段
    const form = el("div", "int-form");
    const inputs = new Map();
    for (const field of current.data_schema ?? []) {
      const line = el("div", "field");
      line.appendChild(el("label", null, field.name));
      const input = flowFieldInput(field);
      inputs.set(field.name, input);
      line.appendChild(input);
      form.appendChild(line);
    }
    slot.appendChild(form);
    const submit = el("button", null, "提交");
    submit.type = "button";
    submit.addEventListener("click", () => {
      submit.disabled = true;
      const fields = {};
      for (const field of current.data_schema ?? []) {
        const input = inputs.get(field.name);
        if (!input) continue;
        fields[field.name] =
          field.type === "boolean" ? input.checked : input.value;
      }
      api("integrations/flow", { method: "POST", body: { flowId, fields } })
        .then((payload) => render(payload.step))
        .catch((error) => {
          submit.disabled = false;
          showError(error.message);
        });
    });
    slot.appendChild(submit);
  };
  render(step);
}

function renderNative() {
  stopPolling();
  state.view = "native";
  setState(nativeStateText(null));
  clear(els.body);
  const wrap = el("div", "native");

  wrap.appendChild(buildIntegrationsBar());

  const hint = el("details");
  const summary = el("summary", null, "界面空白时点开");
  hint.appendChild(summary);
  const fix = el("pre", null);
  fix.textContent =
    "HA 设置 → 系统 → 网络 → 关闭「Send X-Frame-Options」\n旧版 configuration.yaml：\nhttp:\n  use_x_frame_options: false";
  hint.appendChild(fix);
  wrap.appendChild(hint);

  const frame = document.createElement("iframe");
  frame.src = state.baseUrl || "";
  frame.title = "Home Assistant";
  frame.referrerPolicy = "no-referrer";
  wrap.appendChild(frame);
  els.body.appendChild(wrap);
  pollCounts();
  startPolling();
}

// === 启动 ===

els.note?.addEventListener("click", () => setNote("", false));

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
      // 已配置：直接进原生界面（iframe 用 HA 自己的登录态；免登陆由 HA 侧
      // trusted_networks 提供，见通用步骤）
      renderNative();
    })
    .catch((error) => showError(error.message));
}

boot();
