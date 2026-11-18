/**
 * 官方 MCP Registry 客户端（registry.modelcontextprotocol.io）。
 *
 * 接口事实（2026-09 实测）：`GET /v0/servers?search=&limit=&cursor=`，**无需鉴权**；
 * 返回 `{ servers: [{ server: { name, description, version, repository,
 * packages: [{ registryType, identifier, version, transport: { type }, runtimeHint }],
 * remotes: [{ type, url }] }, _meta }], metadata: { nextCursor, count } }`。
 * `search` 只做服务器名的**子串匹配**（官方有意从简），故高级筛选得自己在客户端做。
 *
 * 本项目只支持 **stdio**（本地子进程）：于是只把「有 npm/pypi 包且传输为 stdio」的
 * 条目判为可安装，并给出建议命令（npx / uvx）；HTTP/SSE 远程条目与其它包生态
 * （oci/nuget 等）明确标注为暂不支持，而不是让用户点了才失败。
 */

export const MCP_REGISTRY_BASE = "https://registry.modelcontextprotocol.io";

export interface RegistryPackage {
  registryType: string;
  identifier: string;
  version?: string;
  transportType?: string;
  runtimeHint?: string;
}

export interface RegistryRemote {
  type: string;
  url?: string;
}

export interface RegistryServerView {
  /** 注册表里的规范名，如 io.github.user/filesystem。 */
  name: string;
  description: string;
  version: string;
  repositoryUrl: string | null;
  packages: RegistryPackage[];
  remotes: RegistryRemote[];
  /** 传输类型：stdio = 本地子进程；http = 远程 Streamable HTTP/SSE（两者都可安装）。 */
  kind: "stdio" | "http";
  /** 本客户端能否直接添加（stdio 有 npm/pypi 包，或 http 有远程端点）。 */
  installable: boolean;
  /** 不能添加的原因（用于界面说明，不静默）。 */
  unsupportedReason: string | null;
  /** 可直接填进「添加」表单的命令与参数（stdio）。 */
  suggestedCommand: string | null;
  suggestedArgs: string[];
  /** http 类型的远程端点 URL。 */
  suggestedUrl: string | null;
  /** 建议的 server 名（取注册表名的最后一段，合法化）。 */
  suggestedName: string;
  /** 注册表标记的「最新版本」（同一 server 会按版本各出一条，界面据此去重）。 */
  isLatest: boolean;
}

/** 注册表名 → 可用的 server 名（`io.github.user/filesystem` → `filesystem`）。 */
export function registryNameToServerName(registryName: string): string {
  const tail = registryName.split("/").pop() ?? registryName;
  const sanitized = tail
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "mcp-server";
}

/** 由包信息推导可执行命令（npx / uvx）。 */
export function packageToCommand(
  pkg: RegistryPackage,
): { command: string; args: string[] } | null {
  const identifier = pkg.identifier?.trim();
  if (!identifier) {
    return null;
  }
  const versionSuffix = pkg.version?.trim() ? `@${pkg.version.trim()}` : "";
  switch (pkg.registryType) {
    case "npm":
      return { command: "npx", args: ["-y", `${identifier}${versionSuffix}`] };
    case "pypi":
      return {
        command: "uvx",
        args: [
          pkg.version?.trim()
            ? `${identifier}==${pkg.version.trim()}`
            : identifier,
        ],
      };
    default:
      return null;
  }
}

interface RegistryEntryInput {
  _meta?: Record<string, { isLatest?: boolean; status?: string } | undefined>;
  server: {
    name: string;
    description?: string;
    version?: string;
    repository?: { url?: string };
    packages?: RegistryPackage[];
    remotes?: RegistryRemote[];
  };
}

/** 把一条注册表条目映射为界面可直接使用的视图（纯函数，便于单测）。 */
export function toRegistryServerView(
  entry: RegistryEntryInput,
): RegistryServerView {
  const server = entry.server;
  const packages = server.packages ?? [];
  const remotes = server.remotes ?? [];

  const stdioPackage = packages.find(
    (pkg) => (pkg.transportType ?? "stdio") === "stdio",
  );
  const runnable = stdioPackage ? packageToCommand(stdioPackage) : null;

  // 远程优先：有 HTTP/SSE 端点的 server 走 http 类型（无需本地运行时），
  // 否则看 stdio 包。两者都缺才标记不可安装（原因只可能是「无包」或「生态不支持」）。
  let unsupportedReason: string | null = null;
  if (!stdioPackage) {
    unsupportedReason = "该 server 未声明可本地运行的包";
  } else if (!runnable) {
    unsupportedReason = `暂不支持该包生态（${stdioPackage.registryType}），仅支持 npm / pypi`;
  }
  const remote = remotes.find((item) => Boolean(item.url));
  if (remote?.url) {
    return {
      name: server.name,
      description: server.description ?? "",
      version: server.version ?? "",
      repositoryUrl: server.repository?.url ?? null,
      packages,
      remotes,
      kind: "http",
      installable: true,
      unsupportedReason: null,
      suggestedCommand: null,
      suggestedArgs: [],
      suggestedUrl: remote.url,
      suggestedName: registryNameToServerName(server.name),
      isLatest:
        entry._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest ===
        true,
    };
  }

  return {
    name: server.name,
    description: server.description ?? "",
    version: server.version ?? "",
    repositoryUrl: server.repository?.url ?? null,
    packages,
    remotes,
    kind: "stdio",
    installable: Boolean(runnable),
    suggestedUrl: null,
    unsupportedReason,
    suggestedCommand: runnable?.command ?? null,
    suggestedArgs: runnable?.args ?? [],
    suggestedName: registryNameToServerName(server.name),
    isLatest:
      entry._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest ===
      true,
  };
}

/**
 * 同一 server 会按版本各出一条（实测 `com.pulsemcp/remote-filesystem` 有 3 个版本），
 * 直接铺开会把列表刷满。这里按名称去重：优先保留 `isLatest`，其次保留首个出现的。
 */
export function dedupeRegistryServers(
  servers: RegistryServerView[],
): RegistryServerView[] {
  const byName = new Map<string, RegistryServerView>();
  for (const server of servers) {
    const existing = byName.get(server.name);
    if (!existing) {
      byName.set(server.name, server);
      continue;
    }
    if (server.isLatest && !existing.isLatest) {
      byName.set(server.name, server);
    }
  }
  return [...byName.values()];
}

const CACHE_TTL_MS = 5 * 60 * 1000;
/** 官方建议客户端缓存约 5 分钟（未公开限流）。 */
const cache = new Map<string, { at: number; servers: RegistryServerView[] }>();

export interface RegistrySearchResult {
  servers: RegistryServerView[];
  /** 官方返回的候选总数（当前页条数，含元数据 count）。 */
  count: number;
  nextCursor: string | null;
}

/**
 * 检索官方注册表。网络/解析失败一律抛错（由路由转成可读错误），
 * 不返回空列表假装「没有结果」。
 */
export async function searchOfficialRegistry(
  query: string,
  limit = 20,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<RegistrySearchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const key = `${query.trim().toLowerCase()}|${safeLimit}`;

  const cached = cache.get(key);
  if (cached && now() - cached.at < CACHE_TTL_MS) {
    return {
      servers: cached.servers,
      count: cached.servers.length,
      nextCursor: null,
    };
  }

  const params = new URLSearchParams({
    limit: String(safeLimit),
    ...(query.trim() ? { search: query.trim() } : {}),
  });
  const response = await fetchImpl(
    `${MCP_REGISTRY_BASE}/v0/servers?${params}`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`官方 MCP 注册表请求失败（HTTP ${response.status}）`);
  }
  const payload = (await response.json()) as {
    servers?: RegistryEntryInput[];
    metadata?: { nextCursor?: string | null; count?: number };
  };
  const servers = dedupeRegistryServers(
    (payload.servers ?? []).map(toRegistryServerView),
  );
  cache.set(key, { at: now(), servers });
  return {
    servers,
    count: payload.metadata?.count ?? servers.length,
    nextCursor: payload.metadata?.nextCursor ?? null,
  };
}

/** 测试/运维用：清空缓存。 */
export function clearRegistryCache(): void {
  cache.clear();
}
