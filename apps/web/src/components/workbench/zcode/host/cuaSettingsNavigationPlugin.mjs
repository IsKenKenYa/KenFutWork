import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const original = fileURLToPath(
  new URL("../lib/settingsNavigation.ts", import.meta.url),
);
// vite/vitest 在 Windows 上用正斜杠传模块 id，与 fileURLToPath 的反斜杠字面量不相等；
// 统一 resolve 后再按平台大小写比较，避免宿主改写在 win 上静默失配。
function isSettingsNavigationModule(id) {
  const candidate = resolvePath("/", id.split("?")[0]);
  return (
    candidate === original ||
    (process.platform === "win32" &&
      candidate.toLowerCase() === original.toLowerCase())
  );
}

/** 上游把电脑控制整体隐藏；宿主构建只对已接通的原生权限入口解开该门。 */
export function cuaSettingsNavigationPlugin() {
  return {
    name: "kenfutwork-cua-settings-navigation",
    enforce: "pre",
    transform(source, id) {
      if (!isSettingsNavigationModule(id)) return;
      const marker = '  "computerUse",\n]);';
      if (!source.includes(marker))
        throw new Error("原电脑控制设置导航已变化，请复核宿主适配。");
      return {
        code:
          'import { localCuaDesktopInvoke } from "../host/cuaPermissionPlatform.js";\n' +
          source.replace(
            marker,
            '  ...(localCuaDesktopInvoke() ? [] : ["computerUse" as const]),\n]);',
          ),
        map: null,
      };
    },
  };
}
