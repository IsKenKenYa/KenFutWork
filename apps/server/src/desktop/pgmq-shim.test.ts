import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ensurePgmqAvailable,
  type PgmqShimDeps,
  resolvePgmqShimDir,
} from "./pgmq-shim.js";

const BIN_DIR = join("/pg", "native", "bin");
const EXT_DIR = join("/pg", "native", "share", "extension");
const SHIM_DIR = join("/app", "docker", "pg-dev-shim");

/** 假查询端：只回答「pgmq 是否可用」，并在安装后翻转状态。 */
function createFakeClient(options: { availableAfterInstall?: boolean } = {}) {
  let available = false;
  const queries: string[] = [];
  return {
    client: {
      query: async (text: string) => {
        queries.push(text);
        return { rows: available ? [{ name: "pgmq" }] : [] };
      },
    },
    markInstalled: () => {
      available = options.availableAfterInstall ?? true;
    },
    queries,
  };
}

function createFakeDeps(copies: string[]) {
  const files = new Set<string>();
  const deps: PgmqShimDeps = {
    copyFile: async (source: string, target: string) => {
      copies.push(`${source} -> ${target}`);
      files.add(target);
    },
    exists: (path: string) => files.has(path),
    resolveExtensionDir: async () => EXT_DIR,
  };
  return { copies, deps, files };
}

describe("pgmq shim：源目录解析", () => {
  const allPresent = (path: string) =>
    path.includes("pgmq.control") || path.includes("pgmq--1.0.sql");

  it("优先级：LOOMIC_PGMQ_SHIM_DIR → <exe>/pg/shim → 仓库 docker/pg-dev-shim", () => {
    const env = { LOOMIC_PGMQ_SHIM_DIR: join("E:/", "shim") };
    expect(
      resolvePgmqShimDir({
        env,
        exists: () => true,
        exeDir: join("D:/", "app"),
        repoRoot: join("D:/", "repo"),
      }),
    ).toBe(join("E:/", "shim"));

    expect(
      resolvePgmqShimDir({
        env: {},
        exists: (path) => path.startsWith(join("D:/", "app")),
        exeDir: join("D:/", "app"),
        repoRoot: join("D:/", "repo"),
      }),
    ).toBe(join("D:/", "app", "pg", "shim"));

    expect(
      resolvePgmqShimDir({
        env: {},
        exists: (path) => path.startsWith(join("D:/", "repo")),
        exeDir: join("D:/", "app"),
        repoRoot: join("D:/", "repo"),
      }),
    ).toBe(join("D:/", "repo", "docker", "pg-dev-shim"));
  });

  it("候选目录必须两个文件齐全，否则视为没有 shim（返回 undefined）", () => {
    expect(
      resolvePgmqShimDir({
        env: {},
        exists: allPresent,
        exeDir: "D:/app",
        repoRoot: "D:/repo",
      }),
    ).toBe(join("D:/", "app", "pg", "shim"));

    expect(
      resolvePgmqShimDir({
        env: {},
        exists: (path) => path.endsWith("pgmq.control"),
        exeDir: "D:/app",
        repoRoot: "D:/repo",
      }),
    ).toBeUndefined();
  });
});

describe("pgmq shim：安装", () => {
  it("扩展已可用时什么都不做（不覆盖用户/自托管装的真 pgmq）", async () => {
    const { client } = createFakeClient();
    const { copies, deps } = createFakeDeps([]);
    // 预置状态：可用
    const availableClient = {
      query: async () => ({ rows: [{ name: "pgmq" }] }),
    };

    await ensurePgmqAvailable(
      availableClient,
      { binDir: BIN_DIR, shimDir: SHIM_DIR },
      deps,
    );

    expect(copies).toEqual([]);
    expect(client).toBeTruthy();
  });

  it("不可用且没有 shim 源 → fail loud 并给出 LOOMIC_PGMQ_SHIM_DIR 提示", async () => {
    const { client } = createFakeClient();
    const { deps } = createFakeDeps([]);

    await expect(
      ensurePgmqAvailable(
        client,
        { binDir: BIN_DIR, shimDir: undefined },
        deps,
      ),
    ).rejects.toThrow(/LOOMIC_PGMQ_SHIM_DIR/);
  });

  it("不可用时把两个文件装进 share/extension，已存在的不重复覆盖", async () => {
    const { client, markInstalled } = createFakeClient();
    const copies: string[] = [];
    const { deps, files } = createFakeDeps(copies);
    // 预置一个已存在的文件：只应补装缺失的那个
    files.add(join(EXT_DIR, "pgmq.control"));

    const done = ensurePgmqAvailable(
      client,
      { binDir: BIN_DIR, shimDir: SHIM_DIR },
      deps,
    );
    // 装完文件后扩展即可用（模拟 Postgres 读到新文件）
    markInstalled();
    await done;

    expect(copies).toEqual([
      `${join(SHIM_DIR, "pgmq--1.0.sql")} -> ${join(EXT_DIR, "pgmq--1.0.sql")}`,
    ]);
  });

  it("装完仍不可用 → fail loud（不把故障留给后面的迁移）", async () => {
    const { client } = createFakeClient();
    const { deps } = createFakeDeps([]);

    await expect(
      ensurePgmqAvailable(client, { binDir: BIN_DIR, shimDir: SHIM_DIR }, deps),
    ).rejects.toThrow(/shim 安装后仍不可用/);
  });

  it("拿不到 share/extension 目录 → fail loud（含 bin 目录便于定位）", async () => {
    const { client } = createFakeClient();
    const { deps } = createFakeDeps([]);
    deps.resolveExtensionDir = async () => undefined;

    const error: Error = await ensurePgmqAvailable(
      client,
      { binDir: BIN_DIR, shimDir: SHIM_DIR },
      deps,
    ).then(
      () => new Error("应当抛错"),
      (thrown: Error) => thrown,
    );

    expect(error.message).toContain("share/extension");
    expect(error.message).toContain(BIN_DIR);
  });

  it("装好后可通过（前置查询走 pg_available_extensions，不做写探测）", async () => {
    const queries: string[] = [];
    let available = false;
    const client = {
      query: async (text: string) => {
        queries.push(text);
        return { rows: available ? [{ name: "pgmq" }] : [] };
      },
    };
    const copies: string[] = [];
    const { deps } = createFakeDeps(copies);

    const done = ensurePgmqAvailable(
      client,
      { binDir: BIN_DIR, shimDir: SHIM_DIR },
      deps,
    );
    available = true;
    await done;

    expect(
      queries.every((text) => text.includes("pg_available_extensions")),
    ).toBe(true);
    expect(copies).toHaveLength(2);
  });
});
