import { closeSync, openSync, readSync, statSync } from "node:fs";

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
