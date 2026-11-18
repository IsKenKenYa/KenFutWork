import type {
  DirectoryPickerStatus,
  PickDirectoryResponse,
} from "@kenfutwork/shared";
import { localCuaDesktopInvoke } from "./cuaPermissionPlatform.js";
import { surfaceJson } from "./surfaceApi.js";

/** 仅桌面壳提供原生目录选择；普通浏览器返回 null，由调用方保留目录浏览器。 */
export function createTauriDirectoryPicker():
  | (() => Promise<string | null>)
  | null {
  const invoke = localCuaDesktopInvoke();
  if (!invoke) return null;
  return async () => {
    const selected = await invoke("plugin:dialog|open", {
      options: { directory: true, multiple: false, title: "选择文件夹" },
    });
    return typeof selected === "string" ? selected : null;
  };
}

/** 系统对话框不可用时抛出，由调用方回落到目录浏览器（与"用户取消"区分开）。 */
export class NativeDirectoryPickerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeDirectoryPickerUnavailableError";
  }
}

/**
 * 服务端原生文件夹选择器：Web / 自托管形态下，由与用户同机的服务端直接弹
 * 系统文件夹对话框，把绝对路径带回来。用户不用再在一层层 readdir 的自定义
 * 弹窗里翻目录。仅在服务端明确报告 unavailable 时才交给调用方降级。
 */
export function createServerDirectoryPicker(): () => Promise<string | null> {
  return async () => {
    const status = await surfaceJson<DirectoryPickerStatus>(
      "/api/system/directory-picker",
    );
    if (!status.available) {
      throw new NativeDirectoryPickerUnavailableError(
        status.reason ?? "当前形态没有原生目录对话框。",
      );
    }
    const result = await surfaceJson<PickDirectoryResponse>(
      "/api/system/pick-directory",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    if (result.status === "picked") return result.path;
    if (result.status === "unavailable") {
      throw new NativeDirectoryPickerUnavailableError(result.reason);
    }
    if (result.status === "failed") throw new Error(result.reason);
    // cancelled：静默结束，不弹提示也不降级（用户主动取消是正常操作）。
    return null;
  };
}
