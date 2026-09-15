import { readFileSync } from "node:fs";

export const DEFAULT_AGENT_BACKEND_MODE = "state";
export const DEFAULT_AGENT_MODEL = "gpt-4.1";
export const DEFAULT_GOOGLE_AGENT_MODEL = "gemini-2.5-flash";
export const DEFAULT_SERVER_PORT = 3001;
export const DEFAULT_WEB_ORIGIN = "http://localhost:3000";
/** 默认只监听回环：桌面/本地开发的安全默认（对外暴露需显式设 HOST）。 */
export const DEFAULT_SERVER_HOST = "127.0.0.1";

/**
 * Resolve the default agent model based on available provider configuration.
 * When Google/Vertex is configured but OpenAI is not, defaults to Gemini 2.5 Flash.
 */
export function resolveDefaultAgentModel(env: {
  googleApiKey?: string | undefined;
  googleVertexProject?: string | undefined;
  openAIApiKey?: string | undefined;
}): string {
  const hasOpenAI = !!env.openAIApiKey;
  const hasGoogle = !!(env.googleApiKey || env.googleVertexProject);

  if (!hasOpenAI && hasGoogle) return DEFAULT_GOOGLE_AGENT_MODEL;
  return DEFAULT_AGENT_MODEL;
}

export type AgentBackendMode = "filesystem" | "state";

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type ServerEnv = {
  agentBackendMode: AgentBackendMode;
  agentFilesRoot?: string;
  agentModel: string;
  /**
   * 画布 → 真实工作目录映射（`LOOMIC_CANVAS_WORK_DIRS`，JSON 对象）。
   * 本地/桌面形态把工作目录映射到真实电脑环境时用；映射存在时 agent 直接读写
   * 该目录而不落 `<sandboxRoot>/<canvasId>`（产品决策 2026-09-14）。
   */
  canvasWorkDirs?: Record<string, string>;
  /**
   * 沙箱根目录（`LOOMIC_SANDBOX_ROOT`，可相对）。缺省由入口解析为
   * `<项目根（dev）/ exe 安装目录（打包）>/tmp/sandbox`，画布目录为其下画布 UUID；
   * 显式配置时相对路径按入口目录解析。
   */
  sandboxRoot?: string;
  /**
   * 模型流空闲看门狗阈值（毫秒，`LOOMIC_AGENT_STREAM_IDLE_TIMEOUT_MS`）。
   * 上游停滞超过该时长即按有界失败终止本轮（缺省 180s，见 stream-idle-guard）。
   */
  agentStreamIdleTimeoutMs?: number;
  /** SecretStore 主密钥（DEC-7 凭证加密落库）；启用 BYOK 凭证写入时必须配置。 */
  credentialSecret?: string;
  /**
   * 自管 Postgres 连接串（`persistence` 缝）。
   * 去 Supabase 收口后只认 `DATABASE_URL`。
   */
  databaseUrl?: string;
  /** MCP server 配置（P4d）：JSON 数组，v1 支持 stdio 命令型。 */
  mcpServers?: McpServerConfig[];
  /** 联网搜索（§4.5，BYOK 搜索供应商）：配置 Key 即启用 web_search 工具。 */
  searchApiKey?: string;
  searchProvider?: "metaso";
  /** 覆盖搜索端点（镜像/代理/联调）；默认走供应商官方端点。 */
  searchEndpoint?: string;
  googleApiKey?: string;
  googleApplicationCredentials?: string;
  googleFontsApiKey?: string;
  googleVertexLocation?: string;
  googleVertexProject?: string;
  googleVertexVideoLocation?: string;
  metasoApiBase?: string;
  /** 认证形态：`managed`（服务端/自托管，默认，自管令牌）/ `local-trust`（桌面免登录）。 */
  authDriver?: string;
  /** HTTP 监听地址（`HOST`）；local-trust 形态必须是回环地址。缺省回环。 */
  serverHost?: string;
  /** 队列形态：`pgmq`（服务端/自托管，默认）/ `in-process`（桌面，FORM-2）。 */
  queueDriver?: string;
  /** 桌面应用数据目录（`LOOMIC_DATA_DIR`）；缺省按平台惯例解析（FORM-2）。 */
  desktopDataDir?: string;
  /** 内嵌 Postgres 二进制目录（`LOOMIC_PG_BIN_DIR`）；缺省按发布包/依赖包解析。 */
  pgBinDir?: string;
  /**
   * 随包分发的语言运行时 bin 目录（Node/Python/uv/JDK，desktop/runtimes.ts 解析）。
   * 注入 sandbox 的 PATH，使宿主机没装这些运行时也能执行对应任务。
   */
  runtimePathAdditions?: string[];
  /** 随包 JDK 的根目录（JAVA_HOME）。 */
  javaHome?: string;
  /**
   * 随包 git 的 bin 目录（<exeDir>/runtime/git/cmd）。**仅在宿主没有 git 时才有值**——
   * 用户要求 git 优先用本地自带的，打包的只作兜底（见 desktop/runtimes.ts 的 hasSystemGit）。
   */
  gitBinDir?: string;
  /** git 来源：system=宿主自带 / bundled=随包 / unavailable=两者都没有。 */
  gitSource?: "system" | "bundled" | "unavailable";
  /** 桌面形态：由本进程拉起内嵌 Postgres 并跑迁移（FORM-2）。 */
  embeddedPostgres?: boolean;
  /** 内嵌 Postgres 端口；缺省自动挑空闲端口（避免与用户自装 Postgres 冲突）。 */
  embeddedPostgresPort?: number;
  /** `local` 形态的对象根目录。 */
  blobDir?: string;
  /** `local` 形态对外可读的基址（server 自己的 blob 读取路由）。 */
  blobPublicBaseUrl?: string;
  metasoApiKey?: string;
  openAIApiBase?: string;
  openAIApiKey?: string;
  port: number;
  replicateApiToken?: string;
  /** 静态 UI 目录（LOOMIC_WEB_DIST）：配置后 server 直接托管前端。 */
  webDist?: string;
  version: string;
  volcesApiKey?: string;
  volcesBaseUrl?: string;
  lemonSqueezyApiKey?: string;
  lemonSqueezyStoreId?: string;
  lemonSqueezyWebhookSecret?: string;
  lemonSqueezyVariantStarterMonthly?: string;
  lemonSqueezyVariantStarterYearly?: string;
  lemonSqueezyVariantProMonthly?: string;
  lemonSqueezyVariantProYearly?: string;
  lemonSqueezyVariantUltraMonthly?: string;
  lemonSqueezyVariantUltraYearly?: string;
  lemonSqueezyVariantBusinessMonthly?: string;
  lemonSqueezyVariantBusinessYearly?: string;
  skillsRoot?: string;
  webOrigin: string;
  workerConcurrency?: number;
  workerImageConcurrency?: number;
  workerVideoConcurrency?: number;
  workerId?: string;
  workerPollIntervalMs?: number;
  workerMaxBatchSize?: number;
};

export function loadServerEnv(
  overrides: Partial<ServerEnv> = {},
  source: NodeJS.ProcessEnv = process.env,
): ServerEnv {
  const agentFilesRoot =
    overrides.agentFilesRoot ??
    parseAgentFilesRoot(source.LOOMIC_AGENT_FILES_ROOT);
  const credentialSecret =
    overrides.credentialSecret ??
    normalizeOptionalString(source.LOOMIC_CREDENTIAL_SECRET);
  const mcpServers =
    overrides.mcpServers ?? parseMcpServers(source.LOOMIC_MCP_SERVERS);
  const canvasWorkDirs =
    overrides.canvasWorkDirs ??
    parseCanvasWorkDirs(source.LOOMIC_CANVAS_WORK_DIRS);
  const sandboxRoot =
    overrides.sandboxRoot ??
    normalizeOptionalString(source.LOOMIC_SANDBOX_ROOT);
  const searchApiKey =
    overrides.searchApiKey ??
    normalizeOptionalString(source.LOOMIC_SEARCH_API_KEY);
  const searchProvider =
    overrides.searchProvider ??
    parseSearchProvider(source.LOOMIC_SEARCH_PROVIDER);
  const searchEndpoint =
    overrides.searchEndpoint ??
    normalizeOptionalString(source.LOOMIC_SEARCH_ENDPOINT);
  const openAIApiBase =
    overrides.openAIApiBase ?? normalizeOptionalString(source.OPENAI_API_BASE);
  const openAIApiKey =
    overrides.openAIApiKey ?? normalizeOptionalString(source.OPENAI_API_KEY);
  const webDist =
    overrides.webDist ?? normalizeOptionalString(source.LOOMIC_WEB_DIST);
  const authDriver =
    overrides.authDriver ?? normalizeOptionalString(source.LOOMIC_AUTH_DRIVER);
  const queueDriver =
    overrides.queueDriver ??
    normalizeOptionalString(source.LOOMIC_QUEUE_DRIVER);
  const blobDir =
    overrides.blobDir ?? normalizeOptionalString(source.LOOMIC_BLOB_DIR);
  const desktopDataDir =
    overrides.desktopDataDir ?? normalizeOptionalString(source.LOOMIC_DATA_DIR);
  const pgBinDir =
    overrides.pgBinDir ?? normalizeOptionalString(source.LOOMIC_PG_BIN_DIR);
  const embeddedPostgres =
    overrides.embeddedPostgres ?? parseBooleanFlag(source.LOOMIC_EMBEDDED_PG);
  const embeddedPostgresPort =
    overrides.embeddedPostgresPort ??
    parseOptionalPort(
      source.LOOMIC_EMBEDDED_PG_PORT,
      "LOOMIC_EMBEDDED_PG_PORT",
    );
  const blobPublicBaseUrl =
    overrides.blobPublicBaseUrl ??
    normalizeOptionalString(source.LOOMIC_BLOB_PUBLIC_BASE_URL);
  // 连接串取名优先级：`LOOMIC_DATABASE_URL`（首选）→ 通用 `DATABASE_URL`。
  // 云托管时期的连接串回退（`SUPABASE_DB_URL`）已随 M1.5 删除。
  const databaseUrl =
    overrides.databaseUrl ??
    normalizeOptionalString(source.LOOMIC_DATABASE_URL) ??
    normalizeOptionalString(source.DATABASE_URL);
  const googleApiKey =
    overrides.googleApiKey ?? normalizeOptionalString(source.GOOGLE_API_KEY);
  const googleApplicationCredentials =
    overrides.googleApplicationCredentials ??
    normalizeOptionalString(source.GOOGLE_APPLICATION_CREDENTIALS);
  const googleFontsApiKey =
    overrides.googleFontsApiKey ??
    normalizeOptionalString(source.GOOGLE_FONTS_API_KEY);
  const googleVertexProject =
    overrides.googleVertexProject ??
    normalizeOptionalString(source.GOOGLE_VERTEX_PROJECT);
  const googleVertexLocation =
    overrides.googleVertexLocation ??
    normalizeOptionalString(source.GOOGLE_VERTEX_LOCATION);
  const googleVertexVideoLocation =
    overrides.googleVertexVideoLocation ??
    normalizeOptionalString(source.GOOGLE_VERTEX_VIDEO_LOCATION);
  const replicateApiToken =
    overrides.replicateApiToken ??
    normalizeOptionalString(source.REPLICATE_API_TOKEN);
  const metasoApiKey =
    overrides.metasoApiKey ?? normalizeOptionalString(source.METASO_API_KEY);
  const metasoApiBase =
    overrides.metasoApiBase ?? normalizeOptionalString(source.METASO_API_BASE);
  const volcesApiKey =
    overrides.volcesApiKey ?? normalizeOptionalString(source.VOLCES_API_KEY);
  const volcesBaseUrl =
    overrides.volcesBaseUrl ?? normalizeOptionalString(source.VOLCES_BASE_URL);
  const lemonSqueezyApiKey =
    overrides.lemonSqueezyApiKey ??
    normalizeOptionalString(source.LEMONSQUEEZY_API_KEY);
  const lemonSqueezyStoreId =
    overrides.lemonSqueezyStoreId ??
    normalizeOptionalString(source.LEMONSQUEEZY_STORE_ID);
  const lemonSqueezyWebhookSecret =
    overrides.lemonSqueezyWebhookSecret ??
    normalizeOptionalString(source.LEMONSQUEEZY_WEBHOOK_SECRET);
  const lemonSqueezyVariantStarterMonthly =
    overrides.lemonSqueezyVariantStarterMonthly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_STARTER_MONTHLY);
  const lemonSqueezyVariantStarterYearly =
    overrides.lemonSqueezyVariantStarterYearly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_STARTER_YEARLY);
  const lemonSqueezyVariantProMonthly =
    overrides.lemonSqueezyVariantProMonthly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_PRO_MONTHLY);
  const lemonSqueezyVariantProYearly =
    overrides.lemonSqueezyVariantProYearly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_PRO_YEARLY);
  const lemonSqueezyVariantUltraMonthly =
    overrides.lemonSqueezyVariantUltraMonthly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_ULTRA_MONTHLY);
  const lemonSqueezyVariantUltraYearly =
    overrides.lemonSqueezyVariantUltraYearly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_ULTRA_YEARLY);
  const lemonSqueezyVariantBusinessMonthly =
    overrides.lemonSqueezyVariantBusinessMonthly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_BUSINESS_MONTHLY);
  const lemonSqueezyVariantBusinessYearly =
    overrides.lemonSqueezyVariantBusinessYearly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_BUSINESS_YEARLY);
  const skillsRoot =
    overrides.skillsRoot ?? normalizeOptionalString(source.LOOMIC_SKILLS_ROOT);
  const workerConcurrency =
    overrides.workerConcurrency ??
    (source.WORKER_CONCURRENCY
      ? Number.parseInt(source.WORKER_CONCURRENCY, 10)
      : undefined);
  const workerImageConcurrency =
    overrides.workerImageConcurrency ??
    (source.WORKER_IMAGE_CONCURRENCY
      ? Number.parseInt(source.WORKER_IMAGE_CONCURRENCY, 10)
      : undefined);
  const workerVideoConcurrency =
    overrides.workerVideoConcurrency ??
    (source.WORKER_VIDEO_CONCURRENCY
      ? Number.parseInt(source.WORKER_VIDEO_CONCURRENCY, 10)
      : undefined);
  const workerId =
    overrides.workerId ?? normalizeOptionalString(source.WORKER_ID);
  const workerPollIntervalMs =
    overrides.workerPollIntervalMs ??
    (source.WORKER_POLL_INTERVAL_MS
      ? Number.parseInt(source.WORKER_POLL_INTERVAL_MS, 10)
      : undefined);
  const workerMaxBatchSize =
    overrides.workerMaxBatchSize ??
    (source.WORKER_MAX_BATCH_SIZE
      ? Number.parseInt(source.WORKER_MAX_BATCH_SIZE, 10)
      : undefined);

  // Resolve default agent model based on available provider keys.
  // Explicit LOOMIC_AGENT_MODEL always takes precedence; otherwise fall back
  // to Gemini 2.5 Flash when only Google/Vertex is configured.
  const explicitModel =
    overrides.agentModel ?? parseAgentModel(source.LOOMIC_AGENT_MODEL);
  const resolvedAgentModel =
    explicitModel ??
    resolveDefaultAgentModel({
      googleApiKey,
      googleVertexProject,
      openAIApiKey,
    });

  const agentStreamIdleTimeoutMs = parsePositiveInt(
    overrides.agentStreamIdleTimeoutMs ??
      source.LOOMIC_AGENT_STREAM_IDLE_TIMEOUT_MS,
  );

  return {
    agentBackendMode:
      overrides.agentBackendMode ??
      parseAgentBackendMode(source.LOOMIC_AGENT_BACKEND_MODE),
    agentModel: resolvedAgentModel,
    ...(agentStreamIdleTimeoutMs ? { agentStreamIdleTimeoutMs } : {}),
    port: overrides.port ?? parsePort(source.LOOMIC_SERVER_PORT ?? source.PORT),
    serverHost: overrides.serverHost ?? source.HOST ?? DEFAULT_SERVER_HOST,
    version: overrides.version ?? readServerVersion(),
    webOrigin:
      overrides.webOrigin ?? source.LOOMIC_WEB_ORIGIN ?? DEFAULT_WEB_ORIGIN,
    ...(agentFilesRoot ? { agentFilesRoot } : {}),
    ...(canvasWorkDirs ? { canvasWorkDirs } : {}),
    ...(sandboxRoot ? { sandboxRoot } : {}),
    ...(credentialSecret ? { credentialSecret } : {}),
    ...(authDriver ? { authDriver } : {}),
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(queueDriver ? { queueDriver } : {}),
    ...(blobDir ? { blobDir } : {}),
    ...(desktopDataDir ? { desktopDataDir } : {}),
    ...(pgBinDir ? { pgBinDir } : {}),
    ...(overrides.runtimePathAdditions?.length
      ? { runtimePathAdditions: overrides.runtimePathAdditions }
      : {}),
    ...(overrides.javaHome ? { javaHome: overrides.javaHome } : {}),
    ...(overrides.gitBinDir ? { gitBinDir: overrides.gitBinDir } : {}),
    ...(overrides.gitSource ? { gitSource: overrides.gitSource } : {}),
    ...(embeddedPostgres ? { embeddedPostgres } : {}),
    ...(embeddedPostgresPort ? { embeddedPostgresPort } : {}),
    ...(blobPublicBaseUrl ? { blobPublicBaseUrl } : {}),
    ...(mcpServers?.length ? { mcpServers } : {}),
    ...(searchApiKey ? { searchApiKey } : {}),
    ...(searchProvider ? { searchProvider } : {}),
    ...(searchEndpoint ? { searchEndpoint } : {}),
    ...(googleApiKey ? { googleApiKey } : {}),
    ...(googleApplicationCredentials ? { googleApplicationCredentials } : {}),
    ...(openAIApiBase ? { openAIApiBase } : {}),
    ...(openAIApiKey ? { openAIApiKey } : {}),
    ...(webDist ? { webDist } : {}),
    ...(googleFontsApiKey ? { googleFontsApiKey } : {}),
    ...(googleVertexProject ? { googleVertexProject } : {}),
    ...(googleVertexLocation ? { googleVertexLocation } : {}),
    ...(googleVertexVideoLocation ? { googleVertexVideoLocation } : {}),
    ...(replicateApiToken ? { replicateApiToken } : {}),
    ...(metasoApiKey ? { metasoApiKey } : {}),
    ...(metasoApiBase ? { metasoApiBase } : {}),
    ...(volcesApiKey ? { volcesApiKey } : {}),
    ...(volcesBaseUrl ? { volcesBaseUrl } : {}),
    ...(lemonSqueezyApiKey ? { lemonSqueezyApiKey } : {}),
    ...(lemonSqueezyStoreId ? { lemonSqueezyStoreId } : {}),
    ...(lemonSqueezyWebhookSecret ? { lemonSqueezyWebhookSecret } : {}),
    ...(lemonSqueezyVariantStarterMonthly
      ? { lemonSqueezyVariantStarterMonthly }
      : {}),
    ...(lemonSqueezyVariantStarterYearly
      ? { lemonSqueezyVariantStarterYearly }
      : {}),
    ...(lemonSqueezyVariantProMonthly ? { lemonSqueezyVariantProMonthly } : {}),
    ...(lemonSqueezyVariantProYearly ? { lemonSqueezyVariantProYearly } : {}),
    ...(lemonSqueezyVariantUltraMonthly
      ? { lemonSqueezyVariantUltraMonthly }
      : {}),
    ...(lemonSqueezyVariantUltraYearly
      ? { lemonSqueezyVariantUltraYearly }
      : {}),
    ...(lemonSqueezyVariantBusinessMonthly
      ? { lemonSqueezyVariantBusinessMonthly }
      : {}),
    ...(lemonSqueezyVariantBusinessYearly
      ? { lemonSqueezyVariantBusinessYearly }
      : {}),
    ...(skillsRoot ? { skillsRoot } : {}),
    ...(workerConcurrency ? { workerConcurrency } : {}),
    ...(workerImageConcurrency ? { workerImageConcurrency } : {}),
    ...(workerVideoConcurrency ? { workerVideoConcurrency } : {}),
    ...(workerId ? { workerId } : {}),
    ...(workerPollIntervalMs ? { workerPollIntervalMs } : {}),
    ...(workerMaxBatchSize ? { workerMaxBatchSize } : {}),
  };
}

function parseAgentBackendMode(rawMode: string | undefined): AgentBackendMode {
  if (!rawMode) {
    return DEFAULT_AGENT_BACKEND_MODE;
  }

  if (rawMode === "state" || rawMode === "filesystem") {
    return rawMode;
  }

  throw new Error(`Invalid LOOMIC_AGENT_BACKEND_MODE value: ${rawMode}`);
}

function parseSearchProvider(raw: string | undefined): "metaso" | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  if (raw === "metaso") {
    return raw;
  }
  throw new Error(
    `Invalid LOOMIC_SEARCH_PROVIDER value: ${raw} (supported: metaso)`,
  );
}

/**
 * `LOOMIC_CANVAS_WORK_DIRS`：画布 → 真实目录映射，JSON 对象（如
 * `{"<canvasId>":"D:/Desktop/test"}`）。解析 fail loud：结构非法即启动期报错，
 * 不静默降级（否则「以为映射了、实际还在沙箱」这种静默漂移无法排查）。
 */
export function parseCanvasWorkDirs(
  raw: string | undefined,
): Record<string, string> | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "Invalid LOOMIC_CANVAS_WORK_DIRS value: must be a JSON object mapping canvasId to an absolute directory.",
    );
  }
  const result: Record<string, string> = {};
  for (const [canvasId, dir] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!canvasId.trim() || typeof dir !== "string" || !dir.trim()) {
      throw new Error(
        "Invalid LOOMIC_CANVAS_WORK_DIRS entry: canvasId keys and directory string values are required.",
      );
    }
    result[canvasId.trim()] = dir.trim();
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseMcpServers(
  raw: string | undefined,
): McpServerConfig[] | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid LOOMIC_MCP_SERVERS value: must be a JSON array.");
  }
  return parsed.map((entry) => {
    const config = entry as Partial<McpServerConfig>;
    if (!config.name || !config.command) {
      throw new Error(
        "Invalid LOOMIC_MCP_SERVERS entry: name and command are required.",
      );
    }
    return {
      name: config.name,
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      ...(config.env ? { env: config.env } : {}),
    };
  });
}

function parseAgentFilesRoot(rawRoot: string | undefined) {
  return normalizeOptionalString(rawRoot);
}

function parseAgentModel(rawModel: string | undefined) {
  return normalizeOptionalString(rawModel);
}

function normalizeOptionalString(value: string | undefined) {
  const normalizedValue = value?.trim();
  return normalizedValue || undefined;
}

/** 正整数（毫秒阈值一类）：未设置返回 undefined；设置了但非法则 fail loud。 */
function parsePositiveInt(
  raw: string | number | undefined,
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid positive integer value: ${String(raw)}`);
  }
  return value;
}

function parsePort(rawPort: string | undefined) {
  if (!rawPort) {
    return DEFAULT_SERVER_PORT;
  }

  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid LOOMIC_SERVER_PORT value: ${rawPort}`);
  }

  return port;
}

/** 布尔开关：`1`/`true`/`yes`/`on` 为真，其余视为未设置（fail loud 落在使用处）。 */
function parseBooleanFlag(rawValue: string | undefined) {
  const normalized = rawValue?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return ["1", "true", "yes", "on"].includes(normalized) ? true : undefined;
}

/** 可选端口：缺省 `undefined`（由内核自动挑空闲端口），非法值 fail loud。 */
function parseOptionalPort(rawValue: string | undefined, name: string) {
  const normalized = normalizeOptionalString(rawValue);
  if (!normalized) {
    return undefined;
  }

  const port = Number.parseInt(normalized, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid ${name} value: ${rawValue}`);
  }

  return port;
}

function readServerVersion() {
  try {
    // import.meta.url 在 SEA（CJS 打包）下为空，回退到 "0.0.0"
    const packageJson = readFileSync(
      new URL("../../package.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(packageJson) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
