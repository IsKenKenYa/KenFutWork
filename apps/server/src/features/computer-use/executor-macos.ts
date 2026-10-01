/**
 * macOS 执行器（A 档）：JXA（AX 树/应用枚举/语义动作）+ nut-js（截屏/坐标鼠标）。
 *
 * TCC 语义：AX 读取与 AXPress/keystroke 需要「辅助功能」授权；截屏需要
 * 「屏幕录制」授权——授权主体是本服务进程（dev 形态 = dev server，桌面形态
 * = 内嵌 server）。权限判定以**内容为准**：截屏黑帧按无权限处理（budget.ts），
 * 权限查询只作提示用（实测两者可能不一致）。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { PNG } from "pngjs";

import { blackFrameRatio } from "./budget.js";
import type {
  ComputerUseExecutor,
  CuAppInfo,
  CuAccessStatus,
  CuActionResult,
  CuObservation,
  CuRaster,
  CuWindowRow,
} from "./executor.js";
import {
  AX_MAX_DEPTH,
  buildElementActionScript,
  buildListAppsScript,
  buildListWindowsScript,
  buildObserveScript,
  JXA_DESCRIBE_ELEMENT,
  jxaObservationToParts,
  runJxa,
  toJxaAppSelector,
} from "./jxa.js";
import type { CuTarget, ParsedAppRef } from "./target.js";

const execFileAsync = promisify(execFile);

/** pbcopy 走 stdin（promisify 的 execFile 重载不吃 options.input）。 */
function writeStdin(file: string, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, [], (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/** 进程内帧序号（frameId 单调即可，不跨进程）。 */
let frameSeq = 0;

async function jxaJson<T>(script: string, timeoutMs: number): Promise<T> {
  return (await runJxa(script, timeoutMs)) as T;
}

/** 应用未运行时按 bundleId 拉起后重试一次（getApp 透明拉起语义）。 */
async function ensureAppRunning(
  appRef: ParsedAppRef,
  timeoutMs: number,
): Promise<void> {
  if (appRef.bundleId) {
    await execFileAsync("open", ["-b", appRef.bundleId]);
    // 拉起是异步的：给系统一点时间再重试观察（局部等待，非治理语义）
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return;
  }
  if (appRef.name) {
    await execFileAsync("open", ["-a", appRef.name]);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return;
  }
  throw Object.assign(new Error("应用未运行且无法按 pid 拉起"), { code: "app_not_found" });
}

async function observeWithLaunch(
  appRef: ParsedAppRef,
  timeoutMs: number,
): Promise<CuObservation> {
  try {
    return jxaObservationToParts(
      await jxaJson<unknown>(buildObserveScript(appRef), timeoutMs),
    );
  } catch (error) {
    if (/undefined|not found|Can't get|无法/gi.test(String(error))) {
      await ensureAppRunning(appRef, timeoutMs);
      return jxaObservationToParts(
        await jxaJson<unknown>(buildObserveScript(appRef), timeoutMs),
      );
    }
    throw error;
  }
}

interface WindowBoundsResult {
  bounds?: [number, number, number, number] | null;
}

async function windowBounds(
  appRef: ParsedAppRef,
  timeoutMs: number,
): Promise<[number, number, number, number]> {
  const observation = await jxaJson<WindowBoundsResult>(
    buildObserveScript(appRef),
    timeoutMs,
  );
  const bounds = observation.bounds ?? (observation as { window?: { bounds?: [number, number, number, number] } }).window?.bounds;
  if (!bounds) {
    throw Object.assign(new Error("无法读取目标窗口边界"), { code: "app_not_found" });
  }
  return bounds;
}

export async function rgbToPngBase64(
  rgb: Uint8Array,
  width: number,
  height: number,
): Promise<string> {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += 3) {
    const k = i * 4;
    rgba[k] = rgb[j] ?? 0;
    rgba[k + 1] = rgb[j + 1] ?? 0;
    rgba[k + 2] = rgb[j + 2] ?? 0;
    rgba[k + 3] = 255;
  }
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba.buffer);
  return PNG.sync.write(png).toString("base64");
}

export function createMacosExecutor(options?: {
  actionTimeoutMs?: number;
}): ComputerUseExecutor {
  const timeoutMs = options?.actionTimeoutMs ?? 10_000;

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
        actionSent: fallbackSent && code !== "app_not_found",
      },
    );
    throw wrapped;
  };

  return {
    id: "macos-jxa-nutjs",
    available: true,

    async accessStatus(): Promise<CuAccessStatus> {
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
      const missing = [
        accessibility !== "granted" ? "辅助功能（AX 读取与动作）" : null,
        screen !== "granted" ? "屏幕录制（截屏）" : null,
      ].filter(Boolean);
      return {
        accessibility,
        screen,
        hint:
          missing.length > 0
            ? `缺少权限：${missing.join("、")}。在 系统设置 → 隐私与安全性 里为${devFormLabel()}授予后重试（截屏是否可用最终以内容为准）。`
            : "权限查询通过；截屏能力以实际内容（黑帧检测）为准。",
      };
    },

    async listApps(): Promise<CuAppInfo[]> {
      const raw = await jxaJson<
        Array<{ pid: number; name: string | null; bundleId: string | null; active: boolean }>
      >(buildListAppsScript(), timeoutMs);
      return raw.map((app) => ({
        pid: app.pid,
        name: app.name,
        bundleId: app.bundleId,
        active: app.active,
      }));
    },

    async listWindows(appRef: ParsedAppRef): Promise<CuWindowRow[]> {
      const raw = await jxaJson<
        Array<{
          title?: string | null;
          subrole?: string | null;
          bounds?: [number, number, number, number] | null;
          main?: boolean;
          focused?: boolean;
        }>
      >(buildListWindowsScript(appRef), timeoutMs);
      return raw.map((win, i) => ({
        windowId: i,
        title: win.title ?? null,
        subrole: win.subrole ?? null,
        bounds: win.bounds ?? null,
        main: win.main === true,
        focused: win.focused === true,
      }));
    },

    async observe(appRef: ParsedAppRef): Promise<CuObservation> {
      try {
        return await observeWithLaunch(appRef, timeoutMs);
      } catch (error) {
        return actionError(error, false);
      }
    },

    async capture(appRef: ParsedAppRef): Promise<CuRaster> {
      try {
        const [x = 0, y = 0, w = 1, h = 1] = await windowBounds(appRef, timeoutMs);
        const { screen, Region } = await import("@computer-use/nut-js");
        // grabRegion(Region)：窗口级截屏（隐私默认——不抓全屏）
        const image = await screen.grabRegion(
          new Region(
            Math.max(0, Math.floor(x)),
            Math.max(0, Math.floor(y)),
            Math.max(1, Math.floor(w)),
            Math.max(1, Math.floor(h)),
          ),
        );
        const rgb = new Uint8Array(image.data);
        const base64 = await rgbToPngBase64(rgb, image.width, image.height);
        frameSeq += 1;
        return {
          frameId: `frame-${frameSeq}`,
          mimeType: "image/png",
          width: image.width,
          height: image.height,
          base64,
          blackFrame: blackFrameRatio(rgb) >= 0.995,
        };
      } catch (error) {
        return actionError(error, false);
      }
    },

    async click(appRef: ParsedAppRef, target: CuTarget): Promise<CuActionResult> {
      try {
        if (target.kind === "element") {
          const result = await jxaJson<{
            ok: boolean;
            error?: string;
            message?: string;
          }>(buildElementActionScript(appRef, target.index, "press"), timeoutMs);
          if (!result.ok) {
            return actionError(
              Object.assign(
                new Error(result.message ?? "元素动作不可用"),
                { code: result.error ?? "action_unavailable" },
              ),
              true,
            );
          }
          return { actionSent: true, detail: `已对元素 #${target.index} 执行 AXPress` };
        }
        const [bx = 0, by = 0] = await windowBounds(appRef, timeoutMs);
        const { mouse } = await import("@computer-use/nut-js");
        await mouse.setPosition({
          x: bx + target.x,
          y: by + target.y,
        } as unknown as Parameters<typeof mouse.setPosition>[0]);
        await mouse.leftClick();
        return {
          actionSent: true,
          detail: `已点击窗口内坐标 (${target.x},${target.y})`,
        };
      } catch (error) {
        return actionError(error, true);
      }
    },

    async typeText(
      appRef: ParsedAppRef,
      text: string,
      target?: CuTarget,
    ): Promise<CuActionResult> {
      try {
        // Unicode/中文走剪贴板通道：先备份原剪贴板，Cmd+V 输入后还原
        const needsClipboard = /[^\x00-\x7F]/.test(text);
        let clipboardBackup: string | null = null;
        if (needsClipboard) {
          try {
            const { stdout } = await execFileAsync("pbpaste");
            clipboardBackup = stdout;
          } catch {
            clipboardBackup = null;
          }
          await writeStdin("pbcopy", text);
        }
        const index = target?.kind === "element" ? target.index : undefined;
        const script = buildTypeScript(appRef, text, needsClipboard, index);
        const result = await jxaJson<{ ok: boolean; message?: string }>(
          script,
          timeoutMs,
        );
        if (needsClipboard && clipboardBackup != null) {
          await writeStdin("pbcopy", clipboardBackup);
        }
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
  return process.env.KENFUTWORK_DEPLOYMENT === "desktop"
    ? "KenFutWork 桌面端"
    : "运行 KenFutWork 服务端的应用（dev 形态通常是终端）";
}

/** 输入脚本：与观察**同一份遍历实现**定位元素（可缺省=当前焦点）→ set value 或剪贴板粘贴/keystroke。 */
function buildTypeScript(
  appRef: ParsedAppRef,
  text: string,
  viaClipboard: boolean,
  index: number | undefined,
): string {
  return `
ObjC.import('AppKit');
const se = Application('System Events');
const proc = ${toJxaAppSelector(appRef)};
${JXA_DESCRIBE_ELEMENT}
const win = proc.windows[0];
let target = null;
if (${index ?? -1} >= 0) {
  const root = describeElementEx(win, 0, ${AX_MAX_DEPTH});
  if (root) {
    let counter = 0;
    const visit = (result) => {
      if (target) return;
      if (counter === ${index ?? -1}) { target = result.elm; return; }
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
    target.actions['AXPress'].perform();
  } catch (e0) {}
  try {
    se.keystroke('v', { using: ['command down'] });
    typed = true;
  } catch (e) { why = String(e); }`
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
