import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  type CodeExecutionScope,
  instanceSettingsSchema,
} from "@kenfutwork/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeTestInstance } from "../../agent/runtime-test-fixtures.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";
import { createCodeGitService } from "./code-git-service.js";
import {
  createGitClient,
  type ExecGit,
  type GitCommandResult,
  toAutoCommitMessage,
} from "./git-client.js";

const INSTANCE_ID = "2cdb5c27-a1f7-4109-9927-40e0b0822956";
const PROJECT_ID = "c15b75a5-b7ef-46b5-8b0c-d543dd7769d5";
const TASK_ID = "0432143f-e2b8-4ea6-adea-01f706f537d3";
const ACTOR: LocalActor = {
  instanceId: INSTANCE_ID,
  accessClientId: "00000000-0000-4000-8000-000000000009",
};
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 8 })),
  );
  vi.restoreAllMocks();
});

function run(
  cwd: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
      (error, stdout, stderr) => {
        const exitCode = (error as { code?: unknown } | null)?.code;
        resolve({
          code: typeof exitCode === "number" ? exitCode : error ? 1 : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

/** 测试侧 ExecGit：跑本机真实 git（生产注入 Task 沙箱执行器，测试验证 git 行为本身）。 */
const realExec: ExecGit = async (args, cwd, _input) => {
  const result = await run(cwd, args);
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
};

/** 初始化一个有基准提交的仓库（显式配置身份，不依赖机器全局 git config）。 */
async function initRepo(root: string) {
  await run(root, ["init"]);
  await run(root, ["config", "user.email", "auto-commit@test.local"]);
  await run(root, ["config", "user.name", "Auto Commit Test"]);
  await writeFile(join(root, "README.md"), "base\n");
  await run(root, ["add", "-A"]);
  await run(root, ["commit", "-m", "基准提交"]);
}

async function lastSubject(root: string): Promise<string | null> {
  const log = await run(root, ["log", "-1", "--pretty=%s"]);
  return log.code === 0 ? log.stdout.trim() : null;
}

async function commitCount(root: string): Promise<number> {
  const log = await run(root, ["rev-list", "--count", "HEAD"]);
  return log.code === 0 ? Number(log.stdout.trim()) : 0;
}

/**
 * 装配真实作用域 + 可注入设置的 CodeGitService。
 * `execOverride` 在真实 git 执行**之前**判定：返回合成结果即跳过真实执行
 * （模拟 index.lock 碰撞 / 干净竞态——不能「先真跑再把结果翻成失败」，真实提交会落盘）。
 */
async function world(
  options: {
    codeAutoCommitEnabled?: boolean;
    execOverride?: (args: readonly string[]) => GitCommandResult | undefined;
  } = {},
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-git-autocommit-")),
  );
  temporary.push(root);
  const identity: CodeExecutionScope = {
    instanceId: INSTANCE_ID,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    rootDirectory: root,
    additionalDirectories: [],
    sandboxMode: "workspace-write",
    generation: 1,
  };
  const scopes = createExecutionScopes({
    repository: {
      load: async () => ({
        scope: identity,
        state: "ready",
        branchGeneration: 1,
      }),
    },
    localInstance: createRuntimeTestInstance(INSTANCE_ID),
    resolveFileLimits: async () => ({ ...AGENT_GOVERNANCE_DEFAULTS }),
  });
  const override = options.execOverride;
  const exec: ExecGit = async (args, cwd, input) =>
    (override?.(args) as GitCommandResult | undefined) ??
    realExec(args, cwd, input);
  const service = createCodeGitService({
    scopes,
    gitForScope: async () => createGitClient({ exec }),
    processSandbox: {
      spawn: vi.fn(async () => {
        throw new Error("自动提交测试不应走终端通道。");
      }),
    } as never,
    source: "system",
    localInstance: createRuntimeTestInstance(INSTANCE_ID),
    settingsService: {
      getInstanceSettings: async () =>
        instanceSettingsSchema.parse({
          defaultModel: "test",
          ...(options.codeAutoCommitEnabled === undefined
            ? {}
            : { codeAutoCommitEnabled: options.codeAutoCommitEnabled }),
        }),
    },
  });
  return { root, service };
}

describe("toAutoCommitMessage（porcelain 摘要纯函数）", () => {
  const status = (stdout: string): GitCommandResult => ({
    code: 0,
    stdout,
    stderr: "",
  });

  it("修改类变更列出文件名与数量", () => {
    expect(toAutoCommitMessage(status(" M a.ts\n M b.ts\n M c.ts\n"))).toBe(
      "自动提交：修改 3 个文件（a.ts、b.ts、c.ts）",
    );
  });

  it("全部新增（含未跟踪）用「新增」", () => {
    expect(toAutoCommitMessage(status("?? a.ts\nA  b.ts\n"))).toBe(
      "自动提交：新增 2 个文件（a.ts、b.ts）",
    );
  });

  it("超过 3 个文件只列 3 个代表名并以「等」收尾", () => {
    expect(
      toAutoCommitMessage(status(" M a.ts\n M b.ts\n?? c.ts\n M d.ts\n")),
    ).toBe("自动提交：修改 4 个文件（a.ts、b.ts、c.ts 等）");
  });

  it("重命名认新路径；删除计入修改", () => {
    expect(
      toAutoCommitMessage(status("R  old.ts -> new.ts\n D gone.ts\n")),
    ).toBe("自动提交：修改 2 个文件（gone.ts、new.ts）");
  });

  it("干净工作区返回 null", () => {
    expect(toAutoCommitMessage(status(""))).toBeNull();
  });
});

describe("CodeGitService.autoCommitRun（真实 git）", () => {
  it("run 终态钩子提交全部变更，信息含文件名", async () => {
    const { root, service } = await world();
    await initRepo(root);
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "b.ts"), "export const b = 2;\n");
    await writeFile(join(root, "README.md"), "base\n改动\n");

    await service.autoCommitRun(ACTOR, TASK_ID);

    expect(await commitCount(root)).toBe(2);
    expect(await lastSubject(root)).toBe(
      "自动提交：修改 3 个文件（README.md、a.ts、b.ts）",
    );
    // 提交后工作区干净
    const clean = await run(root, ["status", "--porcelain"]);
    expect(clean.stdout.trim()).toBe("");
  });

  it("未跟踪文件也进自动提交（全部新增口径）", async () => {
    const { root, service } = await world();
    await initRepo(root);
    await writeFile(join(root, "new-1.ts"), "1\n");
    await writeFile(join(root, "new-2.ts"), "2\n");

    await service.autoCommitRun(ACTOR, TASK_ID);

    expect(await lastSubject(root)).toBe(
      "自动提交：新增 2 个文件（new-1.ts、new-2.ts）",
    );
  });

  it("开关关闭时不提交", async () => {
    const { root, service } = await world({ codeAutoCommitEnabled: false });
    await initRepo(root);
    await writeFile(join(root, "a.ts"), "1\n");

    await service.autoCommitRun(ACTOR, TASK_ID);

    expect(await commitCount(root)).toBe(1);
  });

  it("非仓库静默跳过：不提交也不自动 init", async () => {
    const { root, service } = await world();
    await writeFile(join(root, "a.ts"), "1\n");

    await expect(
      service.autoCommitRun(ACTOR, TASK_ID),
    ).resolves.toBeUndefined();

    const dir = await run(root, ["rev-parse", "--is-inside-work-tree"]);
    expect(dir.code).not.toBe(0);
  });

  it("干净工作区静默跳过：不追加提交", async () => {
    const { root, service } = await world();
    await initRepo(root);

    await service.autoCommitRun(ACTOR, TASK_ID);

    expect(await commitCount(root)).toBe(1);
  });

  it("git 失败重试一次仍失败：warn 可检索且不抛（不阻塞终态）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { root, service } = await world({
      execOverride: (args) =>
        args[0] === "commit"
          ? {
              code: 1,
              stdout: "",
              stderr: "fatal: Unable to create index.lock",
            }
          : undefined,
    });
    await initRepo(root);
    await writeFile(join(root, "a.ts"), "1\n");

    await expect(
      service.autoCommitRun(ACTOR, TASK_ID),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("auto_commit");
    expect(await commitCount(root)).toBe(1);
  });

  it("与用户手速并发（index.lock）重试一次可成功", async () => {
    let commitAttempts = 0;
    const { root, service } = await world({
      execOverride: (args) => {
        if (args[0] !== "commit") return undefined;
        commitAttempts += 1;
        return commitAttempts === 1
          ? {
              code: 1,
              stdout: "",
              stderr: "fatal: Unable to create index.lock",
            }
          : undefined;
      },
    });
    await initRepo(root);
    await writeFile(join(root, "a.ts"), "1\n");

    await service.autoCommitRun(ACTOR, TASK_ID);

    expect(commitAttempts).toBe(2);
    expect(await commitCount(root)).toBe(2);
    // 首次尝试已把新文件暂存，重试的 porcelain 是 `A  a.ts`——按新增口径
    expect(await lastSubject(root)).toBe("自动提交：新增 1 个文件（a.ts）");
  });

  it("并发窗口里别人先提交干净：视作跳过不 warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { root, service } = await world({
      execOverride: (args) =>
        args[0] === "commit"
          ? {
              code: 1,
              stdout: "",
              stderr: "nothing to commit, working tree clean",
            }
          : undefined,
    });
    await initRepo(root);
    await writeFile(join(root, "a.ts"), "1\n");

    await expect(
      service.autoCommitRun(ACTOR, TASK_ID),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
