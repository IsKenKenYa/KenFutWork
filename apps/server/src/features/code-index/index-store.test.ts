import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCodeIndexStore, IndexTooLargeError } from "./index-store.js";

/**
 * 代码库索引（R4-3）：规格里那几条——建/增量/失效/上限/搜索排序——逐条锁住。
 * 索引文件落在临时目录（不碰真实工作目录）。
 */
describe("代码库索引", () => {
  const dirs: string[] = [];
  const makeDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "kfw-index-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it("建索引：列出文件与文本摘要；跳过 node_modules；二进制只记元数据（无摘要）", async () => {
    const root = makeDir();
    const indexDir = makeDir();
    writeFileSync(join(root, "app.py"), "print('你好')\n", "utf8");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "lib.ts"), "export const a = 1;\n", "utf8");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "dep.js"), "x", "utf8");
    writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 2, 0]));

    const store = createCodeIndexStore({ indexDir });
    const index = await store.build("c1", root);
    const paths = index.entries.map((e) => e.path).sort();
    // 二进制也在（可按文件名搜到），但没有摘要
    expect(paths).toEqual(["app.py", "blob.bin", "src/lib.ts"]);
    expect(index.entries.find((e) => e.path === "blob.bin")?.summary).toBe("");
    expect(index.entries.find((e) => e.path === "app.py")?.language).toBe(
      "python",
    );
    expect(
      index.entries.find((e) => e.path === "src/lib.ts")?.summary,
    ).toContain("export const a = 1;");
    // skipped 只统计「读不出来」的文件；node_modules 里的依赖不进索引
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    // 落盘后能读回
    expect((await store.load("c1"))?.entries.map((e) => e.path).sort()).toEqual(
      paths,
    );
    // 统计
    const stats = await store.stats(await store.load("c1"));
    expect(stats?.files).toBe(3);
    expect(stats?.indexBytes).toBeGreaterThan(0);
  });

  it("增量：未变的文件复用摘要（不重读内容），改过的重读，删掉的摘除", async () => {
    const root = makeDir();
    const indexDir = makeDir();
    writeFileSync(join(root, "keep.txt"), "keep\n", "utf8");
    writeFileSync(join(root, "gone.txt"), "gone\n", "utf8");

    const store = createCodeIndexStore({ indexDir });
    const first = await store.build("c1", root);
    expect(first.entries.map((e) => e.path).sort()).toEqual([
      "gone.txt",
      "keep.txt",
    ]);

    // 改一个、删一个、加一个
    rmSync(join(root, "gone.txt"));
    writeFileSync(join(root, "keep.txt"), "keep-v2\n", "utf8");
    writeFileSync(join(root, "new.txt"), "new\n", "utf8");
    const second = await store.rebuild("c1", root);
    expect(second.entries.map((e) => e.path).sort()).toEqual([
      "keep.txt",
      "new.txt",
    ]);
    expect(
      second.entries.find((e) => e.path === "keep.txt")?.summary,
    ).toContain("keep-v2");
  });

  it("搜索：文件名 > 路径 > 摘要 分档排序，空查询返回空", async () => {
    const root = makeDir();
    const indexDir = makeDir();
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "readme.md"), "关于部署的说明\n", "utf8");
    // 只有**路径**命中 deploy（文件名 notes.txt、正文也不含）
    mkdirSync(join(root, "src", "deploy"), { recursive: true });
    writeFileSync(join(root, "src", "deploy", "notes.txt"), "随手记\n", "utf8");
    writeFileSync(join(root, "deploy.py"), "# 部署脚本\nprint(1)\n", "utf8");
    writeFileSync(join(root, "other.txt"), "deploy 出现在正文里\n", "utf8");

    const store = createCodeIndexStore({ indexDir });
    const index = await store.build("c1", root);
    const hits = store.search(index, "deploy");
    expect(hits.map((h) => h.matched)).toEqual(["name", "path", "content"]);
    expect(hits[0]?.path).toBe("deploy.py");
    expect(store.search(index, "  ")).toEqual([]);
    expect(store.search(index, "不存在的词")).toEqual([]);
    // 上限截断
    expect(store.search(index, "e", 1)).toHaveLength(1);
  });

  it("清空：索引文件真删（统计回到 null）", async () => {
    const root = makeDir();
    const indexDir = makeDir();
    writeFileSync(join(root, "a.txt"), "a\n", "utf8");
    const store = createCodeIndexStore({ indexDir });
    await store.build("c1", root);
    expect(await store.load("c1")).not.toBeNull();
    await store.clear("c1");
    expect(await store.load("c1")).toBeNull();
    expect(await store.stats(null)).toBeNull();
  });

  it("ensure：允许自动建时懒建一份（搜索路径不必先手工重建）", async () => {
    const root = makeDir();
    const indexDir = makeDir();
    writeFileSync(join(root, "lazy.txt"), "lazy\n", "utf8");
    const store = createCodeIndexStore({ indexDir });
    const index = await store.ensure("c1", root, { auto: true });
    expect(index?.entries.map((e) => e.path)).toEqual(["lazy.txt"]);
    expect(await store.load("c1")).not.toBeNull();
  });

  it("ensure：开关关着（不允许自动建）时**不建**，返回 null 让界面如实说", async () => {
    const root = makeDir();
    const indexDir = makeDir();
    writeFileSync(join(root, "lazy.txt"), "lazy\n", "utf8");
    const store = createCodeIndexStore({ indexDir });
    expect(await store.ensure("c1", root, { auto: false })).toBeNull();
    expect(await store.load("c1")).toBeNull();
  });

  it("自动建达到资格线（50,000）→ 抛 IndexTooLargeError 且**不落盘**半截索引", async () => {
    const root = makeDir();
    const indexDir = makeDir();
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(root, `f${i}.ts`), `// ${i}\n`, "utf8");
    }
    // 注入小上限（造 50,000 个文件不现实）：语义与真实上限完全一致
    const store = createCodeIndexStore({ indexDir, entryLimit: 3 });
    await expect(
      store.ensure("c1", root, { auto: true }),
    ).rejects.toBeInstanceOf(IndexTooLargeError);
    expect(await store.load("c1")).toBeNull();
  });

  it("手动重建不受资格线限制：超限只截断（并标注 truncated），不会拒", async () => {
    const root = makeDir();
    const indexDir = makeDir();
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(root, `g${i}.ts`), `// ${i}\n`, "utf8");
    }
    const store = createCodeIndexStore({ indexDir, entryLimit: 3 });
    const index = await store.rebuild("c1", root);
    expect(index.truncated).toBe(true);
    expect(index.entries.length).toBeLessThanOrEqual(3);
    expect(await store.load("c1")).not.toBeNull();
  });
});
