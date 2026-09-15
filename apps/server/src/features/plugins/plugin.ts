import path from "node:path";

import { registerPluginRoutes } from "../../http/plugins.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { createInstallPluginTool } from "./install-plugin-tool.js";
import type { PluginContext, PluginDefinition } from "../../kernel/types.js";
import { CompatLoadError } from "./compat-context.js";
import {
  createPluginRegistryService,
  type PluginCatalogEntry,
  type PluginRegistryService,
} from "./plugin-registry-service.js";

/**
 * plugin-registry 插件：插件市场的服务端（目录 / 安装 / 卸载 / 启停 / 导入校验 / 导出）。
 *
 * 能力缝三元组：
 * - Service Definition：`PluginRegistryService`
 * - Service Provider：`createPluginRegistryService`（本地插件目录 + 兼容性门禁）
 * - Consumer：`/api/plugins*` 路由 + 前端插件市场 UI
 *
 * 依赖 `auth`（登录门）与 `admin`（变更类端点的管理员门）：安装会拉取并在本机执行
 * 第三方代码，属实例级危险操作。
 */

export type { PluginCatalogEntry, PluginRegistryService };

export interface PluginsPluginDeps {
  /** 内置插件目录（来自 profile，避免与 profiles 互相 import） */
  builtinCatalog: readonly PluginCatalogEntry[];
  /** 已安装插件落盘目录；缺省 `<cwd>/.loomic/plugins`，可用 LOOMIC_PLUGINS_DIR 覆盖 */
  pluginsDir?: string;
  /** GitHub token（可选，提升匿名速率上限） */
  githubToken?: string;
  /** 宿主 Node 主版本（engines 判定用）；缺省取 process.version */
  hostNodeMajor?: number;
}

/**
 * 解析插件落盘目录。
 *
 * 默认按 `process.cwd()` 解析——**启动期会把绝对路径打进日志**，因为 cwd 随启动方式变化
 * （`pnpm --filter` 时是 `apps/server`，桌面 exe 启动时是任意目录），不打印出来会很难排查。
 * 需要固定位置时用 `LOOMIC_PLUGINS_DIR` 覆盖。
 */
function resolvePluginsDir(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const fromEnv = process.env.LOOMIC_PLUGINS_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), ".loomic", "plugins");
}

function resolveHostNodeMajor(explicit?: number): number {
  if (typeof explicit === "number") return explicit;
  return Number.parseInt(
    process.version.replace(/^v/, "").split(".")[0] ?? "22",
    10,
  );
}

/**
 * 把插件的 `ctx.on(event, listener)`（已映射为 kernel 事件名）接到内核事件缝。
 * 逐个事件显式分支：内核事件是封闭的三个，用类型安全的写法而不是 `as never`。
 */
function bridgeSubscribe(ctx: PluginContext) {
  return (
    event: string,
    listener: (payload: unknown, next?: unknown) => unknown,
  ): (() => void) => {
    switch (event) {
      case "pre-step":
        return ctx.on(
          "pre-step",
          async (payload, next) =>
            (await listener(payload, next)) as typeof payload,
        );
      case "tool-pre-execute":
        return ctx.on(
          "tool-pre-execute",
          async (payload, next) =>
            (await listener(payload, next)) as typeof payload,
        );
      case "turn-stopping":
        return ctx.on("turn-stopping", async (payload, next) => {
          await listener(payload, next);
        });
      default:
        // 门禁已拦未映射事件；此处是运行时的最后一道，保持 fail loud
        throw new CompatLoadError(
          `事件 ${event} 未映射到内核事件缝。`,
          "event_unsupported",
        );
    }
  };
}

export function createPluginsPlugin(deps: PluginsPluginDeps): PluginDefinition {
  let service: PluginRegistryService | undefined;

  return {
    name: "plugin-registry",
    inject: ["auth", "admin", "persistence", "viewer"],
    apply(ctx) {
      const pluginsDir = resolvePluginsDir(deps.pluginsDir);
      ctx.register("plugins", () => {
        service = createPluginRegistryService({
          pluginsDir,
          tools: ctx.get("tools"),
          subscribe: bridgeSubscribe(ctx),
          hostNodeMajor: resolveHostNodeMajor(deps.hostNodeMajor),
          builtinCatalog: deps.builtinCatalog,
          ...(deps.githubToken ? { githubToken: deps.githubToken } : {}),
        });
        return service;
      });
      console.log(`[plugins] 插件目录：${pluginsDir}`);
      // kernel dispose 时卸载已装载的第三方插件，释放其注册的工具与副作用
      ctx.effect(() => () => {
        void service?.shutdown();
      });

      // install_plugin：创造模式的插件产物收尾（从工作目录安装；管理员门 + 兼容性门禁不绕过）
      ctx.get("tools").register(
        createInstallPluginTool({
          registry: ctx.get("plugins"),
          auth: ctx.get("auth"),
          admin: ctx.get("admin"),
          sandboxRoot: ctx.env.sandboxRoot,
          canvasWorkDirs: ctx.env.canvasWorkDirs,
        }),
      );
    },
    mounted(ctx) {
      const registry = ctx.get("plugins");
      void registerPluginRoutes(ctx.app, {
        auth: ctx.get("auth"),
        admin: ctx.get("admin"),
        registry,
        canvasRepository: createCanvasRepository(ctx.get("persistence")),
        viewerService: ctx.get("viewer"),
        sandboxRoot: ctx.env.sandboxRoot,
        canvasWorkDirs: ctx.env.canvasWorkDirs,
      });
      // 启动装载已启用插件：单个失败只记日志，不阻断进程启动
      void registry.restore();
    },
  };
}
