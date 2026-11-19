import { afterEach, expect, it, vi } from "vitest";
import {
  createCuaPermissionOnboarding,
  localCuaDesktopInvoke,
  prepareCuaSettingsReturn,
} from "../src/components/workbench/zcode/host/cuaPermissionPlatform.js";

afterEach(() => vi.unstubAllGlobals());

it("应用级原生焦点完成返回且释放监听，iframe焦点不冒充原生焦点", async () => {
  const controller = new AbortController();
  let emit: (focused: boolean) => void = () => {};
  const unlisten = vi.fn();
  const { returned } = await prepareCuaSettingsReturn(
    window,
    controller.signal,
    async (listener) => {
      emit = listener;
      return unlisten;
    },
  );
  let finished = false;
  void returned.then(() => {
    finished = true;
  });
  window.dispatchEvent(new Event("blur"));
  window.dispatchEvent(new Event("focus"));
  emit(true);
  await Promise.resolve();
  expect(finished).toBe(false);
  emit(false);
  emit(true);
  await returned;
  expect(finished).toBe(true);
  expect(unlisten).toHaveBeenCalledTimes(1);
});

it("Tauri父宿主内部invoke入口可用，普通浏览器不声明桌面能力", () => {
  const invoke = vi.fn(async () => ({}));
  const host = window as Window & {
    __TAURI_INTERNALS__?: { invoke: typeof invoke };
  };
  expect(localCuaDesktopInvoke()).toBeNull();
  host.__TAURI_INTERNALS__ = { invoke };
  try {
    expect(localCuaDesktopInvoke()).toBe(invoke);
  } finally {
    delete host.__TAURI_INTERNALS__;
  }
});

it("普通focus不能冒充系统设置返回，取消会解除监听", async () => {
  const controller = new AbortController();
  let returned = false;
  const { returned: pendingReturn } = await prepareCuaSettingsReturn(
    window,
    controller.signal,
  );
  const pending = pendingReturn.then(() => {
    returned = true;
  });
  window.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  expect(returned).toBe(false);
  window.dispatchEvent(new Event("blur"));
  window.dispatchEvent(new Event("focus"));
  await pending;
  expect(returned).toBe(true);

  const canceled = new AbortController();
  const { returned: waiting } = await prepareCuaSettingsReturn(
    window,
    canceled.signal,
  );
  canceled.abort(new DOMException("取消", "AbortError"));
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
});

it("按权限依次进入系统设置，返回只声明流程完成并要求刷新真实状态", async () => {
  const panes: string[] = [];
  const onboarding = createCuaPermissionOnboarding(async (command, args) => {
    expect(command).toBe("open_cua_permission_settings");
    panes.push(String(args?.permission));
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });
  const result = await onboarding.openCuaPermissionOnboarding({
    operationId: "manual-1",
    requiredPermissions: ["accessibility", "screen_recording"],
  });
  expect(panes).toEqual(["accessibility", "screen_recording"]);
  expect(result).toEqual({
    success: true,
    sessionId: "manual-1",
    returnedFromSettings: true,
    restartHelperAfterReturn: false,
  });
  expect(result).not.toHaveProperty("permissionStatus");
});

it("关闭权限页取消精确操作，设置打开失败不能报告成功", async () => {
  const onboarding = createCuaPermissionOnboarding(async () => {});
  const pending = onboarding.openCuaPermissionOnboarding({
    operationId: "canceled-1",
  });
  onboarding.cancelCuaPermissionOnboarding("unrelated");
  onboarding.cancelCuaPermissionOnboarding("canceled-1");
  expect(await pending).toEqual({ success: false, canceled: true });

  const failed = createCuaPermissionOnboarding(async () => {
    throw new Error("系统设置打不开");
  });
  expect(await failed.openCuaPermissionOnboarding()).toEqual({
    success: false,
    error: "系统设置打不开",
  });
});
