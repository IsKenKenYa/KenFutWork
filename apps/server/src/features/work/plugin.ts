import { join } from "node:path";
import { resolveDesktopDataDir } from "../../desktop/paths.js";
import {
  registerWorkHostRoutes,
  resolveInstalledEditors,
} from "../../http/work-host.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { toKernelTool } from "../mcp/mcp-tools.js";
import { registerKicadRoutes } from "./kicad/routes.js";
import { KicadWorker } from "./kicad/worker.js";

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
    inject: ["localAccess", "tools"],
    apply() {},
    mounted(ctx) {
      // 本机数据目录（与 flow 引擎 env/日志同一数据根）；扩展包落位在
      // `<dataRoot>/work/editors/<id>`，下载器与静态托管按这一口径共用。
      const dataRoot = resolveDesktopDataDir({
        env: { KENFUTWORK_DATA_DIR: ctx.env.desktopDataDir },
      });
      const editorsDir = join(dataRoot, "work", "editors");
      const tools = ctx.get("tools");
      // KiCad：真实的 ZCode 插件（MCP 服务 + 面板）常驻一个进程，agent 与面板共用。
      const kicad = new KicadWorker(dataRoot);
      ctx.effect(() => () => {
        void kicad.close();
      });
      const kicadClient = {
        listTools: async () => ({ tools: await kicad.listTools() }),
        callTool: async (args: {
          name: string;
          arguments?: Record<string, unknown>;
        }) => kicad.callTool(args.name, args.arguments ?? {}),
      };
      // 懒启动：Work 页面/面板第一次访问时再拉起服务，避免每个会话都常驻一个 Python 进程。
      kicad.onStarted((list) => {
        for (const tool of list) {
          const definition = toKernelTool("kicad", tool, kicadClient);
          ctx.effect(() =>
            tools.registerDynamic({
              id: `mcp:instance:${definition.name}`,
              scope: "shared",
              configurationVersion: "work-kicad:1",
              resolve(run) {
                return run.scopeHandle?.role === "main" ? definition : null;
              },
            }),
          );
        }
        console.log(
          `[work] KiCad 工具已装载：${list.map((tool) => tool.name).join(", ")}`,
        );
      });
      registerKicadRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        worker: kicad,
      });
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
