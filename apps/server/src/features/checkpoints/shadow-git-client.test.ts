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
import type { ExecShadowGit } from "./shadow-git-client.js";
import {
  createShadowGitClient,
  SHADOW_EXCLUDES,
  type ShadowGitScope,
} from "./shadow-git-client.js";

/**
 * 影子 git（Code 模式检查点核心）。
 *
 * 全部用例跑**真实 git**（不是替身）：影子机制的价值就在 git 的真实语义上——
 * 裸仓库放数据目录、work-tree 指向沙箱、绝不碰用户自己的 .git。替身测不出
 * 「嵌套仓库隐形」「read-tree 恢复含删除」「ignore 文件不动」这些行为。
 */

// 纯 Git 客户端语义测试的执行替身；生产执行只走 ProcessSandbox。
const exec: ExecShadowGit = async (args, scope, input) => {
  mkdirSync(scope.gitDir, { recursive: true });
  try {
    return {
      code: 0,
      stderr: "",
      stdout: execFileSync("git", ["--no-optional-locks", ...args], {
        cwd: scope.workTree,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_DIR: scope.gitDir,
          GIT_WORK_TREE: scope.workTree,
        },
        ...(input === undefined ? {} : { input }),
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    const failure = error as {
      status?: number;
      stderr?: Buffer;
      stdout?: Buffer;
    };
    return {
      code: failure.status ?? 1,
      stderr: failure.stderr?.toString() ?? "失败",
      stdout: failure.stdout?.toString() ?? "",
    };
  }
};
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
    it("空目录首次产生真实空树baseline，之后新文件可与pre比较，无变化不重复提交", async () => {
      const scope = makeScope();
      await setup(scope);
      expect(await client.hasCommits(scope)).toBe(false);
      const baseline = await client.commitSnapshot({ ...scope, message: "空" });
      expect(baseline?.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(await client.hasCommits(scope)).toBe(true);
      if (!baseline) throw new Error("首次空树缺少真实baseline");
      expect(await client.commitSnapshot({ ...scope, message: "仍然空" })).toBe(
        null,
      );
      writeFileSync(join(scope.workTree, "new.txt"), "new\n", "utf8");
      const after = await client.commitSnapshot({
        ...scope,
        message: "新文件",
      });
      if (!after) throw new Error("新文件缺少真实post");
      expect(
        await client.numstat({ ...scope, from: baseline.sha, to: after.sha }),
      ).toEqual([{ path: "new.txt", added: 1, deleted: 0 }]);
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

  describe("私有恢复 staging", () => {
    it("精确保留二进制/中文文件字节，materialize不碰实时文件或用户.git", async () => {
      const scope = makeScope();
      await setup(scope);
      const bytes = Buffer.from([0, 255, 10, 128]);
      writeFileSync(join(scope.workTree, "binary.dat"), bytes);
      writeFileSync(join(scope.workTree, "中文 文件.txt"), "原始\n");
      const first = await client.commitSnapshot({ ...scope, message: "初始" });
      if (!first) throw new Error("缺少初始快照");
      writeFileSync(join(scope.workTree, "binary.dat"), "当前内容");
      writeFileSync(join(scope.workTree, "new.txt"), "新文件");
      mkdirSync(join(scope.workTree, ".git"));
      writeFileSync(join(scope.workTree, ".git", "config"), "用户git");
      const stagingDirectory = join(scope.gitDir, "restore");
      mkdirSync(stagingDirectory);
      await client.materialize({ ...scope, sha: first.sha, stagingDirectory });
      expect(readFileSync(join(stagingDirectory, "binary.dat"))).toEqual(bytes);
      expect(
        readFileSync(join(stagingDirectory, "中文 文件.txt"), "utf8"),
      ).toBe("原始\n");
      expect(existsSync(join(stagingDirectory, "new.txt"))).toBe(false);
      expect(readFileSync(join(scope.workTree, "binary.dat"), "utf8")).toBe(
        "当前内容",
      );
      expect(readFileSync(join(scope.workTree, ".git", "config"), "utf8")).toBe(
        "用户git",
      );
      expect(await client.currentPaths(scope)).toContain("new.txt");
      expect(await client.currentPaths(scope)).not.toContain(".git/config");
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

      const stagingDirectory = join(scope.gitDir, "restore-chinese");
      mkdirSync(stagingDirectory);
      await client.materialize({ ...scope, sha: sha1, stagingDirectory });
      expect(
        readFileSync(join(stagingDirectory, "中文 文件.txt"), "utf8"),
      ).toBe("你好\n");
      expect(readFileSync(path, "utf8")).toBe("你好\n世界\n");
    });
  });
});
