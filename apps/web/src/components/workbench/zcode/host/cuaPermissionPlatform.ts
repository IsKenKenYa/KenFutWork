import type {
  CuaAccessibilitySettingsResult,
  CuaPermissionKind,
  OpenCuaPermissionOnboardingOptions,
} from "@zcode/shared";

type DesktopInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export function localCuaDesktopInvoke() {
  try {
    const parent = window.parent as Window & {
      __TAURI__?: { core?: { invoke?: DesktopInvoke } };
      __TAURI_INTERNALS__?: { invoke?: DesktopInvoke };
    };
    return (
      parent.__TAURI__?.core?.invoke ??
      parent.__TAURI_INTERNALS__?.invoke ??
      null
    );
  } catch {
    return null;
  }
}

type FocusSubscription = (
  listener: (focused: boolean) => void,
) => Promise<() => void>;

export function nativeCuaFocusSubscription(): FocusSubscription | null {
  try {
    const parent = window.parent as Window & {
      __TAURI__?: {
        window?: {
          getCurrentWindow(): {
            onFocusChanged(
              handler: (event: { payload: boolean }) => void,
            ): Promise<() => void>;
          };
        };
      };
    };
    const native = parent.__TAURI__?.window?.getCurrentWindow();
    return native
      ? (listener) => native.onFocusChanged((event) => listener(event.payload))
      : null;
  } catch {
    return null;
  }
}

/** 先安装原生焦点监听再打开设置；iframe的DOM焦点不能代表应用级返回。 */
export async function prepareCuaSettingsReturn(
  target: Window,
  signal: AbortSignal,
  subscribe?: FocusSubscription | null,
) {
  let left = false,
    settled = false;
  let unsubscribe: (() => void) | undefined;
  let resolveReturn: () => void, rejectReturn: (reason: unknown) => void;
  const returned = new Promise<void>((resolve, reject) => {
    resolveReturn = resolve;
    rejectReturn = reject;
  });
  // 注册期取消也由调用方消费，不能产生未处理拒绝。
  void returned.catch(() => {});
  const cleanup = () => {
    settled = true;
    target.removeEventListener("blur", blur);
    target.removeEventListener("focus", focus);
    signal.removeEventListener("abort", cancel);
    unsubscribe?.();
  };
  const update = (focused: boolean) => {
    if (settled) return;
    if (!focused) left = true;
    else if (left) {
      cleanup();
      resolveReturn();
    }
  };
  const blur = () => update(false),
    focus = () => update(true);
  const cancel = () => {
    cleanup();
    rejectReturn(signal.reason);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    if (settled) return { returned };
    if (subscribe) {
      unsubscribe = await subscribe(update);
      if (settled) unsubscribe();
    } else {
      target.addEventListener("blur", blur);
      target.addEventListener("focus", focus);
    }
  } catch (error) {
    cleanup();
    throw error;
  }
  return { returned };
}

/** 直接打开某个权限面板：供自动化这类不参与「必需项」流程的权限使用。 */
export async function openCuaPermissionPane(
  permission: "accessibility" | "screen_recording" | "automation",
): Promise<boolean> {
  const invoke = localCuaDesktopInvoke();
  if (!invoke) return false;
  try {
    await invoke("open_cua_permission_settings", { permission });
    return true;
  } catch {
    return false;
  }
}

export interface CuaPermissionPromptResult {
  requested: boolean;
  granted?: boolean;
  reason?: string;
}

export type CuaPermissionPrompt = (
  kind: "accessibility" | "screen_recording",
) => Promise<CuaPermissionPromptResult>;

export function createCuaPermissionOnboarding(
  invoke: NonNullable<ReturnType<typeof localCuaDesktopInvoke>>,
  capabilities: { requestPermission?: CuaPermissionPrompt } = {},
) {
  const operations = new Map<string, AbortController>();
  return {
    async openCuaPermissionOnboarding(
      options: OpenCuaPermissionOnboardingOptions = {},
    ): Promise<CuaAccessibilitySettingsResult> {
      const id = options.operationId ?? crypto.randomUUID();
      const controller = new AbortController();
      operations.get(id)?.abort();
      operations.set(id, controller);
      const required: CuaPermissionKind[] = options.requiredPermissions ?? [
        options.initialPermission ?? "accessibility",
      ];
      try {
        for (const permission of required) {
          controller.signal.throwIfAborted();
          // 只有 Helper 自己弹权限框，TCC 才会把授权记到 Helper 上；主应用代弹无效。
          // 弹框已通过时直接进入下一项，否则继续打开系统设置手动批准。
          if (capabilities.requestPermission) {
            const prompted = await capabilities.requestPermission(permission);
            controller.signal.throwIfAborted();
            if (prompted.requested && prompted.granted === true) continue;
          }
          const { returned } = await prepareCuaSettingsReturn(
            window,
            controller.signal,
            nativeCuaFocusSubscription(),
          );
          await Promise.all([
            returned,
            invoke("open_cua_permission_settings", { permission }).catch(
              (error) => {
                controller.abort(error);
                throw error;
              },
            ),
          ]);
        }
        // Helper 由服务端管理，设置返回后必须重启新进程才能读到最新 TCC 状态。
        return {
          success: true,
          sessionId: id,
          returnedFromSettings: true,
          restartHelperAfterReturn: true,
        };
      } catch (error) {
        return controller.signal.aborted &&
          controller.signal.reason?.name === "AbortError"
          ? { success: false, canceled: true }
          : {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            };
      } finally {
        if (operations.get(id) === controller) operations.delete(id);
      }
    },
    cancelCuaPermissionOnboarding(id: string) {
      operations
        .get(id)
        ?.abort(new DOMException("权限引导已取消", "AbortError"));
    },
  };
}
