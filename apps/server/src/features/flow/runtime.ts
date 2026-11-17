import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  type Dirent,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import { createServer as createTcpServer } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { Client } from "pg";

import { ensureStackEnvFile } from "./engine/install.js";

/**
 * flow 运行时托管（免手配）：插件安装后由宿主自动准备配置、数据库、网关与前端，
 * 应用重启或电脑重启后由同一条路径重新拉起。
 *
 * 边界：
 * - 只在本机实例（有 `databaseUrl`）且未显式配置外部 flow 地址时接管；
 * - 配置落在数据目录 `flow/flow-runtime.json`（0600），端口与密钥重启复用；
 * - 网关用 flow 自带构建产物 `dist/main.js`，前端用构建产物静态托管，
 *   不再依赖手工启动 `pnpm run start:dev` / `rsbuild dev`；
 * - 构建产物缺失时才构建；前端构建按网关地址校验，网关地址变化会重建。
 */

const CONFIG_FILE = "flow-runtime.json";
const ENV_FILE = "flow-runtime.env";
const FRONTEND_BUILD_MARKER = "frontend-build.json";
const GATEWAY_LOG = "gateway.log";
const GATEWAY_BUILD_LOG = "gateway-build.log";
const FRONTEND_BUILD_LOG = "frontend-build.log";

export const DEFAULT_FLOW_GATEWAY_PORT = 15010;
export const DEFAULT_FLOW_FRONTEND_PORT = 8190;

const DB_NAME = "futureflow";
/** 构建/启动的兜底等待：只在失败时生效，正常路径远小于它。 */
const BUILD_TIMEOUT_MS = 10 * 60_000;
const GATEWAY_READY_TIMEOUT_MS = 120_000;

export interface FlowManagedConfig {
  version: 1;
  sharedSecret: string;
  jwtSecret: string;
  encryptionSecret: string;
  /** 应用库没有口令时用于满足网关校验；本机 trust 形态下不参与认证。 */
  dbPassword: string;
  gatewayPort: number;
  frontendPort: number;
  createdAt: string;
}

export type FlowRuntimeState = "starting" | "ready" | "error" | "stopped";

export interface FlowRuntimeSnapshot {
  state: FlowRuntimeState;
  detail?: string;
  gatewayUrl: string;
  frontendUrl: string;
}

export function flowRuntimeDir(dataDir: string): string {
  return join(dataDir, "flow");
}

export function flowGatewayUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function flowFrontendUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function randomSecret(): string {
  return randomBytes(32).toString("hex");
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createTcpServer();
    server.unref();
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolvePort(true));
    });
  });
}

async function pickFreePort(
  preferred: number,
  isFree: (port: number) => Promise<boolean>,
): Promise<number> {
  for (let offset = 0; offset < 50; offset += 1) {
    const candidate = preferred + offset;
    if (candidate > 65_535) break;
    if (await isFree(candidate)) return candidate;
  }
  throw new Error(`找不到空闲端口（从 ${preferred} 起试了 50 个）。`);
}

function parseConfig(file: string): FlowManagedConfig | null {
  if (!existsSync(file)) return null;
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object") return null;
  const config = parsed as Partial<FlowManagedConfig>;
  if (
    config.version !== 1 ||
    typeof config.sharedSecret !== "string" ||
    typeof config.jwtSecret !== "string" ||
    typeof config.encryptionSecret !== "string" ||
    typeof config.dbPassword !== "string" ||
    !Number.isInteger(config.gatewayPort) ||
    !Number.isInteger(config.frontendPort)
  )
    return null;
  return config as FlowManagedConfig;
}

/**
 * 读取本机 flow 运行配置；没有就按默认端口生成一份。坏文件只改名保留，不覆盖
 * （便于排查），随后重新生成。同步实现：插件装配期就要拿到端口与密钥去注册路由。
 */
export function loadOrCreateFlowManagedConfig(input: {
  dataDir: string;
  preferredGatewayPort?: number | undefined;
  preferredFrontendPort?: number | undefined;
}): FlowManagedConfig {
  const dir = flowRuntimeDir(input.dataDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, CONFIG_FILE);
  let existing: FlowManagedConfig | null = null;
  try {
    existing = parseConfig(file);
  } catch {
    const moved = `${file}.corrupt-${Date.now()}`;
    renameSync(file, moved);
    console.warn(`[flow] 运行配置损坏，已保留为 ${moved} 并重新生成。`);
  }
  if (existing) return existing;
  const config: FlowManagedConfig = {
    version: 1,
    sharedSecret: randomSecret(),
    jwtSecret: randomSecret(),
    encryptionSecret: randomSecret(),
    dbPassword: randomSecret(),
    gatewayPort: input.preferredGatewayPort ?? DEFAULT_FLOW_GATEWAY_PORT,
    frontendPort: input.preferredFrontendPort ?? DEFAULT_FLOW_FRONTEND_PORT,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return config;
}

/** 配置被端口冲突改写后落盘（前端端口变化不影响构建产物）。 */
export function writeFlowManagedConfig(
  dataDir: string,
  config: FlowManagedConfig,
): void {
  mkdirSync(flowRuntimeDir(dataDir), { recursive: true });
  writeFileSync(
    join(flowRuntimeDir(dataDir), CONFIG_FILE),
    `${JSON.stringify(config, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

/** 应用库连接串 → flow 独立库连接参数（同实例、独立 database）。 */
export function resolveFlowDatabase(databaseUrl: string): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
} {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 5432,
    user: decodeURIComponent(url.username) || "postgres",
    password: decodeURIComponent(url.password),
    database: DB_NAME,
  };
}

/** 在应用库里准备 flow 独立数据库（幂等）。 */
export async function ensureFlowDatabase(
  databaseUrl: string,
  deps: { connect?: (url: string) => Client } = {},
): Promise<void> {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  const client =
    deps.connect?.(url.toString()) ??
    new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const existing = await client.query(
      "select 1 from pg_database where datname = $1",
      [DB_NAME],
    );
    if (existing.rowCount === 0) {
      await client.query(`create database "${DB_NAME.replaceAll('"', '""')}"`);
    }
  } catch (error) {
    throw new Error(
      `创建 flow 数据库失败：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await client.end();
  }
}

function readEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/u)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (match?.[1] !== undefined) values[match[1]] = match[2] ?? "";
  }
  return values;
}

/** 老的本机 flow 安装（flow/.env）里已有的 Dify 加密密钥；没有则 undefined。 */
function legacyEncryptionSecret(flowDir: string): string | undefined {
  for (const file of [
    join(flowDir, ".futureflow.runtime.env"),
    join(flowDir, ".env"),
  ]) {
    const value = readEnvFile(file).DIFY_KEY_ENCRYPTION_SECRET?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * 网关注入环境：端口/密钥/数据库/宿主回调地址全部由宿主生成，
 * Dify 管理员凭据与应用库连通性来自数据目录里的同一份安装状态。
 */
export function buildFlowGatewayEnv(input: {
  config: FlowManagedConfig;
  dataDir: string;
  database: Parameters<typeof resolveFlowDatabase>[0];
  serverPort: number;
  webOrigin: string;
}): Record<string, string> {
  const database = resolveFlowDatabase(input.database);
  const stackEnvFile = ensureStackEnvFile(input.dataDir);
  const stackEnv = readEnvFile(stackEnvFile);
  const frontendOrigin = flowFrontendUrl(input.config.frontendPort);
  const serverOrigin = `http://127.0.0.1:${input.serverPort}`;
  const hostOrigins = [
    input.webOrigin,
    frontendOrigin,
    frontendOrigin.replace("127.0.0.1", "localhost"),
    "http://tauri.localhost",
  ];
  const password = database.password || input.config.dbPassword;
  return {
    NODE_ENV: "development",
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_PORT: String(input.config.gatewayPort),
    GATEWAY_JWT_SECRET: input.config.jwtSecret,
    GATEWAY_BOOTSTRAP_ADMIN_ENABLED: "false",
    POSTGRES_HOST: database.host,
    POSTGRES_PORT: String(database.port),
    POSTGRES_DB: database.database,
    POSTGRES_USER: database.user,
    POSTGRES_PASSWORD: password,
    CORS_ORIGIN: [...new Set([input.webOrigin, frontendOrigin])].join(","),
    HOST_MODE: "embedded",
    HOST_SHARED_SECRET: input.config.sharedSecret,
    HOST_IDENTITY_VERIFY_URL: `${serverOrigin}/api/flow/host/identity`,
    HOST_CREDENTIALS_URL: `${serverOrigin}/api/flow/host/credentials`,
    HOST_PROJECT_FILES_URL: `${serverOrigin}/api/flow/host/project-files`,
    HOST_ALLOWED_ORIGINS: [...new Set(hostOrigins)].join(","),
    DIFY_API_BASE: stackEnv.DIFY_API_BASE ?? "http://127.0.0.1:15001/v1",
    DIFY_CONSOLE_BASE:
      stackEnv.DIFY_CONSOLE_BASE ?? "http://127.0.0.1:15001/console/api",
    DIFY_AUTO_BOOTSTRAP: "true",
    DIFY_SYNC_LLM_PROVIDER: "false",
    DIFY_KEY_ENCRYPTION_SECRET: input.config.encryptionSecret,
    MEDIA_CREDENTIAL_ENCRYPTION_SECRET: input.config.encryptionSecret,
    DIFY_MEDIA_GATEWAY_URL: `http://host.docker.internal:${input.serverPort}`,
    DIFY_MEDIA_GATEWAY_HOST: "host.docker.internal",
    DIFY_MEDIA_GATEWAY_PORT: String(input.serverPort),
    DIFY_ADMIN_EMAIL: stackEnv.DIFY_ADMIN_EMAIL ?? "admin@kenfutwork.local",
    DIFY_ADMIN_PASSWORD: stackEnv.DIFY_ADMIN_PASSWORD ?? "",
    DIFY_INIT_PASSWORD: stackEnv.DIFY_INIT_PASSWORD ?? "",
    DIFY_ADMIN_API_KEY: stackEnv.DIFY_ADMIN_API_KEY ?? "",
    DIFY_SECRET_KEY: stackEnv.DIFY_SECRET_KEY ?? "",
    DIFY_DB_PASSWORD: stackEnv.DIFY_DB_PASSWORD ?? "",
    DIFY_SANDBOX_API_KEY: stackEnv.DIFY_SANDBOX_API_KEY ?? "",
  };
}

function writeEnvFile(file: string, env: Record<string, string>): string {
  const lines = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);
  const content = `${lines.join("\n")}\n`;
  // 内容没变就不落盘：开发态 `node --watch` 对仓库内文件的写入很敏感，
  // 每次启动重写同一个文件会把服务端拖进「重启→重写→再重启」的循环。
  if (existsSync(file) && readFileSync(file, "utf8") === content) return file;
  writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  return file;
}

/** 写运行时 env 文件：管理员凭据同源的落点（引擎安装会补写这里）。 */
export function writeFlowRuntimeEnv(
  dataDir: string,
  env: Record<string, string>,
): string {
  const dir = flowRuntimeDir(dataDir);
  mkdirSync(dir, { recursive: true });
  return writeEnvFile(join(dir, ENV_FILE), env);
}

/**
 * 网关自己的最高优先级 env 文件。
 *
 * Nest 的 `ConfigModule` 会先读 env 文件、再读进程环境；只把值放进 spawn env
 * 会被 flow 开发目录里遗留的 `.env` 覆盖（实测连错数据库、拿旧密钥解密失败）。
 * 写到网关目录的 `.futureflow.runtime.env`（envFilePath 的第一位）才真正决定
 * 本次托管运行的数据库、密钥与宿主回调地址。
 */
export function writeGatewayRuntimeEnv(
  flowDir: string,
  env: Record<string, string>,
): string {
  const gatewayDir = join(flowDir, "gateway");
  mkdirSync(gatewayDir, { recursive: true });
  return writeEnvFile(join(gatewayDir, ".futureflow.runtime.env"), env);
}

async function probeHttp(
  url: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(1500),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/** 目录内最新文件时间（毫秒）；用于判断构建产物是否落后于源码。 */
function newestMtime(dir: string): number {
  let newest = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(path));
    else if (entry.isFile()) newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

function readTail(file: string, lines = 20): string {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/u).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** 执行一次构建（输出落日志，失败带日志尾部）。 */
function runBuild(input: {
  script: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
  label: string;
}): Promise<void> {
  return new Promise((resolveBuild, rejectBuild) => {
    const stream = createWriteStream(input.logFile, { flags: "w" });
    const child = spawn(process.execPath, [input.script, ...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      stream.end();
      rejectBuild(
        new Error(
          `${input.label}超时（超过 ${Math.round(BUILD_TIMEOUT_MS / 60000)} 分钟），日志：${input.logFile}`,
        ),
      );
    }, BUILD_TIMEOUT_MS);
    child.stdout?.pipe(stream, { end: false });
    child.stderr?.pipe(stream, { end: false });
    child.on("error", (error) => {
      clearTimeout(timer);
      stream.end();
      rejectBuild(new Error(`${input.label}无法启动：${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      stream.end();
      if (code === 0) return resolveBuild();
      rejectBuild(
        new Error(
          `${input.label}失败（退出码 ${code}）：${readTail(input.logFile, 12)}`,
        ),
      );
    });
  });
}

const CONTENT_TYPES: Record<string, string> = {
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
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function startFrontendServer(
  distDir: string,
  port: number,
): Promise<HttpServer> {
  const root = resolve(distDir);
  const index = join(root, "index.html");
  const server = createHttpServer((request, response) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://127.0.0.1").pathname,
      );
    } catch {
      response.writeHead(400).end("bad request");
      return;
    }
    const target = resolve(root, `.${pathname}`);
    const inside = target === root || target.startsWith(`${root}${sep}`);
    if (!inside) {
      response.writeHead(403).end("forbidden");
      return;
    }
    let file = target;
    if (existsSync(file) && statSync(file).isDirectory()) file = index;
    if (!existsSync(file)) {
      // SPA 路由：无扩展名的路径回 index.html；资源缺失保持 404。
      file = extname(pathname) ? file : index;
    }
    if (!existsSync(file)) {
      response.writeHead(404).end("not found");
      return;
    }
    response.setHeader("x-kenfutwork-flow", "1");
    response.setHeader(
      "content-type",
      CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    );
    response.setHeader(
      "cache-control",
      extname(file) === ".html"
        ? "no-cache"
        : "public, max-age=31536000, immutable",
    );
    createReadStream(file).pipe(response);
  });
  return new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(port, "127.0.0.1", () => resolveServer(server));
  });
}

export interface FlowStackSupervisor {
  ensure(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): FlowRuntimeSnapshot;
  /** 引擎安装时把管理员凭据同源写入的 env 文件。 */
  gatewayEnvFiles(): string[];
}

/**
 * 托管一套 flow 运行时。`ensure` 幂等：并发调用共享同一次启动；
 * 已就绪时直接返回，失败后再次调用会重新尝试。
 */
export function createFlowStackSupervisor(deps: {
  flowDir: string;
  dataDir: string;
  databaseUrl: string;
  serverPort: number;
  webOrigin: string;
  fetchImpl?: typeof fetch | undefined;
  spawnImpl?: typeof spawn | undefined;
  isPortFree?: ((port: number) => Promise<boolean>) | undefined;
  /** 测试注入：跳过真实建库。 */
  ensureDatabaseImpl?: ((url: string) => Promise<void>) | undefined;
}): FlowStackSupervisor {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const isFree = deps.isPortFree ?? isPortFree;
  const ensureDatabase = deps.ensureDatabaseImpl ?? ensureFlowDatabase;
  let state: FlowRuntimeState = "stopped";
  let detail: string | undefined;
  // 装配期就读取/生成配置：状态端点与工具注册要立刻拿到稳定端口和密钥。
  let config: FlowManagedConfig = loadOrCreateFlowManagedConfig({
    dataDir: deps.dataDir,
  });
  let child: ChildProcess | undefined;
  let frontendServer: HttpServer | undefined;
  let startedByUs = false;
  let pending: Promise<void> | undefined;

  const gatewayUrl = () => flowGatewayUrl(config.gatewayPort);
  const frontendUrl = () => flowFrontendUrl(config.frontendPort);

  function snapshot(): FlowRuntimeSnapshot {
    return {
      state,
      ...(detail ? { detail } : {}),
      gatewayUrl: gatewayUrl(),
      frontendUrl: frontendUrl(),
    };
  }

  function prepare(): FlowManagedConfig {
    return config;
  }

  async function buildGateway(env: NodeJS.ProcessEnv): Promise<void> {
    const gatewayDir = join(deps.flowDir, "gateway");
    const nestCli = join(
      gatewayDir,
      "node_modules",
      "@nestjs",
      "cli",
      "bin",
      "nest.js",
    );
    if (!existsSync(nestCli))
      throw new Error(
        "flow 网关依赖未安装：请先在 flow 目录执行 pnpm install（或安装 flow 插件时缺少依赖）。",
      );
    await runBuild({
      script: nestCli,
      args: ["build"],
      cwd: gatewayDir,
      env,
      logFile: join(flowRuntimeDir(deps.dataDir), GATEWAY_BUILD_LOG),
      label: "flow 网关构建",
    });
  }

  async function ensureFrontendBuild(env: NodeJS.ProcessEnv): Promise<void> {
    const frontendDir = join(deps.flowDir, "frontend");
    const distIndex = join(frontendDir, "dist", "index.html");
    const markerFile = join(
      flowRuntimeDir(deps.dataDir),
      FRONTEND_BUILD_MARKER,
    );
    const expectedGateway = gatewayUrl();
    let marker: { gatewayUrl?: string } = {};
    try {
      marker = JSON.parse(readFileSync(markerFile, "utf8")) as {
        gatewayUrl?: string;
      };
    } catch {
      marker = {};
    }
    const fresh =
      existsSync(distIndex) &&
      marker.gatewayUrl === expectedGateway &&
      newestMtime(join(frontendDir, "src")) <= statSync(markerFile).mtimeMs;
    if (fresh) return;
    const rsbuild = join(
      frontendDir,
      "node_modules",
      "@rsbuild",
      "core",
      "bin",
      "rsbuild.js",
    );
    if (!existsSync(rsbuild))
      throw new Error(
        "flow 前端依赖未安装：请先在 flow 目录执行 pnpm install（或安装 flow 插件时缺少依赖）。",
      );
    await runBuild({
      script: rsbuild,
      args: ["build"],
      cwd: frontendDir,
      env: {
        ...env,
        MODE: "app",
        NODE_ENV: "production",
        PUBLIC_GATEWAY_URL: expectedGateway,
      },
      logFile: join(flowRuntimeDir(deps.dataDir), FRONTEND_BUILD_LOG),
      label: "flow 前端构建",
    });
    writeFileSync(
      markerFile,
      `${JSON.stringify({ gatewayUrl: expectedGateway, builtAt: new Date().toISOString() }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  async function startGateway(env: Record<string, string>): Promise<void> {
    const url = gatewayUrl();
    if (await probeHttp(`${url}/healthz`, fetchImpl)) return;
    const distMain = join(deps.flowDir, "gateway", "dist", "main.js");
    const envWithNode = env as NodeJS.ProcessEnv;
    const stale =
      existsSync(distMain) &&
      newestMtime(join(deps.flowDir, "gateway", "src")) >
        statSync(distMain).mtimeMs;
    if (!existsSync(distMain) || stale) await buildGateway(envWithNode);
    const logFile = join(flowRuntimeDir(deps.dataDir), GATEWAY_LOG);
    const fd = openSync(logFile, "a");
    const spawned = spawnImpl(process.execPath, [distMain], {
      cwd: join(deps.flowDir, "gateway"),
      env: { ...process.env, ...env },
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    closeSync(fd);
    child = spawned;
    startedByUs = true;
    spawned.on("exit", (code, signal) => {
      if (child !== spawned) return;
      child = undefined;
      if (state === "ready" || state === "starting") {
        state = "error";
        detail = `flow 网关已退出（${signal ?? `退出码 ${code}`}）。${readTail(logFile, 8)}`;
      }
    });
    spawned.on("error", (error) => {
      if (child !== spawned) return;
      child = undefined;
      state = "error";
      detail = `flow 网关无法启动：${error.message}`;
    });
    const deadline = Date.now() + GATEWAY_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (state === "error") throw new Error(detail ?? "flow 网关启动失败。");
      if (await probeHttp(`${url}/healthz`, fetchImpl)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    throw new Error(
      `flow 网关启动超时（${url}/healthz）。${readTail(logFile, 12)}`,
    );
  }

  async function startFrontend(): Promise<void> {
    const url = frontendUrl();
    const existing = await fetchImpl(`${url}/`, {
      signal: AbortSignal.timeout(1500),
    }).catch(() => null);
    if (existing?.ok && existing.headers.get("x-kenfutwork-flow") === "1") {
      await existing.body?.cancel();
      return;
    }
    await existing?.body?.cancel().catch(() => undefined);
    if (existing) {
      // 端口被别的服务占着：换一个端口并落盘（前端端口不进构建产物）。
      const nextPort = await pickFreePort(config.frontendPort + 1, isFree);
      config = { ...config, frontendPort: nextPort };
      writeFlowManagedConfig(deps.dataDir, config);
      console.warn(`[flow] 前端端口 ${url} 被占用，已改用 ${frontendUrl()}。`);
    }
    const server = await startFrontendServer(
      join(deps.flowDir, "frontend", "dist"),
      config.frontendPort,
    );
    frontendServer = server;
  }

  async function runEnsure(): Promise<void> {
    state = "starting";
    detail = undefined;
    try {
      const managed = prepare();
      const gatewayOrigin = flowGatewayUrl(managed.gatewayPort);
      if (!(await probeHttp(`${gatewayOrigin}/healthz`, fetchImpl)))
        state = "starting";
      await ensureDatabase(deps.databaseUrl);
      const env = buildFlowGatewayEnv({
        config: managed,
        dataDir: deps.dataDir,
        database: deps.databaseUrl,
        serverPort: deps.serverPort,
        webOrigin: deps.webOrigin,
      });
      writeFlowRuntimeEnv(deps.dataDir, env);
      writeGatewayRuntimeEnv(deps.flowDir, env);
      const frontendEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...env,
        FRONTEND_PORT: String(managed.frontendPort),
        PUBLIC_GATEWAY_URL: gatewayOrigin,
      };
      await ensureFrontendBuild(frontendEnv);
      await startFrontend();
      try {
        await startGateway(env);
      } catch (error) {
        // 迁移老的本机 flow 安装：库里已有用旧密钥加密的 Dify 授权，
        // 随机生成的新密钥解不开。沿用老密钥重试一次，避免用户重装/重授权。
        const legacy = legacyEncryptionSecret(deps.flowDir);
        const message = error instanceof Error ? error.message : String(error);
        // 崩溃栈可能出现在日志更早的位置：错误摘要里未必带着这句话，
        // 所以要读完整日志确认，不能只匹配异常消息。
        const decryptFailure = (() => {
          try {
            return readFileSync(
              join(flowRuntimeDir(deps.dataDir), GATEWAY_LOG),
              "utf8",
            ).includes("无法解密已保存的 Dify 凭据");
          } catch {
            return false;
          }
        })();
        if (
          !legacy ||
          legacy === env.DIFY_KEY_ENCRYPTION_SECRET ||
          (!message.includes("无法解密已保存的 Dify 凭据") && !decryptFailure)
        )
          throw error;
        console.warn(
          "[flow] 检测到旧的本机 Dify 加密密钥：沿用旧密钥重试一次。",
        );
        config = { ...config, encryptionSecret: legacy };
        writeFlowManagedConfig(deps.dataDir, config);
        env.DIFY_KEY_ENCRYPTION_SECRET = legacy;
        env.MEDIA_CREDENTIAL_ENCRYPTION_SECRET = legacy;
        writeFlowRuntimeEnv(deps.dataDir, env);
        writeGatewayRuntimeEnv(deps.flowDir, env);
        state = "starting";
        detail = undefined;
        await startGateway(env);
      }
      state = "ready";
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
      await stopRuntime();
      state = "error";
      detail = error instanceof Error ? error.message : String(error);
    }
  }

  async function stopRuntime(): Promise<void> {
    const server = frontendServer;
    frontendServer = undefined;
    if (server) {
      // 长连接（iframe 资源/keep-alive）会让 close 一直等：先断开再关闭监听。
      server.closeAllConnections();
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      ).catch(() => undefined);
    }
    if (child && startedByUs) {
      const target = child;
      child = undefined;
      target.kill();
    }
    startedByUs = false;
    if (state !== "error") {
      state = "stopped";
      detail = undefined;
    }
  }

  return {
    async ensure() {
      if (state === "ready") return;
      pending ??= runEnsure().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    stop: stopRuntime,
    snapshot,
    gatewayEnvFiles() {
      return [join(deps.flowDir, "gateway", ".futureflow.runtime.env")];
    },
  };
}
