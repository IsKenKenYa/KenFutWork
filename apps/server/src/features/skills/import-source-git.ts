import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { x as extractTar } from "tar";
import {
  classifyArchiveEntryPath,
  SkillImportSourceError,
  type SkillImportSourceLimits,
  SourceBudget,
} from "./import-source-support.js";

/**
 * 从 git 仓库地址准备技能来源。
 *
 * 安全口径（服务端替用户拉取任意仓库，逐条写死）：
 * - 只收 https 地址，不带用户名密码、查询串或片段；
 * - 云元数据地址一律拒绝（与网页抓取同一张名单）；内网与自建 git 服务放行，
 *   自托管场景下用户自己的仓库就在局域网上；
 * - 克隆时固定 git 配置与协议：不读系统/全局配置、不提示输入、只允许 https、
 *   不跟随 HTTP 跳转（防止跳去别的主机）；
 * - 仓库内容经 `git archive` 转成 tar 流再解出，符号链接等非普通文件不落盘；
 * - 解出的字节数、条目数与总时长都受治理值约束。
 */

/** 云元数据地址：拉它没有任何产品价值，只有越权读取风险。 */
const BLOCKED_HOSTS = new Set([
  "169.254.169.254",
  "100.100.100.200",
  "metadata.google.internal",
]);

const GIT_OUTPUT_MAX_BYTES = 8_192;

export interface GitSkillSource {
  /** 规范化地址（去掉末尾斜杠与 .git 后缀），同时用于展示与来源身份 */
  url: string;
  host: string;
}

/**
 * 校验并规范化仓库地址。
 *
 * 这一层只做地址形态与名单校验；域名解析到哪个地址由 git 自己处理，
 * 与网页抓取同一口径（只拦云元数据地址，不拦内网）。
 */
export function parseGitSkillSource(rawUrl: string): GitSkillSource {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new SkillImportSourceError("仓库地址不是合法 URL。");
  }
  if (parsed.protocol !== "https:") {
    throw new SkillImportSourceError("仓库地址必须以 https:// 开头。");
  }
  if (parsed.username || parsed.password) {
    throw new SkillImportSourceError("仓库地址里不要带用户名或密码。");
  }
  if (parsed.search || parsed.hash) {
    throw new SkillImportSourceError("仓库地址不要带查询串或片段。");
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) {
    throw new SkillImportSourceError("这是云元数据地址，不作为技能来源。");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new SkillImportSourceError(
      "仓库地址要写到仓库名，例如 https://github.com/owner/repo。",
    );
  }
  const normalized = `${parsed.origin}${parsed.pathname
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "")}`;
  return { url: normalized, host };
}

function describeGitFailure(stderr: string): string {
  const text = stderr.trim();
  if (
    /Authentication failed|could not read Username|terminal prompts disabled/iu.test(
      text,
    )
  ) {
    return "仓库需要登录才能读取，技能导入只支持公开仓库。";
  }
  if (/Repository not found|not found/iu.test(text)) {
    return "仓库不存在，或当前网络无法访问。";
  }
  if (/Could not resolve host|unable to access/iu.test(text)) {
    return "连不上仓库服务器，请检查网络。";
  }
  return "克隆仓库失败，请确认地址正确且仓库是公开的。";
}

/** 收掉整棵进程树（Windows 的 taskkill / POSIX 的 SIGTERM→SIGKILL）。 */
function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }, 2_000).unref?.();
}

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 运行一条 git 命令，输出只保留前 8KB（错误提示够用即可）。 */
function runGit(input: {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.binary, input.args, {
      cwd: input.cwd,
      windowsHide: true,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killedByDeadline = false;
    const append = (current: string, chunk: Buffer) =>
      current.length >= GIT_OUTPUT_MAX_BYTES
        ? current
        : (current + chunk.toString("utf8")).slice(0, GIT_OUTPUT_MAX_BYTES);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const onAbort = () => {
      killedByDeadline = true;
      if (child.pid) killProcessTree(child.pid);
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) onAbort();
    const finish = (
      code: number | null,
      spawnError?: NodeJS.ErrnoException,
    ) => {
      input.signal.removeEventListener("abort", onAbort);
      if (killedByDeadline) {
        reject(input.signal.reason);
        return;
      }
      if (spawnError) {
        reject(
          new SkillImportSourceError(
            spawnError.code === "ENOENT"
              ? "找不到 git 命令，无法从仓库导入技能。"
              : `启动 git 失败：${spawnError.message}`,
            500,
            { cause: spawnError },
          ),
        );
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}

/** 克隆时使用的固定 git 配置：不读本机配置、不提示输入、只走 https、不跟跳转。 */
function hardenedGitArgs(): string[] {
  return [
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https=always",
    "-c",
    "http.followRedirects=false",
    "-c",
    "credential.helper=",
    "-c",
    "core.askPass=",
  ];
}

function hardenedGitEnv(
  baseEnv: NodeJS.ProcessEnv,
  emptyConfig: string,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_ALLOW_PROTOCOL: "https",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

/**
 * 浅克隆仓库，把最新提交的文件树解进 `destination`（不含 `.git`）。
 *
 * @returns 来源标识（规范化地址 + 提交号）与被跳过的条目数
 */
export async function fetchGitSkillSource(input: {
  url: string;
  destination: string;
  /** 克隆与解包共用的临时目录（`.git` 与空配置放这里，随暂存一起清理） */
  workDirectory: string;
  binary: string;
  limits: SkillImportSourceLimits;
  signal: AbortSignal;
  baseEnv?: NodeJS.ProcessEnv;
}): Promise<{ sourceKey: string; commit: string; skippedEntries: number }> {
  const gitDirectory = join(input.workDirectory, "repo");
  mkdirSync(gitDirectory, { recursive: true });
  const env = hardenedGitEnv(
    input.baseEnv ?? process.env,
    join(input.workDirectory, "absent-gitconfig"),
  );

  const clone = await runGit({
    binary: input.binary,
    args: [
      ...hardenedGitArgs(),
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      "--no-checkout",
      "--quiet",
      "--",
      input.url,
      gitDirectory,
    ],
    cwd: input.workDirectory,
    env,
    signal: input.signal,
  });
  if (clone.code !== 0) {
    throw new SkillImportSourceError(describeGitFailure(clone.stderr), 400);
  }

  const head = await runGit({
    binary: input.binary,
    args: [...hardenedGitArgs(), "rev-parse", "HEAD"],
    cwd: gitDirectory,
    env,
    signal: input.signal,
  });
  const commit = head.stdout.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new SkillImportSourceError("读不出仓库的最新提交，导入中止。", 500);
  }

  const budget = new SourceBudget(input.limits);
  const rejected: string[] = [];
  let skippedEntries = 0;
  const archive = extractTar({
    cwd: input.destination,
    // 绝对路径与 .. 由条目分类拒绝；溢出文件名只跳过该条目
    preservePaths: false,
    strict: false,
    noMtime: true,
    onwarn: () => {},
    filter: (path, entry) => {
      // 读归档（git archive 流）时 tar 恒传 ReadEntry；带 `type` 字段的才认得出文件/目录
      const entryType = (entry as { type?: unknown }).type;
      if (entryType !== "File" && entryType !== "Directory") {
        skippedEntries += 1;
        return false;
      }
      let entryPath: ReturnType<typeof classifyArchiveEntryPath>;
      try {
        entryPath = classifyArchiveEntryPath(path, {
          backslashIsSeparator: false,
          destination: input.destination,
        });
      } catch {
        // 越界路径先记下、跳过落盘，整个来源在解包结束后拒绝
        rejected.push(path);
        return false;
      }
      if (entryPath.kind === "skipped") {
        skippedEntries += 1;
        return false;
      }
      budget.addEntry();
      if (entryPath.kind === "file") budget.addBytes(entry.size);
      return true;
    },
  });

  const gitArchive = spawn(
    input.binary,
    [...hardenedGitArgs(), "archive", "--format=tar", "HEAD"],
    {
      cwd: gitDirectory,
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let archiveStderr = "";
  gitArchive.stderr?.on("data", (chunk: Buffer) => {
    archiveStderr = (archiveStderr + chunk.toString("utf8")).slice(
      0,
      GIT_OUTPUT_MAX_BYTES,
    );
  });
  // 进程结束时必然结算：正常退出给 0，启动失败或非零退出给出可读原因
  const archiveExit = new Promise<{ code: number; spawnError?: Error }>(
    (resolve) => {
      gitArchive.on("error", (error) =>
        resolve({ code: -1, spawnError: error }),
      );
      gitArchive.on("close", (code) => resolve({ code: code ?? -1 }));
    },
  );
  const onAbort = () => {
    if (gitArchive.pid) killProcessTree(gitArchive.pid);
    // Unpack 的类型声明不带 stream 方法；它实际是 Writable，可 destroy
    (archive as unknown as { destroy(reason?: Error): void }).destroy(
      input.signal.reason as Error,
    );
  };
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (input.signal.aborted) onAbort();

  try {
    await pipeline(gitArchive.stdout, archive);
    const exit = await archiveExit;
    if (exit.spawnError) {
      const spawnError: NodeJS.ErrnoException = exit.spawnError;
      throw new SkillImportSourceError(
        spawnError.code === "ENOENT"
          ? "找不到 git 命令，无法从仓库导入技能。"
          : `启动 git 失败：${spawnError.message}`,
        500,
        { cause: spawnError },
      );
    }
    if (exit.code !== 0) {
      throw new SkillImportSourceError(
        `读取仓库文件失败：${archiveStderr.trim() || "git archive 未正常结束"}`,
        400,
      );
    }
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason;
    if (error instanceof SkillImportSourceError) throw error;
    throw new SkillImportSourceError(
      `解出仓库文件失败：${error instanceof Error ? error.message : String(error)}`,
      400,
      { cause: error },
    );
  } finally {
    input.signal.removeEventListener("abort", onAbort);
  }
  if (input.signal.aborted) throw input.signal.reason;
  if (rejected.length > 0) {
    throw new SkillImportSourceError(
      "仓库里有写到暂存目录之外的文件路径，已拒绝导入。",
    );
  }

  const digest = createHash("sha256")
    .update(`${input.url}@${commit}`)
    .digest("hex")
    .slice(0, 16);
  return {
    sourceKey: `git:${input.url}@${commit}#${digest}`,
    commit,
    skippedEntries,
  };
}
