import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AGENT_GOVERNANCE_DEFAULTS as d } from "@kenfutwork/shared";
import type {
  ComputerUseExecutor,
  CuDisplay,
  CuInputAction,
  CuOperationContext,
  CuRaster,
} from "./executor.js";
import type { CuTarget, ParsedAppRef } from "./target.js";

/** portal会话/FD/输入生命周期在helper，权限/预算/Task和结果事件仍在同一Harness。 */
export async function createWaylandExecutor(): Promise<ComputerUseExecutor> {
  let child: ChildProcessWithoutNullStreams | undefined;
  let epoch = randomUUID();
  let buffer = "";
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  let stopping: Promise<void> | undefined;
  let deadlineMs: number = d.computerUseActionTimeoutMs;
  let outputMaxBytes: number = d.processMaxOutputBytes;
  const stop = async () => {
    if (stopping) return stopping;
    const process = child;
    if (!process) return;
    stopping = new Promise<void>((resolve) => {
      const force = setTimeout(() => process.kill("SIGKILL"), deadlineMs);
      process.once("close", () => {
        clearTimeout(force);
        resolve();
      });
      process.kill("SIGTERM");
    }).finally(() => {
      stopping = undefined;
    });
    await stopping;
  };
  const start = () => {
    if (child) return;
    epoch = randomUUID();
    buffer = "";
    const process = spawn(
      "python3",
      [fileURLToPath(new URL("./wayland-portal.py", import.meta.url))],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child = process;
    let diagnostic = "";
    process.stderr.on("data", (data) => {
      diagnostic = String(data).slice(-d.processPreviewMaxChars);
    });
    process.stdout.on("data", (data) => {
      buffer += String(data);
      if (buffer.length > outputMaxBytes) {
        process.kill();
        return;
      }
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const response = JSON.parse(line) as {
            id: string;
            event?: string;
            ok: boolean;
            result?: unknown;
            error?: string;
          };
          if (response.event === "session_closed") {
            epoch = randomUUID();
            for (const request of pending.values())
              request.reject(
                Object.assign(
                  new Error("用户或portal已关闭桌面会话，请重新授权并观察"),
                  { code: "permission_revoked", actionSent: true },
                ),
              );
            pending.clear();
            continue;
          }
          const request = pending.get(response.id);
          if (!request) continue;
          pending.delete(response.id);
          if (response.ok) request.resolve(response.result);
          else {
            const message = response.error ?? "portal请求失败";
            request.reject(
              Object.assign(new Error(message), {
                code: message.match(/^([a-z_]+):/)?.[1] ?? "native_failed",
              }),
            );
          }
        } catch {
          process.kill();
        }
      }
    });
    const fail = () => {
      if (child !== process) return;
      child = undefined;
      for (const request of pending.values())
        request.reject(
          Object.assign(
            new Error(
              `Wayland helper已断开：${diagnostic || "请确认python3-dbus/PyGObject/GStreamer PipeWire和portal服务"}`,
            ),
            { code: "backend_disconnected", actionSent: true },
          ),
        );
      pending.clear();
    };
    process.once("error", fail);
    process.once("close", fail);
  };
  const call = async <T>(
    operation: string,
    input: Record<string, unknown> = {},
    context?: CuOperationContext,
  ): Promise<T> => {
    deadlineMs = context?.timeoutMs ?? d.computerUseActionTimeoutMs;
    outputMaxBytes = context?.maxOutputBytes ?? d.processMaxOutputBytes;
    context?.signal.throwIfAborted();
    start();
    const process = child;
    if (!process) throw new Error("Wayland helper未启动");
    const id = randomUUID();
    const cancel = () => {
      void stop();
    };
    context?.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(
      cancel,
      context?.timeoutMs ?? d.computerUseActionTimeoutMs,
    );
    try {
      return await new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as T), reject });
        process.stdin.write(
          `${JSON.stringify({ id, operation, ...input, timeoutMs: context?.timeoutMs ?? d.computerUseActionTimeoutMs, inputDelayMs: context?.inputDelayMs ?? d.computerUseInputDelayMs })}\n`,
          (error) => {
            if (error) {
              pending.delete(id);
              reject(error);
            }
          },
        );
      });
    } finally {
      clearTimeout(timer);
      context?.signal.removeEventListener("abort", cancel);
    }
  };
  await call("status");
  const source = (app: ParsedAppRef) => {
    if (!app.displayId)
      throw Object.assign(
        new Error(
          "请选择list_displays中经用户授权的portal屏幕/窗口源；应用树由AT-SPI或其它provider提供",
        ),
        { code: "invalid_target", actionSent: false },
      );
    return app.displayId;
  };
  const point = async (
    app: ParsedAppRef,
    target: CuTarget,
    context: CuOperationContext,
  ) => {
    if (target.kind !== "coordinate" || !context.raster?.bounds)
      throw new Error("portal输入需要最近截图坐标");
    const id = source(app),
      binding = `${epoch}/${id}`;
    if (context.raster.binding !== binding)
      throw Object.assign(new Error("portal会话已变化，旧帧不能复用"), {
        code: "element_stale",
        actionSent: false,
      });
    const current = (await call<CuDisplay[]>("displays", {}, context)).find(
      (row) => row.id === id,
    );
    if (
      !current ||
      current.bounds.some((value, i) => value !== context.raster?.bounds?.[i])
    )
      throw new Error("portal源几何已变化，请重新截图");
    return [
      (target.x * current.bounds[2]) / context.raster.width,
      (target.y * current.bounds[3]) / context.raster.height,
    ];
  };
  const perform = async (
    app: ParsedAppRef,
    action: CuInputAction,
    context: CuOperationContext,
  ) => {
    const displayId = source(app);
    if (action.kind === "focus")
      throw new Error(
        "portal不提供应用激活，请用应用provider或用户选择的窗口源",
      );
    if (action.kind === "keys")
      return call<{ actionSent: boolean; detail: string }>(
        "keys",
        { displayId, keys: action.keys },
        context,
      );
    if (action.kind === "drag")
      return call<{ actionSent: boolean; detail: string }>(
        "drag",
        {
          displayId,
          from: await point(app, action.from, context),
          to: await point(app, action.to, context),
        },
        context,
      );
    if (action.kind === "scroll") {
      if (action.target)
        await call(
          "move",
          { displayId, point: await point(app, action.target, context) },
          context,
        );
      return call<{ actionSent: boolean; detail: string }>(
        "scroll",
        { displayId, direction: action.direction, amount: action.amount },
        context,
      );
    }
    return call<{ actionSent: boolean; detail: string }>(
      action.kind,
      {
        displayId,
        point: await point(app, action.target, context),
        ...(action.kind === "click"
          ? { button: action.button, count: action.count }
          : {}),
      },
      context,
    );
  };
  return {
    id: "linux-wayland-portal",
    available: true,
    accessStatus: (context) => call("status", {}, context),
    listDisplays: (context) => call<CuDisplay[]>("displays", {}, context),
    listApps: async () => {
      throw new Error(
        "portal授权源不是进程库存，请使用应用/AT-SPI provider发现应用",
      );
    },
    listWindows: async () => {
      throw new Error("portal窗口由真实用户选择，不合成全局窗口ID");
    },
    observe: async (app, context) => {
      const id = source(app),
        row = (await call<CuDisplay[]>("displays", {}, context)).find(
          (item) => item.id === id,
        );
      if (!row) throw new Error("portal源不存在");
      return {
        app: { name: row.name },
        window: { bounds: row.bounds },
        root: { role: "desktop", title: "portal像素源，未附着应用AT-SPI树" },
        accessibility: {
          state: "unavailable",
          reason: "选择应用provider以读取真实无障碍树",
        },
      };
    },
    capture: async (app, context): Promise<CuRaster> => {
      const id = source(app),
        image = await call<{
          width: number;
          height: number;
          base64: string;
          bounds: [number, number, number, number];
        }>("capture", { displayId: id }, context);
      return {
        ...image,
        frameId: randomUUID(),
        binding: `${epoch}/${id}`,
        mimeType: "image/png",
        blackFrame: false,
      };
    },
    click: async (app, target, context) => {
      if (!context) throw new Error("portal点击缺少控制上下文");
      return perform(
        app,
        { kind: "click", target, button: "left", count: 1 },
        context,
      );
    },
    typeText: async (app, text, target, context) => {
      if (!context) throw new Error("portal输入缺少控制上下文");
      if (target)
        await perform(
          app,
          { kind: "click", target, button: "left", count: 1 },
          context,
        );
      return call("type", { displayId: source(app), text }, context);
    },
    perform,
    stop,
  };
}
