import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  Agent,
  type Dispatcher,
  EnvHttpProxyAgent,
  setGlobalDispatcher,
} from "undici";

export type NetworkProxyConfig = {
  httpProxy?: string;
  noProxy?: string;
  caCertPath?: string;
};

export type NetworkProxySummary = {
  proxy: string;
  hasNoProxy: boolean;
  usesCaCertificate: boolean;
};

/**
 * 从实例偏好解析出网络出口配置：空串视为未配置（界面清空时要真的删除旧值）。
 * 只认绝对路径的 CA：相对路径在桌面形态下会随工作目录漂移，宁可启动期报错。
 */
export function resolveNetworkProxyConfig(
  preferences: Record<string, unknown>,
): NetworkProxyConfig {
  const pick = (key: string): string | undefined => {
    const value = preferences[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const httpProxy = pick("httpProxy");
  const noProxy = pick("httpProxyNoProxy");
  const caCertPath = pick("httpProxyCaCertPath");
  if (caCertPath && !isAbsolute(caCertPath))
    throw new Error("自定义 CA 证书路径必须是绝对路径。");
  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(noProxy ? { noProxy } : {}),
    ...(caCertPath ? { caCertPath } : {}),
  };
}

export function hasNetworkProxyConfig(config: NetworkProxyConfig): boolean {
  return Boolean(config.httpProxy || config.caCertPath);
}

/**
 * 构建全局出口 dispatcher：HTTP(S) 代理 + No Proxy 列表 + 自定义 CA。
 *
 * 设置页明确提示这三项需要重启生效，故只在进程启动时装配一次；运行期改动
 * 落到偏好后，下次启动由同一函数读取，不保留第二份内存状态。
 */
export async function buildNetworkProxyDispatcher(
  config: NetworkProxyConfig,
  readCa?: (path: string) => Promise<Buffer>,
): Promise<{ dispatcher: Dispatcher; summary: NetworkProxySummary }> {
  const ca = config.caCertPath
    ? await (readCa ?? readFile)(config.caCertPath)
    : undefined;
  // 只有 CA 没有代理时用普通 Agent：EnvHttpProxyAgent 会顺带认进程环境里的
  // HTTP(S)_PROXY，那不是用户在设置页表达的意图。
  const dispatcher: Dispatcher = config.httpProxy
    ? new EnvHttpProxyAgent({
        httpProxy: config.httpProxy,
        httpsProxy: config.httpProxy,
        ...(config.noProxy ? { noProxy: config.noProxy } : {}),
        ...(ca
          ? {
              requestTls: { ca },
              proxyTls: { ca },
              connect: { ca },
            }
          : {}),
      })
    : ca
      ? new Agent({ connect: { ca } })
      : new Agent();
  return {
    dispatcher,
    summary: {
      proxy: config.httpProxy ?? "",
      hasNoProxy: Boolean(config.noProxy),
      usesCaCertificate: Boolean(config.caCertPath),
    },
  };
}

/** 启动期满装配：没有配置时不动全局 dispatcher（避免凭空改变既有网络行为）。 */
export async function installNetworkProxy(options: {
  preferences: Record<string, unknown>;
  readCa?: (path: string) => Promise<Buffer>;
  install?: (dispatcher: Dispatcher) => void;
}): Promise<NetworkProxySummary | null> {
  const config = resolveNetworkProxyConfig(options.preferences);
  if (!hasNetworkProxyConfig(config)) return null;
  const { dispatcher, summary } = await buildNetworkProxyDispatcher(
    config,
    options.readCa,
  );
  (options.install ?? setGlobalDispatcher)(dispatcher);
  return summary;
}
