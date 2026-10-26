/**
 * 智能家居面板页（插件自带，无构建、无外部依赖）。
 *
 * 两种视图（2026-10-25 用户口径「里面只要一个 ha 面板」）：
 * - **原生视图（默认）**：满幅 iframe 内嵌 HA 自己的前端，无任何上方套壳条；
 *   免登陆由 HA 侧 trusted_networks 提供（自动关联本地用户）。宿主标题栏「配置」
 *   （面板声明 configurable，宿主经 postMessage 通知切换）。
 * - **配置视图**（经标题栏「配置」进入）：集成区（默认小米/华为，**打开即自动发起
 *   配置流**——未添加的品牌直接推进到 OAuth 授权步，点「打开授权页」完成授权即添加；
 *   已添加可卸载）+ 界面空白诊断 + 连接表单；未配置态则是欢迎页 + 品牌卡引导 +
 *   连接表单。
 *
 * 本机接入由浏览器 HttpOnly cookie 持有，面板不接收也不保管宿主令牌；数据面请求带
 * credentials，由服务端解析稳定实例。HA 令牌只存在服务端插件存储里。
 *
 * 加载方式：**本文件不是 ES module**（无 import/export），由 panel.html 以经典脚本注入。
 */

const BASE = location.pathname.replace(/\/assets\/[^/]*$/, "");

const state = {
  baseUrl: "",
  defaultBaseUrl: "",
  version: null,
  view: "config",
  busy: false,
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
 * 不与内容同容器：清空瞬时消息不会让页面矮一截（米家面板实测过的同一现象）。
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

// === 配置视图：欢迎页/品牌卡引导（未配置）与 集成管理/表单（已连接） ===

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

/** 连接表单：未配置是「连接」，已连接是「保存」（重新探活并落库）。 */
function buildConnectCard(message) {
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

  const button = el("button", "primary", "连接");
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
  return card;
}

function renderSetup(message) {
  state.view = "config";
  const connected = Boolean(state.baseUrl);
  document.body.classList.remove("native-mode");
  clear(els.body);

  if (connected) {
    // 已连接的配置页 = 返回 + 集成，就这两样（2026-10-26 用户口径：
    // 「配置页面只要米家和华为的集成就行了，其他的地址什么的、界面空白时
    // 点开都不要」）。首用接入路径只服务未配置态。
    setState("");
    const back = el("button", "back", "返回");
    back.type = "button";
    back.addEventListener("click", () => renderNative());
    els.body.appendChild(back);
    els.body.appendChild(buildIntegrationsSection());
    return;
  }

  // 未配置：欢迎页 + 品牌卡引导 + 连接表单（首次接入的唯一路径）
  setState("未配置");
  const card = buildConnectCard(message, false);
  els.body.appendChild(buildHero());
  els.body.appendChild(card);
  loadGuide().then((guide) => {
    if (!els.body.contains(card)) return;
    const section = buildGuideSection(guide.brands, guide.steps);
    if (section.childElementCount === 0) return;
    els.body.insertBefore(section, card);
  });
}

// === 集成管理：默认小米/华为，可添加（HA 配置流）与卸载 ===

/** 面板里默认支持的两个品牌（与服务端 integrations 路由同一张表）。 */
const BRAND_LABELS = {
  xiaomi: "米家",
  huawei: "华为",
};
const BRAND_ICONS = {
  xiaomi: "米",
  huawei: "华",
};
const BRAND_DOMAINS = {
  xiaomi: "xiaomi_home",
  huawei: "huawei_smarthome",
};

/**
 * 集成区（常开）：默认小米/华为两行——未添加的**自动发起配置流**并推进到 OAuth
 * 授权步（点「打开授权页」完成授权即添加，回跳后自动推进），已添加可卸载。
 * 打开配置页即拉取列表并自动起流（2026-10-25 用户口径「默认这两个都添加」）。
 */
function buildIntegrationsSection() {
  const box = el("div", "integrations");
  box.appendChild(el("h3", "group", "集成"));
  const body = el("div", "integrations-body");
  box.appendChild(body);
  loadIntegrations(body);
  return box;
}

function integrationRow(body, brand) {
  const item = el("div", "int-item");
  const row = el("div", "int-row");
  row.appendChild(el("span", `brand-icon ${brand}`, BRAND_ICONS[brand] ?? "?"));
  const meta = el("div", "int-meta");
  meta.appendChild(el("span", "int-name", BRAND_LABELS[brand]));
  const status = el("span", "int-status", "…");
  meta.appendChild(status);
  row.appendChild(meta);
  const action = el("button");
  action.type = "button";
  row.appendChild(action);
  item.appendChild(row);
  const slot = el("div", "int-flow");
  item.appendChild(slot);
  body.appendChild(item);
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
          status.textContent = "已添加";
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
          // 未添加：自动发起配置流（2026-10-25「默认这两个都添加」）——
          // 流程在本行内推进到授权步，用户只需完成账号授权
          status.textContent = "连接中…";
          action.hidden = true;
          api("integrations/start", { method: "POST", body: { brand } })
            .then((payload) => {
              status.textContent = "";
              runFlowDialog(slot, payload.flowId, payload.step, () =>
                loadIntegrations(body),
              );
            })
            .catch((error) => {
              status.textContent = "暂不能添加";
              action.hidden = false;
              action.textContent = "重试";
              action.addEventListener("click", () => {
                action.disabled = true;
                api("integrations/start", { method: "POST", body: { brand } })
                  .then((payload) => {
                    status.textContent = "";
                    runFlowDialog(
                      slot,
                      payload.flowId,
                      payload.step,
                      () => loadIntegrations(body),
                    );
                  })
                  .catch((retryError) => {
                    action.disabled = false;
                    showError(retryError.message);
                  });
              });
              if (error.code !== "not_found") showError(error.message);
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

/** HA 配置流字段名 → 中文标签（schema 常只有英文字段名；认不出的照原样显示）。 */
const FIELD_LABELS = {
  account: "华为账号",
  username: "用户名",
  password: "密码",
  code: "验证码",
  challenge_code: "挑战码",
  cloud_server: "登录地区",
  servers: "登录地区",
  integration_language: "语言",
  language: "语言",
  eula: "同意用户协议",
};

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
function runFlowDialog(slot, flowId, step, onDone) {
  let polling = null;
  const stop = () => {
    if (polling) {
      clearInterval(polling);
      polling = null;
    }
  };
  /** 授权等待态：external 与 progress 都可能带授权链接（xiaomi_home 的 OAuth 步
   * 在 HA 2026.10 是 progress_action=oauth 的 progress 步，链接在描述占位里）。
   * 链接用 <a target=_blank>（iframe 里 window.open 易被弹窗策略拦截）。
   * 轮询连续失败（流程过期被 HA 清掉）后提示重开配置页，不死等。 */
  const renderOAuthWait = (current, waiting) => {
    slot.appendChild(el("p", "int-status", waiting));
    const url = authLinkOf(current);
    if (url) {
      const open = el("a", null, "打开授权页");
      open.href = url;
      open.target = "_blank";
      open.rel = "noopener";
      open.className = "int-open";
      slot.appendChild(open);
    }
    let failures = 0;
    polling = setInterval(() => {
      api("integrations/flow", { method: "POST", body: { flowId } })
        .then((payload) => {
          failures = 0;
          if (payload.step.type !== current.type) render(payload.step);
        })
        .catch(() => {
          failures += 1;
          if (failures >= 5) {
            stop();
            clear(slot);
            slot.appendChild(
              el("p", "int-status", "授权已过期，重开配置页可重新发起。"),
            );
          }
        });
    }, 2000);
  };
  const render = (current) => {
    stop();
    clear(slot);
    if (current.type === "create_entry") {
      slot.appendChild(el("p", "int-status", "已添加"));
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
      renderOAuthWait(current, "等待授权完成…");
      return;
    }
    if (current.type === "progress") {
      renderOAuthWait(current, "等待授权完成…");
      return;
    }
    // form：按 data_schema 渲染字段
    const form = el("div", "int-form");
    const inputs = new Map();
    for (const field of current.data_schema ?? []) {
      const line = el("div", "field");
      line.appendChild(el("label", null, FIELD_LABELS[field.name] ?? field.name));
      const input = flowFieldInput(field);
      inputs.set(field.name, input);
      line.appendChild(input);
      form.appendChild(line);
    }
    slot.appendChild(form);
    const submit = el("button", "primary", "提交");
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

// === 原生视图：满幅 iframe，无任何上方套壳条 ===

function renderNative() {
  state.view = "native";
  // 类挂 <body>：native 布局要同时收掉 body 内边距与 header/footer（见 panel.html）
  document.body.classList.add("native-mode");
  setState("");
  clear(els.body);
  const frame = document.createElement("iframe");
  frame.src = state.baseUrl || "";
  frame.title = "Home Assistant";
  frame.referrerPolicy = "no-referrer";
  els.body.appendChild(frame);
}

// === 启动与视图切换 ===

// 宿主标题栏「配置」（面板声明 configurable，PluginPanelOverlay 渲染）经
// postMessage 通知切换：原生 ↔ 配置 互转。
// 来源校验用「发送方必须是父窗口」：宿主页面与面板分属 3300/3301 两个源，
// event.origin 是发送方（3300）的端口，按 location.origin 比对永远不等（真机踩过）。
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  if (event.data?.type !== "kenfutwork:plugin-panel-toggle-config") return;
  setNote("", false);
  if (state.view === "native") renderSetup();
  else renderNative();
});

function boot() {
  setState("加载中…");
  api("config")
    .then((payload) => {
      state.baseUrl = payload.baseUrl || "";
      state.defaultBaseUrl = payload.defaultBaseUrl || "";
      if (!payload.configured) {
        renderSetup();
        return;
      }
      // 已配置：直接进原生界面（iframe 用 HA 自己的登录态；免登陆由 HA 侧
      // trusted_networks 提供，见配置页通用步骤）
      renderNative();
    })
    .catch((error) => showError(error.message));
}

boot();
