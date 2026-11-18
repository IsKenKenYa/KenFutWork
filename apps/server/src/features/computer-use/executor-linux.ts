import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import { atspi } from "./atspi.js";
import { readPngWithinBudget } from "./budget.js";
import type {
  ComputerUseExecutor,
  CuActionResult,
  CuDisplay,
  CuInputAction,
  CuOperationContext,
  CuRaster,
  CuWindowRow,
} from "./executor.js";
import type { CuTarget, ParsedAppRef } from "./target.js";

const exec = promisify(execFile);
interface XWindow extends CuWindowRow {
  pid: number;
  bounds: [number, number, number, number];
}

/** X11原语是桌面能力provider，不承担Agent loop或MCP库存。Wayland另走portal。 */
export async function createLinuxExecutor(): Promise<ComputerUseExecutor> {
  if (!process.env.DISPLAY)
    throw new Error(
      "没有X11 DISPLAY；Wayland会话需要RemoteDesktop portal或外部桌面MCP后端。",
    );
  await exec("xdotool", ["--version"]);
  await exec("xrandr", ["--version"]);
  await exec("import", ["-version"]);
  const defaults = AGENT_GOVERNANCE_DEFAULTS;
  const command = async (
    file: string,
    args: string[],
    context?: CuOperationContext,
  ) => {
    try {
      return (
        await exec(file, args, {
          timeout: context?.timeoutMs ?? defaults.computerUseActionTimeoutMs,
          maxBuffer: context?.maxOutputBytes ?? defaults.processMaxOutputBytes,
          ...(context ? { signal: context.signal } : {}),
        })
      ).stdout.trim();
    } catch (error) {
      const failure = error as {
        stderr?: string;
        code?: string;
        signal?: string;
      };
      throw Object.assign(
        new Error(
          `${file}失败：${failure.stderr?.trim() || failure.signal || failure.code || "无结果"}`,
        ),
        { code: context?.signal.aborted ? "cancelled" : "native_failed" },
      );
    }
  };
  const displays = async (
    context?: CuOperationContext,
  ): Promise<CuDisplay[]> => {
    const rows = await command("xrandr", ["--listmonitors"], context);
    return rows
      .split("\n")
      .slice(1)
      .flatMap((line) => {
        const match = line.match(
          /\s*\d+:\s+([+*]*)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+([+-]\d+)([+-]\d+)/,
        );
        if (!match?.[2]) return [];
        return [
          {
            id: match[2],
            name: match[2],
            bounds: [
              Number(match[5]),
              Number(match[6]),
              Number(match[3]),
              Number(match[4]),
            ] as [number, number, number, number],
            primary: (match[1] ?? "").includes("*"),
            scaleFactor: 1,
          },
        ];
      });
  };
  const windows = async (context?: CuOperationContext): Promise<XWindow[]> => {
    const clients = await command(
      "xprop",
      ["-root", "_NET_CLIENT_LIST"],
      context,
    );
    const ids = clients.match(/0x[0-9a-f]+/gi) ?? [];
    const active = Number(
      (await command("xdotool", ["getactivewindow"], context)).trim(),
    );
    const result: XWindow[] = [];
    for (const id of ids) {
      const windowId = Number.parseInt(id, 16);
      const info = await command(
        "xprop",
        ["-id", id, "_NET_WM_PID", "WM_NAME"],
        context,
      );
      const pid = Number(
        info.match(/_NET_WM_PID\([^)]*\)\s*=\s*(\d+)/)?.[1] ?? 0,
      );
      const geometry = await command(
        "xdotool",
        ["getwindowgeometry", "--shell", String(windowId)],
        context,
      );
      const field = (name: string) =>
        Number(geometry.match(new RegExp(`^${name}=(-?\\d+)$`, "m"))?.[1]);
      const bounds: [number, number, number, number] = [
        field("X"),
        field("Y"),
        field("WIDTH"),
        field("HEIGHT"),
      ];
      result.push({
        pid,
        windowId,
        title: await command(
          "xdotool",
          ["getwindowname", String(windowId)],
          context,
        ),
        bounds,
        subrole: "X11Window",
        main: active === windowId,
        focused: active === windowId,
      });
    }
    return result;
  };
  const select = async (app: ParsedAppRef, context?: CuOperationContext) => {
    const candidates = (await windows(context)).filter((row) =>
      app.pid !== undefined
        ? row.pid === app.pid
        : app.name !== undefined
          ? row.title === app.name
          : app.windowId !== undefined
            ? row.windowId === app.windowId
            : false,
    );
    const selected =
      app.windowId !== undefined
        ? candidates.find((row) => row.windowId === app.windowId)
        : (candidates.find((row) => row.focused) ?? candidates[0]);
    if (!selected)
      throw Object.assign(new Error("X11应用/窗口不存在，或已被关闭"), {
        code: "app_not_found",
        actionSent: false,
      });
    return selected;
  };
  const geometry = async (app: ParsedAppRef, context?: CuOperationContext) => {
    if (app.displayId) {
      const display = (await displays(context)).find(
        (row) => row.id === app.displayId,
      );
      if (!display)
        throw Object.assign(new Error("显示器不存在或已断开"), {
          code: "display_not_found",
          actionSent: false,
        });
      return display.bounds;
    }
    return (await select(app, context)).bounds;
  };
  const point = async (
    app: ParsedAppRef,
    target: CuTarget,
    context: CuOperationContext,
  ) => {
    if (target.kind !== "coordinate" || !context.raster?.bounds)
      throw Object.assign(new Error("此X11动作需要当前截图坐标"), {
        code: "invalid_target",
        actionSent: false,
      });
    const bounds = context.raster.bounds;
    if ((await geometry(app, context)).some((value, i) => value !== bounds[i]))
      throw Object.assign(new Error("窗口/显示器几何已变化，请重新截图"), {
        code: "element_stale",
        actionSent: false,
      });
    return [
      Math.round(bounds[0] + (target.x * bounds[2]) / context.raster.width),
      Math.round(bounds[1] + (target.y * bounds[3]) / context.raster.height),
    ];
  };
  const focus = async (app: ParsedAppRef, context: CuOperationContext) => {
    if (!app.displayId)
      await command(
        "xdotool",
        [
          "windowactivate",
          "--sync",
          String((await select(app, context)).windowId),
        ],
        context,
      );
  };
  const accessibility = async (
    app: ParsedAppRef,
    operation: "observe" | "click" | "type",
    context?: CuOperationContext,
    index?: number,
    text?: string,
  ) => {
    const win = await select(app, context);
    if (!win.pid || !win.bounds)
      return {
        available: false,
        reason: "该X11窗口未提供进程身份，不能绑定AT-SPI",
      };
    return await atspi(
      {
        operation,
        pid: win.pid,
        title: win.title,
        bounds: win.bounds,
        ...(index !== undefined ? { index } : {}),
        ...(text !== undefined ? { text } : {}),
      },
      context,
    );
  };
  const perform = async (
    app: ParsedAppRef,
    action: CuInputAction,
    context: CuOperationContext,
  ): Promise<CuActionResult> => {
    await focus(app, context);
    const move = async (target: CuTarget) => {
      const [x, y] = await point(app, target, context);
      await command(
        "xdotool",
        ["mousemove", "--sync", "--", String(x), String(y)],
        context,
      );
    };
    let heldMouse = false;
    const keyMap: Record<string, string> = {
      command: "Super_L",
      cmd: "Super_L",
      meta: "Super_L",
      ctrl: "Control_L",
      control: "Control_L",
      alt: "Alt_L",
      option: "Alt_L",
      shift: "Shift_L",
      enter: "Return",
      escape: "Escape",
      space: "space",
    };
    const keys =
      action.kind === "keys"
        ? action.keys.map((key) => keyMap[key.toLowerCase()] ?? key)
        : [];
    try {
      if (action.kind === "move") await move(action.target);
      else if (action.kind === "click") {
        await move(action.target);
        const button = { left: 1, middle: 2, right: 3 }[action.button];
        await command(
          "xdotool",
          [
            "click",
            "--repeat",
            String(action.count),
            "--delay",
            String(context.inputDelayMs ?? defaults.computerUseInputDelayMs),
            String(button),
          ],
          context,
        );
      } else if (action.kind === "drag") {
        await move(action.from);
        heldMouse = true;
        await command("xdotool", ["mousedown", "1"], context);
        await move(action.to);
      } else if (action.kind === "scroll") {
        if (action.target) await move(action.target);
        await command(
          "xdotool",
          [
            "click",
            "--repeat",
            String(action.amount),
            "--delay",
            String(context.inputDelayMs ?? defaults.computerUseInputDelayMs),
            String({ up: 4, down: 5, left: 6, right: 7 }[action.direction]),
          ],
          context,
        );
      } else if (action.kind === "keys") {
        await command(
          "xdotool",
          [
            "key",
            "--clearmodifiers",
            "--delay",
            String(context.inputDelayMs ?? defaults.computerUseInputDelayMs),
            keys.join("+"),
          ],
          context,
        );
      }
      return {
        actionSent: true,
        detail: `已下发X11 ${action.kind}，请重新观察确认`,
      };
    } finally {
      const cleanup = { ...context, signal: new AbortController().signal };
      if (heldMouse) await command("xdotool", ["mouseup", "1"], cleanup);
      if (context.signal.aborted && keys.length)
        await command("xdotool", ["keyup", ...keys.slice().reverse()], cleanup);
    }
  };
  return {
    id: "linux-x11",
    available: true,
    accessStatus: async () => ({
      accessibility: "not_determined",
      screen: "granted",
      hint: "已连接X11会话；无障碍树依赖同会话AT-SPI服务。输入与截图效果需实际验证。Wayland须选择portal后端。",
    }),
    listDisplays: displays,
    async listApps(context) {
      return (await windows(context)).map((row) => ({
        pid: row.pid || null,
        name: row.title,
        bundleId: null,
        active: row.focused,
      }));
    },
    async listWindows(app, context) {
      return (await windows(context)).filter((row) =>
        app.pid !== undefined
          ? row.pid === app.pid
          : app.name !== undefined
            ? row.title === app.name
            : row.windowId === app.windowId,
      );
    },
    async observe(app, context) {
      const win = app.displayId ? undefined : await select(app, context);
      const ax = win
        ? await accessibility(app, "observe", context).catch((error) => {
            if (context?.signal.aborted) throw error;
            return {
              available: false,
              reason: error instanceof Error ? error.message : String(error),
            };
          })
        : { available: false, reason: "显示器整体不提供单应用AT-SPI树" };
      return {
        app: {
          ...(win?.pid ? { pid: win.pid } : {}),
          name: win?.title ?? `显示器 ${app.displayId}`,
        },
        window: {
          ...(win ? { windowId: win.windowId } : {}),
          bounds: await geometry(app, context),
        },
        root: ("root" in ax && ax.root) || {
          role: "desktop",
          title: ax.reason ?? "该目标未提供AT-SPI树，请使用截图",
        },
        ...(ax.available
          ? { treeLimits: context?.treeLimits }
          : {
              accessibility: {
                state: "unavailable",
                reason: ax.reason ?? "该目标未提供AT-SPI树",
              },
            }),
      };
    },
    async capture(app, context): Promise<CuRaster> {
      const directory = await mkdtemp(join(tmpdir(), "kenfutwork-x11-"));
      try {
        const bounds = await geometry(app, context),
          file = join(directory, "frame.png");
        const source = app.displayId
          ? [
              "-window",
              "root",
              "-crop",
              `${bounds[2]}x${bounds[3]}${bounds[0] >= 0 ? "+" : ""}${bounds[0]}${bounds[1] >= 0 ? "+" : ""}${bounds[1]}`,
            ]
          : ["-window", String((await select(app, context)).windowId)];
        await command("import", [...source, file], context);
        const buffer = await readFile(file),
          image = readPngWithinBudget(
            buffer,
            context?.maxOutputBytes ?? defaults.processMaxOutputBytes,
          );
        return {
          frameId: randomUUID(),
          mimeType: "image/png",
          width: image.width,
          height: image.height,
          base64: buffer.toString("base64"),
          blackFrame: false,
          bounds,
        };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async click(app, target, context) {
      if (!context) throw new Error("X11输入缺少当前帧上下文");
      if (target.kind === "element") {
        const result = await accessibility(app, "click", context, target.index);
        if (!result.available)
          throw new Error(result.reason ?? "该元素不支持AT-SPI点击");
        return { actionSent: true, detail: "已下发AT-SPI点击，请重新观察确认" };
      }
      return perform(
        app,
        { kind: "click", target, count: 1, button: "left" },
        context,
      );
    },
    async typeText(app, text, target, context) {
      if (!context) throw new Error("X11输入缺少控制上下文");
      await focus(app, context);
      if (target?.kind === "element") {
        const result = await accessibility(
          app,
          "type",
          context,
          target.index,
          text,
        );
        if (!result.available)
          throw new Error(result.reason ?? "该元素不支持AT-SPI输入");
        return {
          actionSent: true,
          detail: "已通过AT-SPI输入文本，请重新观察确认",
        };
      }
      if (target)
        await perform(
          app,
          { kind: "click", target, count: 1, button: "left" },
          context,
        );
      const directory = await mkdtemp(join(tmpdir(), "kenfutwork-x11-input-"));
      try {
        const file = join(directory, "text");
        await (await import("node:fs/promises")).writeFile(file, text, {
          mode: 0o600,
        });
        await command(
          "xdotool",
          [
            "type",
            "--clearmodifiers",
            "--delay",
            String(context.inputDelayMs ?? defaults.computerUseInputDelayMs),
            "--file",
            file,
          ],
          context,
        );
        return {
          actionSent: true,
          detail:
            "已向当前焦点输入，请重新观察确认；IME目标可选择AT-SPI/MCP后端",
        };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    perform,
    stop: async () => {},
  };
}
