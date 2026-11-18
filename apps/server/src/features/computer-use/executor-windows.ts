/**
 * Windows 执行器：UIAutomation + 本机 PowerShell，不使用 TCC Helper。
 *
 * 边界：进程始终以当前用户权限运行，不自动请求 UAC 提权；目标应用以管理员运行时
 * 受 UIPI/安全桌面限制，原语失败按 `native_failed` 返回，由模型或用户决定是否
 * 手动以管理员身份启动目标应用。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import {
  type ComputerUseExecutor,
  CU_AX_DEFAULT_LIMITS,
  type CuActionResult,
  type CuAppInfo,
  type CuDisplay,
  type CuInputAction,
  type CuObservation,
  type CuOperationContext,
  type CuWindowRow,
} from "./executor.js";
import type { CuTarget, ParsedAppRef } from "./target.js";
import { WindowsHost, type WindowsHostResponse } from "./windows-host.js";

const READ_ONLY_OPERATIONS = new Set([
  "status",
  "apps",
  "windows",
  "observe",
  "capture",
  "geometry",
  "displays",
]);

export async function createWindowsExecutor(): Promise<ComputerUseExecutor> {
  const defaults = AGENT_GOVERNANCE_DEFAULTS;
  // 常驻后端：脚本以 -Serve 起动后只编译一次 C#，后续动作不再重启 PowerShell。
  const host = new WindowsHost(() =>
    spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Sta",
        "-File",
        fileURLToPath(new URL("./windows-native.ps1", import.meta.url)),
        "-Serve",
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    ),
  );
  const call = async <T>(
    operation: string,
    input: Record<string, unknown> = {},
    context?: CuOperationContext,
  ): Promise<T> => {
    const response: WindowsHostResponse = await host.call<T>(
      {
        operation,
        ...input,
        ...(context?.binding ? { expectedBinding: context.binding } : {}),
        limits: context?.treeLimits ?? CU_AX_DEFAULT_LIMITS,
        delay: context?.inputDelayMs ?? defaults.computerUseInputDelayMs,
        maxOutputBytes:
          context?.maxOutputBytes ?? defaults.processMaxOutputBytes,
      },
      {
        timeoutMs: context?.timeoutMs ?? defaults.computerUseActionTimeoutMs,
        ...(context?.signal ? { signal: context.signal } : {}),
      },
    );
    if (!response.ok) {
      const message = response.error ?? "Windows桌面原语失败";
      throw Object.assign(new Error(message), {
        code: message.match(/^([a-z_]+):/)?.[1] ?? "native_failed",
        actionSent: response.actionSent ?? !READ_ONLY_OPERATIONS.has(operation),
      });
    }
    return response.result as T;
  };
  // 首次调用要现场编译 C#，并行启动或安全软件扫描可能造成一次瞬时失败；
  // 只重试启动探针，真实桌面操作不自动重放。
  try {
    await call("status");
  } catch {
    await call("status");
  }
  const geometry = async (
    app: ParsedAppRef,
    context?: CuOperationContext,
  ): Promise<{ bounds: [number, number, number, number]; binding: string }> => {
    if (app.displayId) {
      const display = (await call<CuDisplay[]>("displays", {}, context)).find(
        (row) => row.id === app.displayId,
      );
      if (!display)
        throw Object.assign(new Error("显示器已断开"), {
          code: "display_not_found",
          actionSent: false,
        });
      return { bounds: display.bounds, binding: display.id };
    }
    return call("geometry", { app }, context);
  };
  const point = async (
    app: ParsedAppRef,
    target: CuTarget,
    context: CuOperationContext,
  ) => {
    if (target.kind !== "coordinate" || !context.raster?.bounds)
      throw Object.assign(new Error("Windows指针动作需要当前截图"), {
        code: "invalid_target",
        actionSent: false,
      });
    const current = await geometry(app, context),
      bounds = context.raster.bounds;
    if (
      current.bounds.some((value, i) => value !== bounds[i]) ||
      (context.raster.binding && current.binding !== context.raster.binding)
    )
      throw Object.assign(new Error("窗口/进程身份或几何已变化，请重新观察"), {
        code: "element_stale",
        actionSent: false,
      });
    return {
      x: Math.round(bounds[0] + (target.x * bounds[2]) / context.raster.width),
      y: Math.round(bounds[1] + (target.y * bounds[3]) / context.raster.height),
    };
  };
  const focus = async (app: ParsedAppRef, context?: CuOperationContext) => {
    if (!app.displayId) await call("focus", { app }, context);
  };
  const perform = async (
    app: ParsedAppRef,
    action: CuInputAction,
    context: CuOperationContext,
  ): Promise<CuActionResult> => {
    try {
      if (action.kind === "focus") {
        await focus(app, context);
        return { actionSent: true, detail: "已激活目标窗口" };
      }
      if (action.kind === "keys")
        return await call(
          "keys",
          { app, keys: action.keys, activate: true },
          context,
        );
      if (action.kind === "drag") {
        const from = await point(app, action.from, context),
          to = await point(app, action.to, context);
        return await call(
          "drag",
          { app, ...from, toX: to.x, toY: to.y, activate: true },
          context,
        );
      }
      if (action.kind === "scroll") {
        const at = action.target
          ? await point(app, action.target, context)
          : {};
        return await call(
          "scroll",
          {
            app,
            ...at,
            direction: action.direction,
            amount: action.amount,
            activate: true,
          },
          context,
        );
      }
      return await call(
        action.kind,
        {
          app,
          ...(await point(app, action.target, context)),
          ...(action.kind === "click"
            ? { button: action.button, count: action.count }
            : {}),
          activate: true,
        },
        context,
      );
    } finally {
      if (context.signal.aborted)
        await call(
          "release",
          { ...(action.kind === "keys" ? { keys: action.keys } : {}) },
          { ...context, signal: new AbortController().signal },
        );
    }
  };
  return {
    id: "windows-uia-user32",
    available: true,
    accessStatus: (context) => call("status", {}, context),
    listApps: (context) => call<CuAppInfo[]>("apps", {}, context),
    listDisplays: (context) => call<CuDisplay[]>("displays", {}, context),
    listWindows: (app, context) =>
      call<CuWindowRow[]>("windows", { app }, context),
    observe: async (app, context) => ({
      ...(await call<CuObservation>("observe", { app }, context)),
      treeLimits: context?.treeLimits ?? CU_AX_DEFAULT_LIMITS,
    }),
    capture: async (app, context) => {
      await focus(app, context);
      return {
        ...(await call<{
          width: number;
          height: number;
          base64: string;
          bounds: [number, number, number, number];
          binding: string;
        }>("capture", { app }, context)),
        frameId: randomUUID(),
        mimeType: "image/png",
        blackFrame: false,
      };
    },
    click: async (app, target, context) => {
      if (!context) throw new Error("Windows动作缺少控制上下文");
      if (target.kind === "element")
        return call("element", { app, index: target.index }, context);
      return perform(
        app,
        { kind: "click", target, count: 1, button: "left" },
        context,
      );
    },
    typeText: async (app, text, target, context) => {
      if (!context) throw new Error("Windows输入缺少控制上下文");
      if (target?.kind === "element")
        return call("element", { app, index: target.index, text }, context);
      if (target)
        await perform(
          app,
          { kind: "click", target, count: 1, button: "left" },
          context,
        );
      try {
        return await call("type", { app, text, activate: true }, context);
      } finally {
        if (context.signal.aborted)
          await call(
            "release",
            {},
            { ...context, signal: new AbortController().signal },
          );
      }
    },
    perform,
    stop: async () => {
      await host.stop();
    },
  };
}
