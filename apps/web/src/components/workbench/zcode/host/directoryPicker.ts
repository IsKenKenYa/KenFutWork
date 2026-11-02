import { localCuaDesktopInvoke } from "./cuaPermissionPlatform.js";

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
