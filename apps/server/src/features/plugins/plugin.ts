import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ServerEnv } from "../../config/env.js";
import {
  resolveDesktopDataDir,
  resolveDesktopPaths,
} from "../../desktop/paths.js";
import { registerPluginRoutes } from "../../http/plugins.js";
import type { PluginContext, PluginDefinition } from "../../kernel/types.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { CODE_UI_HOST_RPC_CAPABILITY } from "../code-ui/host-rpc-handler.js";
import { projectWorkDirLoaderFor } from "../projects/work-dir.js";
import { type BundleFiles, buildBundleManifest } from "./bundle-manifest.js";
import { createCodeUiPluginSourceHost } from "./code-ui-host.js";
import { CompatLoadError } from "./compat-context.js";
import { validateBundleFiles } from "./compat-validator.js";
import { createInstallPluginTool } from "./install-plugin-tool.js";
import {
  type BundledBundle,
  createPluginRegistryService,
  type PluginCatalogEntry,
  type PluginRegistryService,
} from "./plugin-registry-service.js";
import { createPluginStorage } from "./plugin-storage.js";

/**
 * plugin-registry 插件：插件市场的服务端（目录 / 安装 / 卸载 / 启停 / 导入校验 / 导出）。
 *
 * 能力缝三元组：
 * - Service Definition：`PluginRegistryService`
 * - Service Provider：`createPluginRegistryService`（本地插件目录 + 兼容性门禁）
 * - Consumer：`/api/plugins*` 路由 + 前端插件市场 UI
 *
 * 管理由localAccess验证的实例主人操作；安装检查与执行审批继续生效。
 */

export type { PluginCatalogEntry, PluginRegistryService };

export interface PluginsPluginDeps {
  /** 内置插件目录（来自 profile，避免与 profiles 互相 import） */
  builtinCatalog: readonly PluginCatalogEntry[];
  /** 已安装插件目录；生产为实例数据根/plugins，测试可显式注入。 */
  pluginsDir?: string;
  /**
   * 自带 bundle 插件目录（每个子目录是一个可安装的插件，如 `plugins/mihome`）。
   * 缺省依次尝试 `<cwd>/plugins` 与 `<cwd>/../../plugins`（pnpm workspace 布局），
   * 可用 KENFUTWORK_BUILTIN_PLUGINS_DIR 覆盖；目录不存在时没有自带插件（不报错）。
   */
  builtinPluginsDir?: string;
  /** GitHub token（可选，提升匿名速率上限） */
  githubToken?: string;
  /** 宿主 Node 主版本（engines 判定用）；缺省取 process.version */
  hostNodeMajor?: number;
}

/**
 * 解析插件落盘目录。
 *
 * 正式入口已经统一目录；独立kernel/测试可用deps或ServerEnv注入。
 * 插件不直接读取进程环境，cwd只用于寻找随包只读bundle。
 */
function resolvePluginsDir(env: ServerEnv, explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (env.pluginsDir) return path.resolve(env.pluginsDir);
  return resolveDesktopPaths(
    resolveDesktopDataDir({
      env: {
        KENFUTWORK_DATA_DIR: env.desktopDataDir,
      },
    }),
  ).pluginsDir;
}

function resolveHostNodeMajor(explicit?: number): number {
  if (typeof explicit === "number") return explicit;
  return Number.parseInt(
    process.version.replace(/^v/, "").split(".")[0] ?? "22",
    10,
  );
}

/** 自带 bundle 目录的候选（按顺序取第一个存在的）；显式传入/环境变量优先。 */
function builtinPluginsDirCandidates(explicit?: string): string[] {
  const candidates: string[] = [];
  if (explicit) candidates.push(path.resolve(explicit));
  const fromEnv = process.env.KENFUTWORK_BUILTIN_PLUGINS_DIR?.trim();
  if (fromEnv) candidates.push(path.resolve(fromEnv));
  candidates.push(path.resolve(process.cwd(), "plugins"));
  candidates.push(path.resolve(process.cwd(), "..", "..", "plugins"));
  return candidates;
}

/**
 * 读自带 bundle 插件（每个子目录 = 一个可安装插件）。启动期一次读入内存：
 * 市场列表要点出来、安装时直接落盘，资产（图标）也能在未安装时显示。
 * 解析失败/门禁不过的子目录跳过并记日志——一个坏目录不拖垮其余自带插件。
 *
 * 导出供回归测试锁定**打包布局契约**：桌面发布包把本仓库 `plugins/` 拷到应用目录，
 * 壳以该目录为服务端 cwd 拉起（`apps/desktop/src-tauri/src/lib.rs` 的
 * `packaged_spawn_config`）——目录候选里的 `<cwd>/plugins` 就是靠这两件事成立的。
 */
export function loadBundledBundles(
  explicitDir: string | undefined,
  hostNodeMajor: number,
  log: { warn(message: string): void },
): BundledBundle[] {
  let rootDir: string | undefined;
  for (const candidate of builtinPluginsDirCandidates(explicitDir)) {
    try {
      if (readdirSync(candidate).length > 0) {
        rootDir = candidate;
        break;
      }
    } catch {
      // 候选目录不存在，试下一个
    }
  }
  if (!rootDir) return [];

  const out: BundledBundle[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(rootDir, entry.name);
    const files: BundleFiles = {};
    const collect = (rel: string): void => {
      for (const item of readdirSync(path.join(pluginDir, rel), {
        withFileTypes: true,
      })) {
        const child = rel ? `${rel}/${item.name}` : item.name;
        if (item.isDirectory()) {
          if (item.name === "node_modules") continue;
          collect(child);
        } else {
          files[child] = readFileSync(path.join(pluginDir, child), "utf8");
        }
      }
    };
    try {
      collect("");
      const { manifest } = buildBundleManifest(files);
      const report = validateBundleFiles(files, {
        hostNodeMajor,
        allowLifecycleScripts: false,
        fallbackName: entry.name,
      });
      if (!report.compatible) {
        log.warn(
          `[plugins] 自带插件 ${entry.name} 门禁未通过，跳过：${report.issues
            .filter((issue) => issue.severity === "blocker")
            .map((issue) => issue.message)
            .join("；")}`,
        );
        continue;
      }
      out.push({
        id: `bundled__${manifest.name}`,
        name: manifest.name,
        files,
        manifest,
        report,
      });
    } catch (error) {
      log.warn(
        `[plugins] 自带插件目录 ${entry.name} 读取失败，跳过：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return out;
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
    inject: [
      "localAccess",
      "persistence",
      "localInstance",
      "projects",
      "executionScopes",
    ],
    apply(ctx) {
      const pluginsDir = resolvePluginsDir(ctx.env, deps.pluginsDir);
      const hostNodeMajor = resolveHostNodeMajor(deps.hostNodeMajor);
      const bundledBundles = loadBundledBundles(
        deps.builtinPluginsDir,
        hostNodeMajor,
        { warn: (message) => console.warn(message) },
      );
      if (bundledBundles.length > 0) {
        console.log(
          `[plugins] 自带插件：${bundledBundles
            .map((bundle) => bundle.name)
            .join(", ")}`,
        );
      }
      ctx.register("plugins", () => {
        service = createPluginRegistryService({
          // 部署形态决定能不能跑第三方插件（云端默认禁止；见 env.resolveAllowThirdPartyPlugins）
          allowThirdParty: ctx.env.allowThirdPartyPlugins !== false,
          pluginsDir,
          tools: ctx.get("tools"),
          subscribe: bridgeSubscribe(ctx),
          hostNodeMajor,
          builtinCatalog: deps.builtinCatalog,
          bundledBundles,
          storage: createPluginStorage({
            persistence: ctx.get("persistence"),
          }),
          ...(deps.githubToken ? { githubToken: deps.githubToken } : {}),
        });
        return service;
      });
      console.log(`[plugins] 插件目录：${pluginsDir}`);
      // kernel dispose 时卸载已装载的第三方插件，释放其注册的工具与副作用
      ctx.effect(() => () => service?.shutdown());
    },
    mounted(ctx) {
      const registry = ctx.get("plugins");
      for (const [id, value] of Object.entries(
        createCodeUiPluginSourceHost({
          registry,
          localInstance: ctx.get("localInstance"),
        }),
      )) {
        ctx.effect(() =>
          ctx
            .get("capabilities")
            .register(CODE_UI_HOST_RPC_CAPABILITY, { id, value }),
        );
      }
      // 从已授权工作目录安装；实例归属、安装检查与执行审批在消费方保持有效。
      ctx.get("tools").register(
        createInstallPluginTool({
          registry,
          localInstance: ctx.get("localInstance"),
          sandboxRoot: ctx.env.sandboxRoot,
          canvasWorkDirs: ctx.env.canvasWorkDirs,
          projectWorkDirLoader: projectWorkDirLoaderFor(ctx.get("persistence")),
        }),
      );
      void registerPluginRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        registry,
        canvasRepository: createCanvasRepository(ctx.get("persistence")),
        projects: ctx.get("projects"),
        executionScopes: ctx.get("executionScopes"),
        localInstance: ctx.get("localInstance"),
        sandboxRoot: ctx.env.sandboxRoot,
        canvasWorkDirs: ctx.env.canvasWorkDirs,
        projectWorkDirLoader: projectWorkDirLoaderFor(ctx.get("persistence")),
        // 引擎托管缝（flow-host 插件注册）：卸载 flow 插件时清理引擎。
        // 调用时再解析（装配顺序不保证 flow-host 先于本插件 mounted）。
        enginePurge: (pluginId) =>
          ctx.tryGet("flowEngine")?.purgeForPlugin(pluginId) ??
          Promise.resolve({ ok: true }),
      });
      // 原服务必须在宿主接请求前恢复，在同步kernel disposer前完成在途释放。
      ctx.app.addHook("onReady", async () => {
        await registry.restore();
      });
      ctx.app.addHook("preClose", async () => {
        console.log("[shutdown] 关闭本地插件。");
        await registry.shutdown();
        console.log("[shutdown] 本地插件已关闭。");
      });
    },
  };
}
