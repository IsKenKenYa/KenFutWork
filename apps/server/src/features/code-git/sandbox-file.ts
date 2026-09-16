import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveInsideRoot } from "../../utils/inside-root.js";

/**
 * 沙箱工作目录里的**只读文本预览**（R3-2「打开」与 R3-3「文档入口」共用）。
 *
 * 两条纪律写在这里，别让调用方各自发挥：
 * - 路径必须落在工作目录内（`resolveInsideRoot` 拦 `../` 与绝对路径）；
 * - 只读一个**有上限的窗口**：按 fd 读前 N 字节，而不是先整文件读进内存再截断——
 *   工作目录里可能是几百 MB 的构建产物，先读后截会把服务端内存打爆。
 *
 * 二进制判定用「窗口里有没有 NUL 字节」这一常见启发式：不是万无一失的 MIME 探测，
 * 但足够避免把 .png 当文本塞进界面。命中就只回元信息、不回内容。
 */
export const MAX_VIEW_BYTES = 256 * 1024;

export interface SandboxFileView {
  /** 相对工作目录的路径（回显给界面，便于确认看的是哪个文件）。 */
  path: string;
  /** 文件实际字节数。 */
  bytes: number;
  /** 只回了前 MAX_VIEW_BYTES 字节。 */
  truncated: boolean;
  /** 看起来是二进制（窗口内有 NUL 字节），此时 content 为空。 */
  binary: boolean;
  content: string;
}

export function readSandboxTextFile(
  root: string,
  relativePath: string,
): SandboxFileView {
  const absolute = resolveInsideRoot(root, relativePath);
  const stat = statSync(absolute, { throwIfNoEntry: false });
  if (!stat) {
    throw new Error(`文件不存在：${relativePath}`);
  }
  if (stat.isDirectory()) {
    throw new Error(`${relativePath} 是目录，不能按文件打开。`);
  }

  const size = stat.size;
  const window = Math.min(size, MAX_VIEW_BYTES);
  const buffer = Buffer.alloc(window);
  const fd = openSync(absolute, "r");
  try {
    let read = 0;
    while (read < window) {
      const chunk = readSync(fd, buffer, read, window - read, read);
      if (chunk <= 0) break;
      read += chunk;
    }
    const bytes = buffer.subarray(0, read);
    const binary = bytes.includes(0);
    return {
      path: relativePath,
      bytes: size,
      truncated: size > window,
      binary,
      content: binary ? "" : bytes.toString("utf8"),
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * 候选文档的存在性探测（R3-3「文档入口」）：只 stat，不读内容。
 *
 * 候选清单是**约定俗成**的项目文档名；不存在的直接跳过（这是便利入口，不是错误路径），
 * 越界与读盘失败同样静默跳过——一个候选文件有问题不该把整份清单打空。
 */
export function existingSandboxFiles(
  root: string,
  candidates: readonly string[],
): Array<{ path: string; bytes: number }> {
  const found: Array<{ path: string; bytes: number }> = [];
  for (const candidate of candidates) {
    try {
      const absolute = resolveInsideRoot(root, candidate);
      const stat = statSync(absolute, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) continue;
      found.push({ path: candidate, bytes: stat.size });
    } catch {
      continue;
    }
  }
  return found;
}

/**
 * 列一层目录（R3-1「文件目录」标签）。**只列一层**：子目录由界面点进去再看——
 * 递归整棵树在大型工作目录上会变成几千条，而这个面板是用来「看这一层有什么」的。
 *
 * 排序：目录在前、同类型按名字；跳过 `.git`（版本元数据不是工作内容，且条目极多）。
 * 上限 {@link MAX_DIR_ENTRIES}：超出即标 truncated，界面如实说明「只列前 N 项」。
 */
export const MAX_DIR_ENTRIES = 500;

export interface SandboxDirEntry {
  name: string;
  /** 相对工作目录的路径（点进去时原样回传）。 */
  path: string;
  type: "file" | "dir";
  bytes: number | null;
}

export interface SandboxDirListing {
  /** 列的是哪个目录（相对工作目录；根目录是空串）。 */
  path: string;
  entries: SandboxDirEntry[];
  truncated: boolean;
}

export function listSandboxDir(
  root: string,
  relativePath: string,
): SandboxDirListing {
  const normalized = relativePath.replace(/^[/\\]+/, "");
  const absolute = normalized
    ? resolveInsideRoot(root, normalized)
    : resolveInsideRoot(root, ".");
  const stat = statSync(absolute, { throwIfNoEntry: false });
  if (!stat) {
    throw new Error(`目录不存在：${relativePath || "."}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${relativePath} 不是目录。`);
  }

  const entries: SandboxDirEntry[] = [];
  let truncated = false;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    if (entries.length >= MAX_DIR_ENTRIES) {
      truncated = true;
      break;
    }
    const childAbsolute = join(absolute, entry.name);
    const isDir = entry.isDirectory();
    entries.push({
      name: entry.name,
      path: normalized ? `${normalized}/${entry.name}` : entry.name,
      type: isDir ? "dir" : "file",
      bytes: isDir
        ? null
        : (statSync(childAbsolute, { throwIfNoEntry: false })?.size ?? null),
    });
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { path: normalized, entries, truncated };
}
