import type {
  ComputerUseHelperAxNode,
  ComputerUseHelperWindow,
} from "@kenfutwork/shared";
import { type AxNode, type AxWindowRef, flattenAxTree } from "./ax-tree.js";
import type {
  ComputerUseExecutor,
  CuActionResult,
  CuAppInfo,
  CuDisplay,
  CuInputAction,
  CuObservation,
  CuOperationContext,
  CuRaster,
  CuWindowRow,
} from "./executor.js";
import { CU_AX_DEFAULT_LIMITS } from "./executor.js";
import { HelperRpcError } from "./helper-client.js";
import type { HelperProcessManager } from "./helper-manager.js";
import { normalizeRole } from "./jxa.js";
import type { CuTarget, ParsedAppRef } from "./target.js";

/** 拖拽全程时长只影响一次手势的节奏；固定值不参与限额/重试治理。 */
const DRAG_DURATION_MS = 400;

class HelperExecutorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly actionSent = false,
  ) {
    super(message);
    this.name = "HelperExecutorError";
  }
}

interface ResolvedTarget {
  pid: number;
  bundleId: string | null;
  name: string;
  window: ComputerUseHelperWindow;
}

interface LatestObservation {
  pid: number;
  windowId: number;
  root: AxNode;
  positions: Map<
    number,
    { x: number; y: number; width: number; height: number }
  >;
  binding: string;
  windowBounds: [number, number, number, number];
}

/** 独立 Helper 执行器：AX、截图、输入全部经 Unix socket，不再由 Node 持有 TCC。 */
export function createHelperExecutor(options: {
  manager: HelperProcessManager;
}): ComputerUseExecutor {
  const latestByPid = new Map<number, LatestObservation>();
  const latestRasterByPid = new Map<number, CuRaster>();

  const wrap = (error: unknown): never => {
    if (error instanceof HelperRpcError)
      throw new HelperExecutorError(error.code, error.message);
    throw error;
  };

  const loadApplications = async (signal?: AbortSignal) => {
    try {
      return (await options.manager.applications(signal)).applications;
    } catch (error) {
      return wrap(error);
    }
  };

  const resolveTarget = async (
    appRef: ParsedAppRef,
    context?: CuOperationContext,
  ): Promise<ResolvedTarget> => {
    if (appRef.displayId)
      throw new HelperExecutorError(
        "unsupported_target",
        "当前执行器不支持整屏目标，请按应用操作",
      );
    const catalog = await loadApplications(context?.signal);
    const application =
      appRef.pid !== undefined
        ? catalog.find((candidate) => candidate.pid === appRef.pid)
        : appRef.bundleId
          ? catalog.find((candidate) => candidate.bundleId === appRef.bundleId)
          : appRef.name
            ? catalog.find(
                (candidate) =>
                  candidate.name.localeCompare(appRef.name ?? "", undefined, {
                    sensitivity: "accent",
                  }) === 0,
              )
            : (catalog.find((candidate) => candidate.active) ?? catalog[0]);
    if (!application)
      throw new HelperExecutorError("app_not_found", "找不到目标应用");
    let windows: ComputerUseHelperWindow[];
    try {
      windows = (
        await options.manager.windows(application.pid, context?.signal)
      ).windows;
    } catch (error) {
      return wrap(error);
    }
    const window =
      appRef.windowId !== undefined
        ? windows.find((candidate) => candidate.windowId === appRef.windowId)
        : (windows.find(
            (candidate) => candidate.onScreen && candidate.layer === 0,
          ) ?? windows[0]);
    if (!window)
      throw new HelperExecutorError(
        "window_not_found",
        "目标应用没有可操作窗口",
      );
    return {
      pid: application.pid,
      bundleId: application.bundleId,
      name: application.name,
      window,
    };
  };

  const observeRoot = async (
    target: ResolvedTarget,
    context: CuOperationContext | undefined,
  ): Promise<LatestObservation> => {
    const limits = context?.treeLimits ?? CU_AX_DEFAULT_LIMITS;
    try {
      const request = {
        pid: target.pid,
        windowId: target.window.windowId,
        maxDepth: limits.maxDepth,
        maxChildren: limits.maxChildren,
        maxNodes: Math.min(
          10_000, // 单次 Helper 查询的节点上限，保持 socket 响应有界。
          Math.max(1, limits.maxChildren * limits.maxDepth),
        ),
        titleMaxChars: limits.titleMaxChars,
        valueMaxChars: limits.valueMaxChars,
        maxActions: limits.maxActions,
        ...(context?.timeoutMs === undefined
          ? {}
          : { timeoutMs: context.timeoutMs }),
      };
      const tree = await options.manager.axTree(request, context?.signal);
      const positions = new Map<
        number,
        { x: number; y: number; width: number; height: number }
      >();
      let index = 0;
      const mapNode = (node: ComputerUseHelperAxNode): AxNode => {
        const position = node.position;
        const size = node.size;
        if (position && size) {
          positions.set(index, {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
          });
        }
        index += 1;
        const states: string[] = [];
        if (node.enabled === false) states.push("disabled");
        if (node.focused === true) states.push("focused");
        if (node.actions?.includes("AXPress")) states.push("pressable");
        if (node.role === "AXTextField" || node.role === "AXTextArea")
          states.push("editable");
        const title = helperElementTitle(node);
        const mapped: AxNode = {
          role: normalizeRole(node.role),
          ...(title ? { title } : {}),
          ...(node.value ? { value: node.value } : {}),
          ...(node.actions?.length ? { actions: node.actions } : {}),
          ...(states.length ? { states } : {}),
        };
        if (node.children?.length) mapped.children = node.children.map(mapNode);
        return mapped;
      };
      const root = mapNode(tree.root);
      const bounds: [number, number, number, number] = [
        target.window.bounds.x,
        target.window.bounds.y,
        target.window.bounds.width,
        target.window.bounds.height,
      ];
      const observation: LatestObservation = {
        pid: target.pid,
        windowId: target.window.windowId,
        root,
        positions,
        binding: `helper:${target.pid}:${target.window.windowId}`,
        windowBounds: bounds,
      };
      return observation;
    } catch (error) {
      return wrap(error);
    }
  };

  const actionPoints = (
    resolved: ResolvedTarget,
    context: CuOperationContext | undefined,
  ) => {
    const previous = latestByPid.get(resolved.pid);
    let refreshed: Promise<LatestObservation> | undefined;
    return async (target: CuTarget | undefined) => {
      if (!target) return undefined;
      if (target.kind === "element") {
        const binding = `helper:${resolved.pid}:${resolved.window.windowId}`;
        if (
          previous?.binding !== binding ||
          (context?.binding && context.binding !== binding)
        )
          throw new HelperExecutorError(
            "element_stale",
            "目标窗口已变化，请重新观察",
          );
        refreshed ??= observeRoot(resolved, context);
        return helperElementPoint(
          previous,
          await refreshed,
          target.index,
          context?.expectedElement,
        );
      }
      const raster = context?.raster ?? latestRasterByPid.get(resolved.pid);
      if (!raster)
        throw new HelperExecutorError(
          "element_stale",
          "坐标目标需要先截图并绑定 frameId",
        );
      return helperCoordinate(resolved.window, raster, target);
    };
  };

  const focus = (target: ResolvedTarget, signal?: AbortSignal) =>
    options.manager.focus(
      { pid: target.pid, windowId: target.window.windowId },
      signal,
    );

  const resolveInputTarget = async (
    appRef: ParsedAppRef,
    context?: CuOperationContext,
  ) => {
    const target = await resolveTarget(appRef, context);
    await focus(target, context?.signal);
    return await resolveTarget(
      { pid: target.pid, windowId: target.window.windowId },
      context,
    );
  };

  const executor: ComputerUseExecutor = {
    id: "macos-helper",
    available: true,

    async listApps(): Promise<CuAppInfo[]> {
      const applications = await loadApplications();
      return applications.map((application) => ({
        pid: application.pid,
        name: application.name,
        bundleId: application.bundleId,
        active: application.active,
      }));
    },

    async listWindows(appRef: ParsedAppRef): Promise<CuWindowRow[]> {
      const target = await resolveTarget(appRef);
      try {
        const windows = (await options.manager.windows(target.pid)).windows;
        return windows.map((window) => ({
          windowId: window.windowId,
          title: window.title || null,
          subrole: "AXWindow",
          bounds: [
            window.bounds.x,
            window.bounds.y,
            window.bounds.width,
            window.bounds.height,
          ],
          main: false,
          focused: window.onScreen,
        }));
      } catch (error) {
        return wrap(error);
      }
    },

    async listDisplays(): Promise<CuDisplay[]> {
      try {
        const displays = (await options.manager.displays()).displays;
        return displays.map((display) => ({
          id: display.id,
          name: display.name,
          bounds: [
            display.bounds.x,
            display.bounds.y,
            display.bounds.width,
            display.bounds.height,
          ],
          scaleFactor: display.scaleFactor,
          primary: display.primary,
        }));
      } catch (error) {
        return wrap(error);
      }
    },

    async observe(
      appRef: ParsedAppRef,
      context?: CuOperationContext,
    ): Promise<CuObservation> {
      const target = await resolveTarget(appRef, context);
      const latest = await observeRoot(target, context);
      latestByPid.set(target.pid, latest);
      const window: AxWindowRef = {
        windowId: latest.windowId,
        title: target.window.title,
        bounds: latest.windowBounds,
      };
      return {
        binding: latest.binding,
        app: {
          pid: target.pid,
          bundleId: target.bundleId,
          name: target.name,
        },
        window,
        root: latest.root,
        treeLimits: context?.treeLimits ?? CU_AX_DEFAULT_LIMITS,
      };
    },

    async capture(
      appRef: ParsedAppRef,
      context?: CuOperationContext,
    ): Promise<CuRaster> {
      const target = await resolveTarget(appRef, context);
      try {
        const request = {
          pid: target.pid,
          windowId: target.window.windowId,
          ...(context?.screenshotMaxBytes === undefined
            ? {}
            : { maxBytes: context.screenshotMaxBytes }),
        };
        const shot = await options.manager.screenshot(request, context?.signal);
        const raster: CuRaster = {
          app: {
            pid: target.pid,
            bundleId: target.bundleId,
            name: target.name,
          },
          frameId: `helper-${shot.windowId}-${shot.capturedAt}`,
          mimeType: "image/png",
          width: shot.width,
          height: shot.height,
          base64: shot.imageBase64,
          blackFrame: shot.blackFrame,
          bounds: [
            shot.frame.x,
            shot.frame.y,
            shot.frame.width,
            shot.frame.height,
          ],
          binding: `helper:${target.pid}:${target.window.windowId}`,
        };
        latestRasterByPid.set(target.pid, raster);
        return raster;
      } catch (error) {
        return wrap(error);
      }
    },

    async click(
      appRef: ParsedAppRef,
      target: CuTarget,
      context?: CuOperationContext,
    ): Promise<CuActionResult> {
      const resolved = await resolveInputTarget(appRef, context);
      const point = await actionPoints(resolved, context)(target);
      if (!point)
        throw new HelperExecutorError("invalid_target", "点击缺少目标", false);
      try {
        await options.manager.click(
          { pid: resolved.pid, ...point, button: "left", clickCount: 1 },
          context?.signal,
        );
        return { actionSent: true, detail: "已通过 Helper 发送点击" };
      } catch (error) {
        return wrap(error);
      }
    },

    async typeText(
      appRef: ParsedAppRef,
      text: string,
      target?: CuTarget,
      context?: CuOperationContext,
    ): Promise<CuActionResult> {
      const resolved = await resolveInputTarget(appRef, context);
      const point = await actionPoints(resolved, context)(target);
      try {
        if (point) {
          await options.manager.click(
            { pid: resolved.pid, ...point, button: "left", clickCount: 1 },
            context?.signal,
          );
        }
        const request = {
          pid: resolved.pid,
          text,
          ...(context?.inputDelayMs === undefined
            ? {}
            : { delayMs: context.inputDelayMs }),
        };
        await options.manager.typeText(request, context?.signal);
        return { actionSent: true, detail: "已通过 Helper 发送文本" };
      } catch (error) {
        return wrap(error);
      }
    },

    async readClipboard() {
      try {
        const result = await options.manager.readClipboard();
        return { text: result.text };
      } catch (error) {
        return wrap(error);
      }
    },

    async writeClipboard(text: string) {
      try {
        const result = await options.manager.writeClipboard({ text });
        return { written: result.written };
      } catch (error) {
        return wrap(error);
      }
    },

    async accessStatus() {
      try {
        const status = await options.manager.status();
        const accessibility =
          status.accessibility === "granted"
            ? "granted"
            : status.accessibility === "denied"
              ? "denied"
              : status.accessibility === "stale"
                ? "denied"
                : "not_determined";
        return {
          accessibility,
          screen:
            status.screenRecording === "granted"
              ? "granted"
              : status.screenRecording === "denied"
                ? "denied"
                : "not_determined",
          postEvents: accessibility,
          automation:
            status.automation === "granted" || status.automation === "denied"
              ? status.automation
              : "not_determined",
          hint:
            status.reason ??
            (accessibility === "granted"
              ? "Helper 辅助功能已授权"
              : "请在系统设置中授权 Helper 辅助功能"),
        };
      } catch (error) {
        return wrap(error);
      }
    },

    async perform(
      appRef: ParsedAppRef,
      action: CuInputAction,
      context: CuOperationContext,
    ): Promise<CuActionResult> {
      const resolved =
        action.kind === "focus" || action.kind === "keys"
          ? await resolveTarget(appRef, context)
          : await resolveInputTarget(appRef, context);
      const pointFor = actionPoints(resolved, context);
      try {
        switch (action.kind) {
          case "click": {
            const point = await pointFor(action.target);
            if (!point)
              throw new HelperExecutorError("invalid_target", "点击缺少目标");
            await options.manager.click(
              {
                pid: resolved.pid,
                ...point,
                button: action.button,
                clickCount: action.count,
              },
              context.signal,
            );
            return { actionSent: true, detail: "已通过 Helper 发送点击" };
          }
          case "move": {
            const point = await pointFor(action.target);
            if (!point)
              throw new HelperExecutorError("invalid_target", "移动缺少目标");
            await options.manager.move(
              { pid: resolved.pid, ...point },
              context.signal,
            );
            return { actionSent: true, detail: "已移动指针" };
          }
          case "drag": {
            const from = await pointFor(action.from);
            const to = await pointFor(action.to);
            if (!from || !to)
              throw new HelperExecutorError(
                "invalid_target",
                "拖拽缺少起点或终点",
              );
            const request = {
              pid: resolved.pid,
              fromX: from.x,
              fromY: from.y,
              toX: to.x,
              toY: to.y,
              durationMs: DRAG_DURATION_MS,
            };
            await options.manager.drag(request, context.signal);
            return { actionSent: true, detail: "已通过 Helper 发送拖拽" };
          }
          case "scroll": {
            const point = await pointFor(action.target);
            const amount = Math.abs(action.amount);
            const request = {
              pid: resolved.pid,
              ...(point ? { x: point.x, y: point.y } : {}),
              deltaX:
                action.direction === "left"
                  ? -amount
                  : action.direction === "right"
                    ? amount
                    : 0,
              deltaY:
                action.direction === "up"
                  ? amount
                  : action.direction === "down"
                    ? -amount
                    : 0,
              unit: "line" as const,
            };
            await options.manager.scroll(request, context.signal);
            return { actionSent: true, detail: "已通过 Helper 发送滚动" };
          }
          case "keys": {
            const parsed = toHelperKeyRequest(action.keys);
            await focus(resolved, context.signal);
            await options.manager.key(
              { pid: resolved.pid, ...parsed, repeat: 1 },
              context.signal,
            );
            return { actionSent: true, detail: "已通过 Helper 发送按键" };
          }
          case "focus": {
            await focus(resolved, context.signal);
            return { actionSent: true, detail: "已聚焦目标窗口" };
          }
        }
      } catch (error) {
        return wrap(error);
      }
    },

    async stop(): Promise<void> {
      await options.manager.close();
    },
  };

  return executor;
}

export function helperElementTitle(
  node: Pick<ComputerUseHelperAxNode, "title" | "identifier" | "description">,
): string | undefined {
  return node.title || node.identifier || node.description || undefined;
}

export function helperElementPoint(
  previous: Pick<LatestObservation, "root" | "positions" | "windowBounds">,
  current: Pick<LatestObservation, "root" | "positions" | "windowBounds">,
  index: number,
  expected?: CuOperationContext["expectedElement"],
): { x: number; y: number } {
  const original = flattenAxTree(previous.root)[index]?.node;
  const node = flattenAxTree(current.root)[index]?.node;
  const last = previous.positions.get(index);
  const rect = current.positions.get(index);
  const identity = expected ?? original;
  const [x, y, width, height] = current.windowBounds;
  if (
    !original ||
    !identity ||
    !node ||
    !last ||
    !rect ||
    node.role !== identity.role ||
    (node.title ?? "") !== (identity.title ?? "") ||
    original.role !== node.role ||
    (original.title ?? "") !== (node.title ?? "") ||
    rect.x !== last.x ||
    rect.y !== last.y ||
    rect.width !== last.width ||
    rect.height !== last.height ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    current.windowBounds.some((value, i) => value !== previous.windowBounds[i])
  ) {
    throw new HelperExecutorError(
      "element_stale",
      "目标元素已变化，请重新观察",
    );
  }
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  if (
    point.x < x ||
    point.x >= x + width ||
    point.y < y ||
    point.y >= y + height
  )
    throw new HelperExecutorError(
      "element_stale",
      "目标元素已移出窗口，请重新观察",
    );
  return point;
}

export function helperCoordinate(
  window: ComputerUseHelperWindow,
  raster: Pick<CuRaster, "binding" | "bounds" | "frameId" | "width" | "height">,
  target: Extract<CuTarget, { kind: "coordinate" }>,
): { x: number; y: number } {
  const bounds = raster.bounds;
  const current = window.bounds;
  if (
    !bounds ||
    (target.frameId && target.frameId !== raster.frameId) ||
    raster.binding !== `helper:${window.pid}:${window.windowId}` ||
    current.x !== bounds[0] ||
    current.y !== bounds[1] ||
    current.width !== bounds[2] ||
    current.height !== bounds[3]
  ) {
    throw new HelperExecutorError(
      "element_stale",
      "窗口或截图已改变，请重新截图",
    );
  }
  if (
    target.x < 0 ||
    target.y < 0 ||
    target.x >= raster.width ||
    target.y >= raster.height
  )
    throw new HelperExecutorError("invalid_target", "坐标超出截图范围");
  return {
    x: bounds[0] + target.x * (bounds[2] / raster.width),
    y: bounds[1] + target.y * (bounds[3] / raster.height),
  };
}

export function toHelperKeyRequest(keys: string[]): {
  key: string;
  modifiers: Array<"cmd" | "control" | "option" | "shift">;
} {
  return parseKeyTokens(keys.flatMap(splitCombination));
}

function parseKeyCombination(value: string): {
  key: string;
  modifiers: Array<"cmd" | "control" | "option" | "shift">;
} {
  return parseKeyTokens(splitCombination(value));
}

function splitCombination(value: string): string[] {
  return value !== "+" && value.includes("+") ? value.split("+") : [value];
}

function parseKeyTokens(raw: string[]): {
  key: string;
  modifiers: Array<"cmd" | "control" | "option" | "shift">;
} {
  const parts = raw.map((part) => part.trim().toLowerCase()).filter(Boolean);
  const key = parts.pop();
  if (!key) throw new HelperExecutorError("invalid_target", "按键组合不能为空");
  const modifiers: Array<"cmd" | "control" | "option" | "shift"> = [];
  for (const modifier of parts) {
    if (["cmd", "command", "meta", "⌘"].includes(modifier))
      modifiers.push("cmd");
    else if (["shift", "⇧"].includes(modifier)) modifiers.push("shift");
    else if (["option", "alt", "⌥"].includes(modifier))
      modifiers.push("option");
    else if (["control", "ctrl", "⌃"].includes(modifier))
      modifiers.push("control");
    else
      throw new HelperExecutorError(
        "invalid_target",
        `不支持的修饰键：${modifier}`,
      );
  }
  return { key, modifiers };
}
