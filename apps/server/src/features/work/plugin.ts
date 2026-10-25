import { join } from "node:path";
import { resolveDesktopDataDir } from "../../desktop/paths.js";
import {
  registerWorkHostRoutes,
  resolveInstalledEditors,
} from "../../http/work-host.js";
import type { PluginDefinition } from "../../kernel/types.js";

/**
 * work-host 插件：Work 模式的宿主适配层（`/api/work/host/*`）。
 *
 * 与 `plugins/work` 的分工（FORM-11 同 flow）：**插件**是产品入口（工作台 Work
 * 模式入口按安装态出现），**本插件**是基础设施——编辑器扩展包注册表、按需下载
 * 状态机与静态托管（`packages/shared/src/work-host.ts` 为契约单源）。适配层
 * 自包含：启用不依赖外部引擎，编辑器二进制按需下载（WD-3，W2 锚定 gridcraft）。
 */
export function createWorkHostPlugin(): PluginDefinition {
  return {
    name: "work-host",
    inject: ["localAccess"],
    apply() {},
    mounted(ctx) {
      // 本机数据目录（与 flow 引擎 env/日志同一数据根）；扩展包落位在
      // `<dataRoot>/work/editors/<id>`，下载器与静态托管按这一口径共用。
      const dataRoot = resolveDesktopDataDir({
        env: { KENFUTWORK_DATA_DIR: ctx.env.desktopDataDir },
      });
      const editorsDir = join(dataRoot, "work", "editors");
      void registerWorkHostRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        editors: {
          list: () => resolveInstalledEditors({ editorsDir }),
        },
        dataDir: dataRoot,
        editorsDir,
      });
    },
  };
}
