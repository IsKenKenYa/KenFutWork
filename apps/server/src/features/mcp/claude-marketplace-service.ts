import type { ClaudeMcpMarketplaceSnapshot } from "@kenfutwork/shared";
import {
  CLAUDE_OFFICIAL_MARKETPLACE,
  ClaudeMarketplaceError,
  type CompiledMarketplaceServer,
  compileMarketplaceServer,
  type MarketplaceFile,
  type MarketplacePlugin,
  parseMarketplaceFile,
  pluginFileUrl,
  readPluginDefinitions,
  resolvePluginLocation,
} from "./claude-marketplace.js";

/**
 * Claude Code 官方市场的 MCP 服务读取。
 *
 * 官方市场的 MCP 服务随插件分发：读完市场清单后，逐个插件读 `.mcp.json` 与
 * `plugin.json`（实测 317 个插件、约 500~650 次请求、十几秒），所以放后台读：
 * 请求立即返回当前快照，界面按进度轮询。读完的结果整体替换并缓存；缓存过期后
 * 先给旧结果、同时后台重读，不让列表闪空。
 *
 * 文件经 raw.githubusercontent.com 按插件固定提交号取，只读公开文件。
 */

const RAW_BASE = "https://raw.githubusercontent.com";
const MARKETPLACE_URL = pluginFileUrl(
  RAW_BASE,
  { ...CLAUDE_OFFICIAL_MARKETPLACE.repository, subdir: "" },
  ".claude-plugin/marketplace.json",
);

/** 读取失败后再次自动重试的最短间隔：避免界面轮询把上游打崩。 */
const FAILED_RETRY_INTERVAL_MS = 30_000;

export interface ClaudeMarketplaceReadLimits {
  timeoutMs: number;
  maxBytes: number;
  concurrency: number;
}

export interface ClaudeMarketplaceSnapshot
  extends ClaudeMcpMarketplaceSnapshot {
  /** 读取失败的插件（最多留前 20 条），供日志与诊断。 */
  unreadablePlugins: Array<{ plugin: string; reason: string }>;
}

export interface ClaudeMarketplaceService {
  /** 当前快照；首次调用或缓存过期时在后台开始读。 */
  read(): ClaudeMarketplaceSnapshot;
  /** 按 id 取回一条定义（含模板）；不在当前结果里时抛可读原因。 */
  find(id: string): CompiledMarketplaceServer;
  /** 强制重读（市场页的刷新按钮）；旧结果保留到新结果读完。 */
  refresh(): ClaudeMarketplaceSnapshot;
  shutdown(): void;
}

export interface ClaudeMarketplaceOptions {
  /** 每次现读治理值：改设置后下一次读取立刻生效。 */
  readLimits: () => Promise<ClaudeMarketplaceReadLimits>;
  /** 读取结果视为新鲜的时长（毫秒）。 */
  readCacheTtlMs: () => Promise<number>;
  /** 文件来源（生产是 raw.githubusercontent.com；测试注入本地夹具）。 */
  fetchFile?: (
    url: string,
    limits: { timeoutMs: number; maxBytes: number },
  ) => Promise<string | null>;
  now?: () => number;
  logger?: {
    info(message: string, ...rest: unknown[]): void;
    warn(message: string, ...rest: unknown[]): void;
  };
}

/** `null` = 文件不存在（404）；其它失败抛错，由调用方记为插件不可读。 */
async function fetchRawFile(
  url: string,
  limits: { timeoutMs: number; maxBytes: number },
): Promise<string | null> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(limits.timeoutMs),
    headers: {
      accept: "text/plain",
      "user-agent": "KenFutWork-McpMarketplace/1",
    },
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    throw new ClaudeMarketplaceError(`读取失败（HTTP ${response.status}）`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limits.maxBytes) {
    await response.body?.cancel();
    throw new ClaudeMarketplaceError("文件超过大小上限");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > limits.maxBytes) {
    throw new ClaudeMarketplaceError("文件超过大小上限");
  }
  return new TextDecoder().decode(buffer);
}

/** 一次读取的可见进度（首次读取时界面看它增长）。 */
interface ReadProgress {
  marketplace: ClaudeMcpMarketplaceSnapshot["marketplace"];
  compiled: Map<string, CompiledMarketplaceServer>;
  checked: number;
  total: number;
  unreadable: number;
  unreadablePlugins: Array<{ plugin: string; reason: string }>;
}

/** 上一次读完的结果（缓存；刷新期间继续展示它）。 */
interface ReadResult extends ReadProgress {
  completedAt: number;
}

function sortServers(compiled: Map<string, CompiledMarketplaceServer>) {
  return [...compiled.values()]
    .map((entry) => entry.view)
    .sort((left, right) => {
      // 同一插件的服务排在一起
      const byPlugin = left.plugin.localeCompare(right.plugin);
      return byPlugin !== 0
        ? byPlugin
        : left.serverName.localeCompare(right.serverName);
    });
}

export function createClaudeMarketplaceService(
  options: ClaudeMarketplaceOptions,
): ClaudeMarketplaceService {
  const fetchFile = options.fetchFile ?? fetchRawFile;
  const now = options.now ?? (() => Date.now());

  let result: ReadResult | null = null;
  let progress: ReadProgress | null = null;
  /** 进行中的读取；null = 空闲。 */
  let running: Promise<void> | null = null;
  /** 最近一次读取的失败原因（有旧结果时只作为提示）。 */
  let failure: string | null = null;
  let lastAttemptAt: number | null = null;
  let cacheTtlMs = 0;
  let disposed = false;

  const snapshot = (): ClaudeMarketplaceSnapshot => {
    const picked = result ?? progress;
    // 首次读取没读完：state=loading 并带上已读到的部分；读完是 ready；一直没结果才是 failed
    const state: ClaudeMcpMarketplaceSnapshot["state"] =
      result !== null
        ? "ready"
        : progress !== null
          ? "loading"
          : failure !== null
            ? "failed"
            : "loading";
    return {
      marketplace: picked?.marketplace ?? null,
      state,
      refreshing: running !== null && result !== null,
      checked: progress?.checked ?? result?.checked ?? 0,
      total: progress?.total ?? result?.total ?? 0,
      unreadable: progress?.unreadable ?? result?.unreadable ?? 0,
      completedAt: result?.completedAt ?? null,
      servers: sortServers(picked?.compiled ?? new Map()),
      // 有旧结果时把失败原因当提示透出；没有结果时它就是失败原因
      message: failure,
      unreadablePlugins: (progress ?? result)?.unreadablePlugins ?? [],
    };
  };

  const readPlugin = async (
    plugin: MarketplacePlugin,
    limits: ClaudeMarketplaceReadLimits,
  ): Promise<CompiledMarketplaceServer[]> => {
    const resolved = resolvePluginLocation(plugin);
    if (resolved.kind === "noFiles") return [];
    if (resolved.kind === "failed") {
      throw new ClaudeMarketplaceError(resolved.reason);
    }
    const definitions = await readPluginDefinitions({
      readFile: (relativePath) =>
        fetchFile(
          pluginFileUrl(RAW_BASE, resolved.location, relativePath),
          limits,
        ),
    });
    const compiled: CompiledMarketplaceServer[] = [];
    for (const definition of definitions.servers) {
      const entry = compileMarketplaceServer({
        definition,
        plugin,
        userConfig: definitions.userConfig,
      });
      if (entry) compiled.push(entry);
    }
    return compiled;
  };

  const run = async (): Promise<void> => {
    failure = null;
    lastAttemptAt = now();
    try {
      const limits = await options.readLimits();
      cacheTtlMs = await options.readCacheTtlMs();
      const text = await fetchFile(MARKETPLACE_URL, limits);
      if (text === null) {
        throw new ClaudeMarketplaceError("读不到 Claude 官方市场清单。");
      }
      const marketplace: MarketplaceFile = parseMarketplaceFile(text);
      if (disposed) return;
      const live: ReadProgress = {
        marketplace: { name: marketplace.name, owner: marketplace.owner },
        compiled: new Map(),
        checked: 0,
        total: marketplace.plugins.length,
        unreadable: 0,
        unreadablePlugins: [],
      };
      progress = live;
      let cursor = 0;
      const worker = async () => {
        while (cursor < marketplace.plugins.length && !disposed) {
          const plugin = marketplace.plugins[cursor];
          cursor += 1;
          if (!plugin) continue;
          try {
            const entries = await readPlugin(plugin, limits);
            if (disposed) return;
            for (const entry of entries) {
              live.compiled.set(entry.view.id, entry);
            }
          } catch (error) {
            if (disposed) return;
            live.unreadable += 1;
            if (live.unreadablePlugins.length < 20) {
              live.unreadablePlugins.push({
                plugin: plugin.name,
                reason: error instanceof Error ? error.message : String(error),
              });
            }
            options.logger?.warn(
              `[mcp] 读取市场插件 ${plugin.name} 失败：`,
              error instanceof Error ? error.message : String(error),
            );
          }
          live.checked += 1;
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.max(1, Math.min(limits.concurrency, 32)) },
          worker,
        ),
      );
      if (disposed) return;
      // 读完才整体替换：刷新期间界面继续看旧结果
      result = { ...live, completedAt: now() };
      options.logger?.info(
        `[mcp] Claude 市场读取完成：${live.total} 个插件、${live.compiled.size} 个 MCP 服务、${live.unreadable} 个插件读取失败`,
      );
    } catch (error) {
      if (disposed) return;
      failure = error instanceof Error ? error.message : String(error);
      options.logger?.warn("[mcp] Claude 市场读取失败：", failure);
    } finally {
      if (!disposed) progress = null;
    }
  };

  const startRead = (force: boolean) => {
    if (disposed || running) return;
    if (!force) {
      if (result !== null && now() - result.completedAt <= cacheTtlMs) return;
      if (
        result === null &&
        failure !== null &&
        lastAttemptAt !== null &&
        now() - lastAttemptAt < FAILED_RETRY_INTERVAL_MS
      ) {
        return;
      }
    }
    const task = run().finally(() => {
      if (running === task) running = null;
    });
    running = task;
  };

  return {
    read() {
      startRead(false);
      return snapshot();
    },
    find(id) {
      const found = result?.compiled.get(id) ?? progress?.compiled.get(id);
      if (!found) {
        throw new ClaudeMarketplaceError(
          "这个服务不在当前市场结果里，请刷新市场后再试。",
        );
      }
      return found;
    },
    refresh() {
      startRead(true);
      return snapshot();
    },
    shutdown() {
      disposed = true;
    },
  };
}
