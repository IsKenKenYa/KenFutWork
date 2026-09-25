import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createShadowGitClient,
  SHADOW_EXCLUDES,
  type ShadowGitScope,
} from "./shadow-git-client.js";
import { createShadowGitExec } from "./shadow-git-exec.js";

/**
 * 影子 git（Code 模式检查点核心）。
 *
 * 全部用例跑**真实 git**（不是替身）：影子机制的价值就在 git 的真实语义上——
 * 裸仓库放数据目录、work-tree 指向沙箱、绝不碰用户自己的 .git。替身测不出
 * 「嵌套仓库隐形」「read-tree 恢复含删除」「ignore 文件不动」这些行为。
 */

const exec = createShadowGitExec({ binary: "git" });
const client = createShadowGitClient({
  exec,
  writeTextFile: async (path, content) => {
    writeFileSync(path, content, "utf8");
  },
});

/** 在 workTree 里造一个真实嵌套仓库（带自己的 .git 与已提交文件）。 */
const makeNestedRepo = (workTree: string): void => {
  const nested = join(workTree, "nested");
  mkdirSync(nested, { recursive: true });
  // 测试进程 env 里没有 GIT_DIR/GIT_WORK_TREE，普通 execFileSync 不会污染影子仓库
  execFileSync("git", ["init", "-q", nested]);
  writeFileSync(join(nested, "inner.txt"), "inner\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: nested });
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "n1"],
    { cwd: nested },
  );
};

describe("影子 git（Code 模式检查点核心）", () => {
  const dirs: string[] = [];
  const makeScope = (): ShadowGitScope => {
    const root = mkdtempSync(join(tmpdir(), "kfw-shadow-git-"));
    dirs.push(root);
    const workTree = join(root, "work");
    mkdirSync(workTree);
    return { gitDir: join(root, "shadow.git"), workTree };
  };
  const setup = async (scope: ShadowGitScope): Promise<void> => {
    await client.ensureRepo({ ...scope, excludes: SHADOW_EXCLUDES });
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("ensureRepo", () => {
    it("幂等：两次调用不报错，excludes 文件落盘且含关键忽略项", async () => {
      const scope = makeScope();
      await setup(scope);
      await setup(scope);
      expect(existsSync(join(scope.gitDir, "excludes"))).toBe(true);
      const content = readFileSync(join(scope.gitDir, "excludes"), "utf8");
      expect(content).toContain(".git");
      expect(content).toContain("node_modules");
    });

    it("config 生效：node_modules 不出现在未跟踪列表，普通文件出现", async () => {
      const scope = makeScope();
      await setup(scope);
      writeFileSync(join(scope.workTree, "app.ts"), "export {};\n", "utf8");
      mkdirSync(join(scope.workTree, "node_modules", "pkg"), {
        recursive: true,
      });
      writeFileSync(
        join(scope.workTree, "node_modules", "pkg", "lib.js"),
        "x",
        "utf8",
      );

      const status = await exec(["status", "--porcelain"], scope);
      expect(status.code).toBe(0);
      const lines = status.stdout.split("\n").filter((l) => l.trim());
      expect(lines.some((l) => l.includes("node_modules"))).toBe(false);
      expect(lines.some((l) => l.endsWith("app.ts"))).toBe(true);
    });
  });

  describe("commitSnapshot", () => {
    it("空目录（尚未有提交）返回 null，不产生提交", async () => {
      const scope = makeScope();
      await setup(scope);
      expect(await client.hasCommits(scope)).toBe(false);
      expect(await client.commitSnapshot({ ...scope, message: "空" })).toBe(
        null,
      );
      expect(await client.hasCommits(scope)).toBe(false);
    });

    it("写入文件后返回 sha（无提交的目录也必须产出 baseline 提交）", async () => {
      const scope = makeScope();
      await setup(scope);
      writeFileSync(join(scope.workTree, "a.txt"), "one\n", "utf8");

      const result = await client.commitSnapshot({ ...scope, message: "c1" });
      expect(result).not.toBeNull();
      expect(result?.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(await client.hasCommits(scope)).toBe(true);
    });

    it("再次调用无变化返回 null（跳过空检查点）", async () => {
      const scope = makeScope();
      await setup(scope);
      writeFileSync(join(scope.workTree, "a.txt"), "one\n", "utf8");
      const first = await client.commitSnapshot({ ...scope, message: "c1" });
      expect(first?.sha).toBeDefined();

      expect(await client.commitSnapshot({ ...scope, message: "c2" })).toBe(
        null,
      );
    });

    it("改动文件后再调用返回新 sha", async () => {
      const scope = makeScope();
      await setup(scope);
      writeFileSync(join(scope.workTree, "a.txt"), "one\n", "utf8");
      const first = await client.commitSnapshot({ ...scope, message: "c1" });

      writeFileSync(join(scope.workTree, "a.txt"), "two\n", "utf8");
      const second = await client.commitSnapshot({ ...scope, message: "c2" });
      expect(second?.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(second?.sha).not.toBe(first?.sha);
    });
  });

  describe("numstat 增量", () => {
    it("numstat(sha1, sha2) 只含本轮变化的文件", async () => {
      const scope = makeScope();
      await setup(scope);
      writeFileSync(join(scope.workTree, "a.txt"), "one\n", "utf8");
      writeFileSync(join(scope.workTree, "old.txt"), "old\n", "utf8");
      const sha1 = (await client.commitSnapshot({ ...scope, message: "c1" }))
        ?.sha;

      writeFileSync(join(scope.workTree, "a.txt"), "one-two\n", "utf8");
      writeFileSync(join(scope.workTree, "b.txt"), "b\n", "utf8");
      rmSync(join(scope.workTree, "old.txt"));
      const sha2 = (await client.commitSnapshot({ ...scope, message: "c2" }))
        ?.sha;

      expect(sha1).toBeDefined();
      expect(sha2).toBeDefined();
      const entries = await client.numstat({
        ...scope,
        from: sha1 as string,
        to: sha2 as string,
      });
      expect(entries.map((e) => e.path).sort()).toEqual([
        "a.txt",
        "b.txt",
        "old.txt",
      ]);
      const byPath = new Map(entries.map((e) => [e.path, e]));
      expect(byPath.get("b.txt")?.added).toBe(1);
      expect(byPath.get("old.txt")?.deleted).toBe(1);
    });

    it("二进制文件 added/deleted 为 null（不伪造行数）", async () => {
      const scope = makeScope();
      await setup(scope);
      writeFileSync(
        join(scope.workTree, "logo.png"),
        Buffer.from([0x89, 0x50, 0x00, 0x0a]),
      );
      const sha1 = (await client.commitSnapshot({ ...scope, message: "c1" }))
        ?.sha;
      writeFileSync(
        join(scope.workTree, "logo.png"),
        Buffer.from([0x89, 0x50, 0x01, 0x0b]),
      );
      const sha2 = (await client.commitSnapshot({ ...scope, message: "c2" }))
        ?.sha;

      const entries = await client.numstat({
        ...scope,
        from: sha1 as string,
        to: sha2 as string,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.path).toBe("logo.png");
      expect(entries[0]?.added).toBeNull();
      expect(entries[0]?.deleted).toBeNull();
    });
  });

  describe("restoreTo 恢复三态", () => {
    it("修改、新建、删除三类未提交改动全部精确还原", async () => {
      const scope = makeScope();
      await setup(scope);
      writeFileSync(join(scope.workTree, "a.txt"), "one\n", "utf8");
      writeFileSync(join(scope.workTree, "gone.txt"), "gone\n", "utf8");
      writeFileSync(join(scope.workTree, "keep.txt"), "keep\n", "utf8");
      const sha1 = (await client.commitSnapshot({ ...scope, message: "c1" }))
        ?.sha as string;

      // 三态：改 a.txt、删 gone.txt、增 new.txt
      writeFileSync(join(scope.workTree, "a.txt"), "mutated\n", "utf8");
      rmSync(join(scope.workTree, "gone.txt"));
      writeFileSync(join(scope.workTree, "new.txt"), "new\n", "utf8");

      await client.restoreTo({ ...scope, sha: sha1 });

      expect(readFileSync(join(scope.workTree, "a.txt"), "utf8")).toBe("one\n");
      expect(readFileSync(join(scope.workTree, "gone.txt"), "utf8")).toBe(
        "gone\n",
      );
      expect(readFileSync(join(scope.workTree, "keep.txt"), "utf8")).toBe(
        "keep\n",
      );
      expect(existsSync(join(scope.workTree, "new.txt"))).toBe(false);
    });

    it("只改不提交直接恢复：未提交改动被覆盖回目标状态", async () => {
      const scope = makeScope();
      await setup(scope);
      writeFileSync(join(scope.workTree, "a.txt"), "v1\n", "utf8");
      const sha1 = (await client.commitSnapshot({ ...scope, message: "c1" }))
        ?.sha as string;

      // 不产生新检查点，直接改动后恢复
      writeFileSync(join(scope.workTree, "a.txt"), "未提交的脏改动\n", "utf8");
      await client.restoreTo({ ...scope, sha: sha1 });
      expect(readFileSync(join(scope.workTree, "a.txt"), "utf8")).toBe("v1\n");
    });
  });

  describe("忽略与嵌套", () => {
    it("忽略项（node_modules / *.log）在恢复前后原样存在", async () => {
      const scope = makeScope();
      await setup(scope);
      writeFileSync(join(scope.workTree, "a.txt"), "v1\n", "utf8");
      mkdirSync(join(scope.workTree, "node_modules", "pkg"), {
        recursive: true,
      });
      writeFileSync(
        join(scope.workTree, "node_modules", "pkg", "lib.js"),
        "nm\n",
        "utf8",
      );
      const sha1 = (await client.commitSnapshot({ ...scope, message: "c1" }))
        ?.sha as string;

      // 检查点之后新出现的忽略文件（从未进过影子仓库）
      writeFileSync(join(scope.workTree, "app.log"), "log\n", "utf8");
      writeFileSync(join(scope.workTree, "a.txt"), "v2\n", "utf8");

      await client.restoreTo({ ...scope, sha: sha1 });

      expect(readFileSync(join(scope.workTree, "a.txt"), "utf8")).toBe("v1\n");
      expect(
        readFileSync(
          join(scope.workTree, "node_modules", "pkg", "lib.js"),
          "utf8",
        ),
      ).toBe("nm\n");
      expect(readFileSync(join(scope.workTree, "app.log"), "utf8")).toBe(
        "log\n",
      );
    });

    it("嵌套 .git 不进影子仓库：numstat 不含其内容，恢复后原样存在", async () => {
      const scope = makeScope();
      await setup(scope);
      writeFileSync(join(scope.workTree, "a.txt"), "v1\n", "utf8");
      const sha1 = (await client.commitSnapshot({ ...scope, message: "c1" }))
        ?.sha as string;

      makeNestedRepo(scope.workTree);

      const sha2 = (await client.commitSnapshot({ ...scope, message: "c2" }))
        ?.sha as string;
      const entries = await client.numstat({
        ...scope,
        from: sha1,
        to: sha2,
      });
      // 嵌套仓库的**内容**一个字节都不进影子仓库（gitlink 指针不算内容）
      expect(
        entries.filter((e) => e.path.startsWith("nested/")).map((e) => e.path),
      ).toEqual([]);

      await client.restoreTo({ ...scope, sha: sha1 });
      expect(
        readFileSync(join(scope.workTree, "nested", "inner.txt"), "utf8"),
      ).toBe("inner\n");
    });
  });

  describe("changedAgainst（恢复预览）", () => {
    it("目标 sha 之后工作区的未提交差异被完整列出", async () => {
      const scope = makeScope();
      await setup(scope);
      writeFileSync(join(scope.workTree, "a.txt"), "v1\n", "utf8");
      writeFileSync(join(scope.workTree, "gone.txt"), "gone\n", "utf8");
      const sha1 = (await client.commitSnapshot({ ...scope, message: "c1" }))
        ?.sha as string;

      writeFileSync(join(scope.workTree, "a.txt"), "v1\nv2\n", "utf8");
      rmSync(join(scope.workTree, "gone.txt"));
      writeFileSync(join(scope.workTree, "added.txt"), "added\n", "utf8");

      const entries = await client.changedAgainst({ ...scope, sha: sha1 });
      const byPath = new Map(entries.map((e) => [e.path, e]));
      expect(byPath.get("a.txt")?.added).toBe(1);
      expect(byPath.get("gone.txt")?.deleted).toBe(1);
      expect(byPath.get("added.txt")?.added).toBe(1);
    });
  });

  describe("diffText", () => {
    it("返回统一 diff 原文，可按 path 过滤", async () => {
      const scope = makeScope();
      await setup(scope);
      writeFileSync(join(scope.workTree, "a.txt"), "one\n", "utf8");
      writeFileSync(join(scope.workTree, "b.txt"), "b\n", "utf8");
      const sha1 = (await client.commitSnapshot({ ...scope, message: "c1" }))
        ?.sha as string;
      writeFileSync(join(scope.workTree, "a.txt"), "one\ntwo\n", "utf8");
      const sha2 = (await client.commitSnapshot({ ...scope, message: "c2" }))
        ?.sha as string;

      const all = await client.diffText({ ...scope, from: sha1, to: sha2 });
      expect(all).toContain("diff --git");
      expect(all).toContain("+two");

      const onlyA = await client.diffText({
        ...scope,
        from: sha1,
        to: sha2,
        path: "a.txt",
      });
      expect(onlyA).toContain("a.txt");
      expect(onlyA).not.toContain("b.txt");
    });
  });

  describe("中文与空格文件名", () => {
    it("「中文 文件.txt」走完整 commit → 改动 → restore 循环", async () => {
      const scope = makeScope();
      await setup(scope);
      const path = join(scope.workTree, "中文 文件.txt");
      writeFileSync(path, "你好\n", "utf8");
      const sha1 = (await client.commitSnapshot({ ...scope, message: "c1" }))
        ?.sha as string;

      writeFileSync(path, "你好\n世界\n", "utf8");
      const sha2 = (await client.commitSnapshot({ ...scope, message: "c2" }))
        ?.sha as string;
      expect(sha2).not.toBe(sha1);

      const entries = await client.numstat({ ...scope, from: sha1, to: sha2 });
      expect(entries.map((e) => e.path)).toEqual(["中文 文件.txt"]);
      expect(entries[0]?.added).toBe(1);

      await client.restoreTo({ ...scope, sha: sha1 });
      expect(readFileSync(path, "utf8")).toBe("你好\n");
    });
  });
});
