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
import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import type { AxAppRef, AxNode, AxWindowRef } from "./ax-tree.js";
import { CU_AX_DEFAULT_LIMITS, type CuTreeLimits } from "./executor.js";
import type { ParsedAppRef } from "./target.js";

export interface JxaRawElement {
  role?: string;
  title?: string | null;
  value?: unknown;
  actions?: string[];
  states?: string[];
  children?: JxaRawElement[];
}

export interface JxaRawObservation {
  binding?: string;
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
  return JSON.stringify(value).slice(1, -1);
}

/** CGWindowID提供稳定句柄；AX与CG只接受唯一匹配，重排/同名/替换时不猜数组位置。 */
export function buildResolveWindowScript(
  appRef: ParsedAppRef,
  expectedBinding?: string,
): string {
  const hasApp = appRef.pid != null || appRef.bundleId || appRef.name;
  return `
ObjC.import('AppKit'); ObjC.import('CoreGraphics');
ObjC.bindFunction('CGWindowListCopyWindowInfo', ['id', ['uint32', 'uint32']]);
const se = Application('System Events');
const nativeWindows = $.CGWindowListCopyWindowInfo(0, 0), cg = [];
for (let i=0; i<Number(nativeWindows.count); i++) cg.push(ObjC.deepUnwrap(nativeWindows.objectAtIndex(i)));
const expected = ${JSON.stringify(expectedBinding ?? null)};
const bound = expected ? JSON.parse(expected) : null;
const requestedId = ${appRef.windowId ?? "null"} ?? (bound ? bound.windowId : null);
const cgTarget = requestedId === null ? null : cg.find(row => Number(row.kCGWindowNumber) === requestedId);
if (requestedId !== null && !cgTarget) throw new Error('element_stale: 目标窗口已关闭或被替换');
const proc = ${hasApp ? toJxaAppSelector(appRef) : "se.applicationProcesses.whose({unixId: Number(cgTarget.kCGWindowOwnerPID)})[0]"};
let pid;
try { pid=Number(proc.unixId()); } catch(e) { throw new Error('app_not_found: 目标应用未运行'); }
const host = Application.currentApplication(); host.includeStandardAdditions = true;
const launchedAt = host.doShellScript('LC_ALL=C /bin/ps -p '+pid+' -o lstart=').trim();
if (!launchedAt) throw new Error('app_not_found: 无法确认目标进程的启动身份');
if (bound && (bound.pid !== pid || bound.launchedAt !== launchedAt)) throw new Error('element_stale: 目标进程已替换');
if (cgTarget && Number(cgTarget.kCGWindowOwnerPID) !== pid) throw new Error('element_stale: 窗口不属于目标进程');
function windowBounds(win) {
  const p=win.position(), s=win.size(); return [p[0],p[1],s[0],s[1]];
}
function cgBounds(row) {
  const b=row.kCGWindowBounds; return [Number(b.X),Number(b.Y),Number(b.Width),Number(b.Height)];
}
function matches(win, row) {
  const a=windowBounds(win), b=cgBounds(row);
  return a.every((value,i) => value===b[i]);
}
function uniqueMatch(win, rows) {
  let candidates=rows.filter(row => matches(win,row));
  if (candidates.length>1) {
    const title=win.title(); candidates=candidates.filter(row => row.kCGWindowName===title);
  }
  if (candidates.length!==1) throw new Error('element_stale: 无法唯一绑定AX窗口与原生窗口');
  return candidates[0];
}
const windows=proc.windows();
const cgRows=cg.filter(row => Number(row.kCGWindowOwnerPID)===pid && Number(row.kCGWindowLayer)===0);
let win, nativeWindow;
if (cgTarget) {
  const candidates=windows.filter(candidate => {
    // 已验证CG句柄/进程启动身份，AX标题须唯一。窗口移动不改变身份；坐标几何另行复核。
    if (bound && typeof bound.axTitle==='string') {
      try { return candidate.title()===bound.axTitle; } catch(e) { return false; }
    }
    try { return Number(uniqueMatch(candidate,cgRows).kCGWindowNumber)===requestedId; } catch(e) { return false; }
  });
  if (candidates.length!==1) throw new Error('element_stale: 目标窗口没有唯一AX对应');
  win=candidates[0]; nativeWindow=cgTarget;
} else {
  if (!windows.length) throw new Error('app_not_found: 目标应用没有窗口');
  win=windows[0]; nativeWindow=uniqueMatch(win,cgRows);
}
const windowId=Number(nativeWindow.kCGWindowNumber);
const binding=JSON.stringify({pid,launchedAt,windowId,axTitle:win.title()});
if (expected && binding!==expected) throw new Error('element_stale: 窗口绑定已改变');
`;
}

/**
 * 共享 describeElement：观察/动作/输入三个脚本**同一份**遍历实现——
 * 元素索引的两侧对齐靠它（复制粘贴三份迟早漂移）。
 * 产出 `{ node, _children: [{node, elm}] }`：观察脚本序列化前剥 elm，
 * 动作脚本用 elm 定位目标。
 *
 * 标题解析链：title() → AXIdentifier → description()（Calculator 类自绘按钮
 * 只有 AXIdentifier 有语义值；AXHelp 太长不用）。
 */
export function buildDescribeElementScript(
  limits: CuTreeLimits = CU_AX_DEFAULT_LIMITS,
): string {
  return `
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
    if (typeof t === 'string' && t.length > 0) title = t.slice(0, ${limits.titleMaxChars});
  } catch (e) {}
  if (!title) {
    try {
      const id = elm.attributes.byName('AXIdentifier').value();
      if (typeof id === 'string' && id.length > 0 && id !== 'null') {
        // Calculator 类应用的 AXIdentifier 是动态拼接串 "Name;value:当前值"：
        // 拆开成标题与值（对普通 identifier 无副作用）
        const sep = id.indexOf(';value:');
        if (sep > 0) {
          title = id.slice(0, sep).slice(0, ${limits.titleMaxChars});
          const embedded = id.slice(sep + 7);
          if (embedded.length > 0 && embedded.length <= ${limits.valueMaxChars}) node.value = embedded;
        } else {
          title = id.slice(0, ${limits.titleMaxChars});
        }
      }
    } catch (e) {}
  }
  if (!title) {
    try {
      const d = elm.description();
      if (typeof d === 'string' && d.length > 0 && d !== '按钮' && d !== 'button') {
        title = d.slice(0, ${limits.titleMaxChars});
      }
    } catch (e) {}
  }
  if (title) node.title = title;
  try {
    const v = elm.value();
    if (v !== null && v !== undefined && typeof v !== 'object') {
      node.value = String(v).slice(0, ${limits.valueMaxChars});
    }
  } catch (e) {}
  let actionNames = [];
  try {
    actionNames = elm.actions().map(a => cleanActionName(a.name())).filter(n => n.length > 0).slice(0, ${limits.maxActions});
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
      for (let i = 0; i < kids.length && i < ${limits.maxChildren}; i++) {
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
}

export function buildObserveScript(
  appRef: ParsedAppRef,
  limits: CuTreeLimits = CU_AX_DEFAULT_LIMITS,
): string {
  return `
${buildResolveWindowScript(appRef)}
${buildDescribeElementScript(limits)}
function describeWindow(win) {
  const out = {};
  try { out.title = win.title(); } catch (e) {}
  try {
    const pos = win.position(), size = win.size();
    if (pos && size && pos[0] !== null && size[0] !== null) {
      out.bounds = [pos[0], pos[1], size[0], size[1]];
    }
  } catch (e) {}
  return out;
}

const app = { pid: proc.unixId(), name: proc.name() };
try { app.bundleId = proc.bundleIdentifier(); } catch (e) {}
const windowInfo = describeWindow(win);
windowInfo.windowId = windowId;
JSON.stringify({ app, window: windowInfo, binding, root: toPlainElement(describeElementEx(win, 0, ${limits.maxDepth})) });
`;
}

/** 输入前只取几何；不为每次鼠标动作再次递归整个AX树。 */
export function buildWindowBoundsScript(
  appRef: ParsedAppRef,
  binding?: string,
): string {
  return `${buildResolveWindowScript(appRef, binding)}
const position = win.position(), size = win.size();
JSON.stringify({binding,bounds:[position[0],position[1],size[0],size[1]]});`;
}

/** 直接检查发事件的JXA进程；较新C API不在JXA旧bridge元数据中，按SDK声明绑定。 */
export function buildPostEventAccessScript(): string {
  return `ObjC.import('CoreGraphics');
ObjC.bindFunction('CGPreflightPostEventAccess', ['bool', []]);
JSON.stringify({postEventAccess: Boolean($.CGPreflightPostEventAccess())});`;
}

export function buildListAppsScript(): string {
  return `
ObjC.import('AppKit');
const running = $.NSWorkspace.sharedWorkspace.runningApplications;
const apps = [];
for (let i = 0; i < Number(running.count); i++) {
  const a = running.objectAtIndex(i);
  if (Number(a.activationPolicy) !== 0) continue;
  apps.push({
    pid: Number(a.processIdentifier),
    name: ObjC.unwrap(a.localizedName) || null,
    bundleId: ObjC.unwrap(a.bundleIdentifier) || null,
    active: Boolean(a.active),
  });
}
JSON.stringify(apps);
`;
}

export function buildListWindowsScript(appRef: ParsedAppRef): string {
  return `
${buildResolveWindowScript(appRef)}
const rows = windows.map(win => {
  const out = {};
  try { out.windowId = Number(uniqueMatch(win,cgRows).kCGWindowNumber); } catch(e) { return null; }
  try { out.title = win.title(); } catch (e) { out.title = null; }
  try { out.subrole = win.subrole(); } catch (e) { out.subrole = null; }
  try {
    const pos = win.position(), size = win.size();
    out.bounds = [pos[0], pos[1], size[0], size[1]];
  } catch (e) { out.bounds = null; }
  try { out.main = win.attributes['AXMain'].value() === true; } catch (e) { out.main = false; }
  try { out.focused = win.attributes['AXFocused'].value() === true; } catch (e) { out.focused = false; }
  return out;
}).filter(row => row!==null);
JSON.stringify(rows);
`;
}

/** 元素动作脚本：与观察脚本**同一份遍历实现**（JXA_DESCRIBE_ELEMENT），按索引定位并执行语义动作。 */
export function buildElementActionScript(
  appRef: ParsedAppRef,
  index: number,
  action: "press" | "focus",
  limits: CuTreeLimits = CU_AX_DEFAULT_LIMITS,
  binding?: string,
): string {
  return `
${buildResolveWindowScript(appRef, binding)}
${buildDescribeElementScript(limits)}
const root = describeElementEx(win, 0, ${limits.maxDepth});
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
  signal?: AbortSignal,
  maxOutputBytes: number = AGENT_GOVERNANCE_DEFAULTS.processMaxOutputBytes,
): Promise<unknown> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "osascript",
        ["-l", "JavaScript", "-"],
        {
          timeout: timeoutMs,
          maxBuffer: maxOutputBytes,
          ...(signal ? { signal } : {}),
        },
        (error, output, stderr) => {
          if (error) reject(Object.assign(error, { stderr }));
          else resolve(output);
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(script);
    });
    return JSON.parse(stdout.trim());
  } catch (error) {
    const failure = error as {
      stderr?: string;
      signal?: string;
      code?: string | number;
    };
    const reason = failure.stderr?.trim();
    const code = reason?.match(/\b(element_stale|app_not_found):/)?.[1];
    // child_process默认message包含整段脚本（可能含输入文本），不得把它回传到日志/事件。
    throw Object.assign(
      new Error(
        `macOS桥失败：${reason || failure.signal || failure.code || "无有效JSON结果"}`,
      ),
      {
        code: signal?.aborted ? "cancelled" : (code ?? "internal"),
        // 已知绑定拒绝发生在动作前；其它桥失败可能发生在AX动作之后，由调用方保守判定。
        ...(code ? { actionSent: false } : {}),
      },
    );
  }
}

export function jxaObservationToParts(raw: unknown): {
  app: AxAppRef;
  window: AxWindowRef;
  root: AxNode;
  binding?: string;
} {
  const obs = raw as JxaRawObservation;
  return {
    app: {
      ...(typeof obs.app.pid === "number" ? { pid: obs.app.pid } : {}),
      ...(obs.app.bundleId != null ? { bundleId: obs.app.bundleId } : {}),
      ...(obs.app.name != null ? { name: obs.app.name } : {}),
    },
    window: {
      ...(obs.window.windowId != null ? { windowId: obs.window.windowId } : {}),
      ...(obs.window.title != null ? { title: obs.window.title } : {}),
      ...(obs.window.bounds != null ? { bounds: obs.window.bounds } : {}),
    },
    root: normalizeAxNode(obs.root ?? {}),
    ...(obs.binding ? { binding: obs.binding } : {}),
  };
}
