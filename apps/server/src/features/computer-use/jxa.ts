/**
 * JXA（osascript -l JavaScript）桥：macOS AX 树读取与应用枚举。
 *
 * 为什么是 JXA：nut-js 没有窗口枚举与无障碍树；System Events 的 AX 读取是
 * macOS 自带能力（零原生依赖），配「辅助功能」授权即可用。性能上限低于原生
 * AXAPI（秒级），里程碑 1 的观察频次完全够用；P3 的 B 档 helper 会替换它。
 *
 * 纯函数（normalizeAxNode / toJxaAppSelector）与副作用（runJxa）分离，
 * 前者是单测主战场。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AxAppRef, AxNode, AxWindowRef } from "./ax-tree.js";
import type { ParsedAppRef } from "./target.js";

const execFileAsync = promisify(execFile);

export interface JxaRawElement {
  role?: string;
  title?: string | null;
  value?: unknown;
  actions?: string[];
  states?: string[];
  children?: JxaRawElement[];
}

export interface JxaRawObservation {
  app: { pid?: number; bundleId?: string | null; name?: string | null };
  window: {
    windowId?: number | null;
    title?: string | null;
    bounds?: [number, number, number, number] | null;
  };
  root: JxaRawElement;
}

const ROLE_ALIASES: Record<string, string> = {
  AXButton: "button",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio",
  AXTextField: "textfield",
  AXTextArea: "textarea",
  AXStaticText: "text",
  AXWindow: "window",
  AXGroup: "group",
  AXScrollArea: "scrollarea",
  AXSplitGroup: "splitgroup",
  AXSplitter: "splitter",
  AXMenu: "menu",
  AXMenuItem: "menuitem",
  AXMenuBar: "menubar",
  AXToolbar: "toolbar",
  AXImage: "image",
  AXList: "list",
  AXTable: "table",
  AXRow: "row",
  AXTabGroup: "tabgroup",
  AXPopUpButton: "popup",
  AXSlider: "slider",
  AXComboBox: "combobox",
  AXOutline: "outline",
  AXLink: "link",
  AXSheet: "sheet",
  AXDialog: "dialog",
};

export function normalizeRole(rawRole: string | undefined): string {
  if (!rawRole) return "unknown";
  return ROLE_ALIASES[rawRole] ?? rawRole.replace(/^AX/, "").toLowerCase();
}

/** JXA 原始元素 → 归一化 AxNode（role 映射 + value/states 提纯）。 */
export function normalizeAxNode(raw: JxaRawElement): AxNode {
  const node: AxNode = {
    role: normalizeRole(raw.role),
    ...(raw.title != null ? { title: raw.title } : {}),
    ...(raw.value != null ? { value: String(raw.value) } : {}),
    ...(raw.actions?.length ? { actions: raw.actions } : {}),
    ...(raw.states?.length ? { states: raw.states } : {}),
  };
  const children = (raw.children ?? [])
    .map((child) => normalizeAxNode(child))
    .filter((child) => child.role !== "unknown" || child.title != null);
  if (children.length > 0) {
    node.children = children;
  }
  return node;
}

/**
 * ParsedAppRef → System Events 进程定位脚本（pid 优先，其次精确名）。
 * 前缀 `se.`：调用方脚本须先 `const se = Application('System Events')`。
 */
export function toJxaAppSelector(appRef: ParsedAppRef): string {
  if (appRef.pid != null) {
    return `se.applicationProcesses.whose({unixId: ${appRef.pid}})[0]`;
  }
  if (appRef.bundleId) {
    return `se.applicationProcesses.whose({bundleIdentifier: "${escapeJxaString(appRef.bundleId)}"})[0]`;
  }
  return `se.applicationProcesses.byName("${escapeJxaString(appRef.name ?? "")}")`;
}

function escapeJxaString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 深度上限：AX 树递归的成本护栏（结构常量，非用户语义数值）。 */
export const AX_MAX_DEPTH = 8;

/**
 * 共享 describeElement：观察/动作/输入三个脚本**同一份**遍历实现——
 * 元素索引的两侧对齐靠它（复制粘贴三份迟早漂移）。
 * 产出 `{ node, _children: [{node, elm}] }`：观察脚本序列化前剥 elm，
 * 动作脚本用 elm 定位目标。
 *
 * 标题解析链：title() → AXIdentifier → description()（Calculator 类自绘按钮
 * 只有 AXIdentifier 有语义值；AXHelp 太长不用）。
 */
export const JXA_DESCRIBE_ELEMENT = `
function cleanActionName(raw) {
  // a.name() 可能返回 "Name:拷贝<LF>Target:0x0<LF>Selector:(null)" 这类完整描述：
  // 取首段并剥 Name: 前缀（注意：模板里的 \\\\n 经两层转义后是 JXA 的字面 \\n）
  const first = String(raw).split('\\n')[0];
  return first.replace(/^Name:/, '').trim();
}
function describeElementEx(elm, depth, maxDepth) {
  if (!elm || depth > maxDepth) return null;
  const node = {};
  try { node.role = elm.role(); } catch (e) {}
  let title = null;
  try {
    const t = elm.title();
    if (typeof t === 'string' && t.length > 0) title = t.slice(0, 200);
  } catch (e) {}
  if (!title) {
    try {
      const id = elm.attributes.byName('AXIdentifier').value();
      if (typeof id === 'string' && id.length > 0 && id !== 'null') {
        // Calculator 类应用的 AXIdentifier 是动态拼接串 "Name;value:当前值"：
        // 拆开成标题与值（对普通 identifier 无副作用）
        const sep = id.indexOf(';value:');
        if (sep > 0) {
          title = id.slice(0, sep).slice(0, 200);
          const embedded = id.slice(sep + 7);
          if (embedded.length > 0 && embedded.length <= 300) node.value = embedded;
        } else {
          title = id.slice(0, 200);
        }
      }
    } catch (e) {}
  }
  if (!title) {
    try {
      const d = elm.description();
      if (typeof d === 'string' && d.length > 0 && d !== '按钮' && d !== 'button') {
        title = d.slice(0, 200);
      }
    } catch (e) {}
  }
  if (title) node.title = title;
  try {
    const v = elm.value();
    if (v !== null && v !== undefined && typeof v !== 'object') {
      node.value = String(v).slice(0, 300);
    }
  } catch (e) {}
  let actionNames = [];
  try {
    actionNames = elm.actions().map(a => cleanActionName(a.name())).filter(n => n.length > 0).slice(0, 12);
    if (actionNames.length) node.actions = actionNames;
  } catch (e) {}
  const states = [];
  if (actionNames.indexOf('AXPress') >= 0) states.push('pressable');
  try { if (elm.focused && elm.focused()) states.push('focused'); } catch (e) {}
  try { if (elm.enabled && elm.enabled() === false) states.push('disabled'); } catch (e) {}
  if (states.length) node.states = states;
  const children = [];
  if (depth < maxDepth) {
    try {
      const kids = elm.uiElements();
      for (let i = 0; i < kids.length && i < 120; i++) {
        const child = describeElementEx(kids[i], depth + 1, maxDepth);
        // 过滤谓词与 normalizeAxNode 一致：无角色且无标题的节点不进树（索引对齐的前提）
        if (child && (child.node.role !== undefined || child.node.title !== undefined)) {
          children.push(child);
        }
      }
    } catch (e) {}
  }
  return {
    node: node,
    _children: children,
    elm: elm,
  };
}
function toPlainElement(result) {
  if (!result) return null;
  const node = result.node;
  if (result._children && result._children.length) {
    node.children = result._children.map(toPlainElement).filter(Boolean);
  }
  return node;
}
`;

export function buildObserveScript(appRef: ParsedAppRef): string {
  const selector = toJxaAppSelector(appRef);
  return `
ObjC.import('Foundation');
const se = Application('System Events');
const proc = ${selector};
${JXA_DESCRIBE_ELEMENT}
function describeWindow(win) {
  const out = {};
  try { out.title = win.title(); } catch (e) {}
  try {
    const pos = win.position(), size = win.size();
    if (pos && size && pos.x !== null && size.width !== null) {
      out.bounds = [pos.x, pos.y, size.width, size.height];
    }
  } catch (e) {}
  return out;
}
const app = { pid: proc.unixId(), name: proc.name() };
try { app.bundleId = proc.bundleIdentifier(); } catch (e) {}
const win = proc.windows[0];
const windowInfo = describeWindow(win);
JSON.stringify({ app, window: windowInfo, root: toPlainElement(describeElementEx(win, 0, ${AX_MAX_DEPTH})) });
`;
}

export function buildListAppsScript(): string {
  return `
ObjC.import('AppKit');
const apps = ObjC.deepUnwrap($.NSWorkspace.sharedWorkspace.runningApplications)
  .filter(a => a.activationPolicy === 0)
  .map(a => ({
    pid: a.processIdentifier,
    name: a.localizedName ? String(a.localizedName) : null,
    bundleId: a.bundleIdentifier ? String(a.bundleIdentifier) : null,
    active: a.active === true,
  }));
JSON.stringify(apps);
`;
}

export function buildListWindowsScript(appRef: ParsedAppRef): string {
  const selector = toJxaAppSelector(appRef);
  return `
const se = Application('System Events');
const proc = ${selector};
const rows = proc.windows().map(win => {
  const out = {};
  try { out.title = win.title(); } catch (e) { out.title = null; }
  try { out.subrole = win.subrole(); } catch (e) { out.subrole = null; }
  try {
    const pos = win.position(), size = win.size();
    out.bounds = [pos.x, pos.y, size.width, size.height];
  } catch (e) { out.bounds = null; }
  try { out.main = win.attributes['AXMain'].value() === true; } catch (e) { out.main = false; }
  try { out.focused = win.attributes['AXFocused'].value() === true; } catch (e) { out.focused = false; }
  return out;
});
JSON.stringify(rows);
`;
}

/** 元素动作脚本：与观察脚本**同一份遍历实现**（JXA_DESCRIBE_ELEMENT），按索引定位并执行语义动作。 */
export function buildElementActionScript(
  appRef: ParsedAppRef,
  index: number,
  action: "press" | "focus",
): string {
  const selector = toJxaAppSelector(appRef);
  return `
const se = Application('System Events');
const proc = ${selector};
${JXA_DESCRIBE_ELEMENT}
const win = proc.windows[0];
const root = describeElementEx(win, 0, ${AX_MAX_DEPTH});
if (!root) {
  JSON.stringify({ ok: false, error: 'element_unavailable' });
} else {
  // 与 flattenAxTree 同序：root=0，随后深度优先
  let counter = 0;
  let target = null;
  const visit = (result) => {
    if (target) return;
    if (counter === ${index}) { target = result.elm; return; }
    counter++;
    for (const child of (result._children || [])) {
      visit(child);
      if (target) return;
    }
  };
  visit(root);
  if (!target) {
    JSON.stringify({ ok: false, error: 'element_unavailable' });
  } else {
    ${
      action === "press"
        ? `let done = false, why = '';
    try { target.actions['AXPress'].perform(); done = true; } catch (e1) { why = String(e1); }
    if (!done) {
      try { target.click(); done = true; } catch (e2) { why = String(e2); }
    }
    JSON.stringify(done ? { ok: true } : { ok: false, error: 'action_unavailable', message: why });`
        : `try { target.actions['AXRaise'].perform(); JSON.stringify({ ok: true }); }
  catch (e) { JSON.stringify({ ok: false, error: 'action_unavailable', message: String(e) }); }`
    }
  }
}
`;
}

/** 运行 JXA 脚本并解析 JSON 结果。 */
export async function runJxa(
  script: string,
  timeoutMs: number,
): Promise<unknown> {
  const { stdout } = await execFileAsync(
    "osascript",
    ["-l", "JavaScript", "-e", script],
    { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout.trim());
}

export function jxaObservationToParts(raw: unknown): {
  app: AxAppRef;
  window: AxWindowRef;
  root: AxNode;
} {
  const obs = raw as JxaRawObservation;
  return {
    app: {
      ...(typeof obs.app.pid === "number" ? { pid: obs.app.pid } : {}),
      ...(obs.app.bundleId != null ? { bundleId: obs.app.bundleId } : {}),
      ...(obs.app.name != null ? { name: obs.app.name } : {}),
    },
    window: {
      ...(obs.window.windowId != null
        ? { windowId: obs.window.windowId }
        : {}),
      ...(obs.window.title != null ? { title: obs.window.title } : {}),
      ...(obs.window.bounds != null ? { bounds: obs.window.bounds } : {}),
    },
    root: normalizeAxNode(obs.root ?? {}),
  };
}
