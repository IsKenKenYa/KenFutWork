import { join } from "node:path";

/**
 * 影子 git（Code 模式检查点的核心纯逻辑层）。
 *
 * 机制：影子仓库是服务端数据目录里的一个**独立 git 仓库**（GIT_DIR），工作区
 * （GIT_WORK_TREE）指向沙箱工作目录——绝不碰用户自己的 .git，项目目录零残留。
 * 本文件只做「git 命令 → 结构化结果」的纯逻辑，谁来执行由注入的 `exec` 决定
 * （生产是 `createShadowGitExec`，测试可换替身）；落 excludes 清单的 fs 能力
 * 同样注入（`writeTextFile`），本模块不直接 import fs。
 *
 * 安全前提：调用方必须传入已校验归属的目录（gitDir 在服务端数据目录内、
 * workTree 是沙箱目录），本模块不做路径校验。restoreTo 会覆盖工作区内容，
 * 属丢数据操作，由上层负责确认。
 */

export interface ShadowGitScope {
  /** 影子仓库目录（如 `<数据目录>/checkpoints/<canvasId>.git`）。 */
  gitDir: string;
  /** 被快照的沙箱工作目录；restoreTo 会把其中已跟踪内容切到目标时点。 */
  workTree: string;
}

export interface ShadowGitCommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

/**
 * 执行影子 git：`args` 已定稿（`--no-optional-locks` 由执行层统一前置），
 * `scope` 被执行层翻译成 GIT_DIR / GIT_WORK_TREE env。
 */
export type ExecShadowGit = (
  args: readonly string[],
  scope: ShadowGitScope,
  input?: string,
) => Promise<ShadowGitCommandResult>;

/** 写文本文件（ensureRepo 落 excludes 清单用；生产是 utf8 的 writeFileSync）。 */
export type WriteTextFile = (path: string, content: string) => Promise<void>;

/**
 * 影子仓库的内置忽略清单。
 *
 * `.git` 是关键：work_dir 指向用户真实仓库时，把 `.git` 排除掉可以防止把
 * 嵌套仓库的记录进影子仓库；其余是常见的产物/依赖目录（恢复时原样保留，
 * 不被检查点吞掉也不被还原冲掉）。
 */
export const SHADOW_EXCLUDES = [
  ".git",
  ".kenfutwork",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".venv",
  "__pycache__",
  "target",
  "coverage",
  ".DS_Store",
  "*.log",
];

export interface ShadowNumstatFile {
  /** 相对 workTree 根的路径。 */
  path: string;
  /** 新增行数；二进制文件没有行数概念，为 null（不伪造 0）。 */
  added: number | null;
  /** 删除行数；二进制文件没有行数概念，为 null。 */
  deleted: number | null;
}

/**
 * 解析 `git diff --numstat` 输出：每行 `新增<TAB>删除<TAB>路径`，
 * 二进制文件的前两列是 `-`。路径列按 TAB 拼回（文件名本身可含空格/中文）。
 */
export function parseNumstat(stdout: string): ShadowNumstatFile[] {
  return stdout
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split("\t");
      const added = parts[0] ?? "";
      const deleted = parts[1] ?? "";
      const path = parts.slice(2).join("\t");
      const binary = added === "-" || deleted === "-";
      return {
        path,
        added: binary ? null : Number(added) || 0,
        deleted: binary ? null : Number(deleted) || 0,
      };
    })
    .filter((file) => file.path.length > 0);
}

export function createShadowGitClient(deps: {
  exec: ExecShadowGit;
  writeTextFile: WriteTextFile;
}) {
  const { exec, writeTextFile } = deps;

  /** 命令失败时把 git 的原话抛成可读错误。 */
  const expectOk = async (
    args: readonly string[],
    scope: ShadowGitScope,
    fallback: string,
  ): Promise<void> => {
    const result = await exec(args, scope);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || fallback);
    }
  };

  /**
   * 确保影子仓库存在并配好忽略清单。幂等：重复调用不报错、无副作用
   * （已初始化时连 init 都不再跑，config/excludes 重写为相同内容）。
   */
  const ensureRepo = async (
    input: ShadowGitScope & { excludes: readonly string[] },
  ): Promise<void> => {
    const probe = await exec(["rev-parse", "--git-dir"], input);
    if (probe.code !== 0) {
      // 注意不能用 `--bare`：git 拒绝在 GIT_WORK_TREE 存在时做 bare init（实测 fatal）。
      // 非 bare 仓库目录在 GIT_DIR+GIT_WORK_TREE env 双指定下行为完全一致；
      // init 会自动创建缺失的父目录。
      const init = await exec(["init", input.gitDir], input);
      if (init.code !== 0) {
        throw new Error(init.stderr.trim() || "初始化影子仓库失败。");
      }
    }
    const excludesPath = join(input.gitDir, "excludes");
    await writeTextFile(excludesPath, `${[...input.excludes].join("\n")}\n`);
    const config = await exec(
      ["config", "core.excludesFile", excludesPath],
      input,
    );
    if (config.code !== 0) {
      throw new Error(config.stderr.trim() || "配置影子仓库忽略清单失败。");
    }
  };

  /**
   * 打一个检查点：暂存全部 → 无可提交内容则跳过 → 提交并返回 HEAD sha。
   *
   * - 空目录（还没有 baseline 的素材）返回 null：没有内容的「首次提交」不该发生；
   * - 仓库已有提交且无变化也返回 null：跳过空检查点；
   * - 仓库尚无提交且目录非空：必须提交（这就是 baseline）。
   *
   * 提交身份用 `-c` 内联：不依赖用户全局 git config（新机器/CI 没配身份也能打点）。
   */
  const commitSnapshot = async (
    input: ShadowGitScope & { message: string },
  ): Promise<{ sha: string } | null> => {
    await expectOk(["add", "-A"], input, "影子仓库暂存失败。");
    const status = await exec(["status", "--porcelain"], input);
    if (status.code !== 0) {
      throw new Error(status.stderr.trim() || "读取影子仓库状态失败。");
    }
    if (status.stdout.trim() === "") {
      return null;
    }
    const committed = await exec(
      [
        "-c",
        "user.name=KenFutWork Checkpoint",
        "-c",
        "user.email=checkpoint@kenfutwork.local",
        "commit",
        "-m",
        input.message,
      ],
      input,
    );
    if (committed.code !== 0) {
      throw new Error(committed.stderr.trim() || "影子仓库提交失败。");
    }
    const head = await exec(["rev-parse", "HEAD"], input);
    if (head.code !== 0) {
      throw new Error(head.stderr.trim() || "读取影子仓库 HEAD 失败。");
    }
    return { sha: head.stdout.trim() };
  };

  /** 影子仓库是否已有提交（`rev-parse HEAD` 成功即有）。 */
  const hasCommits = async (scope: ShadowGitScope): Promise<boolean> => {
    const head = await exec(["rev-parse", "HEAD"], scope);
    return head.code === 0;
  };

  // diff 族命令的路径要原样进结构化结果：git 默认 core.quotePath=true 会把
  // 非 ASCII 文件名输出成八进制转义，必须关掉（中文文件名测试锁这个行为）。
  const QUOTE_PATH_OFF = ["-c", "core.quotePath=false"];

  /** 两个检查点之间的逐文件增删行数（二进制文件 added/deleted 为 null）。 */
  const numstat = async (
    input: ShadowGitScope & { from: string; to: string },
  ): Promise<ShadowNumstatFile[]> => {
    const result = await exec(
      [...QUOTE_PATH_OFF, "diff", "--numstat", input.from, input.to],
      input,
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "读取影子仓库差异统计失败。");
    }
    return parseNumstat(result.stdout);
  };

  /** 两个检查点之间的统一 diff 原文；给 `path` 时只看该文件。 */
  const diffText = async (
    input: ShadowGitScope & { from: string; to: string; path?: string },
  ): Promise<string> => {
    const args = [
      ...QUOTE_PATH_OFF,
      "diff",
      "--no-color",
      input.from,
      input.to,
    ];
    if (input.path) {
      args.push("--", input.path);
    }
    const result = await exec(args, input);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "读取影子仓库差异失败。");
    }
    return result.stdout;
  };

  /**
   * 恢复预览：工作区相对目标时点（`sha`）的未提交差异。
   * 先 `add -A` 让未跟踪文件进索引，否则 diff 看不到它们（预览会漏「新增文件」）。
   */
  const changedAgainst = async (
    input: ShadowGitScope & { sha: string },
  ): Promise<ShadowNumstatFile[]> => {
    await expectOk(["add", "-A"], input, "影子仓库暂存失败。");
    const result = await exec(
      [...QUOTE_PATH_OFF, "diff", "--numstat", input.sha],
      input,
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "读取恢复预览失败。");
    }
    return parseNumstat(result.stdout);
  };

  /**
   * 恢复到目标时点：先 `add -A` 把 index 对齐当前工作区，再
   * `read-tree --reset -u <sha>` 让 index 与工作区一起切到目标树（含删除）。
   * 被 ignore 的文件不在 index 里，原样保留（node_modules 等不受恢复影响）；
   * 恢复后 HEAD 不动，下一次 commitSnapshot 会把「回退」本身记成一个新检查点。
   */
  const restoreTo = async (
    input: ShadowGitScope & { sha: string },
  ): Promise<void> => {
    await expectOk(["add", "-A"], input, "影子仓库暂存失败。");
    const reset = await exec(["read-tree", "--reset", "-u", input.sha], input);
    if (reset.code !== 0) {
      throw new Error(reset.stderr.trim() || "恢复到检查点失败。");
    }
  };

  return {
    ensureRepo,
    commitSnapshot,
    hasCommits,
    numstat,
    diffText,
    changedAgainst,
    restoreTo,
  };
}

export type ShadowGitClient = ReturnType<typeof createShadowGitClient>;
