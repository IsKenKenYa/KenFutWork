// KiCad 原理图编辑器（自建 web 版）。
//
// 为什么自建：KiCad 是 Qt 原生应用，没有官方 web 构建；要「内嵌进 Work 主区 + 中文
// 界面 + agent 可操纵」，只能自己实现一个能读写 .kicad_sch 的编辑器。
// 文件格式是 S-expression，不需要 KiCad 运行时：解析 → 画 → 改 → 写回。
//
// 对外接口（宿主与 agent 共用）：window.eda
//   load(text, name)      载入原理图文本
//   dump()                导出当前原理图文本
//   list()                元件清单 [{ref, value, libId, x, y}]
//   move(ref, x, y)       移动元件（mm，图坐标）
//   add(libId, ref, value, x, y)  添加元件（libId 需在库符号表内）
//   select(ref) / fit()

(() => {
  "use strict";

  // ---------- S-expression ----------

  function tokenize(text) {
    const out = [];
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === "(" || c === ")") { out.push(c); i += 1; continue; }
      if (c === '"') {
        let j = i + 1;
        let s = "";
        while (j < text.length) {
          if (text[j] === "\\") { s += text[j + 1] ?? ""; j += 2; continue; }
          if (text[j] === '"') break;
          s += text[j];
          j += 1;
        }
        out.push({ str: s });
        i = j + 1;
        continue;
      }
      if (/\s/.test(c)) { i += 1; continue; }
      let j = i;
      while (j < text.length && !/[\s()"]/.test(text[j])) j += 1;
      out.push(text.slice(i, j));
      i = j;
    }
    return out;
  }

  function parse(text) {
    const tokens = tokenize(text);
    let p = 0;
    const read = () => {
      const t = tokens[p];
      if (t === undefined) return null;
      p += 1;
      if (t === "(") {
        const list = [];
        while (p < tokens.length && tokens[p] !== ")") list.push(read());
        p += 1;
        return list;
      }
      return t;
    };
    while (p < tokens.length) {
      const node = read();
      if (Array.isArray(node)) return node;
    }
    return null;
  }

  const isList = (n) => Array.isArray(n);
  const head = (n) => (isList(n) ? n[0] : undefined);
  const atom = (n) => (isList(n) ? (n[1]?.str ?? n[1]) : n?.str ?? n);
  const num = (n) => { const v = atom(n); const f = Number(v); return Number.isFinite(f) ? f : 0; };

  function children(node, name) {
    return (node ?? []).filter((n) => isList(n) && head(n) === name);
  }
  function child(node, name) {
    return (node ?? []).find((n) => isList(n) && head(n) === name) ?? null;
  }
  function quoted(value) {
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  function serialize(node) {
    if (!isList(node)) {
      if (node && typeof node === "object" && "str" in node) return quoted(node.str);
      return String(node);
    }
    return `(${node.map(serialize).join(" ")})`;
  }

  // ---------- 模型 ----------

  /** 库符号：lib_id → { graphics[], pins[] }，坐标是符号本地 mm。 */
  function readLibSymbols(root) {
    const out = new Map();
    const block = child(root, "lib_symbols");
    if (!block) return out;
    for (const sym of children(block, "symbol")) {
      const name = atom(sym[1]);
      const graphics = [];
      const pins = [];
      // 子单元 "R_0_1" / "R_1_1"：都以父符号名为前缀，全部画出来。
      for (const unit of children(sym, "symbol")) {
        for (const g of unit) {
          if (!isList(g)) continue;
          const kind = head(g);
          if (kind === "rectangle") {
            const s = child(g, "start"), e = child(g, "end");
            graphics.push({ kind: "rect", x1: num(s[1]), y1: num(s[2]), x2: num(e[1]), y2: num(e[2]) });
          } else if (kind === "polyline") {
            const pts = child(g, "pts");
            graphics.push({ kind: "poly", pts: children(pts, "xy").map((q) => [num(q[1]), num(q[2])]) });
          } else if (kind === "circle") {
            const c = child(g, "center");
            graphics.push({ kind: "circle", cx: num(c[1]), cy: num(c[2]), r: num(child(g, "radius")[1]) });
          } else if (kind === "arc") {
            const s = child(g, "start"), m = child(g, "mid"), e = child(g, "end");
            graphics.push({
              kind: "arc",
              start: [num(s[1]), num(s[2])],
              mid: [num(m[1]), num(m[2])],
              end: [num(e[1]), num(e[2])],
            });
          } else if (kind === "pin") {
            const at = child(g, "at");
            pins.push({ x: num(at[1]), y: num(at[2]), angle: num(at[3]), length: num(child(g, "length")?.[1]) });
          } else if (kind === "text") {
            graphics.push({ kind: "text", text: atom(g[1]), x: num(child(g, "at")?.[1]), y: num(child(g, "at")?.[2]) });
          }
        }
      }
      out.set(name, { graphics, pins });
    }
    return out;
  }

  function propertyOf(sym, key) {
    for (const p of children(sym, "property")) {
      if (atom(p[1]) === key) return atom(p[2]);
    }
    return "";
  }

  function readParts(root) {
    return children(root, "symbol")
      .filter((s) => child(s, "lib_id"))
      .map((s) => {
        const at = child(s, "at");
        return {
          node: s,
          libId: atom(child(s, "lib_id")[1]),
          ref: propertyOf(s, "Reference"),
          value: propertyOf(s, "Value"),
          x: num(at?.[1]),
          y: num(at?.[2]),
          angle: num(at?.[3]),
        };
      });
  }

  function readWires(root) {
    return children(root, "wire").map((w) => {
      const pts = child(w, "pts");
      return { node: w, pts: children(pts, "xy").map((q) => [num(q[1]), num(q[2])]) };
    });
  }

  // ---------- 变换 ----------

  /** 符号本地 → 图坐标：KiCad 的 Y 轴向下，角度是逆时针度数。 */
  function place(px, py, part) {
    const rad = (part.angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // 屏幕 Y 向下，故逆时针旋转在屏幕上表现为顺时针：y 分量取负号。
    const rx = px * cos + py * sin;
    const ry = -px * sin + py * cos;
    return [part.x + rx, part.y + ry];
  }

  // ---------- 渲染 ----------

  const state = {
    root: null,
    name: null,
    libs: new Map(),
    parts: [],
    wires: [],
    selected: null,
    scale: 6,
    ox: 0,
    oy: 0,
    dpr: 1,
  };

  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const elParts = document.getElementById("parts");
  const elFile = document.getElementById("file");
  const elPos = document.getElementById("pos");
  const elSel = document.getElementById("sel");
  const elEmpty = document.getElementById("empty");

  function resize() {
    const rect = canvas.getBoundingClientRect();
    state.dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * state.dpr));
    canvas.height = Math.max(1, Math.round(rect.height * state.dpr));
    draw();
  }

  const toScreen = (x, y) => [x * state.scale + state.ox, y * state.scale + state.oy];
  const toWorld = (sx, sy) => [(sx - state.ox) / state.scale, (sy - state.oy) / state.scale];

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#16181d";
    ctx.fillRect(0, 0, w, h);
    if (!state.root) return;

    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    const line = Math.max(1, state.scale * 0.16);

    // 图纸边框
    const paper = child(state.root, "paper");
    const size = { A4: [297, 210], A3: [420, 297], A5: [210, 148], Letter: [279.4, 215.9] }[atom(paper?.[1])] ?? [297, 210];
    ctx.strokeStyle = "#3a4150";
    ctx.lineWidth = 1;
    const [px0, py0] = toScreen(0, 0);
    const [px1, py1] = toScreen(size[0], size[1]);
    ctx.strokeRect(px0, py0, px1 - px0, py1 - py0);

    // 导线
    ctx.strokeStyle = "#3fbf6f";
    ctx.lineWidth = line;
    for (const wire of state.wires) {
      ctx.beginPath();
      wire.pts.forEach(([x, y], i) => {
        const [sx, sy] = toScreen(x, y);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.stroke();
    }

    // 元件
    ctx.lineWidth = line;
    for (const part of state.parts) {
      const lib = state.libs.get(part.libId);
      const on = state.selected === part;
      ctx.strokeStyle = on ? "#4c9aff" : "#c6ccd6";
      ctx.fillStyle = "rgba(76, 154, 255, 0.10)";
      if (lib) {
        for (const g of lib.graphics) drawGraphic(g, part, on);
        for (const pin of lib.pins) drawPin(pin, part, on);
      } else {
        // 库里没有这个符号：画个占位框，让人看见「这里有个元件但符号缺失」。
        const [sx, sy] = toScreen(part.x, part.y);
        ctx.strokeRect(sx - 8, sy - 8, 16, 16);
      }
      const [tx, ty] = toScreen(part.x, part.y);
      ctx.fillStyle = on ? "#4c9aff" : "#e6e8ec";
      ctx.font = "11px ui-monospace, Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText(part.ref || part.libId, tx, ty - 14);
      if (part.value) {
        ctx.fillStyle = "#8b93a1";
        ctx.fillText(part.value, tx, ty + 22);
      }
    }
  }

  function drawGraphic(g, part, on) {
    ctx.strokeStyle = on ? "#4c9aff" : "#c6ccd6";
    if (g.kind === "rect") {
      const [ax, ay] = toScreen(...place(g.x1, g.y1, part));
      const [bx, by] = toScreen(...place(g.x2, g.y2, part));
      ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    } else if (g.kind === "poly" && g.pts.length > 1) {
      ctx.beginPath();
      g.pts.forEach(([x, y], i) => {
        const [sx, sy] = toScreen(...place(x, y, part));
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.stroke();
    } else if (g.kind === "circle") {
      const [cx, cy] = toScreen(...place(g.cx, g.cy, part));
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, g.r * state.scale), 0, Math.PI * 2);
      ctx.stroke();
    } else if (g.kind === "arc") {
      const [sx, sy] = toScreen(...place(...g.start, part));
      const [ex, ey] = toScreen(...place(...g.end, part));
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    } else if (g.kind === "text") {
      const [sx, sy] = toScreen(...place(g.x, g.y, part));
      ctx.fillStyle = "#8b93a1";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(g.text, sx, sy);
    }
  }

  function drawPin(pin, part, on) {
    const rad = (pin.angle * Math.PI) / 180;
    // KiCad 的 pin 角度是「Y 向上」语义：90° 指屏幕上方（y 减小），故 sin 取负。
    const ex = pin.x + Math.cos(rad) * pin.length;
    const ey = pin.y - Math.sin(rad) * pin.length;
    const [ax, ay] = toScreen(...place(pin.x, pin.y, part));
    const [bx, by] = toScreen(...place(ex, ey, part));
    ctx.strokeStyle = on ? "#4c9aff" : "#c6ccd6";
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ax, ay, Math.max(1.5, state.scale * 0.22), 0, Math.PI * 2);
    ctx.fillStyle = on ? "#4c9aff" : "#c6ccd6";
    ctx.fill();
  }

  function renderList() {
    elParts.textContent = "";
    for (const part of state.parts) {
      const li = document.createElement("li");
      li.textContent = `${part.ref || "?"} ${part.value}`.trim();
      if (state.selected === part) li.className = "on";
      li.addEventListener("click", () => { select(part); });
      elParts.append(li);
    }
  }

  function select(part) {
    state.selected = part;
    elSel.textContent = part ? `${part.ref || part.libId} @ ${part.x.toFixed(1)}, ${part.y.toFixed(1)}` : "未选中";
    renderList();
    draw();
  }

  // ---------- 交互 ----------

  let dragging = null;
  let panning = null;

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const [wx, wy] = toWorld(mx, my);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    state.scale = Math.min(60, Math.max(0.6, state.scale * factor));
    state.ox = mx - wx * state.scale;
    state.oy = my - wy * state.scale;
    draw();
  }, { passive: false });

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (e.button === 1 || e.button === 2 || spaceDown) {
      panning = { mx, my, ox: state.ox, oy: state.oy };
      canvas.classList.add("pan");
      return;
    }
    const hit = hitTest(mx, my);
    if (hit) {
      select(hit);
      dragging = { part: hit, start: toWorld(mx, my), origin: [hit.x, hit.y] };
    } else {
      select(null);
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const [wx, wy] = toWorld(mx, my);
    elPos.textContent = `${wx.toFixed(1)}, ${wy.toFixed(1)} mm`;
    if (panning) {
      state.ox = panning.ox + (mx - panning.mx);
      state.oy = panning.oy + (my - panning.my);
      draw();
      return;
    }
    if (dragging) {
      const dx = wx - dragging.start[0];
      const dy = wy - dragging.start[1];
      setPartPosition(dragging.part, dragging.origin[0] + dx, dragging.origin[1] + dy);
      draw();
    }
  });

  canvas.addEventListener("pointerup", (e) => {
    canvas.releasePointerCapture(e.pointerId);
    dragging = null;
    panning = null;
    canvas.classList.remove("pan");
  });

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  let spaceDown = false;
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") { spaceDown = true; canvas.classList.add("pan"); }
    if (e.key === "Escape") select(null);
    if (e.key === "f" || e.key === "F") fit();
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") { spaceDown = false; canvas.classList.remove("pan"); }
  });

  /** 命中测试：符号本地包围盒外扩到图坐标。 */
  function hitTest(mx, my) {
    const [wx, wy] = toWorld(mx, my);
    let best = null;
    let bestArea = Infinity;
    for (const part of state.parts) {
      const lib = state.libs.get(part.libId);
      let box = [part.x - 3, part.y - 3, part.x + 3, part.y + 3];
      if (lib) {
        const xs = [];
        const ys = [];
        for (const g of lib.graphics) {
          if (g.kind === "rect") {
            xs.push(...place(g.x1, g.y1, part), ...place(g.x2, g.y2, part));
          } else if (g.kind === "poly") {
            for (const p of g.pts) xs.push(...place(p[0], p[1], part));
          }
        }
        if (xs.length) {
          const px = xs.filter((_, i) => i % 2 === 0);
          const py = xs.filter((_, i) => i % 2 === 1);
          box = [Math.min(...px), Math.min(...py), Math.max(...px), Math.max(...py)];
          ys.length = 0;
        }
      }
      if (wx >= box[0] - 1 && wx <= box[2] + 1 && wy >= box[1] - 1 && wy <= box[3] + 1) {
        const area = (box[2] - box[0]) * (box[3] - box[1]);
        if (area < bestArea) { best = part; bestArea = area; }
      }
    }
    return best;
  }

  /** 写回 AST：改 `<symbol>` 的 `(at x y angle)`，拖动才会落到导出的文本里。 */
  function setPartPosition(part, x, y) {
    part.x = Math.round(x * 100) / 100;
    part.y = Math.round(y * 100) / 100;
    let at = child(part.node, "at");
    if (!at) {
      at = ["at", String(part.x), String(part.y), String(part.angle || 0)];
      part.node.push(at);
    } else {
      at[1] = String(part.x);
      at[2] = String(part.y);
    }
    elSel.textContent = `${part.ref || part.libId} @ ${part.x.toFixed(1)}, ${part.y.toFixed(1)}`;
  }

  function fit() {
    if (!state.parts.length && !state.wires.length) return;
    const xs = [];
    const ys = [];
    for (const part of state.parts) { xs.push(part.x); ys.push(part.y); }
    for (const wire of state.wires) for (const [x, y] of wire.pts) { xs.push(x); ys.push(y); }
    const minX = Math.min(...xs) - 12;
    const maxX = Math.max(...xs) + 12;
    const minY = Math.min(...ys) - 12;
    const maxY = Math.max(...ys) + 12;
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / Math.max(1, maxX - minX);
    const sy = rect.height / Math.max(1, maxY - minY);
    state.scale = Math.min(60, Math.max(0.6, Math.min(sx, sy)));
    state.ox = rect.width / 2 - ((minX + maxX) / 2) * state.scale;
    state.oy = rect.height / 2 - ((minY + maxY) / 2) * state.scale;
    draw();
  }

  // ---------- 载入 / 导出 ----------

  function load(text, name) {
    const root = parse(text);
    if (!root || head(root) !== "kicad_sch") {
      throw new Error("这不是 KiCad 原理图（缺少 kicad_sch 根节点）");
    }
    state.root = root;
    state.name = name || state.name;
    state.libs = readLibSymbols(root);
    state.parts = readParts(root);
    state.wires = readWires(root);
    state.selected = null;
    elFile.textContent = state.name || "未打开文件";
    elEmpty.classList.add("hide");
    elSel.textContent = "未选中";
    renderList();
    fit();
    return { parts: state.parts.length, wires: state.wires.length };
  }

  const dump = () => (state.root ? `${serialize(state.root)}\n` : "");

  /** 实例文档（编辑器与 agent 共用）：GET 读、POST 写。 */
  const DOC_URL = "/api/work/host/eda/document";
  async function loadHostDocument() {
    try {
      const r = await fetch(DOC_URL, { credentials: "include", cache: "no-store" });
      if (!r.ok) return false;
      const text = await r.text();
      if (!text.trim()) return false;
      load(text, "schematic.kicad_sch");
      return true;
    } catch {
      return false;
    }
  }
  async function saveHostDocument() {
    const r = await fetch(DOC_URL, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: dump() }),
    });
    if (!r.ok) throw new Error("保存失败");
  }

  function list() {
    return state.parts.map((p) => ({
      ref: p.ref,
      value: p.value,
      libId: p.libId,
      x: p.x,
      y: p.y,
      angle: p.angle,
    }));
  }

  function move(ref, x, y) {
    const part = state.parts.find((p) => p.ref === ref);
    if (!part) return { ok: false, error: `没有元件 ${ref}` };
    setPartPosition(part, x, y);
    renderList();
    draw();
    return { ok: true };
  }

  /** 在库符号表里找符号，按编号新建实例。 */
  function add(libId, ref, value, x, y) {
    if (!state.root) return { ok: false, error: "没有打开的原理图" };
    if (!state.libs.has(libId)) return { ok: false, error: `库里没有 ${libId}` };
    if (state.parts.some((p) => p.ref === ref)) return { ok: false, error: `编号 ${ref} 已存在` };
    const node = [
      "symbol",
      ["lib_id", quoted(libId)],
      ["at", String(x), String(y), "0"],
      ["unit", "1"],
      ["in_bom", "yes"],
      ["on_board", "yes"],
      ["dnp", "no"],
      ["uuid", quoted(crypto.randomUUID())],
      ["property", quoted("Reference"), quoted(ref), ["at", String(x + 2.54), String(y - 2.54), "0"]],
      ["property", quoted("Value"), quoted(value), ["at", String(x + 2.54), String(y + 2.54), "0"]],
    ];
    state.root.push(node);
    state.parts = readParts(state.root);
    renderList();
    draw();
    return { ok: true, count: state.parts.length };
  }

  function selectByRef(ref) {
    const part = state.parts.find((p) => p.ref === ref);
    if (!part) return { ok: false, error: `没有元件 ${ref}` };
    select(part);
    return { ok: true };
  }

  // ---------- 文件 ----------

  const picker = document.getElementById("picker");
  document.getElementById("open").addEventListener("click", () => picker.click());
  picker.addEventListener("change", async () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (!file) return;
    try {
      load(await file.text(), file.name);
    } catch (error) {
      alert(error instanceof Error ? error.message : "打不开这个文件");
    }
  });

  document.getElementById("save").addEventListener("click", async () => {
    if (!state.root) return;
    try {
      await saveHostDocument();
      elFile.textContent = "已保存";
    } catch {
      // 实例文档写不了（例如直接打开静态站点）：仍走下载，别让改动丢失。
    }
    const name = state.name && state.name.endsWith(".kicad_sch") ? state.name : `${state.name || "schematic"}.kicad_sch`;
    const blob = new Blob([dump()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("zoom-in").addEventListener("click", () => { state.scale = Math.min(60, state.scale * 1.25); draw(); });
  document.getElementById("zoom-out").addEventListener("click", () => { state.scale = Math.max(0.6, state.scale / 1.25); draw(); });
  document.getElementById("fit").addEventListener("click", fit);
  window.addEventListener("resize", resize);

  window.eda = { load, dump, list, move, add, select: selectByRef, fit, loadHostDocument, saveHostDocument };

  resize();

  // 先开实例文档（agent 可能已经写过）；没有才回落到示例——空画布教不了人这个编辑器能干什么。
  loadHostDocument()
    .then((ok) => (ok ? null : fetch("./sample.kicad_sch", { cache: "no-cache" })))
    .then((r) => (r && r.ok ? r.text() : null))
    .then((text) => {
      if (text && !state.root) {
        load(text, "sample.kicad_sch");
        state.name = "未打开文件";
        elFile.textContent = "示例：分压器";
      }
    })
    .catch(() => {});

  // 宿主可直接把原理图文本灌进来（也用于自动化验证）。
  if (window.parent !== window) {
    window.parent.postMessage({ type: "eda-ready" }, window.location.origin);
  }
})();
