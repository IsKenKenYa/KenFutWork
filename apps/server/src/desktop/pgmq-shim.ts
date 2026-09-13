import { existsSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";

import { binaryName, runCapture } from "./postgres.js";

/**
 * pgmq 兼容 shim 的安装（FORM-2 桌面供给的最后一块）。
 *
 * 为什么必须有这一步：历史迁移 `20260325200000_background_jobs.sql` 里有
 * `CREATE EXTENSION IF NOT EXISTS pgmq;` 且**已执行迁移不可改**；而桌面包不带 PGMQ
 * 扩展（第三方 Postgres 扩展、Windows 无预编译，FORM-2 明确桌面队列改进程内）。
 * 于是「干净的捆绑 Postgres」上的迁移链会在那一条上停住——实测报
 * `extension "pgmq" is not available`。
 *
 * 做法与开发容器一致（`docker/pg-dev-shim/`）：把只含 `pgmq.create(queue)` 的最小 SQL
 * 作为扩展装进**该集群自己的** `share/extension`。这是「历史可重放」的兼容层，
 * 不是队列实现——桌面队列走 `in-process`（M3.2）。
 *
 * 幂等且非侵入：已存在 `pgmq.control` 就什么都不做（用户/自托管装了真 pgmq 时不被覆盖）。
 */

export type PgmqQueryable = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};

export type PgmqShimDeps = {
  copyFile(source: string, target: string): Promise<void>;
  exists(path: string): boolean;
  /** 定位该集群的 `share/extension`（pg_config 优先，缺失则按目录惯例）。 */
  resolveExtensionDir(binDir: string): Promise<string | undefined>;
};

const SHIM_FILES = ["pgmq.control", "pgmq--1.0.sql"] as const;

/**
 * shim 源目录：`LOOMIC_PGMQ_SHIM_DIR` → 发布包 `<exe>/pg/shim` → 仓库 `docker/pg-dev-shim`。
 * 返回 undefined 表示「没有 shim 可用」——此时若库里也没装真 pgmq，由 `ensurePgmqAvailable`
 * 给出可执行的报错。
 */
export function resolvePgmqShimDir(input: {
  env: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  exeDir?: string;
  repoRoot?: string;
}): string | undefined {
  const exists = input.exists ?? existsSync;
  const candidates = [
    input.env.LOOMIC_PGMQ_SHIM_DIR?.trim(),
    join(input.exeDir ?? process.cwd(), "pg", "shim"),
    join(input.repoRoot ?? process.cwd(), "docker", "pg-dev-shim"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) =>
    SHIM_FILES.every((file) => exists(join(candidate, file))),
  );
}

/**
 * 确保集群里 `CREATE EXTENSION pgmq` 可用：已装真扩展则直接返回；
 * 否则把 shim 装进该集群的 `share/extension`，仍不可用即 fail loud。
 */
export async function ensurePgmqAvailable(
  client: PgmqQueryable,
  options: {
    binDir: string;
    shimDir?: string | undefined;
    onLog?: (message: string) => void;
  },
  overrides: Partial<PgmqShimDeps> = {},
): Promise<void> {
  const deps = { ...defaultDeps, ...overrides };

  if (await isPgmqAvailable(client)) {
    return;
  }

  if (!options.shimDir) {
    throw new Error(
      "内嵌 Postgres 缺少 pgmq 扩展，且未找到兼容 shim（应为 pgmq.control + pgmq--1.0.sql）。" +
        "请设置 LOOMIC_PGMQ_SHIM_DIR，或在桌面包里保留 <exe>/pg/shim 目录。",
    );
  }

  const extensionDir = await deps.resolveExtensionDir(options.binDir);
  if (!extensionDir) {
    throw new Error(
      `无法确定内嵌 Postgres 的 share/extension 目录（${options.binDir}）；pgmq shim 无法安装。`,
    );
  }

  for (const file of SHIM_FILES) {
    const target = join(extensionDir, file);
    if (deps.exists(target)) {
      continue;
    }
    await deps.copyFile(join(options.shimDir, file), target);
  }
  options.onLog?.(`已安装 pgmq 兼容 shim：${extensionDir}`);

  if (!(await isPgmqAvailable(client))) {
    throw new Error(
      `pgmq shim 安装后仍不可用（${extensionDir}）。若该集群装了真 pgmq，请让它自行提供扩展。`,
    );
  }
}

async function isPgmqAvailable(client: PgmqQueryable): Promise<boolean> {
  const result = await client.query(
    "select 1 from pg_available_extensions where name = 'pgmq'",
  );
  return result.rows.length > 0;
}

const defaultDeps: PgmqShimDeps = {
  copyFile: async (source, target) => {
    await copyFile(source, target);
  },
  exists: existsSync,
  async resolveExtensionDir(binDir) {
    // 捆绑的 Postgres 是精简分发（只有 initdb/pg_ctl/postgres），通常没有 pg_config，
    // 故「跑 pg_config 取 sharedir」只是优先尝试，主路径是目录惯例 <bin>/../share/extension
    const pgConfig = join(binDir, binaryName("pg_config", process.platform));
    if (existsSync(pgConfig)) {
      const sharedir = await runCapture(pgConfig, ["--sharedir"]);
      if (sharedir) {
        return join(sharedir, "extension");
      }
    }
    const conventional = join(binDir, "..", "share", "extension");
    return existsSync(conventional) ? conventional : undefined;
  },
};
