import { resolveDesktopDataDir } from "../../desktop/paths.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { registerWorkHostRoutes, resolveInstalledEditors } from "../../http/work-host.js";
import { join } from "node:path";

/**
 * work-host 插件：Work 模式的宿主适配层（`/api/work/host/*`）。
 *
 * 与 `plugins/work` 的分工（FORM-11 同 flow）：**插件**是产品入口（工作台 Work
 * 模式入口按安装态出现），**本插件**是基础设施——编辑器扩展包注册表与数据目录
 * 事实（`packages/shared/src/work-host.ts` 为契约单源）。适配层自包含：启用不依赖
 * 外部引擎，编辑器二进制按需下载（WD-3），W1 只登记元数据与挂载点（先接线后下载）。
 */
export function createWorkHostPlugin(): PluginDefinition {
  return {
    name: "work-host",
    inject: ["localAccess"],
    apply() {},
    mounted(ctx) {
      // 本机数据目录（与 flow 引擎 env/日志同一数据根）；扩展包落位在
      // `<dataRoot>/work/editors/<id>`，W2 下载器按这一口径落位。
      const dataRoot = resolveDesktopDataDir({
        env: { KENFUTWORK_DATA_DIR: ctx.env.desktopDataDir },
      });
      void registerWorkHostRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        editors: {
          list: () =>
            resolveInstalledEditors({
              editorsDir: join(dataRoot, "work", "editors"),
            }),
        },
        dataDir: dataRoot,
      });
    },
  };
}
