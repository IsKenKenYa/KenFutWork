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

export function createCuaPermissionOnboarding(
  invoke: NonNullable<ReturnType<typeof localCuaDesktopInvoke>>,
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
        // 本后端每次查询拉起新的只读探针，没有需重启的持久Helper。
        return {
          success: true,
          sessionId: id,
          returnedFromSettings: true,
          restartHelperAfterReturn: false,
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
