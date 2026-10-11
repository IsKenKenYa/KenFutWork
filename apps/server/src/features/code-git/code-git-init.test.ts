import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
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
import { createGitClient, type ExecGit, type GitCommandResult } from "./git-client.js";

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
});

/**
 * 测试侧 ExecGit 替身：跑**本机真实 git**（`createGitClient` 的 exec 本就是注入缝，
 * 生产注入 Task 沙箱执行器，测试直接执行以验证 git 行为本身）。
 * 顺带记录 init 调用次数，供幂等断言使用。
 */
function createRealGitExec(): { exec: ExecGit; initCalls: () => number } {
  let initCount = 0;
  const exec: ExecGit = (args, cwd, input) =>
    new Promise<GitCommandResult>((resolve) => {
      if (args[0] === "init") initCount += 1;
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
      ).stdin?.end(input);
    });
  return { exec, initCalls: () => initCount };
}

async function world(options: { readOnly?: boolean; root?: string } = {}) {
  const root =
    options.root ?? (await realpath(await mkdtemp(join(tmpdir(), "kfw-git-init-"))));
  temporary.push(root);
  const identity: CodeExecutionScope = {
    instanceId: INSTANCE_ID,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    generation: 1,
    rootDirectory: root,
    additionalDirectories: [],
    sandboxMode: options.readOnly ? "read-only" : "workspace-write",
  };
  const scopes = createExecutionScopes({
    repository: {
      load: async () => ({ scope: identity, state: "ready", branchGeneration: 1 }),
    },
    localInstance: createRuntimeTestInstance(INSTANCE_ID),
    resolveFileLimits: async () => ({ ...AGENT_GOVERNANCE_DEFAULTS }),
  });
  const { exec, initCalls } = createRealGitExec();
  const service = createCodeGitService({
    scopes,
    gitForScope: async () => createGitClient({ exec }),
    processSandbox: {
      spawn: vi.fn(async () => {
        throw new Error("init 测试不应走终端通道。");
      }),
    } as never,
    source: "system",
    localInstance: createRuntimeTestInstance(INSTANCE_ID),
    settingsService: {
      getInstanceSettings: async () =>
        instanceSettingsSchema.parse({ defaultModel: "test" }),
    },
  });
  return { root, service, initCalls };
}

describe("Code Git init（真实 git）", () => {
  it("普通目录初始化后 .git 存在且状态回到 isRepo", async () => {
    const { root, service } = await world();
    const status = await service.init(ACTOR, TASK_ID);
    const gitDir = await stat(join(root, ".git"));
    expect(gitDir.isDirectory()).toBe(true);
    expect(status.isRepo).toBe(true);
  });

  it("重复 init 幂等：不再下发 git init，也不报错", async () => {
    const { service, initCalls } = await world();
    await service.init(ACTOR, TASK_ID);
    const firstPass = initCalls();
    const status = await service.init(ACTOR, TASK_ID);
    expect(initCalls()).toBe(firstPass);
    expect(status.isRepo).toBe(true);
  });

  it("无写权限（只读 Task 作用域）在下发 git 前拒绝并给可读原因", async () => {
    const { service, initCalls } = await world({ readOnly: true });
    await expect(service.init(ACTOR, TASK_ID)).rejects.toMatchObject({
      code: "read_only",
    });
    expect(initCalls()).toBe(0);
  });

  it("目录不可用（.git 被同名文件占用）时给可读中文原因", async () => {
    const outer = await realpath(await mkdtemp(join(tmpdir(), "kfw-git-block-")));
    temporary.push(outer);
    const root = join(outer, "blocked");
    await mkdir(root);
    // `.git` 是普通文件时 `git init` 无法建目录：这是跨平台都成立的「init 失败」真实现。
    await writeFile(join(root, ".git"), "占位");
    const { service } = await world({ root });
    await expect(service.init(ACTOR, TASK_ID)).rejects.toMatchObject({
      code: "git_write_failed",
      statusCode: 409,
    });
  });
});
