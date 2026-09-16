import type { TerminalShellId } from "@kenfutwork/shared";

import { getServerBaseUrl } from "./env";
import { ApiApplicationError, ApiAuthError } from "./server-api";

// ── Helpers（与本目录其它 *-api 一致：各自持有，不走共享导出） ──

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function authJsonHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
}

async function handleErrorResponse(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new ApiAuthError();
  }
  const body = await response.json().catch(() => null);
  throw new ApiApplicationError(
    body?.error?.code ?? "application_error",
    body?.error?.message ?? "请求失败，请重试。",
  );
}

/**
 * Code 模式 git 分支视图（工作目录=项目）。
 *
 * 作用域是**画布**（服务端据此算沙箱目录），故调用方传的是项目主画布 id——
 * 与 run 的 `canvasId` 同一口径，保证看到的仓库就是 agent 读写的那一个。
 */
export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  branches: GitBranch[];
  dirty: boolean;
  source: "system" | "bundled" | "unavailable";
}

export async function fetchGitStatus(
  accessToken: string,
  canvasId: string,
): Promise<GitStatus> {
  const query = new URLSearchParams({ canvasId });
  const response = await fetch(
    `${getServerBaseUrl()}/api/code/git?${query.toString()}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { git: GitStatus };
  return payload.git;
}

export async function checkoutGitBranch(
  accessToken: string,
  canvasId: string,
  branch: string,
): Promise<GitStatus> {
  const response = await fetch(`${getServerBaseUrl()}/api/code/git/checkout`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ branch, canvasId }),
  });
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { git: GitStatus };
  return payload.git;
}

// --- R2-1：更改统计 / 提交 / 推送 / 新建分支 ---

export interface GitDiffStat {
  files: number;
  additions: number;
  deletions: number;
  untracked: number;
}

export async function fetchGitDiffStat(
  accessToken: string,
  canvasId: string,
): Promise<GitDiffStat> {
  const query = new URLSearchParams({ canvasId });
  const response = await fetch(
    `${getServerBaseUrl()}/api/code/git/diff-stat?${query.toString()}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { stat: GitDiffStat };
  return payload.stat;
}

// --- R3-2：变更清单 / 单文件差异 / 单文件内容（R3-3 的文档入口共用文件读取） ---

export interface GitChangedFile {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  /** 已进索引（界面标「已暂存」，并决定按钮是「暂存」还是「取消暂存」）。 */
  staged: boolean;
}

export interface GitChanges {
  isRepo: boolean;
  files: GitChangedFile[];
  truncated: boolean;
}

export async function fetchGitChanges(
  accessToken: string,
  canvasId: string,
): Promise<GitChanges> {
  const query = new URLSearchParams({ canvasId });
  const response = await fetch(
    `${getServerBaseUrl()}/api/code/git/changes?${query.toString()}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { changes: GitChanges };
  return payload.changes;
}

export interface GitFileDiff {
  path: string;
  text: string;
  truncated: boolean;
  /** 未跟踪文件：文本是「按新增行」的合成视图，不是 git 给的 diff。 */
  untracked: boolean;
}

/** 暂存 / 取消暂存单个文件（审查视图里的「暂存」）。 */
export async function setGitFileStaged(
  accessToken: string,
  canvasId: string,
  path: string,
  staged: boolean,
): Promise<{ path: string; staged: boolean }> {
  const response = await fetch(`${getServerBaseUrl()}/api/code/git/stage`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ canvasId, path, staged }),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as { path: string; staged: boolean };
}

/**
 * 撤销更改：给了 path 就撤销这个文件，否则撤销全部未提交改动。
 * **会丢内容**，二次确认由界面负责。
 */
export async function discardGitChanges(
  accessToken: string,
  canvasId: string,
  options: { path?: string; untracked?: boolean } = {},
): Promise<{ ok: true }> {
  const response = await fetch(`${getServerBaseUrl()}/api/code/git/discard`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ canvasId, ...options }),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as { ok: true };
}

/** 应用一个块：target=index 暂存/取消暂存，=worktree 撤销这一块的改动。 */
export async function stageGitHunk(
  accessToken: string,
  canvasId: string,
  path: string,
  patch: string,
  options: { reverse?: boolean; target?: "index" | "worktree" } = {},
): Promise<{ path: string; staged: boolean }> {
  const response = await fetch(`${getServerBaseUrl()}/api/code/git/stage-hunk`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ canvasId, path, patch, ...options }),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as { path: string; staged: boolean };
}

export async function fetchGitFileDiff(
  accessToken: string,
  canvasId: string,
  path: string,
): Promise<GitFileDiff> {
  const query = new URLSearchParams({ canvasId, path });
  const response = await fetch(
    `${getServerBaseUrl()}/api/code/git/diff?${query.toString()}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { diff: GitFileDiff };
  return payload.diff;
}

export interface SandboxFileView {
  path: string;
  bytes: number;
  truncated: boolean;
  binary: boolean;
  content: string;
}

// --- R3-1「文件目录」标签：列一层目录（子目录由界面点进去） ---

export interface CodeFileEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  bytes: number | null;
}

export interface CodeFileListing {
  path: string;
  entries: CodeFileEntry[];
  truncated: boolean;
}

export async function fetchCodeFiles(
  accessToken: string,
  canvasId: string,
  path = "",
): Promise<CodeFileListing> {
  const query = new URLSearchParams({ canvasId, path });
  const response = await fetch(
    `${getServerBaseUrl()}/api/code/files?${query.toString()}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { files: CodeFileListing };
  return payload.files;
}

/** 工作目录里的项目文档（R3-3「文档入口」）。 */
export async function fetchCodeDocs(
  accessToken: string,
  canvasId: string,
): Promise<Array<{ path: string; bytes: number }>> {
  const query = new URLSearchParams({ canvasId });
  const response = await fetch(
    `${getServerBaseUrl()}/api/code/docs?${query.toString()}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as {
    docs: Array<{ path: string; bytes: number }>;
  };
  return payload.docs;
}

export async function fetchSandboxFile(
  accessToken: string,
  canvasId: string,
  path: string,
): Promise<SandboxFileView> {
  const query = new URLSearchParams({ canvasId, path });
  const response = await fetch(
    `${getServerBaseUrl()}/api/code/file?${query.toString()}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { file: SandboxFileView };
  return payload.file;
}

/**
 * agent 运行活动（Git 弹层的「智能体 26 秒 · 4 运行」）。
 * 口径（服务端定义）：该**工作区**近 7 天的运行次数与各轮时长之和。
 */
export interface AgentActivity {
  windowDays: number;
  runs: number;
  totalSeconds: number;
}

export async function fetchAgentActivity(
  accessToken: string,
): Promise<AgentActivity> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/agent/runs/activity`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { activity: AgentActivity };
  return payload.activity;
}

// --- R3-1「终端」标签：在画布工作目录里跑用户命令 ---

export interface TerminalResult {
  command: string;
  /** 实际执行这条命令的 shell（`cmd` / `powershell` / `git-bash` / …）。 */
  shell: TerminalShellId;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export async function runTerminalCommand(
  accessToken: string,
  canvasId: string,
  command: string,
  shell?: TerminalShellId,
): Promise<TerminalResult> {
  const response = await fetch(`${getServerBaseUrl()}/api/code/terminal`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ canvasId, command, ...(shell ? { shell } : {}) }),
  });
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { result: TerminalResult };
  return payload.result;
}

/** 本机可用的 shell（右栏终端下拉与设置页共用）。`auto` 只是设置里的值，不在清单里。 */
export interface TerminalShellOption {
  id: TerminalShellId;
  label: string;
  executable: string;
}

export async function fetchTerminalShells(accessToken: string): Promise<{
  shells: TerminalShellOption[];
  defaultShell: TerminalShellId;
  /** 默认值是 `auto` 时，这台机器上实际会用的那个（界面据此说清「auto → cmd」）。 */
  resolvedShell: TerminalShellId;
}> {
  const response = await fetch(`${getServerBaseUrl()}/api/code/shells`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as {
    shells: TerminalShellOption[];
    defaultShell: TerminalShellId;
    resolvedShell: TerminalShellId;
  };
}

/** git 图谱（参考图 `git图谱.png`）：独立窗口里的 图/描述/日期/作者/提交 表格。 */
export interface GitGraphEntry {
  /** 该行的图形字符，界面按等宽渲染成「图」列；连接线行没有提交字段。 */
  rail: string;
  sha: string | null;
  shortSha: string | null;
  subject: string;
  author: string;
  date: string;
  refs: string[];
  parents: string[];
}

export interface GitGraph {
  isRepo: boolean;
  entries: GitGraphEntry[];
  truncated: boolean;
}

export async function fetchGitGraph(
  accessToken: string,
  canvasId: string,
  limit = 30,
): Promise<GitGraph> {
  const query = new URLSearchParams({ canvasId, limit: String(limit) });
  const response = await fetch(
    `${getServerBaseUrl()}/api/code/git/graph?${query.toString()}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { graph: GitGraph };
  return payload.graph;
}

export async function commitGitAll(
  accessToken: string,
  canvasId: string,
  message: string,
): Promise<GitStatus> {
  const response = await fetch(`${getServerBaseUrl()}/api/code/git/commit`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ canvasId, message }),
  });
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { git: GitStatus };
  return payload.git;
}

/** 把工作目录初始化成仓库（幂等）：「每次对话用 git 跟踪」在非仓库目录上的入口。 */
export async function initGitRepo(
  accessToken: string,
  canvasId: string,
): Promise<GitStatus> {
  const response = await fetch(`${getServerBaseUrl()}/api/code/git/init`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ canvasId }),
  });
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { git: GitStatus };
  return payload.git;
}

export async function pushGit(
  accessToken: string,
  canvasId: string,
): Promise<GitStatus> {
  const response = await fetch(`${getServerBaseUrl()}/api/code/git/push`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ canvasId }),
  });
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { git: GitStatus };
  return payload.git;
}

export async function createGitBranch(
  accessToken: string,
  canvasId: string,
  name: string,
): Promise<GitStatus> {
  const response = await fetch(`${getServerBaseUrl()}/api/code/git/branch`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ canvasId, name }),
  });
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { git: GitStatus };
  return payload.git;
}
