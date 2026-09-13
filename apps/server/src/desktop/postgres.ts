import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

import { Client } from "pg";

/**
 * 内嵌 Postgres 生命周期（FORM-2 桌面供给）。
 *
 * **为什么自己管而不用 `embedded-postgres` 的 JS**：它的 JS 通过包内相对路径定位
 * 二进制，SEA 单文件产物里没有 `node_modules` 结构——同一份代码在仓库里跑得通、
 * 打包后必然找不到 `initdb`。本模块只依赖「二进制目录」这一件事（`LOOMIC_PG_BIN_DIR`
 * → 发布包 `<exe>/pg/bin` → 依赖包 `native/bin`），开发、测试、打包三种场景同一条解析链。
 * 二进制本身仍由 `embedded-postgres` 的按平台可选依赖分发（PG 17 线）。
 *
 * 认证：集群用 `scram-sha-256` + 首次 initdb 生成的随机口令（落在应用数据目录），
 * 监听地址锁 `127.0.0.1`。桌面机上的其它进程无法无口令连上。
 */

export type EmbeddedPostgresOptions = {
  binDir: string;
  /** 集群目录（`PG_VERSION` 存在即已初始化）。 */
  dataDir: string;
  /** 目标库名，默认 `loomic`。 */
  database?: string;
  /** 运行日志文件。 */
  logFile: string;
  /** 口令持久化文件（首次 initdb 生成）。 */
  passwordFile: string;
  /** 端口；缺省自动挑一个当前空闲的端口（避免与用户自装 Postgres 撞端口）。 */
  port?: number;
  /** 超级用户名，默认 `loomic`。 */
  user?: string;
  onLog?: (message: string) => void;
};

export type EmbeddedPostgresHandle = {
  connectionString: string;
  database: string;
  dataDir: string;
  port: number;
  /** 幂等：重复调用不再执行 `pg_ctl stop`。 */
  stop(): Promise<void>;
};

export type EmbeddedPostgresDeps = {
  allocatePort(): Promise<number>;
  ensureDatabase(connectionString: string, database: string): Promise<void>;
  fs: {
    exists(path: string): boolean;
    readFile(path: string): Promise<string>;
    mkdir(path: string): Promise<void>;
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
  };
  /** 进程存活探测（仅探测不发信号；注入便于测试）。 */
  isProcessAlive(pid: number): boolean;
  randomPassword(): string;
  run(command: string, args: readonly string[]): Promise<void>;
};

const DEFAULT_USER = "loomic";
const DEFAULT_DATABASE = "loomic";
const CLUSTER_MARKER = "PG_VERSION";
/** Postgres 运行时写入集群目录的进程信息文件。 */
const POSTMASTER_PID = "postmaster.pid";
/** 单条 pg 命令的上限（initdb 在慢盘上最久，60s 足够；超时即 fail loud 而非挂死）。 */
const COMMAND_TIMEOUT_MS = 60_000;

/**
 * 执行命令并取回 stdout（如 `pg_config --sharedir`）。
 * 与 `run` 同口径：只等 `exit`（派生进程继承管道会让 `close` 永不触发），失败返回 undefined。
 */
export async function runCapture(
  command: string,
  args: readonly string[],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    const settle = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(undefined);
    }, COMMAND_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => settle(undefined));
    child.on("exit", (code) =>
      settle(code === 0 ? stdout.trim() || undefined : undefined),
    );
  });
}

/** 平台 → 分发 Postgres 二进制的依赖包（`embedded-postgres` 的按平台可选依赖）。 */
const PLATFORM_PACKAGES: Record<string, string> = {
  "darwin-arm64": "@embedded-postgres/darwin-arm64",
  "darwin-x64": "@embedded-postgres/darwin-x64",
  "linux-arm64": "@embedded-postgres/linux-arm64",
  "linux-x64": "@embedded-postgres/linux-x64",
  "win32-x64": "@embedded-postgres/windows-x64",
};

export function binaryName(base: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${base}.exe` : base;
}

/**
 * 二进制目录解析：`LOOMIC_PG_BIN_DIR` → 发布包内 `<exeDir>/pg/bin` → 依赖包 `native/bin`。
 * 找不到即 fail loud（桌面启动期的第一现场诊断，不能静默降级为「稍后再炸」）。
 */
export function resolvePgBinDir(input: {
  env: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  exeDir?: string;
  platform?: NodeJS.Platform;
}): string {
  const exists = input.exists ?? existsSync;
  const platform = input.platform ?? process.platform;
  const explicit = input.env.LOOMIC_PG_BIN_DIR?.trim();

  if (explicit) {
    if (!exists(explicit)) {
      throw new Error(
        `LOOMIC_PG_BIN_DIR 指向的目录不存在：${explicit}（应包含 ${binaryName("initdb", platform)} 与 ${binaryName("pg_ctl", platform)}）`,
      );
    }
    return explicit;
  }

  const exeDir = input.exeDir ?? process.cwd();
  const bundled = join(exeDir, "pg", "bin");
  if (exists(bundled)) {
    return bundled;
  }

  const dependency = PLATFORM_PACKAGES[`${platform}-${process.arch}`];
  if (dependency) {
    try {
      // 该包的 exports 只暴露主入口（没有 "./package.json" 子路径），故按主入口定位再上溯
      const require = createRequire(import.meta.url);
      const entry = require.resolve(dependency);
      const nativeBin = join(dirname(entry), "..", "native", "bin");
      if (exists(nativeBin)) {
        return nativeBin;
      }
    } catch {
      // 依赖未安装：落到下面的 fail loud
    }
  }

  throw new Error(
    `未找到内嵌 Postgres 二进制（平台 ${platform}-${process.arch}）。` +
      `请设置 LOOMIC_PG_BIN_DIR 指向 Postgres 的 bin 目录，或安装依赖 ${dependency ?? "（该平台暂无预编译包）"}。`,
  );
}

export function buildInitdbArgs(input: {
  dataDir: string;
  passwordFile: string;
  user: string;
}): string[] {
  return [
    "-D",
    input.dataDir,
    "-U",
    input.user,
    "-A",
    "scram-sha-256",
    "--pwfile",
    input.passwordFile,
    "-E",
    "UTF8",
    // Windows 上没有 locale -a，C 是唯一稳妥选择（initdb 也接受它）
    "--locale=C",
  ];
}

export function buildStartArgs(input: {
  dataDir: string;
  logFile: string;
  port: number;
}): string[] {
  return [
    "-D",
    input.dataDir,
    "-l",
    input.logFile,
    "-o",
    `-p ${input.port} -c listen_addresses=127.0.0.1`,
    "-w",
    "start",
  ];
}

export function buildStopArgs(dataDir: string): string[] {
  return ["-D", dataDir, "-m", "fast", "-w", "stop"];
}

export function buildConnectionString(input: {
  database: string;
  password: string;
  port: number;
  user: string;
}): string {
  return `postgres://${encodeURIComponent(input.user)}:${encodeURIComponent(
    input.password,
  )}@127.0.0.1:${input.port}/${encodeURIComponent(input.database)}`;
}

/** 集群是否已初始化（首启动 initdb 的判据）。 */
export function isClusterInitialised(
  dataDir: string,
  exists: (path: string) => boolean = existsSync,
): boolean {
  return exists(join(dataDir, CLUSTER_MARKER));
}

/**
 * 解析 `postmaster.pid`（Postgres 的格式，行序固定）：
 * 1 行 pid、2 行数据目录、3 行启动时间、4 行端口、5 行 socket 目录、6 行监听地址……
 * 只要 pid 与端口两行，且 pid 仍在（进程存活）才算「运行中」——否则是上次崩溃留下的
 * 陈旧文件，交给 `pg_ctl start` 自行处理。
 */
export function parsePostmasterPid(content: string): {
  pid: number;
  port: number;
} | null {
  const lines = content.split("\n").map((line) => line.trim());
  const pid = Number.parseInt(lines[0] ?? "", 10);
  const port = Number.parseInt(lines[3] ?? "", 10);
  if (
    !Number.isInteger(pid) ||
    pid <= 0 ||
    !Number.isInteger(port) ||
    port <= 0
  ) {
    return null;
  }
  return { pid, port };
}

/** 进程是否存活（`kill(pid, 0)`：仅探测，不发信号）。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但无权限探测（仍算活着）；ESRCH 才是真没了
    return (error as { code?: string }).code === "EPERM";
  }
}

async function readRunningCluster(
  dataDir: string,
  deps: EmbeddedPostgresDeps,
): Promise<{ pid: number; port: number } | null> {
  const pidFile = join(dataDir, POSTMASTER_PID);
  if (!deps.fs.exists(pidFile)) {
    return null;
  }
  try {
    const parsed = parsePostmasterPid(await deps.fs.readFile(pidFile));
    if (!parsed || !deps.isProcessAlive(parsed.pid)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function startEmbeddedPostgres(
  options: EmbeddedPostgresOptions,
  overrides: Partial<EmbeddedPostgresDeps> = {},
): Promise<EmbeddedPostgresHandle> {
  const platform = process.platform;
  const user = options.user ?? DEFAULT_USER;
  const database = options.database ?? DEFAULT_DATABASE;
  const deps = { ...defaultDeps, ...overrides };

  await deps.fs.mkdir(options.dataDir);
  await deps.fs.mkdir(dirname(options.logFile));

  const password = await readOrCreatePassword(options.passwordFile, deps);
  const initdb = join(options.binDir, binaryName("initdb", platform));
  const pgCtl = join(options.binDir, binaryName("pg_ctl", platform));

  if (!deps.fs.exists(initdb) || !deps.fs.exists(pgCtl)) {
    throw new Error(
      `内嵌 Postgres 二进制不完整：${options.binDir} 下缺 ${binaryName("initdb", platform)} 或 ${binaryName("pg_ctl", platform)}。`,
    );
  }

  if (!isClusterInitialised(options.dataDir, deps.fs.exists)) {
    // initdb 从文件读口令（命令行带明文会进进程列表）；文件本身是后续每次启动的凭据
    await runOrThrow(
      deps,
      initdb,
      buildInitdbArgs({
        dataDir: options.dataDir,
        passwordFile: options.passwordFile,
        user,
      }),
      "初始化 Postgres 集群",
    );
    options.onLog?.(`已初始化内嵌 Postgres 集群：${options.dataDir}`);
  }

  const running = await readRunningCluster(options.dataDir, deps);
  let port: number;

  if (running) {
    // 上次进程被强杀（Windows 关窗/任务管理器结束进程时不会走退出钩子）会留下活着的
    // postmaster：此时**接管**它，而不是再起一个（同一数据目录起第二个必然失败，
    // 表现为「崩过一次就再也打不开」）。接管后退出时照常停库，顺带清掉上次的孤儿。
    port = running.port;
    options.onLog?.(
      `检测到数据目录已有运行中的集群（pid=${running.pid}，端口 ${port}），直接接管`,
    );
  } else {
    const port2 = options.port ?? (await deps.allocatePort());
    await runOrThrow(
      deps,
      pgCtl,
      buildStartArgs({
        dataDir: options.dataDir,
        logFile: options.logFile,
        port: port2,
      }),
      "启动内嵌 Postgres",
    );
    port = port2;
  }

  const connectionString = buildConnectionString({
    database,
    password,
    port,
    user,
  });
  await deps.ensureDatabase(
    buildConnectionString({ database: "postgres", password, port, user }),
    database,
  );

  let stopped = false;
  return {
    connectionString,
    dataDir: options.dataDir,
    database,
    port,
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      try {
        await deps.run(pgCtl, buildStopArgs(options.dataDir));
      } catch (error) {
        // 已退出/从未起来的集群在这里报错没有意义，但仍要让调用方看见原因
        options.onLog?.(
          `停止内嵌 Postgres 时出错（进程可能已退出）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

async function readOrCreatePassword(
  passwordFile: string,
  deps: EmbeddedPostgresDeps,
): Promise<string> {
  if (deps.fs.exists(passwordFile)) {
    const existing = (await deps.fs.readFile(passwordFile)).trim();
    if (existing) {
      return existing;
    }
  }
  const password = deps.randomPassword();
  await deps.fs.writeFile(passwordFile, password);
  return password;
}

async function runOrThrow(
  deps: EmbeddedPostgresDeps,
  command: string,
  args: readonly string[],
  action: string,
): Promise<void> {
  try {
    await deps.run(command, args);
  } catch (error) {
    throw new Error(
      `${action}失败：${command} ${args.join(" ")}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const defaultDeps: EmbeddedPostgresDeps = {
  async allocatePort() {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close(() => {
          if (port > 0) {
            resolve(port);
          } else {
            reject(new Error("无法分配空闲端口"));
          }
        });
      });
    });
  },

  async ensureDatabase(adminConnectionString, database) {
    const client = new Client({ connectionString: adminConnectionString });
    await client.connect();
    try {
      const existing = await client.query(
        "select 1 from pg_database where datname = $1",
        [database],
      );
      if (existing.rowCount === 0) {
        await client.query(`create database ${quoteIdentifier(database)}`);
      }
    } finally {
      await client.end();
    }
  },

  fs: {
    exists: existsSync,
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    readFile: (path) => readFile(path, "utf8"),
    writeFile: async (path, content) => {
      await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
    },
  },

  isProcessAlive,

  randomPassword() {
    return Array.from({ length: 32 }, () =>
      "abcdefghijklmnopqrstuvwxyz0123456789".charAt(
        Math.floor(Math.random() * 36),
      ),
    ).join("");
  },

  run(command, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      let settled = false;

      const settle = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        // 派生进程（真正的 postgres）继承了 stderr 管道，不主动销毁会吊住事件循环
        child.stderr?.destroy();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      // 只等 `exit`（进程自身退出），不能等 `close`：`pg_ctl start` 派生的 postgres
      // 继承了管道，`close` 会永远不触发——这正是「启动卡死」的成因。
      const timer = setTimeout(() => {
        child.kill();
        settle(new Error(`命令超过 ${COMMAND_TIMEOUT_MS / 1000}s 未返回`));
      }, COMMAND_TIMEOUT_MS);

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => settle(error));
      child.on("exit", (code) => {
        settle(
          code === 0 ? undefined : new Error(stderr.trim() || `退出码 ${code}`),
        );
      });
    });
  },
};

/** 数据库名只来自本模块常量，这里仅作安全拼接口径（标识符不做参数化）。 */
function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
