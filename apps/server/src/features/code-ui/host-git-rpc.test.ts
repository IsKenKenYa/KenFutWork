import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { instanceSettingsSchema } from "@kenfutwork/shared";
import { afterEach, expect, it } from "vitest";
import type { ExecGit, GitCommandResult } from "../code-git/git-client.js";
import { resolveReadOnlyProjectPath } from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";
import { createCodeUiHostGitRpc } from "./host-git-rpc.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const execute: ExecGit = (args, cwd, input, env) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        ...(env ? { env: { ...process.env, ...env } } : {}),
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
    child.stdin?.end(input);
  });
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}
async function resolveTaskWritePath(root: string, path: string) {
  const absolute = isAbsolute(path) ? path : join(root, path);
  const canonical = await canonicalPath(absolute);
  const tail = relative(root, canonical);
  if (isAbsolute(tail) || tail === ".." || tail.startsWith(`..${sep}`))
    throw new Error("路径越出任务主目录");
  return canonical;
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kfw-host-git-")));
  roots.push(root);
  const setup = async (args: string[]) => {
    const result = await execute(args, root);
    if (result.code) throw new Error(result.stderr);
  };
  await setup(["init", "-b", "main"]);
  await setup(["config", "user.name", "Git DTO测试"]);
  await setup(["config", "user.email", "git@test.invalid"]);
  await writeFile(join(root, "tracked.txt"), "base\n");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2]));
  await writeFile(join(root, "rename.txt"), "rename body\n");
  await setup([
    "add",
    "--",
    "tracked.txt",
    ".gitignore",
    "binary.dat",
    "rename.txt",
  ]);
  // 仅此测试独占临时目录的fixture历史，不提交worktree，也不写远端。
  await setup(["commit", "-m", "测试基线"]);
  await writeFile(join(root, "tracked.txt"), "staged\n");
  await setup(["add", "--", "tracked.txt"]);
  await writeFile(join(root, "tracked.txt"), "unstaged\n");
  await writeFile(join(root, "new.txt"), "new content\n");
  await writeFile(join(root, "ignored.txt"), "ignored\n");
  await writeFile(join(root, "untracked-binary.dat"), Buffer.from([0, 4, 5]));
  const instanceId = randomUUID();
  const actor: LocalActor = { instanceId, accessClientId: null };
  const projectId = randomUUID();
  const taskId = randomUUID();
  const requests: Array<readonly string[]> = [];
  let available = true;
  const rpc = createCodeUiHostGitRpc({
    resolveTarget: async (owner, request) => {
      if (
        owner.instanceId !== actor.instanceId ||
        request.workspacePath !== root ||
        !request.viewerScope ||
        (request.viewerScope.kind === "task"
          ? request.viewerScope.taskId !== taskId
          : request.viewerScope.projectId !== projectId)
      )
        throw new Error("没有目标授权");
      return {
        instanceId,
        projectId,
        rootDirectory: root,
        viewerScope: request.viewerScope,
      };
    },
    withSession: async (_actor, target, _connection, read) =>
      read({
        rootDirectory: root,
        available,
        limits: instanceSettingsSchema.parse({ defaultModel: "fixture" }),
        resolvePath: (path, operation) =>
          operation === "write" && target.viewerScope.kind === "task"
            ? resolveTaskWritePath(root, path)
            : resolveReadOnlyProjectPath(
                { rootDirectory: root, additionalDirectories: [] },
                path,
              ),
        exec: (args, cwd, input, env) => {
          requests.push(args);
          return execute(args, cwd, input, env);
        },
      }),
  });
  const connection = {
    connectionId: randomUUID(),
    instanceId,
  };
  const params = {
    workspacePath: root,
    viewerScope: { kind: "task" as const, taskId },
  };
  const call = (method: string, values = {}) =>
    rpc.call(actor, method, [{ ...params, ...values }], connection);
  const raw = (args: string[]): Promise<GitCommandResult> =>
    execute(args, root);
  return {
    root,
    actor,
    projectId,
    taskId,
    instanceId,
    connection,
    params,
    rpc,
    call,
    raw,
    requests,
    setup,
    unavailable: () => {
      available = false;
    },
  };
}
it("原只读GitDTO消费真实临时仓库，staged/unstaged内容不混淆且不截掉文件尾部", async () => {
  const f = await fixture();
  expect(
    await f.call("refresh", {
      includeIdentity: true,
      includeBranchComparison: true,
    }),
  ).toMatchObject({
    result: {
      summary: {
        workspacePath: f.root,
        repoRoot: f.root,
        branchName: "main",
        headRefType: "branch",
        isDirty: true,
        isRepository: true,
        isGitAvailable: true,
      },
      identity: { userName: "Git DTO测试", userEmail: "git@test.invalid" },
      stagedChanges: [
        {
          path: join(f.root, "tracked.txt"),
          section: "staged",
          added: 1,
          removed: 1,
        },
      ],
      unstagedChanges: expect.arrayContaining([
        {
          path: join(f.root, "tracked.txt"),
          repoRelativePath: "tracked.txt",
          workspaceRelativePath: "tracked.txt",
          x: "M",
          y: "M",
          kind: "modified",
          section: "unstaged",
          added: 1,
          removed: 1,
          isStaged: false,
          isUntracked: false,
          isConflicted: false,
        },
      ]),
    },
  });
  expect(
    await f.call("getDiff", { path: "tracked.txt", sourceId: "staged" }),
  ).toMatchObject({
    result: {
      availability: "patch",
      beforeContent: "base\n",
      afterContent: "staged\n",
    },
  });
  expect(
    await f.call("getDiff", { path: "tracked.txt", sourceId: "unstaged" }),
  ).toMatchObject({
    result: {
      availability: "patch",
      beforeContent: "staged\n",
      afterContent: "unstaged\n",
    },
  });
  expect(
    await f.call("getDiff", { path: "untracked-binary.dat" }),
  ).toMatchObject({ result: { availability: "binary", patch: null } });
});

it("未跟踪文本给真实行数，不可预览二进制/空文件不伪造可审查统计，含TAB的rename保留路径", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "empty.txt"), "");
  expect(await f.call("getChanges", { sourceId: "unstaged" })).toMatchObject({
    result: expect.arrayContaining([
      {
        path: join(f.root, "new.txt"),
        repoRelativePath: "new.txt",
        workspaceRelativePath: "new.txt",
        x: "?",
        y: "?",
        kind: "added",
        section: "untracked",
        added: 1,
        removed: 0,
        isStaged: false,
        isUntracked: true,
        isConflicted: false,
      },
    ]),
  });
  const changes = (await f.call("getChanges", { sourceId: "unstaged" }))
    ?.result as Array<{ path: string }>;
  expect(changes.map((entry) => entry.path)).not.toContain(
    join(f.root, "empty.txt"),
  );
  expect(changes.map((entry) => entry.path)).not.toContain(
    join(f.root, "untracked-binary.dat"),
  );
  await f.setup(["mv", "rename.txt", "renamed\tfile.txt"]);
  expect(await f.call("getChanges", { sourceId: "staged" })).toMatchObject({
    result: expect.arrayContaining([
      expect.objectContaining({
        path: join(f.root, "renamed\tfile.txt"),
        kind: "renamed",
        section: "staged",
        added: 0,
        removed: 0,
      }),
    ]),
  });
});

it("含斜杠本地branch的graph ref不是remote；upstream比较保留原DTO分支名与真实文件内容", async () => {
  const f = await fixture();
  await f.setup(["branch", "feature/slash"]);
  await f.setup(["tag", "v-fixture"]);
  expect(await f.call("getCommitGraph", { maxCount: 1 })).toMatchObject({
    result: {
      commits: [
        expect.objectContaining({
          refs: expect.arrayContaining([
            { name: "feature/slash", kind: "branch" },
            { name: "HEAD", kind: "head" },
            { name: "main", kind: "branch" },
            { name: "v-fixture", kind: "tag" },
          ]),
        }),
      ],
    },
  });
  await f.setup(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await f.setup([
    "config",
    "remote.origin.url",
    join(f.root, "local-readonly-fixture"),
  ]);
  await f.setup([
    "config",
    "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*",
  ]);
  await f.setup(["config", "branch.main.remote", "origin"]);
  await f.setup(["config", "branch.main.merge", "refs/heads/main"]);
  // 此提交只建立独占/tmp的比较fixture，不执行生产RPC或远端推送。
  await f.setup(["commit", "-m", "分支比较fixture"]);
  expect(await f.call("getBranchComparison")).toMatchObject({
    result: {
      baseRef: "origin/main",
      headRef: "main",
      comparisonLabel: "main -> origin/main",
      changes: [
        expect.objectContaining({
          path: join(f.root, "tracked.txt"),
          added: 1,
          removed: 1,
          section: "branch",
        }),
      ],
    },
  });
  expect(
    await f.call("getDiff", { path: "tracked.txt", sourceId: "branch" }),
  ).toMatchObject({
    result: {
      beforeContent: "base\n",
      afterContent: "staged\n",
      availability: "patch",
    },
  });
});
it("原ignore/branches/graph/worktree-info来自真实Git，越界不进入执行器", async () => {
  const f = await fixture();
  expect(
    await f.call("getIgnoredPaths", {
      paths: [join(f.root, "ignored.txt"), join(f.root, "new.txt")],
    }),
  ).toEqual({ result: [join(f.root, "ignored.txt")] });
  expect(await f.call("getLocalBranches")).toMatchObject({
    result: {
      currentBranchName: "main",
      branches: [
        {
          name: "main",
          isCurrent: true,
          commitHash: expect.stringMatching(/^[a-f0-9]{40}$/),
        },
      ],
    },
  });
  expect(await f.call("getCommitGraph", { maxCount: 1 })).toMatchObject({
    result: {
      commits: [
        {
          hash: expect.stringMatching(/^[a-f0-9]{40}$/),
          parents: [],
          subject: "测试基线",
          authorName: "Git DTO测试",
          authoredAtMs: expect.any(Number),
        },
      ],
      hasMore: false,
    },
  });
  expect(await f.call("getWorkspaceRepositoryInfo")).toEqual({
    result: { workspacePath: f.root, kind: "main-tree", isGitAvailable: true },
  });
  await expect(
    f.call("getIgnoredPaths", { paths: ["../outside"] }),
  ).rejects.toThrow(/目录|路径/);
  expect(
    f.requests.every(
      (args) =>
        !["add", "restore", "clean", "commit", "push", "switch"].includes(
          args[0] ?? "",
        ),
    ),
  ).toBe(true);
});
it("Project只读投影保持真实目录，连接与workspace核对；项目作用域写操作被拒绝且有可读原因", async () => {
  const f = await fixture();
  const projectParams = {
    ...f.params,
    viewerScope: { kind: "project" as const, projectId: f.projectId },
  };
  expect(
    await f.rpc.call(
      f.actor,
      "getRepositorySummary",
      [projectParams],
      f.connection,
    ),
  ).toMatchObject({ result: { isRepository: true, branchName: "main" } });
  f.requests.splice(0);
  await expect(
    f.rpc.call(f.actor, "getRepositorySummary", [f.params], {
      ...f.connection,
      instanceId: randomUUID(),
    }),
  ).rejects.toThrow(/连接/);
  await expect(
    f.rpc.call(f.actor, "getRepositorySummary", [f.params], {
      ...f.connection,
      instanceId: randomUUID(),
    }),
  ).rejects.toThrow(/实例/);
  const writes: Array<[string, Record<string, unknown>]> = [
    ["stagePaths", { paths: ["tracked.txt"] }],
    ["unstagePaths", { paths: ["tracked.txt"] }],
    ["discardPaths", { paths: ["tracked.txt"] }],
    ["commit", { message: "不会执行", paths: ["new.txt"] }],
    ["push", {}],
    ["switchBranch", { targetBranchName: "main" }],
    ["createBranchAndSwitch", { branchName: "never-created" }],
  ];
  for (const [method, values] of writes)
    await expect(
      f.rpc.call(
        f.actor,
        method,
        [{ ...projectParams, ...values }],
        f.connection,
      ),
    ).rejects.toThrow("项目文件面板仅支持读取，Git写操作请在任务中进行。");
  expect(f.requests).toEqual([]);
  await expect(
    f.call("generateCommitMessage", { message: "x" }),
  ).rejects.toThrow(/尚不支持|未接通/);
  f.unavailable();
  expect(await f.call("getRepositorySummary")).toMatchObject({
    result: { isGitAvailable: false, isRepository: false },
  });
  expect(f.requests).toEqual([]);
});

it("仓库配置里的upstream名称不能变成Git选项，纯读比较不写输出文件", async () => {
  const f = await fixture();
  const remote = "--output=leaked";
  await mkdir(join(f.root, "leaked"));
  await f.setup(["update-ref", `refs/remotes/${remote}/main`, "HEAD"]);
  await f.setup([
    "config",
    "--",
    `remote.${remote}.url`,
    join(f.root, "no-network-fixture"),
  ]);
  await f.setup([
    "config",
    "--",
    `remote.${remote}.fetch`,
    `+refs/heads/*:refs/remotes/${remote}/*`,
  ]);
  await f.setup(["config", "--", "branch.main.remote", remote]);
  await f.setup(["config", "branch.main.merge", "refs/heads/main"]);
  expect(await f.call("getBranchComparison")).toMatchObject({
    result: { baseRef: `${remote}/main`, headRef: "main", changes: [] },
  });
  await expect(
    stat(join(f.root, "leaked", "main...main")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    f.requests
      .filter((args) => args[0] === "diff")
      .every(
        (args) => !args.some((argument) => argument.startsWith("--output=")),
      ),
  ).toBe(true);
});

it("last-turn差异必须走会话入口，graph按skip分页且不多跑写命令", async () => {
  const f = await fixture();
  f.requests.splice(0);
  await expect(
    f.call("getDiff", { path: "tracked.txt", sourceId: "last-turn" }),
  ).rejects.toThrow("上一轮差异必须经真实会话文件变更入口读取。");
  expect(f.requests).toEqual([]);
  await f.setup(["commit", "--allow-empty", "-m", "第二笔"]);
  await f.setup(["commit", "--allow-empty", "-m", "第三笔"]);
  const newest = (await f.call("getCommitGraph", { maxCount: 2, skip: 0 }))
    ?.result as { commits: Array<{ subject: string }>; hasMore: boolean };
  const older = (await f.call("getCommitGraph", { maxCount: 2, skip: 2 }))
    ?.result as { commits: Array<{ subject: string }>; hasMore: boolean };
  expect(newest.commits.map((commit) => commit.subject)).toEqual([
    "第三笔",
    "第二笔",
  ]);
  expect(newest.hasMore).toBe(true);
  expect(older.commits.map((commit) => commit.subject)).toEqual(["测试基线"]);
  expect(older.hasMore).toBe(false);
  expect(
    f.requests.every(
      (args) =>
        !["add", "restore", "clean", "commit", "push", "switch"].includes(
          args[0] ?? "",
        ),
    ),
  ).toBe(true);
});

it("Task作用域对真实仓库暂存、取消暂存与丢弃，未跟踪文件被删除", async () => {
  const f = await fixture();
  await f.call("stagePaths", { paths: ["tracked.txt"] });
  const staged = (
    await f.call("getDiff", { path: "tracked.txt", sourceId: "staged" })
  )?.result as { beforeContent: string | null; afterContent: string | null };
  expect(staged).toMatchObject({
    beforeContent: "base\n",
    afterContent: "unstaged\n",
  });
  await f.call("unstagePaths", { paths: ["tracked.txt"] });
  expect((await f.call("getChanges", { sourceId: "staged" }))?.result).toEqual(
    [],
  );
  expect(await readFile(join(f.root, "tracked.txt"), "utf8")).toBe(
    "unstaged\n",
  );
  await f.call("discardPaths", { paths: ["tracked.txt"] });
  expect(await readFile(join(f.root, "tracked.txt"), "utf8")).toBe("base\n");
  await f.call("discardPaths", { paths: ["new.txt"] });
  await expect(stat(join(f.root, "new.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await writeFile(join(f.root, "tracked.txt"), "staged again\n");
  await f.call("stagePaths", { paths: ["tracked.txt"] });
  await f.call("discardPaths", { paths: ["tracked.txt"], staged: true });
  expect(await readFile(join(f.root, "tracked.txt"), "utf8")).toBe("base\n");
  expect((await f.call("getChanges", { sourceId: "staged" }))?.result).toEqual(
    [],
  );
  await expect(
    f.call("stagePaths", { paths: ["../outside.txt"] }),
  ).rejects.toThrow(/路径/);
});

it("按选中路径提交回读真实哈希，stagedOnly只提交选中已暂存内容", async () => {
  const f = await fixture();
  await f.call("unstagePaths", { paths: ["tracked.txt"] });
  const first = (
    await f.call("commit", { message: "只收选中文件", paths: ["tracked.txt"] })
  )?.result as { commitHash: string; summary: { isDirty: boolean } };
  expect(first.commitHash).toMatch(/^[a-f0-9]{40}$/);
  expect((await f.raw(["rev-parse", "HEAD"])).stdout.trim()).toBe(
    first.commitHash,
  );
  expect(
    (await f.raw(["show", "--pretty=format:", "--name-only", "HEAD"])).stdout
      .split("\n")
      .filter(Boolean),
  ).toEqual(["tracked.txt"]);
  expect(first.summary.isDirty).toBe(true);

  await writeFile(join(f.root, "staged-new.txt"), "first\n");
  await writeFile(join(f.root, "tracked.txt"), "staged version\n");
  await f.call("stagePaths", { paths: ["tracked.txt", "staged-new.txt"] });
  await writeFile(join(f.root, "tracked.txt"), "worktree later\n");
  const second = (
    await f.call("commit", {
      message: "只提交选中暂存",
      paths: ["tracked.txt"],
      stagedOnly: true,
    })
  )?.result as { commitHash: string };
  expect(second.commitHash).toMatch(/^[a-f0-9]{40}$/);
  expect((await f.raw(["show", "HEAD:tracked.txt"])).stdout).toBe(
    "staged version\n",
  );
  expect(
    (await f.raw(["show", "--pretty=format:", "--name-only", "HEAD"])).stdout
      .split("\n")
      .filter(Boolean),
  ).toEqual(["tracked.txt"]);
  expect((await f.raw(["show", "HEAD:staged-new.txt"])).code).not.toBe(0);
  const status = (await f.raw(["status", "--porcelain=v1"])).stdout;
  expect(status).toContain("A  staged-new.txt");
  expect(status).toContain(" M tracked.txt");
  await expect(f.call("commit", { message: "  " })).rejects.toThrow(/提交信息/);
  await expect(
    f.call("commit", {
      message: "没有改动",
      paths: ["tracked.txt"],
      stagedOnly: true,
    }),
  ).rejects.toThrow(/没有可提交/);
});

it("分支创建与切换返回问题码，推送回填远端与上行字段", async () => {
  const f = await fixture();
  const created = (
    await f.call("createBranchAndSwitch", { branchName: "feature/write" })
  )?.result as {
    ok: boolean;
    action: string;
    branchName: string | null;
    didChange: boolean;
    created: boolean;
    issues: Array<{ code: string }>;
    summary: { branchName: string | null };
  };
  expect(created).toMatchObject({
    ok: true,
    action: "create-and-switch",
    branchName: "feature/write",
    didChange: true,
    created: true,
    issues: [],
  });
  expect(created.summary.branchName).toBe("feature/write");
  const duplicate = (
    await f.call("createBranchAndSwitch", { branchName: "feature/write" })
  )?.result as { ok: boolean; issues: Array<{ code: string }> };
  expect(duplicate.ok).toBe(false);
  expect(duplicate.issues[0]?.code).toBe("branch-already-exists");
  const invalid = (
    await f.call("switchBranch", { targetBranchName: "bad name" })
  )?.result as { ok: boolean; issues: Array<{ code: string }> };
  expect(invalid.issues[0]?.code).toBe("invalid-branch-name");
  const missing = (
    await f.call("switchBranch", { targetBranchName: "missing-branch" })
  )?.result as { ok: boolean; issues: Array<{ code: string }> };
  expect(missing.issues[0]?.code).toBe("target-branch-not-found");
  const back = (await f.call("switchBranch", { targetBranchName: "main" }))
    ?.result as {
    ok: boolean;
    didChange: boolean;
    summary: { branchName: string | null };
  };
  expect(back).toMatchObject({ ok: true, didChange: true });
  expect(back.summary.branchName).toBe("main");
  const same = (await f.call("switchBranch", { targetBranchName: "main" }))
    ?.result as { ok: boolean; didChange: boolean };
  expect(same).toMatchObject({ ok: true, didChange: false });

  const worktree = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-host-git-worktree-")),
  );
  roots.push(worktree);
  await f.setup(["worktree", "add", worktree, "-b", "side"]);
  const occupied = (await f.call("switchBranch", { targetBranchName: "side" }))
    ?.result as { ok: boolean; issues: Array<{ code: string }> };
  expect(occupied.issues[0]?.code).toBe("branch-in-other-worktree");
  await f.setup(["worktree", "remove", "--force", worktree]);

  const remoteRoot = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-host-git-remote-")),
  );
  roots.push(remoteRoot);
  await execute(["init", "--bare", remoteRoot], f.root);
  await f.setup(["remote", "add", "origin", remoteRoot]);
  const pushed = (await f.call("push"))?.result as {
    branchName: string | null;
    trackingBranchName: string | null;
    remoteName: string | null;
    setUpstream: boolean;
    summary: { branchName: string | null };
  };
  expect(pushed).toMatchObject({
    branchName: "main",
    trackingBranchName: "origin/main",
    remoteName: "origin",
    setUpstream: true,
  });
  expect(pushed.summary.branchName).toBe("main");
  const again = (await f.call("push"))?.result as { setUpstream: boolean };
  expect(again.setUpstream).toBe(false);

  const bare = await fixture();
  await expect(bare.call("push")).rejects.toThrow(/远端/);
});
