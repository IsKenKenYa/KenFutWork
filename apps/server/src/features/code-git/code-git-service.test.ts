import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkspaceSettings } from "@kenfutwork/shared";
import { afterAll, describe, expect, it, vi } from "vitest";
import { resolveSandboxDir } from "../../agent/sandbox-dir.js";
import type { AuthenticatedUser } from "../auth/types.js";
import {
  CodeGitError,
  createCodeGitService,
  type GitSource,
  validateWorktreePath,
} from "./code-git-service.js";
import type { GitClient, GitRepoView } from "./git-client.js";
import {
  detectTerminalShells,
  type TerminalShellOption,
} from "./terminal-runner.js";

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
  settingsService?: {
    getWorkspaceSettings: (
      user: AuthenticatedUser,
      workspaceId: string,
    ) => Promise<WorkspaceSettings>;
  };
  availableShells?: TerminalShellOption[];
  /** 项目绑定的本机工作目录（`projects.work_dir`）桩：按画布返回路径。 */
  boundWorkDirs?: Record<string, string>;
}) {
  const git: GitClient = {
    listWorktrees: vi.fn(async () => []),
    addWorktree: vi.fn(async () => {}),
    removeWorktree: vi.fn(async () => {}),
    checkout: vi.fn(async () => {}),
    init: vi.fn(async () => {}),
    describe: vi.fn(async () => REPO_VIEW),
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
    ...(options.boundWorkDirs
      ? {
          projectRepository: {
            findWorkDirByCanvas: async (
              _workspaceId: string,
              canvasId: string,
            ) => options.boundWorkDirs?.[canvasId] ?? null,
          },
        }
      : {}),
    viewerService: { resolveWorkspace },
    ...(options.settingsService
      ? { settingsService: options.settingsService }
      : {}),
    ...(options.availableShells
      ? { availableShells: options.availableShells }
      : {}),
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
    expect(git.describe).toHaveBeenCalledWith(
      resolveSandboxDir(CANVAS_ID, undefined, mapped),
    );
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

/**
 * 「每次对话用 git 跟踪」的前置：非仓库目录要能一键初始化，且**幂等**
 * （已是仓库时不重复 init）。
 */
describe("git init（工作目录初始化仓库）", () => {
  it("非仓库时调用 git init；已是仓库时跳过", async () => {
    const notRepo = build({
      git: { describe: vi.fn(async () => ({ ...REPO_VIEW, isRepo: false })) },
    });
    await notRepo.service.init(USER, CANVAS_ID);
    expect(notRepo.git.init).toHaveBeenCalledTimes(1);

    const repo = build({});
    await repo.service.init(USER, CANVAS_ID);
    expect(repo.git.init).not.toHaveBeenCalled();
  });

  it("git 不可用时如实拒绝（不静默）", async () => {
    const { service } = build({ source: "unavailable" });
    await expect(service.init(USER, CANVAS_ID)).rejects.toThrow(/git/i);
  });
});

/**
 * Git 图谱（R2-1 条目 6）。
 *
 * 关键是**把「状态」与「故障」分开**：非仓库、仓库还没有提交都不是错误，
 * 界面要拿到 isRepo 去显示初始化引导 / 「还没有提交」；抛错会把状态说成故障。
 */
describe("Git 图谱", () => {
  const GRAPH = {
    entries: [
      {
        rail: "* ",
        sha: "abc1234full",
        shortSha: "abc1234",
        subject: "第一轮",
        author: "t",
        date: "2026-09-16T00:00:00+08:00",
        refs: ["HEAD -> main"],
        parents: [],
      },
    ],
    truncated: false,
  };

  it("仓库：转发图形行与截断标记", async () => {
    const graphFn = vi.fn(async () => GRAPH);
    const { service } = build({ git: { graph: graphFn } });
    const graph = await service.graph(USER, CANVAS_ID, 30);
    expect(graph).toEqual({ isRepo: true, ...GRAPH });
    expect(graphFn).toHaveBeenCalledWith(resolveSandboxDir(CANVAS_ID), 30);
  });

  it("非仓库：返回 isRepo=false 且不下发 log 命令", async () => {
    const graphFn = vi.fn(async () => GRAPH);
    const { service } = build({
      git: {
        describe: vi.fn(async () => ({ ...REPO_VIEW, isRepo: false })),
        graph: graphFn,
      },
    });
    expect(await service.graph(USER, CANVAS_ID, 30)).toEqual({
      isRepo: false,
      entries: [],
      truncated: false,
    });
    expect(graphFn).not.toHaveBeenCalled();
  });

  it("越权：画布不属于当前工作区 → 404，且不下发任何 git 命令", async () => {
    const graphFn = vi.fn(async () => GRAPH);
    const { service, git } = build({
      canvasFound: false,
      git: { graph: graphFn },
    });
    await expect(service.graph(USER, CANVAS_ID, 30)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(graphFn).not.toHaveBeenCalled();
    expect(git.describe).not.toHaveBeenCalled();
  });
});

/**
 * 变更清单 / 单文件差异 / 单文件内容（R3-2，文件读取同时服务 R3-3 的文档入口）。
 */
describe("变更清单与文件查看", () => {
  const root = mkdtempSync(join(tmpdir(), "kfw-code-git-"));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const CHANGED = {
    files: [
      {
        path: "app.ts",
        additions: 3,
        deletions: 1,
        binary: false,
        status: "modified" as const,
        staged: true,
      },
      {
        path: "draft.md",
        additions: 0,
        deletions: 0,
        binary: false,
        status: "untracked" as const,
        staged: false,
      },
    ],
    truncated: false,
  };

  it("项目绑定本机工作目录（projects.work_dir）：终端/git 落点跟着走，且优先于环境变量映射", async () => {
    const bound = mkdtempSync(join(tmpdir(), "kfw-bound-"));
    const envMapped = mkdtempSync(join(tmpdir(), "kfw-envmapped-"));
    const { service } = build({
      boundWorkDirs: { [CANVAS_ID]: bound },
      canvasWorkDirs: { [CANVAS_ID]: envMapped },
    });

    expect(await service.terminalWorkDir(USER, CANVAS_ID)).toBe(resolve(bound));
    expect((await service.indexScope(USER, CANVAS_ID)).dir).toBe(
      resolve(bound),
    );

    const unbound = build({ canvasWorkDirs: { [CANVAS_ID]: envMapped } });
    expect(await unbound.service.terminalWorkDir(USER, CANVAS_ID)).toBe(
      resolve(envMapped),
    );
  });

  it("绑定目录读取失败时回落环境变量映射（绑定是增强，不是前置条件）", async () => {
    const envMapped = mkdtempSync(join(tmpdir(), "kfw-fallback-"));
    const { service } = build({
      canvasWorkDirs: { [CANVAS_ID]: envMapped },
      boundWorkDirs: {},
    });
    // 桩里空表返回 null（等价于未绑定），不该抛错
    expect(await service.terminalWorkDir(USER, CANVAS_ID)).toBe(
      resolve(envMapped),
    );
  });

  it("变更清单：仓库给逐文件清单，非仓库给空清单 + isRepo=false（状态不是故障）", async () => {
    const repo = build({
      git: { changedFiles: vi.fn(async () => CHANGED) },
      canvasWorkDirs: { [CANVAS_ID]: root },
    });
    expect(await repo.service.changes(USER, CANVAS_ID, 200)).toEqual({
      isRepo: true,
      ...CHANGED,
    });

    const notRepo = build({
      git: { describe: vi.fn(async () => ({ ...REPO_VIEW, isRepo: false })) },
    });
    expect(await notRepo.service.changes(USER, CANVAS_ID, 200)).toEqual({
      isRepo: false,
      files: [],
      truncated: false,
    });
  });

  it("未跟踪文件的「审查」：合成「按新增行」视图并标 untracked（diff HEAD 对它是空的）", async () => {
    writeFileSync(join(root, "draft.md"), "第一行\n第二行\n", "utf8");
    const { service } = build({
      git: { changedFiles: vi.fn(async () => CHANGED) },
      canvasWorkDirs: { [CANVAS_ID]: root },
    });

    const diff = await service.fileDiff(USER, CANVAS_ID, "draft.md");
    expect(diff.untracked).toBe(true);
    // 文件尾的换行不该画成一行孤零零的 `+`
    expect(diff.text).toBe("+第一行\n+第二行");
  });

  it("已跟踪文件的「审查」：透传 git 的 diff", async () => {
    const { service } = build({
      git: {
        changedFiles: vi.fn(async () => CHANGED),
        fileDiff: vi.fn(async () => "diff --git a/app.ts b/app.ts\n+1"),
      },
      canvasWorkDirs: { [CANVAS_ID]: root },
    });
    const diff = await service.fileDiff(USER, CANVAS_ID, "app.ts");
    expect(diff.untracked).toBe(false);
    expect(diff.text).toContain("diff --git");
  });

  it("「打开」：读到文件内容；越界路径折成 400 可读原因", async () => {
    writeFileSync(join(root, "AGENTS.md"), "# 指南\n", "utf8");
    const { service } = build({ canvasWorkDirs: { [CANVAS_ID]: root } });

    const file = await service.readFile(USER, CANVAS_ID, "AGENTS.md");
    expect(file.content).toBe("# 指南\n");

    await expect(
      service.readFile(USER, CANVAS_ID, "../secret.txt"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

/**
 * 终端 shell（用户口径：「终端应该是直连 cmd 或者 powershell、git-bash 等等，可以在设置里
 * 配置默认的」）：默认值来自工作区设置，本次显式选的优先；命令行实际交给选中的 shell。
 */
describe("终端 shell 解析", () => {
  const shells: TerminalShellOption[] = [
    { id: "cmd", label: "cmd", executable: "cmd.exe" },
    {
      id: "powershell",
      label: "Windows PowerShell",
      executable: "powershell.exe",
    },
  ];

  it("清单与默认值：读工作区设置，读不到落 auto", async () => {
    const { service } = build({
      availableShells: shells,
      settingsService: {
        getWorkspaceSettings: async () => ({
          agentMaxRetries: 10,
          defaultModel: "inst-1:glm-5.3-flash",
          terminalShell: "powershell",
          codeIndexEnabled: false,
          codeIndexAutoNewFolder: false,
          autoCompactEnabled: false,
          commands: [],
          hooks: [],
          userRules: "",
          ruleEntries: [],
          subagentMaxDepth: 1,
          subagentMaxConcurrency: 4,
          llmRequestMaxRetries: 10,
          llmInfiniteRetry: false,
          executeTimeoutMs: 120000,
          subagentMaxContinuations: 50,
        }),
      },
    });
    await expect(service.listTerminalShells(USER)).resolves.toEqual({
      shells,
      defaultShell: "powershell",
      resolvedShell: "powershell",
    });

    const { service: noSettings } = build({ availableShells: shells });
    // auto：解析成**系统默认终端**（Windows 上有 PowerShell 就用它，不再落 cmd）
    await expect(noSettings.listTerminalShells(USER)).resolves.toEqual({
      shells,
      defaultShell: "auto",
      resolvedShell:
        process.platform === "win32"
          ? shells.find((s) => s.id === "powershell")?.id
          : shells[0]?.id,
    });
  });

  it("设置读取失败不打断：落 auto，而不是把终端整个打不开", async () => {
    const { service } = build({
      availableShells: shells,
      settingsService: {
        getWorkspaceSettings: async () => {
          throw new Error("boom");
        },
      },
    });
    await expect(service.listTerminalShells(USER)).resolves.toEqual({
      shells,
      defaultShell: "auto",
      resolvedShell:
        process.platform === "win32"
          ? shells.find((s) => s.id === "powershell")?.id
          : shells[0]?.id,
    });
  });

  it("本次显式选的 shell 优先于设置默认（命令确实在那条 shell 里跑）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kfw-cg-shell-"));
    try {
      const { service } = build({
        canvasWorkDirs: { [CANVAS_ID]: dir },
      });
      const result = await service.runTerminal(
        USER,
        CANVAS_ID,
        "echo kfw-shell",
        "auto",
      );
      // auto 解析到的是系统默认终端（本机探测结果），不再是写死的 cmd / sh
      expect(result.shell).not.toBe("auto");
      expect(detectTerminalShells().some((s) => s.id === result.shell)).toBe(
        true,
      );
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 暂存 / 取消暂存（参考图审查视图的「暂存」）：路径必须先过「落在工作目录内」这道门。
 */
describe("暂存单个文件", () => {
  const root = mkdtempSync(join(tmpdir(), "kfw-stage-"));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("在工作目录内：转交 git，并把 path/staged 原样回给客户端", async () => {
    const stageFile = vi.fn(async () => {});
    const { service } = build({
      git: { stageFile },
      canvasWorkDirs: { [CANVAS_ID]: root },
    });
    await expect(
      service.setFileStaged(USER, CANVAS_ID, "src/app.ts", true),
    ).resolves.toEqual({ path: "src/app.ts", staged: true });
    expect(stageFile).toHaveBeenCalledWith(root, "src/app.ts", true);
  });

  it("路径越界（../ 逃逸）：400 且不碰 git", async () => {
    const stageFile = vi.fn(async () => {});
    const { service } = build({
      git: { stageFile },
      canvasWorkDirs: { [CANVAS_ID]: root },
    });
    await expect(
      service.setFileStaged(USER, CANVAS_ID, "../outside.ts", true),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(stageFile).not.toHaveBeenCalled();
  });

  it("画布不属于本工作区：一轮 404（与其它端点同一口径）", async () => {
    const stageFile = vi.fn(async () => {});
    const { service } = build({
      git: { stageFile },
      canvasFound: false,
      canvasWorkDirs: { [CANVAS_ID]: root },
    });
    await expect(
      service.setFileStaged(USER, CANVAS_ID, "src/app.ts", true),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(stageFile).not.toHaveBeenCalled();
  });
});

/**
 * 工作树的服务端校验（R5-2「工作树」条目）：路径必须绝对、不能在仓库里、父目录存在、
 * 目标不存在——这几条**只有服务端知道**（自托管形态下服务端可能不是用户手边那台机器）。
 */
describe("工作树路径校验", () => {
  it("非绝对路径 / 仓库本体 / 仓库内部：都给出可读原因", () => {
    const repo = process.platform === "win32" ? "D:\\repo" : "/repo";
    const sepChar = process.platform === "win32" ? "\\" : "/";
    expect(validateWorktreePath("wt", repo)).toContain("绝对路径");
    expect(validateWorktreePath(repo, repo)).toContain("不能就是仓库本体");
    expect(validateWorktreePath(`${repo}${sepChar}wt-inside`, repo)).toContain(
      "不能放在仓库里面",
    );
  });

  it("父目录不存在 / 目标已存在：报出来（git 只会在那里报一句更含糊的错）", () => {
    const missingParent = join(tmpdir(), "kfw-no-such-parent", "wt");
    expect(validateWorktreePath(missingParent, process.cwd())).toContain(
      "上级目录不存在",
    );
    const existing = mkdtempSync(join(tmpdir(), "kfw-wt-exists-"));
    expect(validateWorktreePath(existing, process.cwd())).toContain("已经存在");
    rmSync(existing, { recursive: true, force: true });
  });

  it("合法路径：通过（父目录存在、目标不存在）", () => {
    const parent = mkdtempSync(join(tmpdir(), "kfw-wt-ok-"));
    expect(validateWorktreePath(join(parent, "wt"), process.cwd())).toBeNull();
    rmSync(parent, { recursive: true, force: true });
  });
});
