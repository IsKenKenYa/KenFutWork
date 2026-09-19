import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildConnectionString,
  buildInitdbArgs,
  buildStartArgs,
  buildStopArgs,
  type EmbeddedPostgresDeps,
  isClusterInitialised,
  parsePostmasterPid,
  resolvePgBinDir,
  startEmbeddedPostgres,
} from "./postgres.js";

const BIN_DIR = join("/pg", "bin");
const DATA_DIR = join("/data", "postgres");
const LOG_FILE = join("/data", "logs", "postgres.log");
const PASSWORD_FILE = join("/data", "postgres-password");
const INITDB = join(
  BIN_DIR,
  process.platform === "win32" ? "initdb.exe" : "initdb",
);
const PG_CTL = join(
  BIN_DIR,
  process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl",
);

type Recorded = { args: readonly string[]; command: string };

/** 记录型假依赖：只记录命令与文件读写，不起真进程。 */
function createFakeDeps(
  options: { files?: Record<string, string>; port?: number } = {},
) {
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const commands: Recorded[] = [];
  const ensuredDatabases: string[] = [];
  const deps: EmbeddedPostgresDeps = {
    allocatePort: async () => options.port ?? 55432,
    ensureDatabase: async (_admin, database) => {
      ensuredDatabases.push(database);
    },
    fs: {
      exists: (path) => files.has(path),
      mkdir: async () => {},
      readFile: async (path) => files.get(path) ?? "",
      writeFile: async (path, content) => {
        files.set(path, content);
      },
    },
    // 默认「进程存活」：接管分支由各用例按需覆盖
    isProcessAlive: () => true,
    randomPassword: () => "generated-password",
    run: async (command, args) => {
      commands.push({ args, command });
    },
  };
  return { commands, deps, ensuredDatabases, files };
}

/** 二进制就位（其余文件按需给）。 */
function withBinaries(files: Record<string, string> = {}) {
  return createFakeDeps({ files: { [INITDB]: "", [PG_CTL]: "", ...files } });
}

const baseOptions = {
  binDir: BIN_DIR,
  dataDir: DATA_DIR,
  logFile: LOG_FILE,
  passwordFile: PASSWORD_FILE,
} as const;

describe("内嵌 Postgres：参数构造", () => {
  it("initdb 用口令文件而非命令行明文，认证方式为 scram", () => {
    const args = buildInitdbArgs({
      dataDir: DATA_DIR,
      passwordFile: PASSWORD_FILE,
      user: "kenfutwork",
    });
    expect(args).toContain("--pwfile");
    expect(args[args.indexOf("--pwfile") + 1]).toBe(PASSWORD_FILE);
    expect(args).toContain("scram-sha-256");
    // 口令明文不得出现在任何参数里
    expect(args.join(" ")).not.toContain("generated-password");
  });

  it("start 只监听回环，并把等待就绪开关打开（-w）", () => {
    const args = buildStartArgs({
      dataDir: DATA_DIR,
      logFile: LOG_FILE,
      port: 55432,
    });
    expect(args).toContain("-w");
    expect(args[args.indexOf("-o") + 1]).toBe(
      "-p 55432 -c listen_addresses=127.0.0.1",
    );
  });

  it("stop 用 fast 模式（不等客户端断开，桌面退出要快）", () => {
    expect(buildStopArgs(DATA_DIR)).toEqual([
      "-D",
      DATA_DIR,
      "-m",
      "fast",
      "-w",
      "stop",
    ]);
  });

  it("连接串对用户名/口令做 URL 编码", () => {
    expect(
      buildConnectionString({
        database: "kenfutwork",
        password: "a b/c",
        port: 55432,
        user: "lo omic",
      }),
    ).toBe("postgres://lo%20omic:a%20b%2Fc@127.0.0.1:55432/kenfutwork");
  });
});

describe("内嵌 Postgres：二进制目录解析", () => {
  it("KENFUTWORK_PG_BIN_DIR 显式覆盖优先", () => {
    expect(
      resolvePgBinDir({
        env: { KENFUTWORK_PG_BIN_DIR: join("D:/", "pg", "bin") },
        exists: () => true,
        platform: "win32",
      }),
    ).toBe(join("D:/", "pg", "bin"));
  });

  it("显式目录不存在时 fail loud（不静默回退到依赖包）", () => {
    expect(() =>
      resolvePgBinDir({
        env: { KENFUTWORK_PG_BIN_DIR: "D:/nope" },
        exists: () => false,
        platform: "win32",
      }),
    ).toThrow(/KENFUTWORK_PG_BIN_DIR 指向的目录不存在/);
  });

  it("发布包内 <exe>/pg/bin 优先于依赖包", () => {
    const bundled = join("D:/app", "pg", "bin");
    expect(
      resolvePgBinDir({
        env: {},
        exists: (path) => path === bundled,
        exeDir: "D:/app",
        platform: "win32",
      }),
    ).toBe(bundled);
  });

  // 本用例 mock 了 win32 路径解析，但 resolvePgBinDir 内部用真实 process.arch 拼
  // 平台 key（win32-x64），且 windows-x64 可选依赖只在 x64 Windows 上安装——
  // 非 x64-Windows 机器直接跳过（依赖缺失的 fail loud 另有专测覆盖）。
  const canRunWin32Resolution =
    process.platform === "win32" && process.arch === "x64";

  it.skipIf(!canRunWin32Resolution)(
    "开发态回落到已安装的平台依赖包 native/bin",
    () => {
      const binDir = resolvePgBinDir({
        env: {},
        exists: (path) => path.includes("native"),
        exeDir: "D:/nope",
        platform: "win32",
      });
      expect(binDir).toMatch(/windows-x64[/\\]native[/\\]bin$/);
    },
  );
});

describe("内嵌 Postgres：生命周期", () => {
  it("首启动 initdb → start，并生成持久化口令", async () => {
    const { commands, deps, files } = withBinaries();

    const handle = await startEmbeddedPostgres(baseOptions, deps);

    expect(commands).toHaveLength(2);
    expect(commands[0]?.command).toBe(INITDB);
    expect(commands[0]?.args.join(" ")).toContain(`-D ${DATA_DIR}`);
    expect(commands[1]?.command).toBe(PG_CTL);
    expect(commands[1]?.args).toContain("start");
    expect(files.get(PASSWORD_FILE)).toBe("generated-password");
    expect(handle.connectionString).toBe(
      "postgres://kenfutwork:generated-password@127.0.0.1:55432/kenfutwork",
    );
  });

  it("已有集群（PG_VERSION 存在）跳过 initdb，直接 start，且复用既有口令", async () => {
    const { commands, deps } = withBinaries({
      [join(DATA_DIR, "PG_VERSION")]: "17",
      [PASSWORD_FILE]: "persisted-password",
    });

    const handle = await startEmbeddedPostgres(baseOptions, deps);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toBe(PG_CTL);
    expect(handle.connectionString).toContain("persisted-password");
  });

  it("确保目标库存在（连维护库判断，已存在则只查询）", async () => {
    const { deps, ensuredDatabases } = withBinaries({
      [join(DATA_DIR, "PG_VERSION")]: "17",
      [PASSWORD_FILE]: "p",
    });

    await startEmbeddedPostgres(
      { ...baseOptions, database: "custom_db" },
      deps,
    );

    expect(ensuredDatabases).toEqual(["custom_db"]);
  });

  it("显式端口覆盖自动分配（调试用）", async () => {
    const { deps } = withBinaries({
      [join(DATA_DIR, "PG_VERSION")]: "17",
      [PASSWORD_FILE]: "p",
    });

    const handle = await startEmbeddedPostgres(
      { ...baseOptions, port: 55440 },
      deps,
    );

    expect(handle.port).toBe(55440);
  });

  it("stop 幂等：重复调用只执行一次 pg_ctl stop", async () => {
    const { commands, deps } = withBinaries({
      [join(DATA_DIR, "PG_VERSION")]: "17",
      [PASSWORD_FILE]: "p",
    });

    const handle = await startEmbeddedPostgres(baseOptions, deps);
    await handle.stop();
    await handle.stop();

    expect(commands.filter((c) => c.args.includes("stop"))).toHaveLength(1);
  });

  it("停库失败不抛出（退出路径不该被二次失败打断）", async () => {
    const files = {
      [join(DATA_DIR, "PG_VERSION")]: "17",
      [PASSWORD_FILE]: "p",
    };
    const { deps } = withBinaries(files);
    const logs: string[] = [];
    deps.run = async (_command, args) => {
      if (args.includes("stop")) {
        throw new Error("pg_ctl: no server running");
      }
    };

    const handle = await startEmbeddedPostgres(
      { ...baseOptions, onLog: (message) => logs.push(message) },
      deps,
    );
    await expect(handle.stop()).resolves.toBeUndefined();
    expect(logs.some((line) => line.includes("停止内嵌 Postgres 时出错"))).toBe(
      true,
    );
  });

  it("二进制缺失时 fail loud（含缺失文件名，便于现场诊断）", async () => {
    const { deps } = createFakeDeps({ files: {} });
    deps.fs.exists = () => false;

    await expect(startEmbeddedPostgres(baseOptions, deps)).rejects.toThrow(
      /内嵌 Postgres 二进制不完整/,
    );
  });

  it("initdb 失败时带上命令与 stderr（启动期第一现场）", async () => {
    const { deps } = withBinaries();
    deps.run = async () => {
      throw new Error("initdb: could not create directory");
    };

    await expect(startEmbeddedPostgres(baseOptions, deps)).rejects.toThrow(
      /初始化 Postgres 集群失败[\s\S]*could not create directory/,
    );
  });

  it("集群判据只看 PG_VERSION（半初始化的目录会被重新初始化）", () => {
    expect(isClusterInitialised(DATA_DIR, () => true)).toBe(true);
    expect(isClusterInitialised(DATA_DIR, () => false)).toBe(false);
  });
});

describe("内嵌 Postgres：接管上次崩溃留下的集群", () => {
  const PID_FILE = join(DATA_DIR, "postmaster.pid");
  const PID_CONTENT = [
    "4321",
    DATA_DIR,
    "1700000000",
    "55999",
    "/tmp",
    "",
    "12345",
    "0",
  ].join("\n");

  it("postmaster.pid 解析：取 pid 与端口两行，畸形内容返回 null", () => {
    expect(parsePostmasterPid(PID_CONTENT)).toEqual({ pid: 4321, port: 55999 });
    expect(parsePostmasterPid("")).toBeNull();
    expect(parsePostmasterPid("not-a-pid\nx\ny\nz")).toBeNull();
  });

  it("pid 存活时接管：不再 initdb、不再 pg_ctl start，直接复用既有端口", async () => {
    const { commands, deps } = withBinaries({
      [join(DATA_DIR, "PG_VERSION")]: "17",
      [PID_FILE]: PID_CONTENT,
      [PASSWORD_FILE]: "p",
    });

    const handle = await startEmbeddedPostgres(baseOptions, deps);

    // 只应有「确保数据库存在」这一步，没有任何进程命令
    expect(commands).toEqual([]);
    expect(handle.port).toBe(55999);
    expect(handle.connectionString).toContain(":55999/");
  });

  it("pid 已死（上次崩溃留下陈旧文件）→ 走正常启动", async () => {
    const { commands, deps } = withBinaries({
      [join(DATA_DIR, "PG_VERSION")]: "17",
      [PID_FILE]: PID_CONTENT,
      [PASSWORD_FILE]: "p",
    });
    deps.isProcessAlive = () => false;

    await startEmbeddedPostgres(baseOptions, deps);

    expect(commands.map((c) => c.command)).toEqual([PG_CTL]);
  });
});
