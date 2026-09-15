import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  CompatReport,
  InstalledPlugin,
  PluginBundleManifest,
  PluginExportArtifact,
  PluginMarketEntry,
} from "@loomic/shared";

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

export interface PluginCatalogEntry {
  name: string;
  title: string;
  description: string;
  /** 该内置插件需要的能力（导出为 bundle 时写入能力声明） */
  capabilities?: readonly string[];
}

export interface PluginRegistryDeps {
  pluginsDir: string;
  tools: ToolRegistry;
  subscribe: (
    event: string,
    listener: (payload: unknown, next?: unknown) => unknown,
  ) => () => void;
  hostNodeMajor: number;
  /** 内置插件目录（市场展示 + 导出用） */
  builtinCatalog: readonly PluginCatalogEntry[];
  /** GitHub token（可选，提升匿名速率上限） */
  githubToken?: string;
  logger?: {
    info(message: string, ...rest: unknown[]): void;
    warn(message: string, ...rest: unknown[]): void;
  };
}

export interface PluginRegistryService {
  list(): Promise<PluginMarketEntry[]>;
  inspect(input: { url: string; ref?: string | undefined }): Promise<{
    manifest: PluginBundleManifest;
    report: CompatReport;
  }>;
  install(input: {
    url: string;
    ref?: string | undefined;
    allowLifecycleScripts: boolean;
  }): Promise<{ installed: InstalledPlugin; report: CompatReport }>;
  uninstall(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<InstalledPlugin>;
  exportPlugin(name: string, format: "dsh" | "kenfutwork"): PluginExportArtifact;
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
      | "not_installed",
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
      description: "",
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
    const entryPath = path.join(bundleDirOf(record.id), entry);
    try {
      // 查询串绕过 ESM 模块缓存：重装同一路径必须拿到新代码
      const moduleUrl = `${pathToFileURL(entryPath).href}?v=${encodeURIComponent(record.installedAt)}`;
      const namespace: unknown = await import(/* @vite-ignore */ moduleUrl);
      const result = await loadCompatPlugin(namespace, {
        tools: deps.tools,
        subscribe: deps.subscribe,
        label: record.id,
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

  function unloadPlugin(id: string): void {
    const handle = loaded.get(id);
    if (!handle) return;
    try {
      handle.dispose();
    } catch (error) {
      log.warn(`[plugins] ${id} 卸载清理失败：`, error);
    }
    loaded.delete(id);
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
        category: null,
        system: SYSTEM_PLUGIN_NAMES.has(entry.name),
        installed: true,
      }));

      for (const record of state.installed) {
        entries.push({
          id: record.id,
          name: record.name,
          title: record.name,
          description: record.manifest.description,
          source: record.source,
          repositoryUrl: record.repositoryUrl,
          headSha: record.headSha,
          installability: record.report.compatible ? "verified" : "failed",
          category: null,
          system: false,
          installed: record.enabled,
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
      const { files, origin } = await fetchBundleFiles(input.url, {
        ...(input.ref ? { ref: input.ref } : {}),
        ...(deps.githubToken ? { token: deps.githubToken } : {}),
      });

      const report = validateBundleFiles(files, {
        hostNodeMajor: deps.hostNodeMajor,
        allowLifecycleScripts: input.allowLifecycleScripts,
        fallbackName: origin.label,
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

      const id = sanitizeId(
        origin.kind === "github"
          ? origin.label.replace(/@.*$/, "").replace("/", "__")
          : `local__${manifest.name}`,
      );

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
        source: origin.kind === "github" ? "url" : "url",
        repositoryUrl: origin.repositoryUrl,
        headSha: origin.headSha,
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
        installed: [
          ...state.installed.filter((item) => item.id !== id),
          record,
        ],
      };
      await writeState(next);

      return { installed: record, report };
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
