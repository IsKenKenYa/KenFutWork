import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { readBinary } from "../code-tools/file-media.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import { scopedPackageFiles } from "../execution/scoped-package-files.js";

/**
 * 沙箱工作目录里的**插件 bundle**扫描（「从工作目录安装插件」+ 创造模式的插件产物）。
 *
 * 判定：目录的 `package.json` 里声明了 bundle——
 * - 本项目：`kenfutwork.bundle`（旧名 `loomic.bundle` 仍认）
 * - dsh 原生：`dsh.bundle`（互操作）
 *
 * 与技能包扫描同一套护栏：深度/目录数受限、跳过依赖与构建目录、路径不出沙箱根。
 * 这里**只做发现**（拿到 name/version 供 UI 展示）；兼容性门禁与安装由
 * PluginRegistryService 负责（它才是唯一判定处）。
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  "dist",
  "build",
  ".next",
  ".turbo",
]);

const MAX_DEPTH = 3;
const MAX_DIRS = 2000;
const MAX_PACKAGE_JSON_BYTES = 256 * 1024;

export interface SandboxPluginBundleCandidate {
  /** 相对沙箱根的目录路径（`/` 分隔） */
  path: string;
  name: string;
  version: string;
  /** 声明来源：kenfutwork（本项目）/ dsh（原生互操作） */
  declaredBy: "kenfutwork" | "dsh";
}

function toPosixRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

/** 读 package.json 并判断它是否声明了 bundle。 */
function readBundleDeclaration(
  dir: string,
): { name: string; version: string; declaredBy: "kenfutwork" | "dsh" } | null {
  const manifestPath = join(dir, "package.json");
  try {
    const stat = statSync(manifestPath);
    if (!stat.isFile() || stat.size > MAX_PACKAGE_JSON_BYTES) return null;
  } catch {
    return null;
  }
  try {
    return parseBundleDeclaration(readFileSync(manifestPath, "utf8"), dir);
  } catch {
    return null;
  }
}

function parseBundleDeclaration(
  content: string,
  dir: string,
): { name: string; version: string; declaredBy: "kenfutwork" | "dsh" } | null {
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = value as Record<string, unknown>;
  const kenfutwork = parsed.kenfutwork as { bundle?: unknown } | undefined;
  const dsh = parsed.dsh as { bundle?: unknown } | undefined;
  const declaredBy = kenfutwork?.bundle
    ? "kenfutwork"
    : dsh?.bundle
      ? "dsh"
      : null;
  if (!declaredBy) return null;
  return {
    name:
      typeof parsed.name === "string"
        ? parsed.name
        : (dir.split(sep).pop() ?? dir),
    version: typeof parsed.version === "string" ? parsed.version : "",
    declaredBy,
  };
}

/**
 * 在沙箱工作目录里列出插件 bundle 候选（深度 ≤ MAX_DEPTH）。
 * 声明了 bundle 的目录不再向下递归（bundle 内不会再有嵌套 bundle）。
 */
export function listSandboxPluginBundles(
  root: string,
  options: { maxDepth?: number } = {},
): SandboxPluginBundleCandidate[] {
  const rootAbsolute = resolve(root);
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const found: SandboxPluginBundleCandidate[] = [];
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: rootAbsolute, depth: 0 },
  ];
  let visited = 0;

  while (queue.length > 0 && visited < MAX_DIRS) {
    const current = queue.shift();
    if (!current) break;
    visited += 1;

    const declaration = readBundleDeclaration(current.dir);
    if (declaration) {
      found.push({
        path: toPosixRelative(rootAbsolute, current.dir),
        ...declaration,
      });
      continue;
    }
    if (current.depth >= maxDepth) continue;

    let entries: string[];
    try {
      entries = readdirSync(current.dir);
    } catch {
      continue;
    }
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

/** Code 候选扫描通过同一 Task backend，绝对路径可定位显式附加目录。 */
export async function listScopedPluginBundles(
  scope: ExecutionScopeHandle,
): Promise<SandboxPluginBundleCandidate[]> {
  const identity = scope.describe();
  const roots = [
    identity.rootDirectory,
    ...identity.additionalDirectories.map((entry) => entry.path),
  ];
  const found: SandboxPluginBundleCandidate[] = [];
  const visited = new Set<string>();
  let bytesRead = 0;
  for (const root of roots) {
    for await (const path of scopedPackageFiles(scope, root, {
      skipDirectories: SKIP_DIRS,
    })) {
      if (basename(path) !== "package.json" || visited.has(path)) continue;
      visited.add(path);
      const directory = dirname(path);
      if (found.some((bundle) => directory.startsWith(`${bundle.path}${sep}`)))
        continue;
      const binary = await readBinary(
        scope,
        path,
        scope.backend.limits.codeReadMaxBytes,
      );
      bytesRead += binary.bytes.length;
      if (bytesRead > scope.backend.limits.codeSearchMaxBytes)
        throw new Error("插件扫描总字节数超过工作区预算。");
      let declaration: ReturnType<typeof parseBundleDeclaration>;
      try {
        declaration = parseBundleDeclaration(
          binary.bytes.toString("utf8"),
          directory,
        );
      } catch {
        continue;
      }
      if (!declaration) continue;
      found.push({ path: directory, ...declaration });
      if (found.length > scope.backend.limits.codeSearchMaxResults)
        throw new Error("插件候选数量超过工作区预算。");
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
