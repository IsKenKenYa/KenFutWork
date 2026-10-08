import { fileURLToPath } from "node:url";

const original = fileURLToPath(
  new URL("../lib/settingsNavigation.ts", import.meta.url),
);

/** 上游把电脑控制整体隐藏；宿主构建只对已接通的原生权限入口解开该门。 */
export function cuaSettingsNavigationPlugin() {
  return {
    name: "kenfutwork-cua-settings-navigation",
    enforce: "pre",
    transform(source, id) {
      if (id.split("?")[0] !== original) return;
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
