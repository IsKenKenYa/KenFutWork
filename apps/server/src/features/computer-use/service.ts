/**
 * ComputerUseService：行为核心（租约/预算/帧绑定/动作上限的执行者）。
 *
 * 职责边界：executor 只做平台原语（读树/截屏/注入），本层持有会话状态——
 * 最新观察（元素索引寻址基准）、最新 raster（坐标帧绑定基准）、run 级控制
 * 租约与动作计数。所有失败以 CallToolResult 形状返回（isError + error.code +
 * suggested_action），不向上抛裸异常——模型与 UI 都按 code 走恢复路径。
 */

import {
  flattenAxTree,
  formatAxTree,
  type AxAppRef,
  type AxWindowRef,
} from "./ax-tree.js";
import { planImageInline } from "./budget.js";
import type { ComputerUseExecutor, CuRaster } from "./executor.js";
import { createCuLease, toActionSentError, type CuActionError } from "./lease.js";
import {
  parseAppRef,
  parseTarget,
  validateTarget,
  type ParsedAppRef,
} from "./target.js";

export interface CuGovernanceValues {
  actionTimeoutMs: number;
  observeMaxBytes: number;
  screenshotMaxBytes: number;
  maxActionsPerRun: number;
  sessionMaxMs: number;
}

export type CuContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export interface CuToolResult {
  content: CuContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface RawTarget {
  type?: unknown;
  index?: unknown;
  x?: unknown;
  y?: unknown;
  frameId?: unknown;
}

const SUGGESTED_ACTIONS: Record<string, string> = {
  element_stale: "重新调用 mcp__computer-use__get_app_state 获取当前帧后再动作。",
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
  stateId: string;
  app: AxAppRef;
  window: AxWindowRef;
  elementIndexes: Set<number>;
  raster?: CuRaster;
}

export function createComputerUseService(options: {
  executor: ComputerUseExecutor;
  governance: () => CuGovernanceValues;
}): {
  requestAccess(): Promise<CuToolResult>;
  listApps(): Promise<CuToolResult>;
  listWindows(appRef: unknown): Promise<CuToolResult>;
  getState(appRef: unknown, input: { includeScreenshot?: boolean }): Promise<CuToolResult>;
  screenshot(appRef: unknown): Promise<CuToolResult>;
  click(appRef: unknown, rawTarget: RawTarget, runId: string): Promise<CuToolResult>;
  typeText(
    appRef: unknown,
    text: string,
    rawTarget: RawTarget | undefined,
    runId: string,
  ): Promise<CuToolResult>;
  stop(runId: string): Promise<CuToolResult>;
  releaseLease(runId: string): void;
  setExecutor(executor: ComputerUseExecutor): void;
  dispose(): Promise<void>;
} {
  const { executor: initialExecutor, governance } = options;
  let executor = initialExecutor;
  const lease = createCuLease();
  const actionCounts = new Map<string, number>();
  const sessionStartedAt = new Map<string, number>();
  let stateSeq = 0;
  let latest: LatestObservation | undefined;

  const ensureAvailable = (): CuToolResult | undefined =>
    executor.available
      ? undefined
      : errorResult("unavailable", executor.unavailableReason ?? "执行器不可用");

  /** 会话与动作治理：租约互斥 + 会话时长 + 单 run 动作上限。 */
  const governAction = (runId: string): CuToolResult | undefined => {
    const gov = governance();
    const acquired = lease.acquire(runId);
    if (!acquired.ok) {
      return errorResult(
        "controller_busy",
        acquired.message,
        { owner: acquired.owner, retry: "never" },
      );
    }
    const now = Date.now();
    const startedAt = sessionStartedAt.get(runId) ?? now;
    sessionStartedAt.set(runId, startedAt);
    if (now - startedAt > gov.sessionMaxMs) {
      return errorResult("session_expired", "控制会话时长超限", { retry: "never" });
    }
    return undefined;
  };

  const bumpActionCount = (runId: string): CuToolResult | undefined => {
    const gov = governance();
    const count = (actionCounts.get(runId) ?? 0) + 1;
    actionCounts.set(runId, count);
    if (count > gov.maxActionsPerRun) {
      return errorResult(
        "action_limit",
        `本轮 run 已执行 ${count - 1} 个动作，达到上限 ${gov.maxActionsPerRun}（设置可调 computerUseMaxActionsPerRun）。`,
        { retry: "never" },
      );
    }
    return undefined;
  };

  const withTimeout = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    const gov = governance();
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(toActionSentError({
            code: "timeout",
            message: `${label} 超时（${gov.actionTimeoutMs}ms，设置可调 computerUseActionTimeoutMs）`,
            actionSent: true,
          }));
        }, gov.actionTimeoutMs);
      }),
    ]);
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
  ): { target?: ReturnType<typeof parseTarget> | undefined; error?: CuToolResult } => {
    let parsed;
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
        error: errorResult(verdict.code, verdict.message, { retry: verdict.retry }),
      };
    }
    return { target: parsed };
  };

  const attachRaster = (
    raster: CuRaster,
    structured: Record<string, unknown>,
  ): { structured: Record<string, unknown>; content: CuContentBlock[]; text: string } => {
    const plan = planImageInline({
      base64Length: raster.base64.length,
      maxInlineBytes: governance().screenshotMaxBytes,
    });
    if (!plan.inline) {
      return {
        structured: { ...structured, has_image: false, image_omitted: plan.reason },
        content: [],
        text: `（截图超出内联预算，仅返回文字观察。${plan.reason}）`,
      };
    }
    return {
      structured: {
        ...structured,
        has_image: true,
        image: {
          mimeType: raster.mimeType,
          data: raster.base64,
          width: raster.width,
          height: raster.height,
          frameId: raster.frameId,
        },
      },
      content: [
        { type: "image", mimeType: raster.mimeType, data: raster.base64 },
      ],
      text: `（附截图 ${raster.width}x${raster.height}，frameId=${raster.frameId}；坐标只能引用这一帧。）`,
    };
  };

  return {
    async requestAccess() {
      const unavailable = ensureAvailable();
      if (unavailable) return unavailable;
      try {
        const status = await withTimeout("request_access", () =>
          executor.accessStatus(),
        );
        return okResult(
          `辅助功能：${status.accessibility}；屏幕录制：${status.screen}。${status.hint}`,
          {
            permissionStatus: {
              accessibility: status.accessibility,
              screen: status.screen,
            },
            hint: status.hint,
          },
        );
      } catch (error) {
        return failureOf(error);
      }
    },

    async listApps() {
      const unavailable = ensureAvailable();
      if (unavailable) return unavailable;
      try {
        const apps = await withTimeout("list_apps", () => executor.listApps());
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

    async listWindows(appRefRaw: unknown) {
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
        const windows = await withTimeout("list_windows", () =>
          executor.listWindows(appRef),
        );
        const text = windows
          .map(
            (w) =>
              `- window_id=${w.windowId} "${w.title ?? ""}"${w.subrole ? ` subrole=${w.subrole}` : "（无 subrole：CoreGraphics 合并行，不可绑定）"}${w.main ? " [main]" : ""}${w.focused ? " [focused]" : ""}`,
          )
          .join("\n");
        return okResult(`窗口清单（${windows.length}）：\n${text}`, { windows });
      } catch (error) {
        return failureOf(error);
      }
    },

    async getState(appRefRaw: unknown, input: { includeScreenshot?: boolean }) {
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
        const observation = await withTimeout("get_app_state", () =>
          executor.observe(appRef),
        );
        stateSeq += 1;
        const formatted = formatAxTree({
          app: observation.app,
          window: observation.window,
          root: observation.root,
          stateId: `s-${stateSeq}`,
          maxBytes: governance().observeMaxBytes,
        });
        latest = {
          stateId: formatted.structuredContent.state_id,
          app: observation.app,
          window: observation.window,
          elementIndexes: new Set(
            flattenAxTree(observation.root).map((row) => row.index),
          ),
        };
        let structured: Record<string, unknown> = {
          ...formatted.structuredContent,
        };
        let extraContent: CuContentBlock[] = [];
        let suffix = "";
        if (input.includeScreenshot) {
          const raster = await withTimeout("screenshot", () =>
            executor.capture(appRef),
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
        return okResult(`${formatted.text}\n${suffix}`, structured, extraContent);
      } catch (error) {
        return failureOf(error);
      }
    },

    async screenshot(appRefRaw: unknown) {
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
        const raster = await withTimeout("screenshot", () =>
          executor.capture(appRef),
        );
        if (raster.blackFrame) {
          // 内容判定优先于权限查询：黑帧按无「屏幕录制」权限处理并给引导
          return errorResult(
            "permission_denied",
            "截屏内容为全黑：本应用很可能没有「屏幕录制」权限。请在 系统设置 → 隐私与安全性 → 屏幕录制 里勾选本应用后重试。",
          );
        }
        if (latest) {
          latest.raster = raster;
        }
        const attached = attachRaster(raster, {
          state_id: latest?.stateId ?? null,
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

    async click(appRefRaw: unknown, rawTarget: RawTarget, runId: string) {
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
      const governed = governAction(runId);
      if (governed) return governed;
      const { target, error } = resolveActionTarget(rawTarget);
      if (error) return error;
      const limited = bumpActionCount(runId);
      if (limited) return limited;
      try {
        const result = await withTimeout("click", () =>
          executor.click(appRef, target!),
        );
        return okResult(
          `${result.detail}（actionSent=${result.actionSent}）`,
          { actionSent: result.actionSent },
        );
      } catch (error) {
        return failureOf(error);
      }
    },

    async typeText(
      appRefRaw: unknown,
      text: string,
      rawTarget: RawTarget | undefined,
      runId: string,
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
      const governed = governAction(runId);
      if (governed) return governed;
      const { target, error } = resolveActionTarget(rawTarget);
      if (error) return error;
      const limited = bumpActionCount(runId);
      if (limited) return limited;
      try {
        const result = await withTimeout("type", () =>
          executor.typeText(appRef, text, target),
        );
        return okResult(
          `${result.detail}（actionSent=${result.actionSent}）`,
          { actionSent: result.actionSent },
        );
      } catch (error) {
        return failureOf(error);
      }
    },

    async stop(runId: string) {
      try {
        await executor.stop();
      } catch {
        // stop 是清理路径：执行器失败不掩盖「租约已释放」的结果
      }
      lease.release(runId);
      actionCounts.delete(runId);
      sessionStartedAt.delete(runId);
      return okResult("已停止桌面控制并释放租约。");
    },

    releaseLease(runId: string) {
      lease.release(runId);
      actionCounts.delete(runId);
      sessionStartedAt.delete(runId);
    },

    setExecutor(next: ComputerUseExecutor) {
      executor = next;
    },

    async dispose() {
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
