import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { resolveInsideRoot } from "../../utils/inside-root.js";

import { parseSkillManifest } from "./skill-import-service.js";

/**
 * 沙箱工作目录里的技能包读取（「从工作目录导入」+ 创造模式的产物）。
 *
 * 技能包的判定：**目录里有 `SKILL.md`**（大小写不敏感），同目录/子目录的其它文件作为
 * 附带文件（scripts/ references/ assets/ 等）。所有路径都相对**沙箱根**——调用方拿到的
 * 目录由 `resolveSandboxDir` 解析（工作目录映射优先，否则 `<沙箱根>/<画布UUID>`）。
 *
 * 护栏（不信任磁盘内容）：
 * - 路径不得越出沙箱根（`resolve` 后前缀校验，防 `../` 逃逸）；
 * - 扫描深度与目录数有限（不跟着 `node_modules`/`.git` 走，避免巨型目录卡死）；
 * - 单文件体积上限（二进制/超大文件跳过，技能包都是文本）。
 */

/** 扫描时跳过的目录名：依赖、版本库、缓存、构建产物。 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "dist",
  "build",
  ".next",
  ".turbo",
]);

const MAX_DEPTH = 3;
const MAX_DIRS = 2000;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 256 * 1024;
/** SKILL.md 允许更大（正文可能很长）。 */
const MAX_SKILL_MD_BYTES = 1024 * 1024;

export interface SandboxSkillPackageCandidate {
  /** 相对沙箱根的目录路径（`/` 分隔） */
  path: string;
  name: string;
  description: string;
}

export interface SandboxSkillFileEntry {
  /** 相对**技能包根**的路径（`/` 分隔） */
  path: string;
  content: string;
}

/** 把绝对路径转成相对沙箱根的 POSIX 风格路径。 */
function toPosixRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

function isSkillMd(fileName: string): boolean {
  return fileName.toLowerCase() === "skill.md";
}

/** 目录是否直接含 SKILL.md。 */
function hasSkillMd(dir: string): boolean {
  try {
    return readdirSync(dir).some(isSkillMd);
  } catch {
    return false;
  }
}

/**
 * 在沙箱工作目录里列出技能包候选（含 SKILL.md 的目录，深度 ≤ MAX_DEPTH）。
 *
 * 解析不出 frontmatter 的目录也会列出（name 用目录名、描述为空），
 * 由用户决定是否导入；导入时再严格校验。
 */
export { resolveInsideRoot };

export function listSandboxSkillPackages(
  root: string,
  options: { maxDepth?: number } = {},
): SandboxSkillPackageCandidate[] {
  const rootAbsolute = resolve(root);
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const found: SandboxSkillPackageCandidate[] = [];
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: rootAbsolute, depth: 0 },
  ];
  let visited = 0;

  while (queue.length > 0 && visited < MAX_DIRS) {
    const current = queue.shift();
    if (!current) break;
    visited += 1;

    let entries: string[];
    try {
      entries = readdirSync(current.dir);
    } catch {
      continue;
    }

    if (current.depth > 0 && entries.some(isSkillMd)) {
      const candidatesDir = current.dir;
      const relativePath = toPosixRelative(rootAbsolute, candidatesDir);
      let name = relativePath.split("/").pop() ?? relativePath;
      let description = "";
      try {
        const manifest = parseSkillManifest(
          readFileSync(join(candidatesDir, "SKILL.md"), "utf8"),
        );
        name = manifest.name || name;
        description = manifest.description ?? "";
      } catch {
        // frontmatter 缺失/损坏：仍然列为候选，导入时报错
      }
      found.push({ path: relativePath, name, description });
      // 技能包内不再继续找嵌套包（避免 references/ 里的示例被当成技能）
      continue;
    }

    if (current.depth >= maxDepth) continue;
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
      const child = join(current.dir, entry);
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      queue.push({ dir: child, depth: current.depth + 1 });
    }
  }

  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 读取一个技能包的全部文本文件（相对技能包根）。
 *
 * @param root 沙箱根
 * @param relativePath 技能包目录（相对沙箱根）
 * @throws Error 越界、目录不存在、缺 SKILL.md、文件数/体积超限
 */
export function readSandboxSkillPackage(
  root: string,
  relativePath: string,
): SandboxSkillFileEntry[] {
  const rootAbsolute = resolve(root);
  const packageRoot = resolveInsideRoot(rootAbsolute, relativePath);

  let entries: string[];
  try {
    entries = readdirSync(packageRoot);
  } catch {
    throw new Error(`目录不可读：${relativePath}`);
  }
  if (!entries.some(isSkillMd)) {
    throw new Error(`目录里没有 SKILL.md：${relativePath}`);
  }

  const files: SandboxSkillFileEntry[] = [];
  const queue: string[] = [packageRoot];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (!dir) break;
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
      const child = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(child);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        queue.push(child);
        continue;
      }
      if (!stat.isFile()) continue;
      const isManifest = isSkillMd(entry);
      const limit = isManifest ? MAX_SKILL_MD_BYTES : MAX_FILE_BYTES;
      if (stat.size > limit) continue;
      if (files.length >= MAX_FILES) {
        throw new Error(`技能包文件过多（超过 ${MAX_FILES} 个）。`);
      }
      files.push({
        path: toPosixRelative(packageRoot, child),
        content: readFileSync(child, "utf8"),
      });
    }
  }

  return files;
}
