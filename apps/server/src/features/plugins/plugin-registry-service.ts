import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type CompatReport,
  type InstalledPlugin,
  PLUGIN_UI_SLOTS,
  type PluginBundleManifest,
  type PluginExportArtifact,
  type PluginMarketEntry,
  type PluginUiSlot,
} from "@kenfutwork/shared";

import type { ToolRegistry } from "../../kernel/types.js";
import { type BundleFiles, buildBundleManifest } from "./bundle-manifest.js";
import { fetchBundleFiles } from "./bundle-source.js";
import {
  CompatLoadError,
  type CompatLoadResult,
  loadCompatPlugin,
} from "./compat-context.js";
import { validateBundleFiles } from "./compat-validator.js";
import {
  exportPluginBundle,
  type PluginExportSpec,
} from "./plugin-exporter.js";
import type { PluginStorage } from "./plugin-storage.js";

/**
 * 插件注册表服务：安装 / 卸载 / 启停 / 导入校验 / 导出。
 *
 * 存储选型：插件**代码**是机器本地的（要落盘才能 `import()`），其安装态因此也是
 * 机器本地的——落在 `pluginsDir` 下的状态文件里，而不是数据库表。桌面端每台机器
 * 的插件集合本就不同，用共享表建模是错的；自托管形态下插件由运维在实例上安装，
 * 同样是实例级。改这个选型前先想清楚「谁的插件」这个问题。
 *
 * 安装事务：先门禁、后落盘、再装载；装载失败回滚落盘。**门禁不通过则一个字节都不写**。
 */

/** 静态资源体积上限（面板页面/样式够用；挡住误托管的打包产物）。 */
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

/** 按扩展名给 content-type（够面板用；未知一律 octet-stream 由浏览器下载）。 */
function contentTypeOf(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const table: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
  };
  return table[ext] ?? "application/octet-stream";
}

export interface PluginCatalogEntry {
  name: string;
  title: string;
  description: string;
  /** 市场分类（chips 用它分组；缺省归「其他」）。 */
  category?: string;
  /** 该内置插件需要的能力（导出为 bundle 时写入能力声明） */
  capabilities?: readonly string[];
}

/** 随应用自带的 bundle（启动时从自带插件目录整体读入内存）。 */
export interface BundledBundle {
  /** 安装后的注册表 id（`local__<包名>`，与本地目录安装同 id，可无缝升级） */
  id: string;
  name: string;
  files: Record<string, string>;
  manifest: PluginBundleManifest;
  report: CompatReport;
}

export interface PluginRegistryDeps {
  /**
   * 是否允许第三方插件（来自部署形态；云端默认 false）。
   * false 时 `install()` 直接拒绝、`restore()` 不装载既有第三方插件——
   * 这是能力开关，不是 UI 提示。
   */
  allowThirdParty?: boolean;
  pluginsDir: string;
  tools: ToolRegistry;
  subscribe: (
    event: string,
    listener: (payload: unknown, next?: unknown) => unknown,
  ) => () => void;
  hostNodeMajor: number;
  /** 内置插件目录（市场展示 + 导出用） */
  builtinCatalog: readonly PluginCatalogEntry[];
  /**
   * 随应用自带的第三方形态 bundle（如米家插件）：市场里直接列出、点「安装」即装，
   * 不需要用户找来源链接；不装就不生效。与 builtinCatalog（内核自身能力，恒可用）不同。
   */
  bundledBundles?: readonly BundledBundle[];
  /**
   * 插件存储（能力 `storage`）：插件**数据**的唯一落点。
   *
   * 与「插件代码/安装态落在 pluginsDir」是两回事——代码和安装态是机器本地的
   * （见文件头注释），而插件数据挂在「工作区」上，必须走 DB 与工作区隔离缝。
   */
  storage: PluginStorage;
  /** GitHub token（可选，提升匿名速率上限） */
  githubToken?: string;
  logger?: {
    info(message: string, ...rest: unknown[]): void;
    warn(message: string, ...rest: unknown[]): void;
  };
}

/** 插件贡献物（提示段 / 路由 / UI 入口）——卸载或停用时一并收回。 */
interface PluginContributions {
  promptFragments: Array<{ pluginId: string; id: string; text: string }>;
  routes: Array<{
    pluginId: string;
    method: "GET" | "POST";
    path: string;
    publicRoute: boolean;
    handler: (request: {
      method: string;
      path: string;
      query: Record<string, string>;
      body: unknown;
      headers: Record<string, string | undefined>;
      workspaceId?: string | undefined;
    }) => unknown | Promise<unknown>;
  }>;
  ui: Array<{
    pluginId: string;
    id: string;
    title: string;
    slot: string;
    url: string;
    icon: string | null;
  }>;
}

export interface PluginRouteDispatchResult {
  status: number;
  /** JSON 可序列化的 body，或字符串（插件可返回 HTML 文本）。 */
  body: unknown;
  headers?: Record<string, string>;
}

export interface PluginRegistryService {
  list(): Promise<PluginMarketEntry[]>;
  inspect(input: { url: string; ref?: string | undefined }): Promise<{
    manifest: PluginBundleManifest;
    report: CompatReport;
  }>;
  install(input: {
    /** 来源链接（与 `builtin` 二选一） */
    url?: string | undefined;
    ref?: string | undefined;
    /** 自带 bundle 的包名（与 `url` 二选一） */
    builtin?: string | undefined;
    allowLifecycleScripts: boolean;
  }): Promise<{ installed: InstalledPlugin; report: CompatReport }>;
  uninstall(id: string): Promise<void>;
  /** 已启用插件贡献的提示段（按装载顺序）。 */
  listPromptFragments(): string[];
  /** 已启用插件贡献的 UI 入口。 */
  listUiEntries(): Array<{
    pluginId: string;
    id: string;
    title: string;
    slot: string;
    url: string;
    icon: string | null;
  }>;
  /** 路由派发：找不到（未启用/未注册/路径不匹配）返回 undefined。 */
  dispatchRoute(input: {
    pluginId: string;
    method: string;
    path: string;
    query: Record<string, string>;
    body: unknown;
    headers: Record<string, string | undefined>;
    isAuthenticated: boolean;
    /** 调用者所属工作区（未登录时为 undefined）：插件 `ctx.storage` 的显式入参。 */
    workspaceId?: string | undefined;
  }): Promise<PluginRouteDispatchResult | undefined>;
  /**
   * 读插件 bundle 里的静态资源（`/api/plugins/<id>/assets/…`）。
   *
   * 只在清单声明 `kenfutwork.assets === true` 时开放；只读、防路径穿越、限体积、
   * 拒绝 `node_modules` 与点文件。返回 undefined = 不存在 / 未开放（路由层转 404）。
   */
  readAsset(input: {
    pluginId: string;
    relativePath: string;
  }): Promise<{ content: Buffer; contentType: string } | undefined>;
  /** 该路由是否声明为公开（未注册时 undefined —— 由调用方决定鉴权口径）。 */
  routeVisibility(input: {
    pluginId: string;
    method: string;
    path: string;
  }): "public" | "private" | undefined;
  setEnabled(id: string, enabled: boolean): Promise<InstalledPlugin>;
  exportPlugin(
    name: string,
    format: "dsh" | "kenfutwork",
  ): PluginExportArtifact;
  /** 启动时装载全部 enabled 的已安装插件（单个失败不阻断启动）。 */
  restore(): Promise<void>;
  /** kernel 关闭时卸载全部已装载插件（释放工具与副作用）。 */
  shutdown(): Promise<void>;
}

export class PluginRegistryError extends Error {
  constructor(
    message: string,
    readonly code:
      | "plugin_not_found"
      | "system_plugin"
      | "install_failed"
      | "not_installed"
      | "invalid_request",
    readonly report?: CompatReport,
  ) {
    super(message);
    this.name = "PluginRegistryError";
  }
}

/** 内置插件的系统集合：与 kernel 装配强绑定，不允许卸载。 */
export const SYSTEM_PLUGIN_NAMES = new Set([
  "model-providers",
  "agent-runs",
  "permissions",
  "agent-modes",
  "canvas",
]);

interface RegistryState {
  version: 1;
  /** id → 安装记录（manifest + 报告 + 来源） */
  installed: InstalledPlugin[];
}

const EMPTY_STATE: RegistryState = { version: 1, installed: [] };

function sanitizeId(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "") || "plugin"
  );
}

/**
 * 校验失败时清单可能根本解析不出来（缺 package.json 等），
 * 但 UI 仍要展示「这是哪个来源、为什么不行」，故构造占位清单。
 */
function manifestOrPlaceholder(
  files: BundleFiles,
  fallbackName: string,
  report: CompatReport,
): PluginBundleManifest {
  try {
    return buildBundleManifest(files).manifest;
  } catch {
    return {
      name: fallbackName,
      version: "0.0.0",
      title: null,
      description: "",
      category: null,
      license: null,
      repositoryUrl: null,
      homepage: null,
      format: report.format,
      patchPath: null,
      entry: null,
      requiredCapabilities: [],
      scope: null,
      enginesNode: null,
      hasClientUi: false,
      ui: [],
      assets: false,
      lifecycleScripts: [],
      dshBaseDependencies: [],
      hasNativeBuild: false,
      dependencies: {},
      peerDependencies: {},
    };
  }
}

export function createPluginRegistryService(
  deps: PluginRegistryDeps,
): PluginRegistryService {
  const log = deps.logger ?? {
    info: (message: string, ...rest: unknown[]) =>
      console.log(message, ...rest),
    warn: (message: string, ...rest: unknown[]) =>
      console.warn(message, ...rest),
  };
  const statePath = path.join(deps.pluginsDir, "installed.json");
  /** 已装载插件的卸载句柄（id → dispose） */
  const loaded = new Map<string, CompatLoadResult>();
  /**
   * 已安装记录的进程内索引（id → 记录）。
   * 存在的理由：导出是同步 API（HTTP 侧不该为拿清单再读一次盘），
   * 且 UI 用的是**插件名**而非注册表 id，解析需要内存这份索引。
   */
  const records = new Map<string, InstalledPlugin>();

  async function readState(): Promise<RegistryState> {
    try {
      const raw = await readFile(statePath, "utf8");
      const parsed = JSON.parse(raw) as RegistryState;
      if (!Array.isArray(parsed.installed)) return { ...EMPTY_STATE };
      return { version: 1, installed: parsed.installed };
    } catch {
      return { ...EMPTY_STATE };
    }
  }

  async function writeState(state: RegistryState): Promise<void> {
    await mkdir(deps.pluginsDir, { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  function bundleDirOf(id: string): string {
    return path.join(deps.pluginsDir, id);
  }

  /**
   * 插件运行副本根 + 按（插件 id, installedAt）定位快照目录。
   *
   * **为什么 import 不直接用落盘目录**：dev 服务端跑在 `node --watch` 下，它把
   * import 过的每个文件都加入监视；bundle 就地 import 后，「卸载 = rm 落盘目录 =
   * 删被监视文件 = dev 服务端重启」，正在跑的 agent run 全部中断（2026-10-07 真机
   * 复现）。因此装载前把 bundle 拷进系统临时目录再 import：
   * - 卸载只删落盘目录，**永不删快照**——同进程内 import 过的快照一旦删除同样触发
   *   重启，所以快照只增不删，残留由 OS 清理 tmp；
   * - 快照按 installedAt 隔离：重装必然拿到新时间戳 → 新目录，重载旧记录复用旧快照。
   */
  const pluginRuntimeRoot = path.join(tmpdir(), "kenfutwork-plugin-runtime");

  function bundleRuntimeDirOf(id: string, installedAt: string): string {
    return path.join(pluginRuntimeRoot, `${id}-${encodeURIComponent(installedAt)}`);
  }

  async function snapshotBundleForImport(
    record: InstalledPlugin,
  ): Promise<string> {
    const target = bundleRuntimeDirOf(record.id, record.installedAt);
    if (existsSync(target)) return target;
    const staging = `${target}.staging-${process.pid}`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(path.dirname(staging), { recursive: true });
    await cp(bundleDirOf(record.id), staging, { recursive: true });
    await rm(target, { recursive: true, force: true });
    await cp(staging, target, { recursive: true });
    await rm(staging, { recursive: true, force: true });
    return target;
  }

  async function writeBundleFiles(
    id: string,
    files: Record<string, string>,
  ): Promise<string> {
    const dir = bundleDirOf(id);
    await rm(dir, { recursive: true, force: true });
    for (const [relative, content] of Object.entries(files)) {
      // 防目录穿越：相对路径里出现 .. 或绝对路径即拒绝
      const normalized = path.normalize(relative).replace(/\\/g, "/");
      if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
        throw new PluginRegistryError(
          `bundle 包含非法路径：${relative}`,
          "install_failed",
        );
      }
      const target = path.join(dir, normalized);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    return dir;
  }

  async function loadInstalledPlugin(
    record: InstalledPlugin,
  ): Promise<CompatLoadResult | undefined> {
    if (loaded.has(record.id)) return loaded.get(record.id);
    const entry = record.manifest.entry;
    if (!entry) {
      log.warn(`[plugins] ${record.id} 未声明入口模块，跳过装载。`);
      return undefined;
    }
    const runtimeDir = await snapshotBundleForImport(record);
    const entryPath = path.join(runtimeDir, entry);
    try {
      // 查询串绕过 ESM 模块缓存：重装同一路径必须拿到新代码
      const moduleUrl = `${pathToFileURL(entryPath).href}?v=${encodeURIComponent(record.installedAt)}`;
      const namespace: unknown = await import(/* @vite-ignore */ moduleUrl);
      const result = await loadCompatPlugin(namespace, {
        tools: deps.tools,
        subscribe: deps.subscribe,
        label: record.id,
        // 贡献物统一记账：提示段进 system prompt、路由挂 /api/plugins/<id>/、UI 入口给前端
        promptFragments: (fragment) => {
          const fragmentId =
            fragment.id ??
            `${record.id}:${contributions.promptFragments.length + 1}`;
          const entry = {
            pluginId: record.id,
            id: fragmentId,
            text: fragment.text,
          };
          contributions.promptFragments.push(entry);
          return () => {
            contributions.promptFragments =
              contributions.promptFragments.filter((item) => item !== entry);
          };
        },
        routes: (spec) => {
          const entry = {
            pluginId: record.id,
            method: spec.method ?? ("GET" as const),
            path: spec.path.replace(/^\/+/, ""),
            publicRoute: spec.public ?? false,
            handler: spec.handler,
          };
          contributions.routes.push(entry);
          return () => {
            contributions.routes = contributions.routes.filter(
              (item) => item !== entry,
            );
          };
        },
        ui: (entry) => {
          // 运行时注册的槽位同样收窄到四个（清单侧已由 schema 收窄，这里防插件写错）。
          const slot = (PLUGIN_UI_SLOTS as readonly string[]).includes(
            entry.slot ?? "",
          )
            ? (entry.slot as PluginUiSlot)
            : "sidebar";
          const item = {
            pluginId: record.id,
            id:
              typeof entry.id === "string" && entry.id
                ? entry.id
                : `${record.id}-panel`,
            title: entry.title,
            slot,
            url: entry.url,
            icon:
              typeof entry.icon === "string" && entry.icon ? entry.icon : null,
          };
          contributions.ui.push(item);
          return () => {
            contributions.ui = contributions.ui.filter((row) => row !== item);
          };
        },
        // 存储：调用方（插件的路由/工具）显式传工作区，这里只把 pluginId 绑上，
        // 插件拿不到「换个插件 id 读写别人数据」的口子。
        storage: {
          get: (workspaceId, key) =>
            deps.storage.get(workspaceId, record.id, key),
          set: (workspaceId, key, value) =>
            deps.storage.set(workspaceId, record.id, key, value),
          remove: (workspaceId, key) =>
            deps.storage.remove(workspaceId, record.id, key),
          keys: (workspaceId) => deps.storage.keys(workspaceId, record.id),
        },
      });
      loaded.set(record.id, result);
      log.info(
        `[plugins] ${record.id} 已装载，注册 ${result.toolNames.length} 个工具：${result.toolNames.join(", ") || "无"}`,
      );
      return result;
    } catch (error) {
      const message =
        error instanceof CompatLoadError
          ? `${error.reason}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      log.warn(`[plugins] ${record.id} 装载失败：${message}`);
      return undefined;
    }
  }

  /** 贡献物记账（每插件一组；卸载/停用时按 pluginId 收回）。 */
  const contributions: PluginContributions = {
    promptFragments: [],
    routes: [],
    ui: [],
  };

  function dropContributions(pluginId: string): void {
    contributions.promptFragments = contributions.promptFragments.filter(
      (item) => item.pluginId !== pluginId,
    );
    contributions.routes = contributions.routes.filter(
      (item) => item.pluginId !== pluginId,
    );
    contributions.ui = contributions.ui.filter(
      (item) => item.pluginId !== pluginId,
    );
  }

  function unloadPlugin(id: string): void {
    dropContributions(id);
    const handle = loaded.get(id);
    if (!handle) return;
    try {
      handle.dispose();
    } catch (error) {
      log.warn(`[plugins] ${id} 卸载清理失败：`, error);
    }
    loaded.delete(id);
  }

  /** 安装事务共用体：先门禁、后落盘、再装载；装载失败回滚落盘。 */
  async function installFromFiles(
    files: BundleFiles,
    options: {
      fallbackLabel: string;
      idOverride?: string;
      source: "url" | "builtin";
      repositoryUrl?: string | null;
      headSha?: string | null;
      allowLifecycleScripts: boolean;
    },
  ): Promise<{ installed: InstalledPlugin; report: CompatReport }> {
    const report = validateBundleFiles(files, {
      hostNodeMajor: deps.hostNodeMajor,
      allowLifecycleScripts: options.allowLifecycleScripts,
      fallbackName: options.fallbackLabel,
    });

    // 门禁在前：不通过则一个字节都不落盘
    if (!report.compatible) {
      throw new PluginRegistryError(
        `兼容性校验未通过，已阻止安装：${report.issues
          .filter((item) => item.severity === "blocker")
          .map((item) => item.message)
          .join("；")}`,
        "install_failed",
        report,
      );
    }

    const { manifest } = buildBundleManifest(files);

    const id = sanitizeId(options.idOverride ?? `local__${manifest.name}`);

    const state = await readState();
    if (state.installed.some((record) => record.id === id)) {
      // 重装：先卸载旧实例，避免工具重名冲突
      unloadPlugin(id);
    }

    await writeBundleFiles(id, files);

    const record: InstalledPlugin = {
      id,
      name: manifest.name,
      version: manifest.version,
      source: options.source,
      repositoryUrl: options.repositoryUrl ?? null,
      headSha: options.headSha ?? null,
      enabled: true,
      manifest,
      report,
      installedAt: new Date().toISOString(),
    };

    const loadResult = await loadInstalledPlugin(record);
    if (!loadResult) {
      // 装载失败：回滚落盘，保持「装了的都能用」
      await rm(bundleDirOf(id), { recursive: true, force: true });
      records.delete(id);
      throw new PluginRegistryError(
        `插件装载失败，已回滚：${manifest.name}`,
        "install_failed",
        report,
      );
    }

    records.set(id, record);
    const next: RegistryState = {
      version: 1,
      installed: [...state.installed.filter((item) => item.id !== id), record],
    };
    await writeState(next);

    return { installed: record, report };
  }

  return {
    async list() {
      const state = await readState();
      const entries: PluginMarketEntry[] = deps.builtinCatalog.map((entry) => ({
        id: entry.name,
        name: entry.name,
        title: entry.title,
        description: entry.description,
        source: "builtin",
        repositoryUrl: null,
        headSha: null,
        installability: null,
        category: entry.category ?? null,
        system: SYSTEM_PLUGIN_NAMES.has(entry.name),
        installed: true,
        // 系统插件不带 UI 入口（它们本来就有专门的界面）
        ui: [],
      }));

      for (const record of state.installed) {
        entries.push({
          id: record.id,
          name: record.name,
          title: record.manifest.title ?? record.name,
          description: record.manifest.description,
          source: record.source,
          repositoryUrl: record.repositoryUrl,
          headSha: record.headSha,
          installability: record.report.compatible ? "verified" : "failed",
          category: record.manifest.category ?? null,
          system: false,
          installed: record.enabled,
          // 停用即收回入口（侧栏不该出现点不开的插件）
          ui: record.enabled ? (record.manifest.ui ?? []) : [],
        });
      }

      // 自带而未装的 bundle：市场里直接可装（点「安装」，无需找来源链接）
      const installedIds = new Set(state.installed.map((item) => item.id));
      for (const bundle of deps.bundledBundles ?? []) {
        if (installedIds.has(bundle.id)) continue;
        entries.push({
          id: bundle.id,
          name: bundle.name,
          title: bundle.manifest.title ?? bundle.name,
          description: bundle.manifest.description,
          source: "builtin",
          repositoryUrl: null,
          headSha: null,
          installability: bundle.report.compatible ? "verified" : "failed",
          category: bundle.manifest.category ?? null,
          system: false,
          installed: false,
          ui: bundle.manifest.ui ?? [],
        });
      }
      return entries;
    },

    async inspect(input) {
      const { files, origin } = await fetchBundleFiles(input.url, {
        ...(input.ref ? { ref: input.ref } : {}),
        ...(deps.githubToken ? { token: deps.githubToken } : {}),
      });
      const report = validateBundleFiles(files, {
        hostNodeMajor: deps.hostNodeMajor,
        allowLifecycleScripts: false,
        fallbackName: origin.label,
      });
      return {
        manifest: manifestOrPlaceholder(files, origin.label, report),
        report,
      };
    },

    async install(input) {
      // 自带 bundle：与应用同发行的第一方代码，不走第三方开关
      if (input.builtin) {
        const bundled = (deps.bundledBundles ?? []).find(
          (item) => item.name === input.builtin,
        );
        if (!bundled) {
          throw new PluginRegistryError(
            `自带的插件不存在：${input.builtin}`,
            "invalid_request",
          );
        }
        return installFromFiles(bundled.files, {
          fallbackLabel: bundled.name,
          idOverride: bundled.id,
          source: "builtin",
          allowLifecycleScripts: input.allowLifecycleScripts,
        });
      }

      // 云端等多租户形态：默认不允许在本实例上跑租户装的任意代码
      if (deps.allowThirdParty === false) {
        throw new PluginRegistryError(
          "当前部署形态不允许安装第三方插件（云端的共享基础设施不执行租户代码；" +
            "如确需开启，请显式设置 KENFUTWORK_ALLOW_THIRD_PARTY_PLUGINS=true）。",
          "install_failed",
        );
      }
      const { files, origin } = await fetchBundleFiles(input.url ?? "", {
        ...(input.ref ? { ref: input.ref } : {}),
        ...(deps.githubToken ? { token: deps.githubToken } : {}),
      });
      return installFromFiles(files, {
        fallbackLabel: origin.label,
        source: "url",
        repositoryUrl: origin.repositoryUrl,
        headSha: origin.headSha,
        allowLifecycleScripts: input.allowLifecycleScripts,
      });
    },

    listPromptFragments() {
      return contributions.promptFragments.map((item) => item.text);
    },

    listUiEntries() {
      return contributions.ui.map((item) => ({ ...item }));
    },

    async readAsset({ pluginId, relativePath }) {
      const state = await readState();
      const record = state.installed.find((item) => item.id === pluginId);
      const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
      if (
        !normalized ||
        normalized.includes("..") ||
        normalized
          .split("/")
          .some((part) => part.startsWith(".") || part === "node_modules")
      ) {
        return undefined;
      }
      // 未安装的自带 bundle：资产从内存出（市场卡片图标在安装前也要能显示）
      if (!record) {
        const bundled = (deps.bundledBundles ?? []).find(
          (item) => item.id === pluginId,
        );
        if (bundled?.manifest.assets !== true) return undefined;
        const content = bundled.files[normalized];
        if (
          content === undefined ||
          Buffer.byteLength(content, "utf8") > MAX_ASSET_BYTES
        ) {
          return undefined;
        }
        return {
          content: Buffer.from(content, "utf8"),
          contentType: contentTypeOf(normalized),
        };
      }
      if (!record.enabled || record.manifest.assets !== true) {
        return undefined;
      }
      const bundleDir = bundleDirOf(pluginId);
      const absolute = path.resolve(bundleDir, normalized);
      if (!absolute.startsWith(path.resolve(bundleDir) + path.sep)) {
        return undefined;
      }
      try {
        const info = await stat(absolute);
        if (!info.isFile() || info.size > MAX_ASSET_BYTES) return undefined;
        const content = await readFile(absolute);
        return { content, contentType: contentTypeOf(absolute) };
      } catch {
        return undefined;
      }
    },

    routeVisibility({ pluginId, method, path: routePath }) {
      const normalized = routePath.replace(/^\/+/, "");
      const route = contributions.routes.find(
        (item) =>
          item.pluginId === pluginId &&
          item.method === method.toUpperCase() &&
          item.path === normalized,
      );
      if (!route) return undefined;
      return route.publicRoute ? "public" : "private";
    },

    async dispatchRoute({
      pluginId,
      method,
      path: routePath,
      query,
      body,
      headers,
      isAuthenticated,
      workspaceId,
    }) {
      const normalized = routePath.replace(/^\/+/, "");
      const route = contributions.routes.find(
        (item) =>
          item.pluginId === pluginId &&
          item.method === method.toUpperCase() &&
          item.path === normalized,
      );
      if (!route) return undefined;
      if (!route.publicRoute && !isAuthenticated) {
        return { status: 401, body: { error: "需要登录。" } };
      }
      try {
        const result = await route.handler({
          method: method.toUpperCase(),
          path: normalized,
          query,
          body,
          headers,
          ...(workspaceId ? { workspaceId } : {}),
        });
        if (
          result &&
          typeof result === "object" &&
          "status" in (result as Record<string, unknown>)
        ) {
          const shaped = result as {
            status?: number;
            body?: unknown;
            headers?: Record<string, string>;
          };
          return {
            status: shaped.status ?? 200,
            body: shaped.body ?? null,
            ...(shaped.headers ? { headers: shaped.headers } : {}),
          };
        }
        return { status: 200, body: result ?? null };
      } catch (error) {
        log.warn(
          `[plugins] ${pluginId} 路由 ${normalized} 处理失败：`,
          error instanceof Error ? error.message : String(error),
        );
        return {
          status: 500,
          body: {
            error:
              error instanceof Error ? error.message : "插件路由处理失败。",
          },
        };
      }
    },

    async uninstall(id) {
      if (SYSTEM_PLUGIN_NAMES.has(id)) {
        throw new PluginRegistryError("系统插件不可卸载。", "system_plugin");
      }
      const state = await readState();
      if (!state.installed.some((record) => record.id === id)) {
        throw new PluginRegistryError("插件未安装。", "not_installed");
      }
      unloadPlugin(id);
      await rm(bundleDirOf(id), { recursive: true, force: true });
      records.delete(id);
      await writeState({
        version: 1,
        installed: state.installed.filter((record) => record.id !== id),
      });
      // 卸载要卸干净：插件存过的键（含加密凭证）一并清掉。
      // 「停用」不走这里——停用只收贡献物，数据留着，重新启用即恢复。
      await deps.storage.purgePlugin(id);
    },

    async setEnabled(id, enabled) {
      const state = await readState();
      const record = state.installed.find((item) => item.id === id);
      if (!record) {
        throw new PluginRegistryError("插件未安装。", "not_installed");
      }
      if (enabled) {
        const handle = await loadInstalledPlugin(record);
        if (!handle) {
          throw new PluginRegistryError(
            "插件装载失败，无法启用。",
            "install_failed",
          );
        }
      } else {
        unloadPlugin(id);
      }
      const updated: InstalledPlugin = { ...record, enabled };
      records.set(id, updated);
      await writeState({
        version: 1,
        installed: state.installed.map((item) =>
          item.id === id ? updated : item,
        ),
      });
      return updated;
    },

    exportPlugin(name, format) {
      const builtin = deps.builtinCatalog.find((entry) => entry.name === name);
      // 已安装插件按「注册表 id」或「插件名」都解析得到（UI 传的是插件名）
      const record =
        records.get(name) ??
        [...records.values()].find((item) => item.name === name);
      const handle = record ? loaded.get(record.id) : undefined;

      if (builtin && !record) {
        const spec: PluginExportSpec = {
          name: builtin.title,
          version: "0.0.0-export",
          description: builtin.description,
          capabilities: builtin.capabilities ?? ["tools"],
          tools: [],
          note: "该插件是 KenFutWork 内置能力，实现留在内核；导出物是**能力声明骨架**，供其他宿主识别它需要什么。",
        };
        return exportPluginBundle(spec, format);
      }

      const spec: PluginExportSpec = {
        name: record?.name ?? name,
        version: record?.version ?? "0.0.0-export",
        description: record?.manifest.description ?? "",
        license: record?.manifest.license ?? null,
        repositoryUrl: record?.repositoryUrl ?? null,
        capabilities: [
          "tools",
          ...(record?.manifest.requiredCapabilities ?? []),
        ],
        tools: handle
          ? handle.toolNames.flatMap((toolName) => {
              const definition = deps.tools.get(toolName);
              return definition
                ? [
                    {
                      name: definition.name,
                      description: definition.description,
                      parameters: definition.parameters,
                    },
                  ]
                : [];
            })
          : [],
        note: "导出物为骨架，工具 execute 需插件作者补全。",
      };
      return exportPluginBundle(spec, format);
    },
    async restore() {
      if (deps.allowThirdParty === false) {
        log.info("[plugins] 当前部署形态禁止第三方插件：跳过重启恢复。");
        return;
      }
      const state = await readState();
      for (const record of state.installed) {
        records.set(record.id, record);
        if (!record.enabled) continue;
        const handle = await loadInstalledPlugin(record);
        if (!handle) {
          log.warn(
            `[plugins] ${record.id} 启动装载失败，已跳过（不阻断启动）。`,
          );
        }
      }
    },

    async shutdown() {
      for (const id of [...loaded.keys()]) {
        unloadPlugin(id);
      }
    },
  };
}
