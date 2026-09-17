#!/usr/bin/env node
/**
 * 开发库临时集群 —— 本机没有可用 Docker 时的替代（拉不到 `postgres:17-alpine` 时用）。
 *
 * 用依赖里自带的 `@embedded-postgres/windows-x64` 二进制在**仓库内**初始化一个集群：
 *   - 数据目录 `.kenfutwork-data/pg-dev`（已 gitignore，删除即重置）
 *   - 只监听 127.0.0.1，端口默认 55432（避开 5432/5433 上的既有库）
 *   - 装 `pgmq` 最小 shim（与 `docker/pg-dev-shim` 同一份文件）：历史迁移
 *     `20260325200000_background_jobs.sql` 里的 `create extension if not exists pgmq`
 *     在官方镜像上没有，缺它迁移链会在那一条停住。它**不是队列实现**，
 *     本地开发请配 `KENFUTWORK_QUEUE_DRIVER=in-process`。
 *
 * 用法：
 *   node scripts/开发库临时集群.mjs start   # 首次会 initdb，随后启动并打印连接串
 *   node scripts/开发库临时集群.mjs status
 *   node scripts/开发库临时集群.mjs stop
 *
 * 起来之后：
 *   LOOMIC_DATABASE_URL=<打印的连接串> pnpm --filter @kenfutwork/server migrate apply
 *   LOOMIC_DATABASE_URL=<连接串> pnpm seed
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, ".kenfutwork-data", "pg-dev");
const LOG_FILE = join(ROOT, ".kenfutwork-data", "pg-dev.log");
// 默认 55433：55432 常被上一轮会话留下的临时集群占着（那份继续用就行，
// 连接串见本脚本输出格式）；要换端口用 KENFUTWORK_DEV_PG_PORT。
const PORT = process.env.KENFUTWORK_DEV_PG_PORT ?? "55433";
const DB_NAME = "kenfutwork";
const DB_USER = "kenfutwork";

function pgBinDir() {
  const pnpmDir = join(ROOT, "node_modules", ".pnpm");
  const entry = readdirSync(pnpmDir).find((name) =>
    name.startsWith("@embedded-postgres+windows-x64@"),
  );
  if (!entry) {
    throw new Error(
      "找不到 @embedded-postgres/windows-x64（先 `pnpm install`；该包是桌面内嵌 PG 的依赖）",
    );
  }
  const bin = join(
    pnpmDir,
    entry,
    "node_modules",
    "@embedded-postgres",
    "windows-x64",
    "native",
    "bin",
  );
  if (!existsSync(join(bin, "initdb.exe"))) {
    throw new Error(`内嵌 PG 二进制不完整：${bin}`);
  }
  return bin;
}

function run(exe, args, { allowFailure = false } = {}) {
  const result = spawnSync(exe, args, { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `${exe} ${args.join(" ")} 失败：\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result;
}

/** pgmq 最小 shim：只保证 `create extension pgmq` 不报错（没有 send/read）。 */
function installPgmqShim(bin) {
  const share = join(bin, "..", "share", "extension");
  const shim = join(ROOT, "docker", "pg-dev-shim");
  for (const file of ["pgmq.control", "pgmq--1.0.sql"]) {
    copyFileSync(join(shim, file), join(share, file));
  }
}

function initialise(bin) {
  if (existsSync(join(DATA_DIR, "PG_VERSION"))) return false;
  mkdirSync(dirname(DATA_DIR), { recursive: true });
  // trust 认证：只监听回环的本地开发库，不折腾口令文件
  run(join(bin, "initdb.exe"), [
    "-D",
    DATA_DIR,
    "-U",
    DB_USER,
    "--auth=trust",
    "-E",
    "UTF8",
  ]);
  return true;
}

function start(bin) {
  const started = run(
    join(bin, "pg_ctl.exe"),
    [
      "-D",
      DATA_DIR,
      "-o",
      `-p ${PORT} -c listen_addresses=127.0.0.1`,
      "-l",
      LOG_FILE,
      "start",
    ],
    { allowFailure: true },
  );
  if (started.status !== 0) {
    const out = `${started.stdout ?? ""}${started.stderr ?? ""}`;
    if (!/already running/i.test(out)) throw new Error(out);
  }
  const created = run(
    join(bin, "createdb.exe"),
    ["-h", "127.0.0.1", "-p", PORT, "-U", DB_USER, DB_NAME],
    { allowFailure: true },
  );
  if (created.status !== 0) {
    const out = `${created.stdout ?? ""}${created.stderr ?? ""}`;
    if (!/already exists/i.test(out)) throw new Error(out);
  }
}

const bin = pgBinDir();
const command = process.argv[2] ?? "start";

if (command === "start") {
  const fresh = initialise(bin);
  installPgmqShim(bin);
  start(bin);
  console.log(
    `[开发库] ${fresh ? "已初始化并启动" : "已启动"}（数据目录 ${DATA_DIR}）`,
  );
  console.log("[开发库] 连接串：");
  console.log(`  postgres://${DB_USER}@127.0.0.1:${PORT}/${DB_NAME}`);
  console.log("[开发库] 下一步：");
  console.log(
    `  LOOMIC_DATABASE_URL=postgres://${DB_USER}@127.0.0.1:${PORT}/${DB_NAME} pnpm --filter @kenfutwork/server migrate apply`,
  );
} else if (command === "stop") {
  const stopped = run(join(bin, "pg_ctl.exe"), ["-D", DATA_DIR, "stop"], {
    allowFailure: true,
  });
  console.log(
    stopped.status === 0 ? "[开发库] 已停止" : "[开发库] 未在运行（或已停止）",
  );
} else if (command === "status") {
  const status = run(join(bin, "pg_ctl.exe"), ["-D", DATA_DIR, "status"], {
    allowFailure: true,
  });
  console.log(`${status.stdout ?? ""}${status.stderr ?? ""}`.trim());
} else {
  console.error(`未知命令：${command}（可用 start / stop / status）`);
  process.exit(1);
}
