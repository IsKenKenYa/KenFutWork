import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { createGitClient, parseWorktreeList } from "./git-client.js";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function realGit() {
  const run = async (args: readonly string[], cwd: string) => {
    try {
      const { stdout, stderr } = await exec("git", [...args], { cwd });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const err = error as { code?: number; stdout?: string; stderr?: string };
      return {
        code: typeof err.code === "number" ? err.code : 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
      };
    }
  };
  const root = await mkdtemp(join(tmpdir(), "kfw-worktree-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await run(["init"], root);
  await run(["config", "user.email", "t@t.test"], root);
  await run(["config", "user.name", "t"], root);
  await writeFile(join(root, "a.txt"), "hello\n");
  await run(["add", "-A"], root);
  await run(["commit", "-m", "init"], root);
  return { root, client: createGitClient({ exec: run }) };
}

test("parseWorktreeList 解析主/附加工作树与 detached", () => {
  const parsed = parseWorktreeList(
    [
      "worktree /repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /repo/wt",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/feature/x",
      "",
      "worktree /repo/detached",
      "HEAD 3333333333333333333333333333333333333333",
      "detached",
      "",
    ].join("\n"),
  );
  expect(parsed).toEqual([
    {
      path: "/repo",
      head: "1111111111111111111111111111111111111111",
      branch: "main",
    },
    {
      path: "/repo/wt",
      head: "2222222222222222222222222222222222222222",
      branch: "feature/x",
    },
    {
      path: "/repo/detached",
      head: "3333333333333333333333333333333333333333",
      branch: null,
    },
  ]);
});

test("真实仓库：新建工作树（新分支）、列表可见、删除后消失", async () => {
  const { root, client } = await realGit();
  const created = await client.createWorktree(root, {
    path: "wt-feature",
    branch: "feature-1",
    createBranch: true,
  });
  expect(created.branch).toBe("feature-1");
  expect(created.path).toContain("wt-feature");

  const list = await client.listWorktrees(root);
  expect(list.map((entry) => entry.branch)).toContain("feature-1");

  await client.deleteWorktree(root, created.path);
  const after = await client.listWorktrees(root);
  expect(after.map((entry) => entry.branch)).not.toContain("feature-1");
});

test("路径越界与非法分支名在客户端层拒绝（不触达 git）", async () => {
  const { root, client } = await realGit();
  await expect(
    client.createWorktree(root, {
      path: "../outside",
      branch: "x",
      createBranch: true,
    }),
  ).rejects.toThrow(/工作目录内部/);
  await expect(
    client.createWorktree(root, {
      path: "ok",
      branch: "-evil",
      createBranch: true,
    }),
  ).rejects.toThrow(/分支名无效/);
});

test("删除未登记路径与主工作目录被拒", async () => {
  const { root, client } = await realGit();
  await expect(
    client.deleteWorktree(root, join(root, "not-registered")),
  ).rejects.toThrow(/登记列表/);
  await expect(client.deleteWorktree(root, root)).rejects.toThrow(
    /主工作目录不能删除/,
  );
});

test("当前工作目录在查询Git登记列表前拒绝删除", async () => {
  let calls = 0;
  const client = createGitClient({
    exec: async () => {
      calls += 1;
      throw new Error("不应触达Git");
    },
  });
  await expect(client.deleteWorktree("/tmp/project", ".")).rejects.toThrow(
    /主工作目录不能删除/,
  );
  expect(calls).toBe(0);
});

test.skipIf(process.platform === "win32")(
  "大小写不同的Unix路径不得匹配另一已登记工作树",
  async () => {
    const calls: Array<readonly string[]> = [];
    const client = createGitClient({
      exec: async (args) => {
        calls.push(args);
        return {
          code: 0,
          stdout:
            "worktree /tmp/project/Feature\nHEAD abc\nbranch refs/heads/feature\n\n",
          stderr: "",
        };
      },
    });
    await expect(
      client.deleteWorktree("/tmp/project", "feature"),
    ).rejects.toThrow(/登记列表/);
    expect(calls).toEqual([["worktree", "list", "--porcelain"]]);
  },
);
