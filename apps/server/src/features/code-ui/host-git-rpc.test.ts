import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceSettingsSchema } from "@kenfutwork/shared";
import { afterEach, expect, it } from "vitest";
import type { ExecGit } from "../code-git/git-client.js";
import { resolveReadOnlyProjectPath } from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";
import { createCodeUiHostGitRpc } from "./host-git-rpc.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const execute: ExecGit = (args, cwd, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8" },
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
    openSession: async () => ({
      rootDirectory: root,
      available,
      limits: instanceSettingsSchema.parse({ defaultModel: "fixture" }),
      resolvePath: (path) =>
        resolveReadOnlyProjectPath(
          { rootDirectory: root, additionalDirectories: [] },
          path,
        ),
      exec: (args, cwd, input) => {
        requests.push(args);
        return execute(args, cwd, input);
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
it("Project不伪造Task，connection与workspace核对；未接通写操作明确拒绝", async () => {
  const f = await fixture();
  await expect(
    f.rpc.call(
      f.actor,
      "getRepositorySummary",
      [
        {
          ...f.params,
          viewerScope: { kind: "project", projectId: f.projectId },
        },
      ],
      f.connection,
    ),
  ).rejects.toThrow(/Task/);
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
  for (const method of [
    "stagePaths",
    "unstagePaths",
    "discardPaths",
    "commit",
    "push",
    "generateCommitMessage",
    "switchBranch",
    "createBranchAndSwitch",
  ])
    await expect(f.call(method)).rejects.toThrow(/尚不支持|未接通/);
  expect(f.requests).toEqual([]);
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
