/**
 * ComputerUseService：行为核心（租约/预算/帧绑定/动作上限的执行者）。
 *
 * 职责边界：executor 只做平台原语（读树/截屏/注入），本层持有会话状态——
 * 最新观察（元素索引寻址基准）、最新 raster（坐标帧绑定基准）、run 级控制
 * 租约与动作计数。所有失败以 CallToolResult 形状返回（isError + error.code +
 * suggested_action），不向上抛裸异常——模型与 UI 都按 code 走恢复路径。
 */

import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import {
  type AxAppRef,
  type AxNode,
  type AxWindowRef,
  flattenAxTree,
  formatAxTree,
} from "./ax-tree.js";
import type {
  ComputerUseExecutor,
  CuInputAction,
  CuOperationContext,
  CuRaster,
} from "./executor.js";
import {
  type CuActionError,
  createCuLease,
  toActionSentError,
} from "./lease.js";
import { fitRasterPreview } from "./raster-preview.js";
import {
  type ParsedAppRef,
  parseAppRef,
  parseTarget,
  validateTarget,
} from "./target.js";

export interface CuGovernanceValues {
  actionTimeoutMs: number;
  observeMaxBytes: number;
  screenshotMaxBytes: number;
  maxActionsPerRun: number;
  sessionMaxMs: number;
  axMaxDepth?: number | undefined;
  axMaxChildren?: number | undefined;
  axTitleMaxChars?: number | undefined;
  axValueMaxChars?: number | undefined;
  axMaxActions?: number | undefined;
  inputDelayMs?: number | undefined;
  processMaxOutputBytes?: number | undefined;
}

export type CuContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export interface CuToolResult {
  content: CuContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  display?: Record<string, unknown>;
  canonicalOutput?: {
    content: CuContentBlock[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  modelContent?: (
    | { type: "text"; text: string }
    | {
        type: "image";
        source_type: "base64";
        mime_type: string;
        data: string;
      }
  )[];
}

export interface CuRequestContext {
  runId?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface RawTarget {
  type?: unknown;
  index?: unknown;
  x?: unknown;
  y?: unknown;
  frameId?: unknown;
}

const SUGGESTED_ACTIONS: Record<string, string> = {
  element_stale:
    "重新调用 mcp__computer-use__get_app_state 获取当前帧后再动作。",
  element_unavailable: "重新观察目标应用，用最新树里的索引寻址。",
  invalid_target: "按返回的 raster 边界给出合法坐标，或改用元素索引。",
  permission_denied:
    "在系统设置里为本应用授予「辅助功能」与「屏幕录制」权限后重试。",
  controller_busy: "让用户停止当前持有桌面控制权的会话后再试。",
  unavailable: "确认运行平台与执行器装配（里程碑 1 仅支持 macOS）。",
  action_limit: "本轮动作数已达上限，让用户确认后续再继续。",
  session_expired: "控制会话超时，让用户重新发起。",
  timeout: "动作超时：先重新观察确认现场，再决定是否重试。",
};

function errorResult(
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): CuToolResult {
  return {
    content: [{ type: "text", text: `${message}（${code}）` }],
    isError: true,
    structuredContent: {
      error: {
        code,
        suggested_action: SUGGESTED_ACTIONS[code] ?? "检查参数后重试。",
        ...extra,
      },
    },
  };
}

function okResult(
  text: string,
  structuredContent?: Record<string, unknown>,
  extraContent: CuContentBlock[] = [],
): CuToolResult {
  return {
    content: [{ type: "text", text }, ...extraContent],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

interface LatestObservation {
  runId?: string | undefined;
  binding?: string | undefined;
  stateId: string;
  app: AxAppRef;
  window: AxWindowRef;
  elementIndexes: Set<number>;
  elementNodes: Map<number, AxNode>;
  raster?: CuRaster;
  treeLimits?: import("./executor.js").CuTreeLimits | undefined;
}

export function createComputerUseService(options: {
  executor: ComputerUseExecutor;
  governance: () => CuGovernanceValues;
}): {
  requestAccess(context?: CuRequestContext): Promise<CuToolResult>;
  listApps(context?: CuRequestContext): Promise<CuToolResult>;
  listWindows(
    appRef: unknown,
    context?: CuRequestContext,
  ): Promise<CuToolResult>;
  getState(
    appRef: unknown,
    input: { includeScreenshot?: boolean },
    context?: CuRequestContext,
  ): Promise<CuToolResult>;
  screenshot(
    appRef: unknown,
    context?: CuRequestContext,
  ): Promise<CuToolResult>;
  click(
    appRef: unknown,
    rawTarget: RawTarget,
    runId: string,
    context?: CuRequestContext,
  ): Promise<CuToolResult>;
  typeText(
    appRef: unknown,
    text: string,
    rawTarget: RawTarget | undefined,
    runId: string,
    context?: CuRequestContext,
  ): Promise<CuToolResult>;
  stop(runId: string): Promise<CuToolResult>;
  perform(
    appRef: unknown,
    action: CuInputAction,
    runId: string,
    context?: CuRequestContext,
  ): Promise<CuToolResult>;
  listDisplays(context?: CuRequestContext): Promise<CuToolResult>;
  releaseLease(runId: string): Promise<void>;
  setExecutor(executor: ComputerUseExecutor): void;
  replaceExecutor(
    executor: ComputerUseExecutor,
    runId: string,
  ): Promise<CuToolResult>;
  dispose(): Promise<void>;
} {
  const { executor: initialExecutor, governance } = options;
  let executor = initialExecutor;
  const lease = createCuLease();
  const actionCounts = new Map<string, number>();
  const sessionStartedAt = new Map<string, number>();
  let stateSeq = 0;
  const observations = new Map<string, LatestObservation>();
  const active = new Map<
    AbortController,
    { owner: string | undefined; done: Promise<void> }
  >();
  let acting = false;
  let disposed = false;
  let replacing = false;
  const stoppingRuns = new Map<string, Promise<void>>();
  const clearRun = (runId: string, finished: boolean) => {
    for (const [key, observation] of observations)
      if (observation.runId === runId) observations.delete(key);
    lease.release(runId);
    // 手动停止仅释放控制权；同一Run的动作总额不能由模型自行重置。
    if (finished) actionCounts.delete(runId);
    sessionStartedAt.delete(runId);
  };
  const joinRun = async (runId: string) => {
    const stopping = [...active].filter(
      ([, operation]) => operation.owner === runId,
    );
    for (const [controller] of stopping) controller.abort();
    await Promise.all(stopping.map(([, operation]) => operation.done));
  };
  const finishRun = (runId: string, stopBackend: boolean, finished = false) => {
    const existing = stoppingRuns.get(runId);
    if (existing) return existing;
    const pending = Promise.resolve()
      .then(async () => {
        await joinRun(runId);
        if (stopBackend) await executor.stop();
        clearRun(runId, finished);
      })
      .finally(() => stoppingRuns.delete(runId));
    stoppingRuns.set(runId, pending);
    return pending;
  };
  const treeLimits = () => {
    const values = governance();
    return {
      maxDepth:
        values.axMaxDepth ?? AGENT_GOVERNANCE_DEFAULTS.computerUseAxMaxDepth,
      maxChildren:
        values.axMaxChildren ??
        AGENT_GOVERNANCE_DEFAULTS.computerUseAxMaxChildren,
      titleMaxChars:
        values.axTitleMaxChars ??
        AGENT_GOVERNANCE_DEFAULTS.computerUseAxTitleMaxChars,
      valueMaxChars:
        values.axValueMaxChars ??
        AGENT_GOVERNANCE_DEFAULTS.computerUseAxValueMaxChars,
      maxActions:
        values.axMaxActions ??
        AGENT_GOVERNANCE_DEFAULTS.computerUseAxMaxActions,
    };
  };
  const observationKey = (app: ParsedAppRef, context?: CuRequestContext) =>
    JSON.stringify([
      context?.runId ?? "",
      app.pid ?? null,
      app.bundleId ?? null,
      app.name ?? null,
      app.windowId ?? 0,
      app.displayId ?? null,
    ]);

  const ensureAvailable = (): CuToolResult | undefined =>
    disposed
      ? errorResult("unavailable", "桌面控制服务已关闭")
      : executor.available
        ? undefined
        : errorResult(
            "unavailable",
            executor.unavailableReason ?? "执行器不可用",
          );

  const checkActionCount = (runId: string): CuToolResult | undefined => {
    const maximum = governance().maxActionsPerRun;
    const count = actionCounts.get(runId) ?? 0;
    return count >= maximum
      ? errorResult(
          "action_limit",
          `本轮 run 已执行 ${count} 个动作，达到上限 ${maximum}（设置可调 computerUseMaxActionsPerRun）。`,
          { retry: "never" },
        )
      : undefined;
  };

  /** 会话与动作治理：租约互斥 + 会话时长 + 单 run 动作上限。 */
  const governAction = (runId: string): CuToolResult | undefined => {
    if (replacing || stoppingRuns.has(runId))
      return errorResult("controller_busy", "桌面控制正在停止或切换后端");
    const limited = checkActionCount(runId);
    if (limited) return limited;
    const gov = governance();
    const acquired = lease.acquire(runId);
    if (!acquired.ok) {
      return errorResult("controller_busy", acquired.message, {
        owner: acquired.owner,
        retry: "never",
      });
    }
    const now = Date.now();
    const startedAt = sessionStartedAt.get(runId) ?? now;
    sessionStartedAt.set(runId, startedAt);
    if (now - startedAt > gov.sessionMaxMs) {
      return errorResult("session_expired", "控制会话时长超限", {
        retry: "never",
      });
    }
    return undefined;
  };

  const bumpActionCount = (runId: string): CuToolResult | undefined => {
    const limited = checkActionCount(runId);
    if (limited) return limited;
    actionCounts.set(runId, (actionCounts.get(runId) ?? 0) + 1);
    return undefined;
  };

  const withTimeout = async <T>(
    label: string,
    run: (operation: CuOperationContext) => Promise<T>,
    context?: CuRequestContext,
    raster?: CuRaster,
    mayHaveSent = false,
    binding?: string,
    expectedElement?: Pick<AxNode, "role" | "title">,
  ): Promise<T> => {
    if (
      disposed ||
      replacing ||
      (context?.runId && stoppingRuns.has(context.runId))
    )
      throw toActionSentError({
        code: "cancelled",
        message: "桌面控制正在关闭或切换，操作未下发",
        actionSent: false,
      });
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    context?.signal?.addEventListener("abort", cancel, { once: true });
    if (context?.signal?.aborted) cancel();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    active.set(controller, { owner: context?.runId, done });
    const timeoutMs = governance().actionTimeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, timeoutMs);
    let entered = false;
    try {
      controller.signal.throwIfAborted();
      entered = true;
      const result = await run({
        signal: controller.signal,
        timeoutMs,
        raster,
        binding: binding ?? raster?.binding,
        expectedElement,
        treeLimits: treeLimits(),
        maxOutputBytes:
          governance().processMaxOutputBytes ??
          AGENT_GOVERNANCE_DEFAULTS.processMaxOutputBytes,
        inputDelayMs:
          governance().inputDelayMs ??
          AGENT_GOVERNANCE_DEFAULTS.computerUseInputDelayMs,
      });
      controller.signal.throwIfAborted();
      return result;
    } catch (error) {
      if ((error as { code?: string })?.code === "input_cleanup_failed")
        throw error;
      if (!controller.signal.aborted) throw error;
      throw toActionSentError({
        code: timedOut ? "timeout" : "cancelled",
        message: timedOut
          ? `${label} 超时（${timeoutMs}ms）`
          : `${label} 已取消`,
        actionSent: entered && mayHaveSent,
      });
    } finally {
      clearTimeout(timer);
      active.delete(controller);
      finish();
      context?.signal?.removeEventListener("abort", cancel);
    }
  };

  /** 统一的失败 → CallToolResult 映射（含 actionSent 语义）。 */
  const failureOf = (error: unknown): CuToolResult => {
    if (error instanceof Error && "code" in error) {
      const actionError = error as CuActionError;
      return errorResult(actionError.code ?? "internal", error.message, {
        ...(actionError.actionSent !== undefined
          ? {
              actionSent: actionError.actionSent,
              retry: actionError.retry ?? "reobserve",
            }
          : {}),
      });
    }
    return errorResult(
      "internal",
      error instanceof Error ? error.message : String(error),
    );
  };

  /** 校验并解析动作目标（相对最新观察/raster）。 */
  const resolveActionTarget = (
    rawTarget: RawTarget | undefined,
    latest: LatestObservation | undefined,
  ): {
    target?: ReturnType<typeof parseTarget> | undefined;
    error?: CuToolResult;
  } => {
    let parsed: ReturnType<typeof parseTarget> | undefined;
    try {
      parsed = rawTarget ? parseTarget(rawTarget) : undefined;
    } catch (error) {
      return {
        error: errorResult(
          "invalid_target",
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
    if (!parsed) return {};
    if (!latest) {
      return {
        error: errorResult(
          "element_stale",
          "尚无观察基准：先调用 mcp__computer-use__get_app_state 建立观察树。",
        ),
      };
    }
    if (
      parsed.kind === "element" &&
      latest.treeLimits &&
      JSON.stringify(latest.treeLimits) !== JSON.stringify(treeLimits())
    )
      return {
        error: errorResult(
          "element_stale",
          "AX观察限制已修改，请重新观察后使用元素索引",
        ),
      };
    const claimedFrameId =
      typeof rawTarget?.frameId === "string" ? rawTarget.frameId : undefined;
    const raster = latest.raster;
    if (parsed.kind === "coordinate" && !raster) {
      return {
        error: errorResult(
          "element_stale",
          "坐标动作需要先有截图帧：先调用 mcp__computer-use__screenshot。",
        ),
      };
    }
    // 绑定基准 = 最新 raster（无 raster 时以观察态伪帧兜底，元素寻址不受影响）。
    // 目标显式声称 frameId 时以其为准——与最新帧不一致即判过期（element_stale）。
    const baseFrame = {
      frameId: raster?.frameId ?? `state-${latest.stateId}`,
      width: raster?.width ?? Number.POSITIVE_INFINITY,
      height: raster?.height ?? Number.POSITIVE_INFINITY,
      elementIndexes: latest.elementIndexes,
    };
    const claimed = claimedFrameId
      ? { ...baseFrame, frameId: claimedFrameId }
      : baseFrame;
    const verdict = validateTarget(parsed, claimed, baseFrame);
    if (!verdict.ok) {
      return {
        error: errorResult(verdict.code, verdict.message, {
          retry: verdict.retry,
        }),
      };
    }
    return { target: parsed };
  };

  const attachRaster = (
    raster: CuRaster,
    structured: Record<string, unknown>,
  ): {
    structured: Record<string, unknown>;
    content: CuContentBlock[];
    text: string;
  } => {
    return {
      structured: {
        ...structured,
        has_image: true,
        image: {
          mimeType: raster.mimeType,
          width: raster.width,
          height: raster.height,
          frameId: raster.frameId,
          bounds: raster.bounds ?? null,
        },
      },
      content: [
        { type: "image", mimeType: raster.mimeType, data: raster.base64 },
      ],
      text: `（附截图 ${raster.width}x${raster.height}，frameId=${raster.frameId}；坐标只能引用这一帧。）`,
    };
  };

  return {
    async requestAccess(context) {
      const unavailable = ensureAvailable();
      if (unavailable) return unavailable;
      try {
        const status = await withTimeout(
          "request_access",
          (operation) => executor.accessStatus(operation),
          context,
        );
        return okResult(
          `辅助功能：${status.accessibility}；屏幕录制：${status.screen}。${status.hint}`,
          {
            permissionStatus: {
              accessibility: status.accessibility,
              screen: status.screen,
              ...(status.postEvents ? { postEvents: status.postEvents } : {}),
            },
            hint: status.hint,
          },
        );
      } catch (error) {
        return failureOf(error);
      }
    },

    async listApps(context) {
      const unavailable = ensureAvailable();
      if (unavailable) return unavailable;
      try {
        const apps = await withTimeout(
          "list_apps",
          (operation) => executor.listApps(operation),
          context,
        );
        const text = apps
          .map(
            (a) =>
              `- ${a.name ?? "(未命名)"}（bundle_id=${a.bundleId ?? "?"}, pid=${a.pid}${a.active ? ", active" : ""}）`,
          )
          .join("\n");
        return okResult(`应用清单（${apps.length}）：\n${text}`, { apps });
      } catch (error) {
        return failureOf(error);
      }
    },

    async listWindows(appRefRaw: unknown, context) {
      const unavailable = ensureAvailable();
      if (unavailable) return unavailable;
      let appRef: ParsedAppRef;
      try {
        appRef = parseAppRefSafe(appRefRaw);
      } catch (error) {
        return errorResult(
          "invalid_target",
          error instanceof Error ? error.message : String(error),
        );
      }
      try {
        const windows = await withTimeout(
          "list_windows",
          (operation) => executor.listWindows(appRef, operation),
          context,
        );
        const text = windows
          .map(
            (w) =>
              `- window_id=${w.windowId} "${w.title ?? ""}"${w.subrole ? ` subrole=${w.subrole}` : "（无 subrole：CoreGraphics 合并行，不可绑定）"}${w.main ? " [main]" : ""}${w.focused ? " [focused]" : ""}`,
          )
          .join("\n");
        return okResult(`窗口清单（${windows.length}）：\n${text}`, {
          windows,
        });
      } catch (error) {
        return failureOf(error);
      }
    },

    async getState(
      appRefRaw: unknown,
      input: { includeScreenshot?: boolean },
      context,
    ) {
      const unavailable = ensureAvailable();
      if (unavailable) return unavailable;
      let appRef: ParsedAppRef;
      try {
        appRef = parseAppRefSafe(appRefRaw);
      } catch (error) {
        return errorResult(
          "invalid_target",
          error instanceof Error ? error.message : String(error),
        );
      }
      try {
        const observation = await withTimeout(
          "get_app_state",
          (operation) => executor.observe(appRef, operation),
          context,
        );
        stateSeq += 1;
        const formatted = formatAxTree({
          app: observation.app,
          window: observation.window,
          root: observation.root,
          stateId: `s-${stateSeq}`,
          maxBytes: governance().observeMaxBytes,
        });
        const latest: LatestObservation = {
          runId: context?.runId,
          stateId: formatted.structuredContent.state_id,
          app: observation.app,
          window: observation.window,
          treeLimits: observation.treeLimits,
          binding: observation.binding,
          elementIndexes: new Set(
            observation.accessibility
              ? []
              : flattenAxTree(observation.root).map((row) => row.index),
          ),
          elementNodes: new Map(
            flattenAxTree(observation.root).map((row) => [row.index, row.node]),
          ),
        };
        observations.set(observationKey(appRef, context), latest);
        let structured: Record<string, unknown> = {
          ...formatted.structuredContent,
          elements: formatted.rows,
          ...(observation.accessibility
            ? { accessibility: observation.accessibility }
            : {}),
        };
        let extraContent: CuContentBlock[] = [];
        let suffix = "";
        if (input.includeScreenshot) {
          const raster = await withTimeout(
            "screenshot",
            async (operation) =>
              fitRasterPreview(
                await executor.capture(appRef, operation),
                governance().screenshotMaxBytes,
              ),
            context,
            undefined,
            false,
            latest.binding,
          );
          if (raster.blackFrame) {
            suffix =
              "（警告：截屏为全黑——本应用可能缺少「屏幕录制」权限；树观察不受影响。）";
          } else {
            latest.raster = raster;
            const attached = attachRaster(raster, structured);
            structured = attached.structured;
            extraContent = attached.content;
            suffix = attached.text;
          }
        }
        return okResult(
          `${formatted.text}\n${suffix}`,
          structured,
          extraContent,
        );
      } catch (error) {
        return failureOf(error);
      }
    },

    async screenshot(appRefRaw: unknown, context) {
      const unavailable = ensureAvailable();
      if (unavailable) return unavailable;
      let appRef: ParsedAppRef;
      try {
        appRef = parseAppRefSafe(appRefRaw);
      } catch (error) {
        return errorResult(
          "invalid_target",
          error instanceof Error ? error.message : String(error),
        );
      }
      try {
        const raster = await withTimeout(
          "screenshot",
          async (operation) =>
            fitRasterPreview(
              await executor.capture(appRef, operation),
              governance().screenshotMaxBytes,
            ),
          context,
        );
        if (raster.blackFrame) {
          // 内容判定优先于权限查询：黑帧按无「屏幕录制」权限处理并给引导
          return errorResult(
            "permission_denied",
            "截屏内容为全黑：本应用很可能没有「屏幕录制」权限。请在 系统设置 → 隐私与安全性 → 屏幕录制 里勾选本应用后重试。",
          );
        }
        const key = observationKey(appRef, context);
        const latest = observations.get(key) ?? {
          runId: context?.runId,
          stateId: `s-${++stateSeq}`,
          app: appRef,
          window: {},
          elementIndexes: new Set<number>(),
          elementNodes: new Map<number, AxNode>(),
        };
        latest.raster = raster;
        latest.binding = raster.binding;
        observations.set(key, latest);
        const attached = attachRaster(raster, {
          state_id: latest?.stateId ?? null,
          ...(raster.app ? { app: raster.app } : {}),
        });
        return okResult(
          `已截取目标窗口 ${raster.width}x${raster.height}（frameId=${raster.frameId}）。${attached.text}`,
          attached.structured,
          attached.content,
        );
      } catch (error) {
        return failureOf(error);
      }
    },

    async click(
      appRefRaw: unknown,
      rawTarget: RawTarget,
      runId: string,
      context,
    ) {
      const unavailable = ensureAvailable();
      if (unavailable) return unavailable;
      let appRef: ParsedAppRef;
      try {
        appRef = parseAppRefSafe(appRefRaw);
      } catch (error) {
        return errorResult(
          "invalid_target",
          error instanceof Error ? error.message : String(error),
        );
      }
      const latest = observations.get(observationKey(appRef, context));
      const { target, error } = resolveActionTarget(rawTarget, latest);
      if (error) return error;
      if (acting)
        return errorResult("controller_busy", "另一个桌面动作尚未结束");
      const governed = governAction(runId);
      if (governed) return governed;
      const limited = bumpActionCount(runId);
      if (limited) return limited;
      acting = true;
      try {
        const result = await withTimeout(
          "click",
          (operation) => executor.click(appRef, target!, operation),
          { ...context, runId },
          latest?.raster,
          true,
          latest?.binding,
          target?.kind === "element"
            ? latest?.elementNodes.get(target.index)
            : undefined,
        );
        return okResult(`${result.detail}（actionSent=${result.actionSent}）`, {
          actionSent: result.actionSent,
          ...(latest?.binding ? { app: latest.app } : {}),
        });
      } catch (error) {
        return failureOf(error);
      } finally {
        acting = false;
      }
    },

    async typeText(
      appRefRaw: unknown,
      text: string,
      rawTarget: RawTarget | undefined,
      runId: string,
      context?: CuRequestContext,
    ) {
      const unavailable = ensureAvailable();
      if (unavailable) return unavailable;
      let appRef: ParsedAppRef;
      try {
        appRef = parseAppRefSafe(appRefRaw);
      } catch (error) {
        return errorResult(
          "invalid_target",
          error instanceof Error ? error.message : String(error),
        );
      }
      const latest = observations.get(observationKey(appRef, context));
      const { target, error } = resolveActionTarget(rawTarget, latest);
      if (error) return error;
      if (acting)
        return errorResult("controller_busy", "另一个桌面动作尚未结束");
      const governed = governAction(runId);
      if (governed) return governed;
      const limited = bumpActionCount(runId);
      if (limited) return limited;
      acting = true;
      try {
        const result = await withTimeout(
          "type",
          (operation) => executor.typeText(appRef, text, target, operation),
          { ...context, runId },
          latest?.raster,
          true,
          latest?.binding,
          target?.kind === "element"
            ? latest?.elementNodes.get(target.index)
            : undefined,
        );
        return okResult(`${result.detail}（actionSent=${result.actionSent}）`, {
          actionSent: result.actionSent,
          ...(latest?.binding ? { app: latest.app } : {}),
        });
      } catch (error) {
        return failureOf(error);
      } finally {
        acting = false;
      }
    },

    async listDisplays(context) {
      const unavailable = ensureAvailable();
      if (unavailable) return unavailable;
      if (!executor.listDisplays)
        return errorResult("unavailable", "此后端不提供显示器发现");
      try {
        const displays = await withTimeout(
          "list_displays",
          (operation) => executor.listDisplays!(operation),
          context,
        );
        return okResult(JSON.stringify(displays), {
          displays,
          backend: executor.id,
        });
      } catch (error) {
        return failureOf(error);
      }
    },

    async perform(appRaw, action, runId, context) {
      const unavailable = ensureAvailable();
      if (unavailable) return unavailable;
      if (!executor.perform)
        return errorResult("unavailable", "此后端不提供该输入原语");
      let app: ParsedAppRef;
      try {
        app = parseAppRef(appRaw);
      } catch (error) {
        return errorResult(
          "invalid_target",
          error instanceof Error ? error.message : String(error),
        );
      }
      const latest = observations.get(observationKey(app, context));
      const targets =
        action.kind === "drag"
          ? [action.from, action.to]
          : "target" in action && action.target
            ? [action.target]
            : [];
      for (const target of targets) {
        const raw =
          target.kind === "element"
            ? { type: "element", index: target.index }
            : {
                type: "coordinate",
                x: target.x,
                y: target.y,
                frameId: target.frameId,
              };
        const resolved = resolveActionTarget(raw, latest);
        if (resolved.error) return resolved.error;
      }
      if (acting)
        return errorResult("controller_busy", "另一个桌面动作尚未结束");
      const governed = governAction(runId);
      if (governed) return governed;
      const limited = bumpActionCount(runId);
      if (limited) return limited;
      acting = true;
      try {
        const result = await withTimeout(
          action.kind,
          (operation) => executor.perform!(app, action, operation),
          { ...context, runId },
          latest?.raster,
          true,
          latest?.binding,
        );
        return okResult(result.detail, {
          actionSent: result.actionSent,
          ...(latest?.binding ? { app: latest.app } : {}),
        });
      } catch (error) {
        return failureOf(error);
      } finally {
        acting = false;
      }
    },

    async stop(runId: string) {
      if (lease.current() && lease.current() !== runId)
        return errorResult("controller_busy", "只有持有方可以停止桌面控制");
      try {
        await finishRun(runId, true);
        return okResult("已停止桌面控制并释放租约。");
      } catch (error) {
        return failureOf(error);
      }
    },

    async releaseLease(runId: string) {
      await finishRun(runId, false, true);
    },

    setExecutor(next: ComputerUseExecutor) {
      if (disposed || replacing) return;
      observations.clear();
      executor = next;
    },
    async replaceExecutor(next, runId) {
      if (disposed) return errorResult("unavailable", "桌面控制服务已关闭");
      if (replacing || stoppingRuns.size)
        return errorResult("controller_busy", "桌面控制正在停止或切换后端");
      if (lease.current() && lease.current() !== runId)
        return errorResult(
          "controller_busy",
          "其它Run持有桌面控制权，不能切换后端",
        );
      if (acting)
        return errorResult(
          "controller_busy",
          "输入尚未结束，请先停止控制再切换后端",
        );
      replacing = true;
      try {
        for (const controller of active.keys()) controller.abort();
        await Promise.all(
          [...active.values()].map((operation) => operation.done),
        );
        await executor.stop();
        observations.clear();
        executor = next;
        return okResult(`已选择桌面后端 ${next.id}，请重新观察建立该后端的帧`, {
          backend: next.id,
        });
      } catch (error) {
        return failureOf(error);
      } finally {
        replacing = false;
      }
    },

    async dispose() {
      disposed = true;
      for (const controller of active.keys()) controller.abort();
      await Promise.all(
        [...active.values()].map((operation) => operation.done),
      );
      observations.clear();
      try {
        await executor.stop();
      } catch {
        // 进程退出路径，吞掉执行器清理错误
      }
    },
  };
}

function parseAppRefSafe(raw: unknown): ParsedAppRef {
  return parseAppRef(raw);
}
