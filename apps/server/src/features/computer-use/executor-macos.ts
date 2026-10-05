/**
 * macOS 执行器（A 档）：JXA（AX 树/应用枚举/语义动作）+ nut-js（截屏/坐标鼠标）。
 *
 * TCC 语义：AX 读取与 AXPress/keystroke 需要「辅助功能」授权；截屏需要
 * 「屏幕录制」授权——授权主体是本服务进程（dev 形态 = dev server，桌面形态
 * = 内嵌 server）。权限判定以**内容为准**：截屏黑帧按无权限处理（budget.ts），
 * 权限查询只作提示用（实测两者可能不一致）。
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";

import { readPngWithinBudget } from "./budget.js";
import type {
  ComputerUseExecutor,
  CuAccessStatus,
  CuActionResult,
  CuAppInfo,
  CuDisplay,
  CuInputAction,
  CuObservation,
  CuOperationContext,
  CuRaster,
  CuTreeLimits,
  CuWindowRow,
} from "./executor.js";
import { CU_AX_DEFAULT_LIMITS } from "./executor.js";
import {
  buildDescribeElementScript,
  buildElementActionScript,
  buildElementIdentityScript,
  buildListAppsScript,
  buildListWindowsScript,
  buildObserveScript,
  buildPostEventAccessScript,
  buildResolveWindowScript,
  buildWindowBoundsScript,
  jxaObservationToParts,
  runJxa,
} from "./jxa.js";
import { withMacosClipboardText } from "./macos-clipboard.js";
import { macosMouse } from "./macos-mouse.js";
import { nativeInput } from "./native-input.js";
import type { CuTarget, ParsedAppRef } from "./target.js";

const execFileAsync = promisify(execFile);

/** 进程内帧序号（frameId 单调即可，不跨进程）。 */
let frameSeq = 0;

async function jxaJson<T>(
  script: string,
  timeoutMs: number,
  context?: CuOperationContext,
): Promise<T> {
  return (await runJxa(
    script,
    context?.timeoutMs ?? timeoutMs,
    context?.signal,
    context?.maxOutputBytes,
  )) as T;
}

/** 应用未运行时按 bundleId 拉起后重试一次（getApp 透明拉起语义）。 */
async function ensureAppRunning(
  appRef: ParsedAppRef,
  timeoutMs: number,
  context?: CuOperationContext,
): Promise<void> {
  const args = appRef.bundleId
    ? ["-b", appRef.bundleId]
    : appRef.name
      ? ["-a", appRef.name]
      : undefined;
  if (!args)
    throw Object.assign(new Error("应用未运行且无法按 pid 拉起"), {
      code: "app_not_found",
    });
  await execFileAsync("open", args, {
    timeout: context?.timeoutMs ?? timeoutMs,
    ...(context ? { signal: context.signal } : {}),
  });
}

async function observeWithLaunch(
  appRef: ParsedAppRef,
  timeoutMs: number,
  context?: CuOperationContext,
): Promise<CuObservation> {
  const deadline = Date.now() + (context?.timeoutMs ?? timeoutMs);
  const observe = async () =>
    jxaObservationToParts(
      await jxaJson<unknown>(
        buildObserveScript(appRef, context?.treeLimits),
        timeoutMs,
        context,
      ),
    );
  try {
    return await observe();
  } catch (error) {
    if (
      (error as { code?: string }).code === "app_not_found" &&
      appRef.pid === undefined &&
      appRef.windowId === undefined
    ) {
      await ensureAppRunning(appRef, timeoutMs, context);
      while (Date.now() < deadline) {
        try {
          return await observe();
        } catch (next) {
          if ((next as { code?: string }).code !== "app_not_found") throw next;
        }
        await delay(
          context?.inputDelayMs ??
            AGENT_GOVERNANCE_DEFAULTS.computerUseInputDelayMs,
          undefined,
          { signal: context?.signal },
        );
      }
      throw Object.assign(new Error("应用启动后未在期限内出现可用窗口"), {
        code: "timeout",
        actionSent: false,
      });
    }
    throw error;
  }
}

interface WindowBoundsResult {
  binding?: string;
  bounds?: [number, number, number, number] | null;
}

async function windowBounds(
  appRef: ParsedAppRef,
  timeoutMs: number,
  context?: CuOperationContext,
): Promise<[number, number, number, number]> {
  const observation = await jxaJson<WindowBoundsResult>(
    buildWindowBoundsScript(appRef, context?.binding),
    timeoutMs,
    context,
  );
  const bounds =
    observation.bounds ??
    (observation as { window?: { bounds?: [number, number, number, number] } })
      .window?.bounds;
  if (!bounds) {
    throw Object.assign(new Error("无法读取目标窗口边界"), {
      code: "app_not_found",
    });
  }
  return bounds;
}

export function createMacosExecutor(options?: {
  actionTimeoutMs?: number;
}): ComputerUseExecutor {
  const timeoutMs =
    options?.actionTimeoutMs ??
    AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs;

  const actionError = (error: unknown, fallbackSent: boolean): never => {
    const code =
      typeof (error as { code?: string })?.code === "string"
        ? (error as { code: string }).code
        : /timed?out/i.test(String(error))
          ? "timeout"
          : "internal";
    const wrapped = Object.assign(
      new Error(error instanceof Error ? error.message : String(error)),
      {
        code,
        actionSent:
          (error as { actionSent?: boolean })?.actionSent ??
          (fallbackSent &&
            code !== "app_not_found" &&
            code !== "element_stale"),
      },
    );
    throw wrapped;
  };

  const listDisplays = async (
    context?: CuOperationContext,
  ): Promise<CuDisplay[]> => {
    return jxaJson<CuDisplay[]>(
      `ObjC.import('AppKit');
const screens = $.NSScreen.screens, primaryHeight = Number(screens.objectAtIndex(0).frame.size.height);
const rows = [];
for (let i = 0; i < Number(screens.count); i++) {
  const s = screens.objectAtIndex(i), f = s.frame;
  rows.push({ id: String(s.deviceDescription.objectForKey('NSScreenNumber').intValue),
    name: ObjC.unwrap(s.localizedName), primary: i === 0, scaleFactor: Number(s.backingScaleFactor),
    bounds: [Number(f.origin.x), primaryHeight - Number(f.origin.y) - Number(f.size.height), Number(f.size.width), Number(f.size.height)] });
}
JSON.stringify(rows);`,
      timeoutMs,
      context,
    );
  };
  const geometry = async (
    app: ParsedAppRef,
    context?: CuOperationContext,
  ): Promise<[number, number, number, number]> => {
    if (!app.displayId) return windowBounds(app, timeoutMs, context);
    const display = (await listDisplays(context)).find(
      (row) => row.id === app.displayId,
    );
    if (!display)
      throw Object.assign(new Error("显示器已断开或不存在"), {
        code: "display_not_found",
        actionSent: false,
      });
    return display.bounds;
  };
  const coordinate = async (
    app: ParsedAppRef,
    target: CuTarget,
    context: CuOperationContext,
  ) => {
    if (target.kind !== "coordinate" || !context.raster?.bounds)
      throw Object.assign(new Error("此动作需要当前截图坐标"), {
        code: "invalid_target",
        actionSent: false,
      });
    const current = await geometry(app, context);
    const bounds = context.raster.bounds;
    if (current.some((value, i) => value !== bounds[i]))
      throw Object.assign(new Error("窗口移动或缩放后必须重新截图"), {
        code: "element_stale",
        actionSent: false,
      });
    return {
      x: Math.round(bounds[0] + (target.x * bounds[2]) / context.raster.width),
      y: Math.round(bounds[1] + (target.y * bounds[3]) / context.raster.height),
    };
  };
  const focus = async (app: ParsedAppRef, context: CuOperationContext) => {
    if (app.displayId) return;
    await jxaJson<unknown>(
      `${buildResolveWindowScript(app, context.binding)}
proc.frontmost = true;
win.actions.byName('AXRaise').perform(); JSON.stringify({ok:true});`,
      timeoutMs,
      context,
    );
  };
  const perform = async (
    app: ParsedAppRef,
    action: CuInputAction,
    context: CuOperationContext,
  ): Promise<CuActionResult> => {
    try {
      if (action.kind === "focus") {
        if (app.displayId)
          throw Object.assign(new Error("激活窗口需要应用目标"), {
            code: "invalid_target",
            actionSent: false,
          });
        await focus(app, context);
        return { actionSent: true, detail: "已定位并激活目标窗口" };
      }
      await focus(app, context);
      if (action.kind === "keys")
        await nativeInput({ kind: "keys", keys: action.keys }, context);
      else if (action.kind === "drag") {
        const from = await coordinate(app, action.from, context),
          to = await coordinate(app, action.to, context);
        await macosMouse(
          { kind: "drag", ...from, toX: to.x, toY: to.y },
          context,
          timeoutMs,
        );
      } else if (action.kind === "scroll") {
        const point = action.target
          ? await coordinate(app, action.target, context)
          : {};
        await macosMouse({ ...action, ...point }, context, timeoutMs);
      } else {
        const point = await coordinate(app, action.target, context);
        await macosMouse({ ...action, ...point }, context, timeoutMs);
      }
      return {
        actionSent: true,
        detail: `已下发 ${action.kind}，请重新观察确认结果`,
      };
    } catch (error) {
      return actionError(error, true);
    }
  };

  return {
    id: "macos-coregraphics-jxa",
    available: true,
    perform,

    async accessStatus(context): Promise<CuAccessStatus> {
      const { default: macPermissions } = await import(
        "@computer-use/node-mac-permissions"
      );
      const map = (status: string): CuAccessStatus["accessibility"] =>
        status === "authorized"
          ? "granted"
          : status === "denied"
            ? "denied"
            : "not_determined";
      const accessibility = map(macPermissions.getAuthStatus("accessibility"));
      const screen = map(macPermissions.getAuthStatus("screen"));
      const post = await jxaJson<{ postEventAccess: boolean }>(
        buildPostEventAccessScript(),
        timeoutMs,
        context,
      );
      const postEvents = post.postEventAccess ? "granted" : "denied";
      const missing = [
        accessibility !== "granted" ? "辅助功能（AX 读取与动作）" : null,
        screen !== "granted" ? "屏幕录制（截屏）" : null,
        postEvents !== "granted" ? "输入事件（实际发事件进程）" : null,
      ].filter(Boolean);
      return {
        accessibility,
        screen,
        postEvents,
        hint:
          missing.length > 0
            ? `缺少权限：${missing.join("、")}。在 系统设置 → 隐私与安全性 里为${devFormLabel()}授予后重试（截屏是否可用最终以内容为准）。`
            : "权限查询通过；请用实际观察和输入效果确认桌面能力。",
      };
    },

    async listApps(context): Promise<CuAppInfo[]> {
      const raw = await jxaJson<
        Array<{
          pid: number;
          name: string | null;
          bundleId: string | null;
          active: boolean;
        }>
      >(buildListAppsScript(), timeoutMs, context);
      return raw.map((app) => ({
        pid: app.pid,
        name: app.name,
        bundleId: app.bundleId,
        active: app.active,
      }));
    },

    async listWindows(appRef: ParsedAppRef, context): Promise<CuWindowRow[]> {
      if (appRef.displayId)
        throw Object.assign(new Error("窗口清单需要应用目标"), {
          code: "invalid_target",
          actionSent: false,
        });
      const raw = await jxaJson<
        Array<{
          windowId: number;
          title?: string | null;
          subrole?: string | null;
          bounds?: [number, number, number, number] | null;
          main?: boolean;
          focused?: boolean;
        }>
      >(buildListWindowsScript(appRef), timeoutMs, context);
      return raw.map((win) => ({
        windowId: win.windowId,
        title: win.title ?? null,
        subrole: win.subrole ?? null,
        bounds: win.bounds ?? null,
        main: win.main === true,
        focused: win.focused === true,
      }));
    },

    async observe(appRef: ParsedAppRef, context): Promise<CuObservation> {
      if (appRef.displayId)
        return {
          app: { name: `显示器 ${appRef.displayId}` },
          window: { bounds: await geometry(appRef, context) },
          root: {
            role: "desktop",
            title: "屏幕整体未提供AX树，请选择应用获得元素观察或使用截图",
          },
          accessibility: {
            state: "unavailable",
            reason: "屏幕整体不暴露单应用AX树",
          },
        };
      try {
        return {
          ...(await observeWithLaunch(appRef, timeoutMs, context)),
          treeLimits: context?.treeLimits ?? CU_AX_DEFAULT_LIMITS,
        };
      } catch (error) {
        return actionError(error, false);
      }
    },

    listDisplays,

    async capture(appRef: ParsedAppRef, context): Promise<CuRaster> {
      const directory = await mkdtemp(join(tmpdir(), "kenfutwork-cu-"));
      try {
        if (context) await focus(appRef, context);
        const metadata = appRef.displayId
          ? { bounds: await geometry(appRef, context) }
          : await jxaJson<WindowBoundsResult>(
              buildWindowBoundsScript(appRef, context?.binding),
              timeoutMs,
              context,
            );
        const bounds = metadata.bounds;
        if (!bounds)
          throw Object.assign(new Error("无法读取目标窗口边界"), {
            code: "app_not_found",
            actionSent: false,
          });
        const binding = metadata.binding;
        const file = join(directory, "frame.png");
        await execFileAsync(
          "/usr/sbin/screencapture",
          ["-x", "-R", bounds.join(","), file],
          {
            timeout: context?.timeoutMs ?? timeoutMs,
            ...(context ? { signal: context.signal } : {}),
          },
        );
        const buffer = await readFile(file);
        const image = readPngWithinBudget(
          buffer,
          context?.maxOutputBytes ??
            AGENT_GOVERNANCE_DEFAULTS.processMaxOutputBytes,
        );
        const current = await geometry(
          appRef,
          context ? { ...context, binding } : undefined,
        );
        if (current.some((value, i) => value !== bounds[i]))
          throw Object.assign(new Error("截屏期间窗口移动或缩放，请重新观察"), {
            code: "element_stale",
            actionSent: false,
          });
        return {
          frameId: `frame-${++frameSeq}`,
          mimeType: "image/png",
          width: image.width,
          height: image.height,
          base64: buffer.toString("base64"),
          bounds,
          ...(binding ? { binding } : {}),
          blackFrame: false,
        };
      } catch (error) {
        return actionError(error, false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },

    async click(
      appRef: ParsedAppRef,
      target: CuTarget,
      context,
    ): Promise<CuActionResult> {
      try {
        if (target.kind === "element") {
          const result = await jxaJson<{
            ok: boolean;
            error?: string;
            message?: string;
          }>(
            buildElementActionScript(
              appRef,
              target.index,
              "press",
              context?.treeLimits,
              context?.binding,
              context?.expectedElement,
            ),
            timeoutMs,
            context,
          );
          if (!result.ok) {
            return actionError(
              Object.assign(new Error(result.message ?? "元素动作不可用"), {
                code: result.error ?? "action_unavailable",
              }),
              true,
            );
          }
          return {
            actionSent: true,
            detail: `已对元素 #${target.index} 执行 AXPress`,
          };
        }
        if (!context) throw new Error("坐标输入缺少捕获基准");
        await focus(appRef, context);
        const point = await coordinate(appRef, target, context);
        await macosMouse(
          { kind: "click", ...point, button: "left", count: 1 },
          context,
          timeoutMs,
        );
        return {
          actionSent: true,
          detail: `已点击截图坐标 (${target.x},${target.y})`,
        };
      } catch (error) {
        return actionError(error, true);
      }
    },

    async typeText(
      appRef: ParsedAppRef,
      text: string,
      target?: CuTarget,
      context?: CuOperationContext,
    ): Promise<CuActionResult> {
      try {
        if (appRef.displayId) {
          if (!context) throw new Error("整屏输入缺少控制上下文");
          if (target?.kind === "coordinate") {
            const point = await coordinate(appRef, target, context);
            await macosMouse(
              { kind: "click", ...point, button: "left", count: 1 },
              context,
              timeoutMs,
            );
          }
          await nativeInput({ kind: "text", text }, context);
          return {
            actionSent: true,
            detail: "已向当前焦点输入文本，请重新观察确认",
          };
        }
        if (context) {
          await focus(appRef, context);
          if (target?.kind === "coordinate") {
            const point = await coordinate(appRef, target, context);
            await macosMouse(
              { kind: "click", ...point, button: "left", count: 1 },
              context,
              timeoutMs,
            );
          }
        }
        const needsClipboard = [...text].some(
          (character) => (character.codePointAt(0) ?? 0) > 0x7f,
        );
        const index = target?.kind === "element" ? target.index : undefined;
        const script = buildTypeScript(
          appRef,
          text,
          needsClipboard,
          index,
          context?.treeLimits,
          context?.binding,
          context?.expectedElement,
        );
        const type = async () => {
          const prepared = await jxaJson<{ ok: boolean; message?: string }>(
            script,
            timeoutMs,
            context,
          );
          if (prepared.ok && needsClipboard && context)
            await nativeInput(
              { kind: "keys", keys: ["command", "V"] },
              context,
            );
          return prepared;
        };
        let result: { ok: boolean; message?: string };
        if (needsClipboard) {
          if (!context) throw new Error("Unicode输入缺少控制上下文");
          result = await withMacosClipboardText(text, context, timeoutMs, type);
        } else result = await type();
        if (!result.ok) {
          return actionError(
            Object.assign(new Error(result.message ?? "输入失败"), {
              code: "action_unavailable",
            }),
            true,
          );
        }
        return { actionSent: true, detail: `已输入 ${text.length} 个字符` };
      } catch (error) {
        return actionError(error, true);
      }
    },

    async stop(): Promise<void> {
      // A 档无常驻资源：租约与计数在 service 层释放；此处保持 no-op
    },
  };
}

function devFormLabel(): string {
  return "运行KenFutWork的宿主应用（桌面端为KenFutWork，开发时通常为终端）";
}

/** 输入脚本：与观察**同一份遍历实现**定位元素（可缺省=当前焦点）→ set value 或剪贴板粘贴/keystroke。 */
function buildTypeScript(
  appRef: ParsedAppRef,
  text: string,
  viaClipboard: boolean,
  index: number | undefined,
  limits: CuTreeLimits = CU_AX_DEFAULT_LIMITS,
  binding?: string,
  expectedElement?: CuOperationContext["expectedElement"],
): string {
  return `
${buildResolveWindowScript(appRef, binding)}
${buildDescribeElementScript(limits)}
${buildElementIdentityScript(expectedElement)}
let target = null;
if (${index ?? -1} >= 0) {
  const root = describeElementEx(win, 0, ${limits.maxDepth});
  if (root) {
    let counter = 0;
    const visit = (result) => {
      if (target) return;
      if (counter === ${index ?? -1}) { checkElementIdentity(result.node); target = result.elm; return; }
      counter++;
      for (const child of (result._children || [])) {
        visit(child);
        if (target) return;
      }
    };
    visit(root);
  }
} else {
  target = win;
}
if (!target) {
  JSON.stringify({ ok: false, message: '找不到目标元素' });
} else {
  try {
    $.NSRunningApplication.runningApplicationWithProcessIdentifier(proc.unixId()).activateWithOptions(0);
  } catch (e) {}
  let typed = false, why = '';
  ${
    viaClipboard
      ? `try {
    target.attributes.byName('AXFocused').value = true;
  } catch (e0) { try { target.focused = true; } catch (e1) {} }
  typed = true;`
      : `try {
    target.value = ${JSON.stringify(text)};
    typed = true;
  } catch (e1) {
    why = String(e1);
    try {
      target.actions['AXPress'].perform();
      se.keystroke(${JSON.stringify(text)});
      typed = true;
    } catch (e2) { why = String(e2); }
  }`
  }
  JSON.stringify(typed ? { ok: true } : { ok: false, message: why });
}
`;
}
