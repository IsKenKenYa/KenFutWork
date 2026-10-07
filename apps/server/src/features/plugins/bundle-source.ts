import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { Parser as TarParser } from "tar";
import { readBinary } from "../code-tools/file-media.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import { scopedPackageFiles } from "../execution/scoped-package-files.js";
import type { BundleFiles } from "./bundle-manifest.js";

/**
 * bundle 来源解析：把「一个 GitHub 仓库链接」或「一个本地目录」变成待校验的文件集合。
 *
 * 安装前固定提交（headSha）是有意设计：git 源不跑构建，上游一次推送就能改变
 * 实际执行的代码；固定 sha 后「你审的是哪份代码」与「装的是哪份代码」才一致。
 */

export interface BundleOrigin {
  kind: "github" | "local";
  /** 人类可读来源标识（owner/repo#sha 或本地路径） */
  label: string;
  repositoryUrl: string | null;
  /** 分支/tag/commit；本地来源为 null */
  ref: string | null;
  /** 固定后的提交 sha；本地来源为 null */
  headSha: string | null;
  /** monorepo 内的包子目录 */
  subdir: string | null;
}

export interface BundleSourceResult {
  files: BundleFiles;
  origin: BundleOrigin;
}

export class BundleSourceError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "url_invalid"
      | "fetch_failed"
      | "not_found"
      | "too_large"
      | "path_invalid",
  ) {
    super(message);
    this.name = "BundleSourceError";
  }
}

/** 允许进入校验的文本文件：清单、配置层、模块源码与文档。 */
const TEXT_EXTENSIONS = new Set([
  ".json",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".yml",
  ".yaml",
  ".md",
  ".txt",
  // 插件自带的 UI 面板资源（能力 `ui` + `kenfutwork.assets`）：允许纯文本类静态文件；
  // 二进制（png/woff 等）不进 bundle——面板页面用内联样式/SVG 即可
  ".html",
  ".htm",
  ".css",
  ".svg",
]);

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".github",
  ".turbo",
  ".next",
  "coverage",
  "__pycache__",
]);

const MAX_FILES = 2000;
const MAX_FILE_BYTES = 512 * 1024;

/**
 * 解析 GitHub 仓库链接。支持：
 * - `https://github.com/owner/repo`
 * - `https://github.com/owner/repo/tree/<ref>/<subdir>`
 * - `owner/repo`、`owner/repo#<ref>`
 * - `git+https://github.com/owner/repo.git`
 */
export function parseGitHubUrl(input: string): {
  owner: string;
  repo: string;
  ref?: string;
  subdir?: string;
} | null {
  const trimmed = input
    .trim()
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
  if (!trimmed) return null;

  if (!/^https?:/i.test(trimmed)) {
    const shorthand = trimmed.match(/^([\w.-]+)\/([\w.-]+?)(?:#(.+))?$/);
    if (!shorthand) return null;
    // 捕获组在整体匹配成功时必然存在，默认值只为把 string | undefined 收窄
    const [, owner = "", repo = "", ref] = shorthand;
    return {
      owner,
      repo,
      ...(ref ? { ref } : {}),
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const repo = segments[1];
  if (!owner || !repo) return null;

  if (segments[2] === "tree" && segments[3]) {
    const ref = decodeURIComponent(segments[3]);
    const subdir = segments.slice(4).join("/") || undefined;
    return { owner, repo, ref, ...(subdir ? { subdir } : {}) };
  }
  return { owner, repo };
}

function isTextFile(
  relativePath: string,
  size: number,
  maxBytes: number = MAX_FILE_BYTES,
): boolean {
  if (size > maxBytes) return false;
  const extension = path.extname(relativePath).toLowerCase();
  return TEXT_EXTENSIONS.has(extension);
}

function shouldSkip(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((segment) => SKIP_DIRECTORIES.has(segment));
}

function stripSubdir(files: BundleFiles, subdir: string | null): BundleFiles {
  if (!subdir) return files;
  const prefix = `${subdir.replace(/\/+$/, "")}/`;
  const out: BundleFiles = {};
  for (const [filePath, content] of Object.entries(files)) {
    if (filePath === subdir || filePath.startsWith(prefix)) {
      const relative = filePath.slice(prefix.length);
      if (relative) out[relative] = content;
    }
  }
  return out;
}

async function readLocalBundle(
  directory: string,
  subdir: string | null,
  localSource?: ScopedBundleSource,
): Promise<BundleFiles> {
  if (localSource) {
    const root = await localSource.resolvePath(directory);
    const files: BundleFiles = {};
    let totalBytes = 0;
    let fileCount = 0;
    for await (const absolutePath of localSource.listFiles(root)) {
      const relativePath = path
        .relative(root, absolutePath)
        .split(path.sep)
        .join("/");
      if (!TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase()))
        continue;
      if (fileCount >= localSource.maxFiles)
        throw new BundleSourceError(
          "插件 bundle 文件数量超过工作区读取预算。",
          "too_large",
        );
      const content = await localSource.readText(absolutePath);
      totalBytes += Buffer.byteLength(content);
      if (totalBytes > localSource.maxTotalBytes)
        throw new BundleSourceError(
          "插件 bundle 总字节数超过工作区读取预算。",
          "too_large",
        );
      files[relativePath] = content;
      fileCount++;
    }
    await localSource.resolvePath(root);
    return stripSubdir(files, subdir);
  }
  let root: string;
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) {
      throw new BundleSourceError(
        `本地路径不是目录：${directory}`,
        "path_invalid",
      );
    }
    root = directory;
  } catch (error) {
    if (error instanceof BundleSourceError) throw error;
    throw new BundleSourceError(`本地路径不可读：${directory}`, "path_invalid");
  }

  const files: BundleFiles = {};
  let fileCount = 0;
  const walk = async (current: string, relative: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        await walk(path.join(current, entry.name), childRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(path.join(current, entry.name));
      if (!isTextFile(childRelative, info.size)) continue;
      if (fileCount >= MAX_FILES)
        throw new BundleSourceError(
          "插件 bundle 文件数量超过读取预算。",
          "path_invalid",
        );
      const filePath = path.join(current, entry.name);
      const content = await readFile(filePath, "utf8");
      files[childRelative] = content;
      fileCount++;
    }
  };

  await walk(root, "");
  return stripSubdir(files, subdir);
}

async function resolveGitHubHeadSha(
  owner: string,
  repo: string,
  ref: string | undefined,
  token: string | undefined,
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref ?? "HEAD")}`;
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new BundleSourceError(
      `解析仓库提交失败（${response.status}）：${owner}/${repo}${ref ? `#${ref}` : ""}`,
      response.status === 404 ? "not_found" : "fetch_failed",
    );
  }
  const payload = (await response.json()) as { sha?: unknown };
  if (typeof payload.sha !== "string" || !payload.sha) {
    throw new BundleSourceError(
      `仓库提交响应缺少 sha：${owner}/${repo}`,
      "fetch_failed",
    );
  }
  return payload.sha;
}

/**
 * 拉取 GitHub 仓库的 tarball 并解出文本文件。
 * 固定 sha 拉取（而非分支名）：确保校验的代码与安装的代码完全一致。
 */
async function readGitHubBundle(
  owner: string,
  repo: string,
  ref: string | undefined,
  subdir: string | null,
  token: string | undefined,
): Promise<{ files: BundleFiles; headSha: string }> {
  const headSha = await resolveGitHubHeadSha(owner, repo, ref, token);
  const tarballUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${headSha}`;

  const response = await fetch(tarballUrl, {
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  if (!response.ok || !response.body) {
    throw new BundleSourceError(
      `下载仓库归档失败（${response.status}）：${owner}/${repo}`,
      "fetch_failed",
    );
  }
  const archive = Buffer.from(await response.arrayBuffer());

  const files: BundleFiles = {};
  await new Promise<void>((resolve, reject) => {
    // tar 顶层目录固定为 `<repo>-<sha>`，按第一个路径段剥离
    const parser = new TarParser({
      onReadEntry(entry) {
        const raw = entry.path.replace(/\\/g, "/");
        const withoutRoot = raw.split("/").slice(1).join("/");
        const skip =
          entry.type !== "File" ||
          !withoutRoot ||
          shouldSkip(withoutRoot) ||
          !isTextFile(withoutRoot, entry.size ?? 0) ||
          Object.keys(files).length >= MAX_FILES;
        if (skip) {
          entry.resume();
          return;
        }
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => chunks.push(chunk));
        entry.on("end", () => {
          files[withoutRoot] = Buffer.concat(chunks).toString("utf8");
        });
      },
    });
    parser.on("error", (error: Error) => {
      reject(
        new BundleSourceError(
          `解包仓库归档失败：${error.message}`,
          "fetch_failed",
        ),
      );
    });
    parser.on("end", () => resolve());
    parser.write(archive);
    parser.end();
  });

  return { files: stripSubdir(files, subdir), headSha };
}

export interface FetchBundleOptions {
  /** 显式 ref（分支/tag/commit）；缺省时对 GitHub 来源锁默认分支 HEAD */
  ref?: string;
  /** GitHub token（提升速率上限；缺省走匿名） */
  token?: string;
  /** GitHub 仓库内子目录（monorepo 包路径） */
  subdir?: string | null;
  localSource?: ScopedBundleSource;
}

export interface ScopedBundleSource {
  resolvePath(path: string): Promise<string>;
  listFiles(root: string): AsyncIterable<string>;
  readText(path: string): Promise<string>;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}
export function createScopedBundleSource(
  scope: ExecutionScopeHandle,
  signal?: AbortSignal,
): ScopedBundleSource {
  return {
    resolvePath: (path) => {
      signal?.throwIfAborted();
      return scope.resolvePath(path, "read");
    },
    listFiles: (root) =>
      scopedPackageFiles(scope, root, {
        skipDirectories: SKIP_DIRECTORIES,
        ...(signal ? { signal } : {}),
      }),
    readText: async (path) => {
      const file = await readBinary(
        scope,
        path,
        scope.backend.limits.codeReadMaxBytes,
        signal,
      );
      return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    },
    maxFiles: scope.backend.limits.codeSearchMaxResults,
    maxFileBytes: scope.backend.limits.codeReadMaxBytes,
    maxTotalBytes: scope.backend.limits.codeSearchMaxBytes,
  };
}

/** 解析来源并取出文件集合（不校验、不安装）。 */
export async function fetchBundleFiles(
  input: string,
  options: FetchBundleOptions = {},
): Promise<BundleSourceResult> {
  const local = looksLikeLocalPath(input);
  if (local) {
    const files = await readLocalBundle(
      local,
      options.subdir ?? null,
      options.localSource,
    );
    return {
      files,
      origin: {
        kind: "local",
        label: local,
        repositoryUrl: null,
        ref: null,
        headSha: null,
        subdir: options.subdir ?? null,
      },
    };
  }

  const parsed = parseGitHubUrl(input);
  if (!parsed) {
    throw new BundleSourceError(
      `无法识别的插件来源：${input}。请填 GitHub 仓库链接（https://github.com/owner/repo）或本地目录路径。`,
      "url_invalid",
    );
  }

  const ref = options.ref ?? parsed.ref;
  const subdir = options.subdir ?? parsed.subdir ?? null;
  const { files, headSha } = await readGitHubBundle(
    parsed.owner,
    parsed.repo,
    ref,
    subdir,
    options.token,
  );

  return {
    files,
    origin: {
      kind: "github",
      label: `${parsed.owner}/${parsed.repo}@${headSha.slice(0, 7)}`,
      repositoryUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
      ref: ref ?? null,
      headSha,
      subdir,
    },
  };
}

/** 本地路径判定：绝对路径、相对路径或 `file:` 前缀（显式排除 URL）。 */
function looksLikeLocalPath(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("file:")) {
    return trimmed.slice("file:".length).replace(/^\/\//, "");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;
  if (path.isAbsolute(trimmed)) return trimmed;
  // 带路径分隔符的相对路径（`./x`、`../x`、`a/b/c`）视为本地；
  // 纯 `owner/repo` 交给 GitHub 简写解析。
  if (/^\.{1,2}[\\/]/.test(trimmed)) return path.resolve(trimmed);
  if (/[\\/]/.test(trimmed) && !/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return path.resolve(trimmed);
  }
  return null;
}
