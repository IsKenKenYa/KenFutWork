import { describe, expect, it, vi } from "vitest";

import { resolveSandboxDir } from "../../agent/sandbox-dir.js";
import type { AuthenticatedUser } from "../auth/types.js";
import {
  CodeGitError,
  createCodeGitService,
  type GitSource,
} from "./code-git-service.js";
import type { GitClient, GitRepoView } from "./git-client.js";

const USER = {
  accessToken: "t",
  email: "u@e.com",
  id: "u1",
  userMetadata: {},
} as AuthenticatedUser;
const WORKSPACE = { id: "ws-1" } as never;
const CANVAS_ID = "beb5095b-de61-4b3e-a376-501b9905344c";

const REPO_VIEW: GitRepoView = {
  isRepo: true,
  branch: "main",
  branches: [
    { name: "main", current: true },
    { name: "next", current: false },
  ],
  dirty: false,
};

function build(options: {
  canvasFound?: boolean;
  git?: Partial<GitClient>;
  source?: GitSource;
  canvasWorkDirs?: Record<string, string>;
}) {
  const git: GitClient = {
    checkout: vi.fn(async () => {}),
    describe: vi.fn(async () => REPO_VIEW),
    ...options.git,
  };
  const findById = vi.fn(async () =>
    options.canvasFound === false ? null : ({ id: CANVAS_ID } as never),
  );
  const resolveWorkspace = vi.fn(async () => WORKSPACE);
  const service = createCodeGitService({
    canvasRepository: { findById },
    git,
    source: options.source ?? "system",
    ...(options.canvasWorkDirs
      ? { canvasWorkDirs: options.canvasWorkDirs }
      : {}),
    viewerService: { resolveWorkspace },
  });
  return { findById, git, resolveWorkspace, service };
}

describe("Code git 服务", () => {
  it("状态：返回仓库视图，并把 source 透给界面", async () => {
    const { service, git } = build({ source: "bundled" });
    const status = await service.status(USER, CANVAS_ID);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.source).toBe("bundled");
    expect(git.describe).toHaveBeenCalledTimes(1);
  });

  /**
   * 越权边界：沙箱目录名就是画布 id（可枚举），若不做归属校验，任何登录用户凭一个
   * uuid 就能读别人的工作目录仓库状态。这里锁死「不可见即 404，且**不下发 git 命令**」。
   */
  it("越权：画布不属于当前工作区 → 404，且不执行任何 git 命令", async () => {
    const { service, git } = build({ canvasFound: false });
    await expect(service.status(USER, CANVAS_ID)).rejects.toMatchObject({
      code: "not_found",
      statusCode: 404,
    });
    expect(git.describe).not.toHaveBeenCalled();
  });

  it("工作区解析失败 → 404，同样不下发 git 命令", async () => {
    const { git } = build({});
    const failing = createCodeGitService({
      canvasRepository: { findById: vi.fn() },
      git,
      source: "system",
      viewerService: {
        resolveWorkspace: vi.fn(async () => {
          throw new Error("no workspace");
        }),
      } as never,
    });
    await expect(failing.status(USER, CANVAS_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(git.describe).not.toHaveBeenCalled();
  });

  /**
   * 目录来源必须与 agent 后端同处：否则「git 切的分支目录」不是「agent 读写文件的目录」，
   * 用户会看到切了分支但文件没变。
   */
  it("git 命令跑在 resolveSandboxDir(canvasId) 上（与 agent 工作目录同处）", async () => {
    const { service, git } = build({});
    await service.status(USER, CANVAS_ID);
    expect(git.describe).toHaveBeenCalledWith(resolveSandboxDir(CANVAS_ID));
  });

  /**
   * 真实目录映射（产品决策 2026-09-14）：git 操作必须与 agent 一起落到映射后的
   * 真实目录，否则「界面看分支状态」与「agent 实际工作目录」再次分叉。
   */
  it("画布命中真实目录映射时，git 命令跑映射目录而非沙箱根", async () => {
    const mapped = "D:\\Desktop\\test";
    const { service, git } = build({
      canvasWorkDirs: { [CANVAS_ID]: mapped },
    });
    await service.status(USER, CANVAS_ID);
    expect(git.describe).toHaveBeenCalledWith(resolveSandboxDir(CANVAS_ID, undefined, mapped));
  });

  it("切换分支：成功后回读新状态", async () => {
    const checkout = vi.fn(async () => {});
    const describe = vi.fn(async () => REPO_VIEW);
    const { service } = build({ git: { checkout, describe } });
    await service.checkout(USER, CANVAS_ID, "next");
    expect(checkout).toHaveBeenCalledWith(resolveSandboxDir(CANVAS_ID), "next");
    expect(describe).toHaveBeenCalledTimes(1);
  });

  it("git 不可用：切分支给 503 且说清原因（不是空下拉）", async () => {
    const { service, git } = build({ source: "unavailable" });
    await expect(
      service.checkout(USER, CANVAS_ID, "next"),
    ).rejects.toMatchObject({
      code: "git_unavailable",
      statusCode: 503,
    });
    expect(git.checkout).not.toHaveBeenCalled();
  });

  it("切换失败：把 git 的可读原因折成 409", async () => {
    const { service } = build({
      git: {
        checkout: vi.fn(async () => {
          throw new Error("error: Your local changes would be overwritten");
        }),
      },
    });
    const error = await service
      .checkout(USER, CANVAS_ID, "next")
      .catch((e: unknown) => e as CodeGitError);
    expect(error).toBeInstanceOf(CodeGitError);
    expect((error as CodeGitError).statusCode).toBe(409);
    expect((error as CodeGitError).message).toMatch(/local changes/);
  });
});
