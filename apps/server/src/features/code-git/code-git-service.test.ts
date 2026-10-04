import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  type CodeExecutionScope,
  workspaceSettingsSchema,
} from "@kenfutwork/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/types.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import type {
  ManagedProcess,
  ProcessSandbox,
} from "../process-sandbox/types.js";
import { createCodeGitService } from "./code-git-service.js";
import type { GitClient, GitRepoView } from "./git-client.js";

const WORKSPACE_ID = "2cdb5c27-a1f7-4109-9927-40e0b0822956";
const PROJECT_ID = "c15b75a5-b7ef-46b5-8b0c-d543dd7769d5";
const TASK_ID = "0432143f-e2b8-4ea6-adea-01f706f537d3";
const ACTOR: AuthenticatedUser = {
  id: "actor",
  email: "actor@example.test",
  accessToken: "private",
  userMetadata: {},
};
const view: GitRepoView = {
  isRepo: true,
  branch: "main",
  branches: [{ name: "main", current: true }],
  dirty: false,
};
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function world(
  options: {
    readOnly?: boolean;
    unavailable?: boolean;
    missingTask?: boolean;
    rangeEmpty?: boolean;
    patchMaxBytes?: number;
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kfw-git-scope-")));
  temporary.push(root);
  const extra = await realpath(await mkdtemp(join(tmpdir(), "kfw-git-extra-")));
  temporary.push(extra);
  const identity: CodeExecutionScope = {
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    generation: 1,
    rootDirectory: root,
    additionalDirectories: [{ path: extra, access: "read-only" }],
    sandboxMode: options.readOnly ? "read-only" : "workspace-write",
  };
  const scopes = createExecutionScopes({
    repository: {
      load: async () =>
        options.missingTask
          ? null
          : { scope: identity, state: "ready", branchGeneration: 1 },
    },
    viewerService: {
      resolveWorkspace: vi.fn(
        async () => ({ id: identity.workspaceId }) as never,
      ),
    },
    resolveFileLimits: async () => ({
      ...AGENT_GOVERNANCE_DEFAULTS,
      codePatchMaxBytes:
        options.patchMaxBytes ?? AGENT_GOVERNANCE_DEFAULTS.codePatchMaxBytes,
    }),
  });
  const git: GitClient = {
    checkout: vi.fn(async () => {}),
    init: vi.fn(async () => {}),
    describe: vi.fn(async () => view),
    diffStat: vi.fn(async () => ({
      files: 0,
      additions: 0,
      deletions: 0,
      untracked: 0,
    })),
    commitAll: vi.fn(async () => {}),
    push: vi.fn(async () => {}),
    createBranch: vi.fn(async () => {}),
    graph: vi.fn(async () => ({ entries: [], truncated: false })),
    changedFiles: vi.fn(async () => ({ files: [], truncated: false })),
    fileDiff: vi.fn(async () => ""),
    stageFile: vi.fn(async () => {}),
    applyHunk: vi.fn(async () => {}),
    discardFile: vi.fn(async () => {}),
    discardAll: vi.fn(async () => {}),
  };
  const process = {
    id: "process",
    endStdin: vi.fn(async () => {}),
    waitForExit: vi.fn(async () => ({
      exitCode: 7,
      rangeEmpty: options.rangeEmpty !== false,
      signal: null,
      reason: null,
      stopped: false,
    })),
    readOutput: vi.fn(async () => ({
      data: "command output",
      nextOffset: 14,
      done: true,
    })),
    snapshot: vi.fn(() => ({ discardedBytes: 0 })),
  } as unknown as ManagedProcess;
  const sandbox = {
    spawn: vi.fn(async () => process),
  } as unknown as ProcessSandbox;
  const service = createCodeGitService({
    scopes,
    gitForScope: vi.fn(async () => git),
    processSandbox: sandbox,
    source: options.unavailable ? "unavailable" : "system",
    viewerService: {
      resolveWorkspace: async () => ({ id: identity.workspaceId }) as never,
    },
    settingsService: {
      getWorkspaceSettings: async () =>
        workspaceSettingsSchema.parse({ defaultModel: "test" }),
    },
    availableShells: [{ id: "bash", label: "Bash", executable: "/bin/bash" }],
  });
  return { root, extra, identity, scopes, git, sandbox, process, service };
}
describe("Code Git Task scope", () => {
  it("状态/图谱/提交使用 Task 创建时绑定目录，不引用 Canvas", async () => {
    const { service, root, git } = await world();
    expect((await service.status(ACTOR, TASK_ID)).branch).toBe("main");
    await service.graph(ACTOR, TASK_ID, 12);
    await service.commit(ACTOR, TASK_ID, "完成一轮");
    expect(git.describe).toHaveBeenCalledWith(root);
    expect(git.graph).toHaveBeenCalledWith(root, 12);
    expect(git.commitAll).toHaveBeenCalledWith(root, "完成一轮");
  });
  it("他人/删除 Task 在下发 Git 命令前拒绝", async () => {
    const { service, git } = await world({ missingTask: true });
    await expect(service.status(ACTOR, TASK_ID)).rejects.toMatchObject({
      code: "task_not_found",
      statusCode: 404,
    });
    expect(git.describe).not.toHaveBeenCalled();
  });
  it("只读 Scope 禁止 checkout/init/提交及撤销", async () => {
    const { service, git } = await world({ readOnly: true });
    for (const action of [
      () => service.checkout(ACTOR, TASK_ID, "next"),
      () => service.init(ACTOR, TASK_ID),
      () => service.commit(ACTOR, TASK_ID, "x"),
      () => service.discardAllChanges(ACTOR, TASK_ID),
    ])
      await expect(action()).rejects.toMatchObject({ code: "read_only" });
    expect(git.checkout).not.toHaveBeenCalled();
    expect(git.init).not.toHaveBeenCalled();
    expect(git.commitAll).not.toHaveBeenCalled();
  });
  it("文件读取支持明确额外目录；范围外路径拒绝", async () => {
    const { service, extra, root } = await world();
    await writeFile(join(extra, "notes.txt"), "只读资料");
    expect(
      (await service.readFile(ACTOR, TASK_ID, join(extra, "notes.txt")))
        .content,
    ).toBe("只读资料");
    await expect(
      service.readFile(ACTOR, TASK_ID, join(root, "..", "outside.txt")),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  it("暂存拒绝只读额外目录与路径越界，合法文件进同仓库", async () => {
    const { service, extra, git, root } = await world();
    await service.setFileStaged(ACTOR, TASK_ID, "file.ts", true);
    expect(git.stageFile).toHaveBeenCalledWith(root, "file.ts", true);
    await expect(
      service.setFileStaged(ACTOR, TASK_ID, join(extra, "file.ts"), true),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      service.setFileStaged(ACTOR, TASK_ID, "../outside.ts", true),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(git.stageFile).toHaveBeenCalledTimes(1);
  });
  it("单文件Git补丁服从治理字节预算，超限在下发Git前拒绝", async () => {
    const { service, git } = await world({ patchMaxBytes: 1024 });
    await expect(
      service.applyFileHunk(ACTOR, TASK_ID, "file.ts", "x".repeat(1025)),
    ).rejects.toThrow("补丁超过工作区字节预算");
    expect(git.applyHunk).not.toHaveBeenCalled();
    const patch =
      "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n";
    await expect(
      service.applyFileHunk(ACTOR, TASK_ID, "file.ts", patch),
    ).resolves.toEqual({ path: "file.ts", applied: true });
    expect(git.applyHunk).toHaveBeenCalledTimes(1);
  });
  it("非仓库状态保留空视图；缺 Git 的写请求 fail loud", async () => {
    const available = await world();
    vi.mocked(available.git.describe).mockResolvedValue({
      ...view,
      isRepo: false,
    });
    expect(await available.service.graph(ACTOR, TASK_ID, 10)).toEqual({
      isRepo: false,
      entries: [],
      truncated: false,
    });
    const unavailable = await world({ unavailable: true });
    await expect(
      unavailable.service.commit(ACTOR, TASK_ID, "x"),
    ).rejects.toMatchObject({ code: "git_unavailable", statusCode: 503 });
    expect(unavailable.git.commitAll).not.toHaveBeenCalled();
  });
  it("用户终端同样经 ProcessSandbox，EOF 后等待真实退出并保留退出码", async () => {
    const { service, root, sandbox, process, identity } = await world();
    const result = await service.runTerminal(ACTOR, TASK_ID, "echo hi", "bash");
    expect(sandbox.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: identity,
        cwd: root,
        command: "echo hi",
        shell: "/bin/bash",
        background: false,
      }),
    );
    expect(process.endStdin).toHaveBeenCalledTimes(1);
    expect(process.waitForExit).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("command output");
  });
  it("终端进程范围尚未清空不能报告成功", async () => {
    const { service } = await world({ rangeEmpty: false });
    await expect(
      service.runTerminal(ACTOR, TASK_ID, "echo hi", "bash"),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
  it("Git 撤销之外的只读查询不修改用户文件", async () => {
    const { service, root } = await world();
    const path = join(root, "file.txt");
    await writeFile(path, "unchanged");
    await service.listFiles(ACTOR, TASK_ID, ".");
    await service.status(ACTOR, TASK_ID);
    expect(await readFile(path, "utf8")).toBe("unchanged");
  });
});
