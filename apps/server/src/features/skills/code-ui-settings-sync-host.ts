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
/**
 * 宿主只需要「列出本轮暂存来源」这一项；具体登记表由 HTTP 路由侧持有，
 * 这里用窄接口，避免宿主与暂存实现互相依赖。
 */
export interface StagedSkillImportSource {
  kind: "git" | "zip";
  label: string;
  rootPath: string;
  sourceKey: string;
}

import {
  CodeUiHostRpcError,
  type CodeUiHostRpcHandler,
} from "../code-ui/host-rpc-handler.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import {
  type ExternalSkillAgent,
  ExternalSkillPathError,
  type ExternalSkillScanRoot,
  ExternalSkillSlugConflictError,
  importExternalSkill,
  importStagedSkill,
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

/** 暂存来源在导入对话框里的名字：git 仓库与 zip 包各一行。 */
const STAGED_AGENT_LABEL = {
  git: "gitRepository",
  zip: "zipArchive",
} as const;

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
  root: ExternalSkillScanRoot,
  candidates: readonly {
    relativePath: string;
    name: string;
    imported: boolean;
    changed: boolean;
    deleted: boolean;
  }[],
  /** 展示用来源名；暂存来源用 git 地址或 zip 文件名，不暴露临时目录 */
  displayPath: string = root.rootPath,
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
    path: displayPath,
    discoveredCount: skills.length,
    importableCount: skills.filter((skill) => skill.importable).length,
    skippedCount: skills.filter((skill) => !skill.importable).length,
    skills,
  };
}

function resolveSelection(
  path: string,
  roots: readonly ExternalSkillScanRoot[],
): { root: ExternalSkillScanRoot; relativePath: string; name: string } {
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
      "只能导入已知外部技能目录或本轮导入来源里的技能。",
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
 *
 * 本轮的暂存来源（git 仓库快照 / zip 包）作为额外的来源根一并列出：
 * 读取位置是暂存目录，来源身份用 `sourceKey`，展示名用 `label`。
 */
export function createCodeUiSettingsSyncHost(deps: {
  localInstance: LocalInstanceService;
  catalog: SkillCatalogRepository;
  receipts: SkillImportReceiptRepository;
  /** 测试注入的 home 目录；生产环境使用系统 home。 */
  homeDir?: string;
  /** 本轮已暂存的技能来源；未接入时不出现这两类来源。 */
  stagedSources?: {
    list(instanceId: string): Promise<readonly StagedSkillImportSource[]>;
  };
  /**
   * 查找技能目录的层数上限（实例设置 `skillImportScanDepth`）；
   * 未接入时沿用沙箱技能包的固定上限。
   */
  readMaxDepth?: (instanceId: string) => Promise<number>;
}): Record<string, CodeUiHostRpcHandler> {
  const supportSkillsOnly = (categories: readonly string[] | undefined) =>
    categories === undefined || categories.includes("skills");

  /** 暂存来源转成扫描根；展示名重复时加序号，界面行不会撞 key。 */
  const stagedScanRoots = (
    sources: readonly StagedSkillImportSource[],
  ): Array<
    ExternalSkillScanRoot & {
      label: string;
      displayPath: string;
      agent: "git" | "zip";
    }
  > => {
    const usedLabels = new Map<string, number>();
    return sources.map((source) => {
      const seen = usedLabels.get(source.label) ?? 0;
      usedLabels.set(source.label, seen + 1);
      const label = seen === 0 ? source.label : `${source.label} (${seen + 1})`;
      return {
        agent: source.kind,
        rootPath: source.rootPath,
        sourceKey: source.sourceKey,
        label,
        displayPath: label,
      };
    });
  };

  return {
    "settings-sync.detect": {
      async call(actor, args): Promise<SettingsSyncDiscoveryResult> {
        const owner = await deps.localInstance.resolve(actor);
        const input = detectRequestSchema.parse(args[0] ?? {});
        if (!supportSkillsOnly(input.categories)) {
          // 只接了技能类别：其余类别显式报错，不返回空壳结果
          throw new CodeUiHostRpcError(
            "settings_sync_category_unsupported",
            "此导入入口只支持技能类别。",
            400,
          );
        }
        const staged = stagedScanRoots(
          (await deps.stagedSources?.list(owner.instanceId)) ?? [],
        );
        // 层数上限现读实例设置：改设置后下一次扫描立刻生效
        const scanDepth = deps.readMaxDepth
          ? await deps.readMaxDepth(owner.instanceId)
          : undefined;
        const scan = await scanExternalSkillDirectories({
          instanceId: owner.instanceId,
          receipts: deps.receipts,
          ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
          ...(staged.length > 0 ? { stagedRoots: staged } : {}),
          ...(scanDepth !== undefined ? { maxDepth: scanDepth } : {}),
        });
        const roots: Array<ExternalSkillScanRoot & { displayPath?: string }> = [
          ...resolveExternalSkillRoots(deps.homeDir),
          ...staged,
        ];
        const agents = roots.flatMap((root) => {
          const candidates = scan.candidates.filter(
            (candidate) => candidate.rootPath === root.rootPath,
          );
          if (candidates.length === 0) return [];
          const sourceRoot = sourceRootFor(
            root,
            candidates,
            root.displayPath ?? root.rootPath,
          );
          const agent =
            root.agent === "git" || root.agent === "zip"
              ? STAGED_AGENT_LABEL[root.agent]
              : AGENT_LABEL[root.agent];
          return [
            {
              agent: agent as SettingsSyncAgent,
              discovered: true,
              categories: [
                {
                  category: "skills" as const,
                  discoveredCount: sourceRoot.discoveredCount,
                  importableCount: sourceRoot.importableCount,
                  skippedCount: sourceRoot.skippedCount,
                  sourcePaths: [sourceRoot.path],
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
        const staged = stagedScanRoots(
          (await deps.stagedSources?.list(owner.instanceId)) ?? [],
        );
        const roots: ExternalSkillScanRoot[] = [
          ...resolveExternalSkillRoots(deps.homeDir),
          ...staged,
        ];
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
              const common = {
                instanceId: owner.instanceId,
                relativePath: resolved.relativePath,
                installedByClientId: actor.accessClientId ?? null,
                receipts: deps.receipts,
                catalog: deps.catalog,
              };
              if (
                resolved.root.agent === "git" ||
                resolved.root.agent === "zip"
              ) {
                await importStagedSkill({
                  ...common,
                  stagedRoot: resolved.root,
                });
              } else {
                await importExternalSkill({
                  ...common,
                  rootPath: resolved.root.rootPath,
                  ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
                });
              }
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
