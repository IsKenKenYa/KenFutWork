import { realpathSync } from "node:fs";
import { basename, relative, sep } from "node:path";
import type {
  SettingsSyncAgent,
  SettingsSyncDiscoveryResult,
  SettingsSyncImportResult,
  SettingsSyncSkillImportResult,
  SettingsSyncSourceSkillSummary,
} from "@zcode/shared";
import { z as zod } from "zod";
import {
  CodeUiHostRpcError,
  type CodeUiHostRpcHandler,
} from "../code-ui/host-rpc-handler.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import {
  type ExternalSkillAgent,
  ExternalSkillPathError,
  type ExternalSkillRoot,
  ExternalSkillSlugConflictError,
  importExternalSkill,
  resolveExternalSkillRoots,
  scanExternalSkillDirectories,
} from "./external-directory-import.js";
import {
  SkillImportConflictError as ConflictError,
  SkillImportDeletedError as DeletedError,
  type SkillCatalogRepository,
  type SkillImportReceiptRepository,
} from "./repository.js";

const detectRequestSchema = zod.object({
  workspacePath: zod.string().optional(),
  workspaceIdentity: zod.string().optional(),
  categories: zod.array(zod.string()).optional(),
  intent: zod.string().optional(),
});

const importSelectionSchema = zod.object({
  agent: zod.string(),
  category: zod.string(),
  sourceScope: zod.enum(["global", "project"]).optional(),
  targetScope: zod.enum(["global", "project"]).optional(),
  importMode: zod.enum(["copy", "symlink"]).optional(),
  skillPaths: zod.array(zod.string()).optional(),
});

const importRequestSchema = zod.object({
  selections: zod.array(importSelectionSchema).max(50),
});

const AGENT_LABEL: Record<ExternalSkillAgent, SettingsSyncAgent> = {
  claude: "claudeCode",
  codex: "codexCli",
  // SettingsSyncAgent 联合类型没有 cursor；界面按原字符串展示该来源。
  cursor: "cursor" as SettingsSyncAgent,
  agents: "agents",
};

function skipReasonFor(candidate: {
  imported: boolean;
  changed: boolean;
  deleted: boolean;
}): SettingsSyncSourceSkillSummary["skipReason"] | undefined {
  if (candidate.deleted) return "sameNameExists";
  if (candidate.changed) return "sameNameExists";
  if (candidate.imported) return "targetExists";
  return undefined;
}

function sourceRootFor(
  root: ExternalSkillRoot,
  candidates: readonly {
    relativePath: string;
    name: string;
    imported: boolean;
    changed: boolean;
    deleted: boolean;
  }[],
) {
  const skills: SettingsSyncSourceSkillSummary[] = candidates.map(
    (candidate) => {
      const summary = {
        name: candidate.name,
        path: `${root.rootPath}${sep}${candidate.relativePath.split("/").join(sep)}`,
        importable:
          !candidate.imported && !candidate.changed && !candidate.deleted,
      };
      const skipReason = skipReasonFor(candidate);
      return skipReason ? { ...summary, skipReason } : summary;
    },
  );
  return {
    scope: "global" as const,
    path: root.rootPath,
    discoveredCount: skills.length,
    importableCount: skills.filter((skill) => skill.importable).length,
    skippedCount: skills.filter((skill) => !skill.importable).length,
    skills,
  };
}

function resolveSelection(
  path: string,
  roots: readonly ExternalSkillRoot[],
): { root: ExternalSkillRoot; relativePath: string; name: string } {
  let realPath: string;
  try {
    realPath = realpathSync(path);
  } catch {
    throw new CodeUiHostRpcError(
      "settings_sync_path_unreadable",
      "技能目录不可读，请重新扫描。",
      400,
    );
  }
  const root = roots.find((entry) =>
    realPath.startsWith(`${entry.rootPath}${sep}`),
  );
  if (!root) {
    throw new CodeUiHostRpcError(
      "settings_sync_path_outside_whitelist",
      "只能导入已知外部技能目录里的技能。",
      400,
    );
  }
  return {
    root,
    relativePath: relative(root.rootPath, realPath).split(sep).join("/"),
    name: basename(realPath),
  };
}

/**
 * Code 宿主的设置同步 RPC：把外部技能目录扫描与导入映射为
 * `ISettingsSyncService.detect` / `.importSelected` 的形状。
 * 只支持 skills 类别；其他类别显式报错，不返回空壳结果。
 */
export function createCodeUiSettingsSyncHost(deps: {
  localInstance: LocalInstanceService;
  catalog: SkillCatalogRepository;
  receipts: SkillImportReceiptRepository;
  /** 测试注入的 home 目录；生产环境使用系统 home。 */
  homeDir?: string;
}): Record<string, CodeUiHostRpcHandler> {
  const supportSkillsOnly = (categories: readonly string[] | undefined) =>
    categories === undefined || categories.includes("skills");

  return {
    "settings-sync.detect": {
      async call(actor, args): Promise<SettingsSyncDiscoveryResult> {
        const owner = await deps.localInstance.resolve(actor);
        const input = detectRequestSchema.parse(args[0] ?? {});
        if (!supportSkillsOnly(input.categories)) {
          return { agents: [] };
        }
        const scan = await scanExternalSkillDirectories({
          instanceId: owner.instanceId,
          receipts: deps.receipts,
          ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        });
        const roots = resolveExternalSkillRoots(deps.homeDir);
        const agents = roots.flatMap((root) => {
          const candidates = scan.candidates.filter(
            (candidate) => candidate.rootPath === root.rootPath,
          );
          if (candidates.length === 0) return [];
          const sourceRoot = sourceRootFor(root, candidates);
          return [
            {
              agent: AGENT_LABEL[root.agent],
              discovered: true,
              categories: [
                {
                  category: "skills" as const,
                  discoveredCount: sourceRoot.discoveredCount,
                  importableCount: sourceRoot.importableCount,
                  skippedCount: sourceRoot.skippedCount,
                  sourcePaths: [root.rootPath],
                  sourceRoots: [sourceRoot],
                  selectedByDefault: sourceRoot.importableCount > 0,
                },
              ],
            },
          ];
        });
        return { agents };
      },
    },
    "settings-sync.importSelected": {
      async call(actor, args): Promise<SettingsSyncImportResult> {
        const owner = await deps.localInstance.resolve(actor);
        const input = importRequestSchema.parse(args[0]);
        const roots = resolveExternalSkillRoots(deps.homeDir);
        const taskResults: SettingsSyncImportResult["taskResults"] = [];
        let successCount = 0;
        let skippedCount = 0;
        let failedCount = 0;
        for (const selection of input.selections) {
          if (selection.category !== "skills") {
            throw new CodeUiHostRpcError(
              "settings_sync_category_unsupported",
              "当前只支持导入技能。",
              400,
            );
          }
          const skillResults: SettingsSyncSkillImportResult[] = [];
          for (const path of selection.skillPaths ?? []) {
            const resolved = resolveSelection(path, roots);
            let status: SettingsSyncSkillImportResult["status"] = "imported";
            let skipReason: SettingsSyncSkillImportResult["skipReason"];
            try {
              await importExternalSkill({
                instanceId: owner.instanceId,
                rootPath: resolved.root.rootPath,
                relativePath: resolved.relativePath,
                installedByClientId: actor.accessClientId ?? null,
                receipts: deps.receipts,
                catalog: deps.catalog,
                ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
              });
            } catch (error) {
              if (
                error instanceof ConflictError ||
                error instanceof ExternalSkillSlugConflictError
              ) {
                status = "skipped";
                skipReason = "sameNameExists";
              } else if (
                error instanceof DeletedError ||
                error instanceof ExternalSkillPathError
              ) {
                status = "failed";
              } else {
                throw error;
              }
            }
            skillResults.push({
              name: resolved.name,
              path,
              sourceScope: "global",
              status,
              ...(skipReason ? { skipReason } : {}),
            });
          }
          const taskImported = skillResults.filter(
            (result) => result.status === "imported",
          ).length;
          const taskSkipped = skillResults.filter(
            (result) => result.status === "skipped",
          ).length;
          const taskFailed = skillResults.filter(
            (result) => result.status === "failed",
          ).length;
          successCount += taskImported;
          skippedCount += taskSkipped;
          failedCount += taskFailed;
          taskResults.push({
            agent: selection.agent as SettingsSyncAgent,
            category: "skills",
            status:
              taskFailed > 0
                ? "failed"
                : taskImported > 0
                  ? "success"
                  : "skipped",
            importedCount: taskImported,
            skippedCount: taskSkipped,
            failedCount: taskFailed,
            skillResults,
          });
        }
        return { successCount, skippedCount, failedCount, taskResults };
      },
    },
  };
}
