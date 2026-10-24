/**
 * 智能家居面板页（插件自带，无构建、无外部依赖）。
 *
 * 三种视图：未配置/修改配置（接入引导 + 连接表单）、**HA 原生界面（已连接后的默认
 * 视图，iframe 直接内嵌 HA 自己的前端——用户拍板「要教程里一样的界面」，2026-10-24）**、
 * 精简面板（自绘实体网格，顶栏可互切）。HA 默认发 X-Frame-Options 挡内嵌，被挡时
 * iframe 空白——原生视图自带折叠提示条给两侧的关法（见接入引导「允许面板内嵌」步）。
 *
 * 本机接入由浏览器 HttpOnly cookie 持有，面板不接收也不保管宿主令牌；数据面请求带
 * credentials，由服务端解析稳定实例。HA 令牌只存在服务端插件存储里，面板写入一次后
 * 只显示「已配置」；内嵌的 HA 前端用 HA 自己的登录态（iframe 里登录一次即记住）。
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
  /** 米家/华为实体计数（服务端按注册表 platform 识别）；null = 识别不了，不显示 */
  ecosystems: null,
  /** 当前视图：config（配置/引导）| native（内嵌 HA 原生界面）| grid（自绘实体网格） */
  view: "config",
  busy: false,
  pollTimer: null,
};

const els = {
  state: document.getElementById("state"),
  body: document.getElementById("body"),
  note: document.getElementById("note"),
  toggleView: document.getElementById("toggleView"),
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

/**
 * 三种视图的顶栏按钮：
 * - `config`：只有配置表单（未配置/修改配置），无连接态操作；
 * - `native`：内嵌 HA 原生界面（默认）——可切「精简面板」，不需要「刷新」；
 * - `grid`：自绘实体网格——可切回「原生界面」，要「刷新」。
 */
function setHeaderButtons(view) {
  const connected = view === "native" || view === "grid";
  els.toggleView.hidden = !connected;
  els.toggleView.textContent = view === "native" ? "精简面板" : "原生界面";
  els.refresh.hidden = view !== "grid";
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

/** 引导步骤只拉一次；失败不缓存（下一轮配置态重试），也绝不影响连接表单。 */
let guidePromise = null;
function loadGuideSteps() {
  if (guidePromise) return guidePromise;
  guidePromise = api("guide")
    .then((payload) => (Array.isArray(payload.steps) ? payload.steps : []))
    .catch(() => {
      guidePromise = null;
      return [];
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

/**
 * 接入引导卡：部署 HA → 装 HACS → 接米家（默认展开）→ 接华为（默认展开）→ 建令牌。
 * 步骤数据来自服务端 `guide` 路由（`lib/setup-guide.js` 一处属主，测试锁死仓库链接）。
 */
function buildGuideCard(steps) {
  const card = el("div", "card guide");
  const intro = el("p", "hint intro");
  intro.textContent = "经 Home Assistant 接入米家与华为设备";
  card.appendChild(intro);
  steps.forEach((step, index) => {
    const details = el("details", "step");
    details.open = step.open === true;
    details.appendChild(el("summary", null, `${index + 1}. ${step.title}`));
    const box = el("div", "step-body");
    for (const item of step.items ?? []) {
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
    details.appendChild(box);
    card.appendChild(details);
  });
  return card;
}

function renderConfigForm(message, guideFirst = true) {
  stopPolling();
  state.view = "config";
  setHeaderButtons("config");
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
  // 引导卡与表单同一页：首用引导在上（照着做），「修改配置」时表单在上（直接改）。
  // 异步插入前先确认表单还在页上（期间可能已连上并切到实体网格）
  loadGuideSteps().then((steps) => {
    if (steps.length === 0 || !els.body.contains(card)) return;
    const guideCard = buildGuideCard(steps);
    if (guideFirst) els.body.insertBefore(guideCard, card);
    else els.body.appendChild(guideCard);
  });
}

// === HA 原生界面（内嵌 iframe，已连接后的默认视图） ===

/**
 * 直接内嵌 HA 自己的前端（就是教程里那个界面）。HA 默认发 `X-Frame-Options` 挡内嵌，
 * 被挡时 iframe 表现为空白——折叠提示条给出两侧的关法（新版 UI 开关 / 旧版 yaml），
 * 不让用户面对白屏猜原因。
 */
function renderNative() {
  stopPolling();
  state.view = "native";
  setHeaderButtons("native");
  setState("HA 原生界面");
  clear(els.body);
  const wrap = el("div", "native");

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
}

// === 实体网格（精简面板） ===

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
    return { row, key: node.key, apply, update: (next) => (current = next) };
  }

  if (node.kind === "slider") {
    const input = el("input");
    input.type = "range";
    input.min = String(node.min);
    input.max = String(node.max);
    input.step = String(node.step);
    const valueEl = el("span", "value");
    const apply = (item) => {
      // 拖动中不打断（否则会被上一轮的旧值弹回去）；关灯后没有当前亮度，滑杆停在量程左端
      if (document.activeElement !== input) {
        input.value = String(current.value ?? current.min);
      }
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
    return { row, key: node.key, apply, update: (next) => (current = next) };
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
    return { row, key: node.key, apply, update: (next) => (current = next) };
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
    return { row, key: node.key, apply, update: () => {} };
  }

  // 只读读数（服务端把无控件的实体包成一个 `read` 控件）
  const valueEl = el("span", "value");
  const apply = (item) => {
    valueEl.textContent = `${current.value ?? "—"}${current.unit ? ` ${current.unit}` : ""}`;
    valueEl.className = item.unavailable === true ? "value off" : "value";
  };
  apply(entity);
  row.appendChild(valueEl);
  return { row, key: node.key, apply, update: (next) => (current = next) };
}

function entityCard(entity) {
  const card = el("div", `device${entity.unavailable ? " offline" : ""}`);
  const title = el("h2");
  title.appendChild(el("span", null, entity.name || entity.entityId));
  title.appendChild(el("span", "badge", entity.domain));
  if (entity.unavailable) title.appendChild(el("span", "badge", "离线"));
  card.appendChild(title);

  // 离线的实体不重复出「状态 离线」一行：标题徽章 + 整卡置灰已经说了同一件事
  const rows = (entity.controls ?? [])
    .filter((node) => !(node.kind === "read" && entity.unavailable === true))
    .map((node) => {
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
  state.view = "grid";
  setHeaderButtons("grid");
  // 刷新不动滚动位置：先记后还原（整页滚动，滚动条在 document 上）
  const scroller = document.scrollingElement ?? document.documentElement;
  const scrollTop = scroller.scrollTop;
  const shown = state.groups.reduce(
    (sum, group) => sum + group.items.length,
    0,
  );
  const version = state.version ? `HA ${state.version}` : "智能家居";
  const mode = state.mode === "realtime" ? "实时" : "轮询";
  // 生态计数来自实体注册表的来源集成（服务端识别）；识别不了（null）就不显示，不猜
  const eco =
    state.ecosystems === null
      ? ""
      : ` · 米家 ${state.ecosystems.mijia} · 华为 ${state.ecosystems.huawei}`;
  setState(
    `${version} · ${mode} · ${state.total} 实体${state.truncated ? `（只显示前 ${shown} 条）` : ""}${eco}`,
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
      state.ecosystems = payload.ecosystems ?? null;
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
      setHeaderButtons(state.view === "grid" ? "grid" : "native");
      showError(error.message);
    });
}

els.refresh.addEventListener("click", () => loadEntities());

els.toggleView.addEventListener("click", () => {
  setNote("", false);
  // 原生 ↔ 精简面板互切；切到网格时拉一轮实体（原生视图不轮询）
  if (state.view === "native") {
    loadEntities();
    return;
  }
  renderNative();
});

els.retest.addEventListener("click", () => {
  setState("连接中…");
  api("test", { method: "POST" })
    .then((payload) => {
      state.version = payload.version ?? null;
      setNote("", false);
      if (state.view === "grid") {
        loadEntities();
        return;
      }
      // 原生视图：测通即可，界面本身由 iframe 自己维护
      setState("HA 原生界面");
    })
    .catch((error) => showError(error.message));
});

els.edit.addEventListener("click", () => {
  setNote("", false);
  // 修改配置：表单优先，引导收在下方（首用相反）
  renderConfigForm(undefined, false);
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
      // 已配置：直接进原生界面（iframe 用 HA 自己的登录态，令牌健康度由
      // 「重新测试」与 agent 工具按需暴露，启动期不必先打一轮 REST）
      renderNative();
    })
    .catch((error) => showError(error.message));
}

boot();
