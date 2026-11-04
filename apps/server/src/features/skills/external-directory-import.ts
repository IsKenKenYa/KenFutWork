import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import type {
  ExternalSkillCandidate,
  ExternalSkillImportResponse,
  ExternalSkillScanDiagnostic,
  ExternalSkillScanResponse,
} from "@kenfutwork/shared";
import { resolveInsideRoot } from "../../utils/inside-root.js";
import { SQLSTATE_UNIQUE_VIOLATION, SqlError } from "../persistence/errors.js";
import type {
  SkillCatalogRepository,
  SkillImportAdmission,
  SkillImportReceiptRepository,
} from "./repository.js";
import {
  insertOwnedSkillRecord,
  insertSkillFileRecords,
  skillImportRequestKey,
  upsertInstanceSkillRecord,
} from "./repository.js";
import {
  MAX_DEPTH,
  MAX_DIRS,
  readSandboxSkillPackage,
  type SandboxSkillFileEntry,
  SKIP_DIRS,
} from "./sandbox-skill-packages.js";
import {
  buildSkillFromFiles,
  parseSkillManifest,
} from "./skill-import-service.js";
import { generateSlug } from "./slug.js";

/**
 * 已知外部技能目录（白名单）：只扫描用户显式配置过的位置，不跟随任意路径。
 * 目录布局与对应客户端一致：`~/.claude/skills`、`~/.codex/skills` 等。
 */
export type ExternalSkillAgent = "claude" | "codex" | "cursor" | "agents";

export type ExternalSkillRoot = {
  agent: ExternalSkillAgent;
  rootPath: string;
};

const EXTERNAL_SKILL_ROOT_DEFINITIONS: ReadonlyArray<{
  agent: ExternalSkillAgent;
  segments: readonly string[];
}> = [
  { agent: "claude", segments: [".claude", "skills"] },
  { agent: "codex", segments: [".codex", "skills"] },
  { agent: "cursor", segments: [".cursor", "skills"] },
  { agent: "agents", segments: [".agents", "skills"] },
];

export class ExternalSkillPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalSkillPathError";
  }
}

export class ExternalSkillSlugConflictError extends Error {
  constructor() {
    super("同名技能已存在，需要换一个来源目录或先删除旧技能。");
    this.name = "ExternalSkillSlugConflictError";
  }
}

/** 解析本机存在的外部技能目录；同一个真实目录只保留一次。 */
export function resolveExternalSkillRoots(
  homeDir = homedir(),
): ExternalSkillRoot[] {
  const seen = new Set<string>();
  const roots: ExternalSkillRoot[] = [];
  for (const definition of EXTERNAL_SKILL_ROOT_DEFINITIONS) {
    let realPath: string;
    try {
      realPath = realpathSync(join(homeDir, ...definition.segments));
    } catch {
      continue;
    }
    try {
      if (!statSync(realPath).isDirectory() || seen.has(realPath)) {
        continue;
      }
    } catch {
      continue;
    }
    seen.add(realPath);
    roots.push({ agent: definition.agent, rootPath: realPath });
  }
  return roots;
}

/** 客户端传来的源根目录必须精确命中白名单里的真实目录。 */
function resolveWhitelistedRoot(
  rootPath: string,
  homeDir?: string,
): ExternalSkillRoot {
  let realPath: string;
  try {
    realPath = realpathSync(rootPath);
  } catch {
    throw new ExternalSkillPathError("源目录不可读。");
  }
  const match = resolveExternalSkillRoots(homeDir).find(
    (root) => root.rootPath === realPath,
  );
  if (!match) {
    throw new ExternalSkillPathError("只能扫描已知外部技能目录。");
  }
  return match;
}

function toPosixPath(rootPath: string, absolutePath: string): string {
  return relative(rootPath, absolutePath).split(sep).join("/");
}

function isSkillManifest(fileName: string): boolean {
  return fileName.toLowerCase() === "skill.md";
}

/** 技能包全文摘要：按路径排序后依次混合路径与内容，来源内容变了就换摘要。 */
export function externalSkillPackageDigest(
  files: readonly SandboxSkillFileEntry[],
): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  })) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

interface ScannedRoot {
  diagnostics: ExternalSkillScanDiagnostic[];
  packagePaths: string[];
}

/**
 * 扫描一个白名单根目录。符号链接一律跳过（不跟随到白名单之外），
 * 深度与目录数沿用沙箱技能包的同一组上限。
 */
function scanRoot(rootPath: string): ScannedRoot {
  const packagePaths: string[] = [];
  const diagnostics: ExternalSkillScanDiagnostic[] = [];
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: rootPath, depth: 0 },
  ];
  let visited = 0;

  while (queue.length > 0) {
    if (visited >= MAX_DIRS) {
      diagnostics.push({
        rootPath,
        reason: "目录数量超过扫描上限。",
      });
      break;
    }
    const current = queue.shift();
    if (!current) break;
    visited += 1;

    let entries: string[];
    try {
      entries = readdirSync(current.dir);
    } catch {
      diagnostics.push({ rootPath, reason: "目录不可读。" });
      continue;
    }

    if (current.depth > 0 && entries.some(isSkillManifest)) {
      packagePaths.push(toPosixPath(rootPath, current.dir));
      continue;
    }
    if (current.depth >= MAX_DEPTH) {
      continue;
    }

    for (const entry of entries) {
      if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
      const child = join(current.dir, entry);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(child);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        diagnostics.push({
          rootPath,
          reason: `跳过符号链接：${toPosixPath(rootPath, child)}`,
        });
        continue;
      }
      if (stat.isDirectory()) {
        queue.push({ dir: child, depth: current.depth + 1 });
      }
    }
  }

  return { packagePaths, diagnostics };
}

function assertInsideRoot(rootPath: string, absolutePath: string): void {
  if (
    absolutePath !== rootPath &&
    !absolutePath.startsWith(`${rootPath}${sep}`)
  ) {
    throw new ExternalSkillPathError("技能包路径越界。");
  }
}

function buildImportSlug(
  name: string,
  sourceSlug: string,
  digest: string,
): string {
  return (
    generateSlug(name) ||
    generateSlug(sourceSlug) ||
    `external-${digest.slice(0, 12)}`
  );
}

/**
 * 只读扫描白名单目录，返回可导入的技能包候选与不可读原因。
 * 同来源同摘要标记已导入，内容变化的标记为冲突候选；已删除的来源明确标记。
 */
export async function scanExternalSkillDirectories(input: {
  instanceId: string;
  homeDir?: string;
  receipts: SkillImportReceiptRepository;
  roots?: readonly string[];
}): Promise<ExternalSkillScanResponse> {
  const diagnostics: ExternalSkillScanDiagnostic[] = [];
  let roots: ExternalSkillRoot[];

  if (input.roots && input.roots.length > 0) {
    const seen = new Set<string>();
    roots = [];
    for (const rootPath of input.roots) {
      try {
        const root = resolveWhitelistedRoot(rootPath, input.homeDir);
        if (seen.has(root.rootPath)) continue;
        seen.add(root.rootPath);
        roots.push(root);
      } catch (error) {
        diagnostics.push({
          rootPath,
          reason: error instanceof Error ? error.message : "源目录不可读。",
        });
      }
    }
  } else {
    roots = resolveExternalSkillRoots(input.homeDir);
  }

  const candidates: ExternalSkillCandidate[] = [];
  for (const root of roots) {
    const scanned = scanRoot(root.rootPath);
    diagnostics.push(...scanned.diagnostics);
    for (const packagePath of scanned.packagePaths) {
      const packageDir = join(root.rootPath, packagePath);
      let realPackageDir: string;
      try {
        realPackageDir = realpathSync(packageDir);
      } catch {
        diagnostics.push({
          rootPath: root.rootPath,
          reason: `技能包不可读：${packagePath}`,
        });
        continue;
      }
      if (
        realPackageDir === root.rootPath ||
        !realPackageDir.startsWith(`${root.rootPath}${sep}`)
      ) {
        diagnostics.push({
          rootPath: root.rootPath,
          reason: `技能包越界：${packagePath}`,
        });
        continue;
      }

      let files: SandboxSkillFileEntry[];
      try {
        files = readSandboxSkillPackage(root.rootPath, packagePath);
      } catch (error) {
        diagnostics.push({
          rootPath: root.rootPath,
          reason:
            error instanceof Error
              ? error.message
              : `技能包不可读：${packagePath}`,
        });
        continue;
      }
      const manifestFile = files.find((file) =>
        isSkillManifest(basename(file.path)),
      );
      if (!manifestFile) {
        diagnostics.push({
          rootPath: root.rootPath,
          reason: `技能包缺少 SKILL.md：${packagePath}`,
        });
        continue;
      }
      let manifest: ReturnType<typeof parseSkillManifest>;
      try {
        manifest = parseSkillManifest(manifestFile.content);
      } catch {
        diagnostics.push({
          rootPath: root.rootPath,
          reason: `SKILL.md 无法解析：${packagePath}`,
        });
        continue;
      }

      const sourceSlug = basename(realPackageDir);
      const digest = externalSkillPackageDigest(files);
      const receipt = await input.receipts.findImportReceipt(
        input.instanceId,
        skillImportRequestKey(root.rootPath, sourceSlug),
      );
      candidates.push({
        rootPath: root.rootPath,
        relativePath: packagePath,
        slug: sourceSlug,
        name: manifest.name || sourceSlug,
        description: manifest.description ?? "",
        digest,
        imported:
          receipt?.status === "imported" &&
          receipt.parameterFingerprint === digest,
        changed:
          receipt?.status === "imported" &&
          receipt.parameterFingerprint !== digest,
        deleted: receipt?.status === "deleted",
      });
    }
  }

  return { candidates, diagnostics };
}

/**
 * 把一个白名单目录里的技能包导入实例技能库。
 *
 * 同一来源同内容摘要重放返回既有技能；内容变化或 slug 被占用返回冲突；
 * 删除后的迟到导入返回已删除，不复活内容。
 */
export async function importExternalSkill(input: {
  instanceId: string;
  rootPath: string;
  relativePath: string;
  installedByClientId: string | null;
  homeDir?: string;
  receipts: SkillImportReceiptRepository;
  catalog: SkillCatalogRepository;
}): Promise<ExternalSkillImportResponse> {
  const root = resolveWhitelistedRoot(input.rootPath, input.homeDir);
  const lexicalPackageDir = resolveInsideRoot(
    root.rootPath,
    input.relativePath,
  );
  let realPackageDir: string;
  try {
    realPackageDir = realpathSync(lexicalPackageDir);
  } catch {
    throw new ExternalSkillPathError("技能包不可读。");
  }
  assertInsideRoot(root.rootPath, realPackageDir);
  if (realPackageDir === root.rootPath) {
    throw new ExternalSkillPathError("技能包不能是白名单根目录本身。");
  }

  let files: SandboxSkillFileEntry[];
  try {
    files = readSandboxSkillPackage(root.rootPath, input.relativePath);
  } catch (error) {
    throw new ExternalSkillPathError(
      error instanceof Error ? error.message : "技能包不可读。",
    );
  }
  const imported = buildSkillFromFiles(files, {
    label: "sandbox",
    url: `external:${root.agent}:${toPosixPath(root.rootPath, realPackageDir)}`,
  });
  const sourceSlug = basename(realPackageDir);
  const digest = externalSkillPackageDigest(files);
  const slug = buildImportSlug(imported.manifest.name, sourceSlug, digest);

  const existing = await input.receipts.findSkillBySlug(input.instanceId, slug);
  if (
    existing &&
    !(await input.receipts.findImportReceipt(
      input.instanceId,
      skillImportRequestKey(root.rootPath, sourceSlug),
    ))
  ) {
    throw new ExternalSkillSlugConflictError();
  }

  let admission: SkillImportAdmission;
  try {
    admission = await input.receipts.admitImport({
      instanceId: input.instanceId,
      requestKey: skillImportRequestKey(root.rootPath, sourceSlug),
      parameterFingerprint: digest,
      sourceRootPath: root.rootPath,
      sourceSlug,
      create: async (client) => {
        const skillRow = await insertOwnedSkillRecord(client, {
          author: imported.manifest.author ?? "system",
          category: "custom",
          createdByClientId: input.installedByClientId,
          description: imported.manifest.description,
          license: imported.manifest.license ?? null,
          metadata: {
            source: {
              type: "external-directory",
              agent: root.agent,
              rootPath: root.rootPath,
              slug: sourceSlug,
              digest,
            },
          },
          name: imported.manifest.name,
          skillContent: imported.skillContent,
          slug,
          sourceUrl: imported.sourceUrl,
          version: imported.manifest.version ?? "1.0",
        });
        if (!skillRow || typeof skillRow.id !== "string") {
          throw new Error("写入技能库失败。");
        }
        await insertSkillFileRecords(client, skillRow.id, imported.files);
        await upsertInstanceSkillRecord(client, {
          enabled: true,
          installedByClientId: input.installedByClientId,
          instanceId: input.instanceId,
          skillId: skillRow.id,
        });
        return { skillId: skillRow.id };
      },
    });
  } catch (error) {
    if (
      error instanceof SqlError &&
      error.code === SQLSTATE_UNIQUE_VIOLATION &&
      error.constraint === "skills_slug_key"
    ) {
      throw new ExternalSkillSlugConflictError();
    }
    throw error;
  }

  if (admission.kind === "replayed") {
    // 重放仍按用户本次「导入」动作保持启用；安装态写入本身幂等。
    await input.catalog.upsertInstallation({
      enabled: true,
      installedByClientId: input.installedByClientId,
      instanceId: input.instanceId,
      skillId: admission.skillId,
    });
  }

  return {
    skillId: admission.skillId,
    slug,
    name: imported.manifest.name,
    replayed: admission.kind === "replayed",
  };
}
