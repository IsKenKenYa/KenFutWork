import { zcodeAgentProviderSchema } from "@zcode/shared";
import { z } from "zod";
import { codeUiViewerScopeSchema } from "./code-ui-contracts.js";
import {
  codeWorkDirectoryTargetSchema,
  visualWorkDirectoryTargetSchema,
} from "./execution-contracts.js";

/** 原技能接口中的目录信息只作UI上下文；安装态由实例持有。 */
export const codeUiSkillsRequestSchema = z.object({
  workspacePath: z.string().optional(),
  workspaceIdentity: z.string().optional(),
  viewerScope: codeUiViewerScopeSchema.optional(),
  provider: zcodeAgentProviderSchema.optional(),
});
export const codeUiSkillToggleRequestSchema = codeUiSkillsRequestSchema.extend({
  skillId: z.uuid(),
  installationRevision: z.string().min(1).max(128),
  enabled: z.boolean(),
  scope: z.enum(["workspace", "user", "plugin"]).optional(),
});
export const codeUiSkillDeleteRequestSchema = codeUiSkillsRequestSchema.extend({
  skillId: z.uuid(),
  installationRevision: z.string().min(1).max(128),
});

// === Enums ===

export const skillCategorySchema = z.enum([
  "design",
  "generation",
  "code",
  "data",
  "writing",
  "custom",
]);
export type SkillCategory = z.infer<typeof skillCategorySchema>;

export const skillSourceSchema = z.enum(["system", "community", "user"]);
export type SkillSource = z.infer<typeof skillSourceSchema>;

// === Entity Schemas ===

export const skillListItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string(),
  author: z.string(),
  version: z.string(),
  category: skillCategorySchema,
  iconName: z.string().nullable(),
  source: skillSourceSchema,
  isFeatured: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  // Populated when listing for a workspace:
  installed: z.boolean().optional(),
  enabled: z.boolean().optional(),
  installedAt: z.iso.datetime({ offset: true }).optional(),
});
export type SkillListItem = z.infer<typeof skillListItemSchema>;

// === Skill File Entry ===

export const skillFileEntrySchema = z.object({
  id: z.string().min(1),
  filePath: z.string().min(1),
  content: z.string(),
  mimeType: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type SkillFileEntry = z.infer<typeof skillFileEntrySchema>;

export const skillDetailSchema = skillListItemSchema.extend({
  license: z.string().nullable(),
  skillContent: z.string(),
  createdByClientId: z.string().nullable(),
  sourceUrl: z.string().nullable().optional(),
  packageName: z.string().nullable().optional(),
  files: z.array(skillFileEntrySchema).optional(),
});
export type SkillDetail = z.infer<typeof skillDetailSchema>;

// === Request Schemas ===

export const skillCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  category: skillCategorySchema,
  skillContent: z.string().min(1),
  iconName: z.string().max(100).optional(),
  files: z
    .array(
      z.object({
        filePath: z.string().min(1).max(500),
        content: z.string(),
        mimeType: z.string().max(100).optional(),
      }),
    )
    .optional(),
});
export type SkillCreateRequest = z.infer<typeof skillCreateRequestSchema>;

export const skillUpdateRequestSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(2000).optional(),
  category: skillCategorySchema.optional(),
  skillContent: z.string().min(1).optional(),
  iconName: z.string().max(100).optional(),
});
export type SkillUpdateRequest = z.infer<typeof skillUpdateRequestSchema>;

export const instanceSkillToggleRequestSchema = z.object({
  enabled: z.boolean(),
});
export type InstanceSkillToggleRequest = z.infer<
  typeof instanceSkillToggleRequestSchema
>;

export const skillImportRequestSchema = z.object({
  url: z.url().min(1),
});
export type SkillImportRequest = z.infer<typeof skillImportRequestSchema>;

/**
 * 从**沙箱工作目录**导入技能包（技能弹窗的「从工作目录导入」入口）。
 *
 * `canvasId` 决定沙箱目录（与 agent / git 同一处解析：工作目录映射优先，否则
 * `<沙箱根>/<画布UUID>`）；`path` 是**相对沙箱根**的技能包目录（内含 SKILL.md）。
 * 服务端校验画布归属与路径不越界——不信任前端传来的路径。
 */
export const sandboxSkillImportRequestSchema = z.union([
  codeWorkDirectoryTargetSchema.extend({ path: z.string().min(1) }),
  visualWorkDirectoryTargetSchema.extend({ path: z.string().min(1) }),
]);
export type SandboxSkillImportRequest = z.infer<
  typeof sandboxSkillImportRequestSchema
>;

/** 工作目录里扫到的技能包候选（含 SKILL.md 的目录）。 */
export const sandboxSkillPackageSchema = z.object({
  /** 相对沙箱根的目录路径 */
  path: z.string(),
  name: z.string(),
  description: z.string(),
});
export type SandboxSkillPackage = z.infer<typeof sandboxSkillPackageSchema>;

export const sandboxSkillPackageListResponseSchema = z.object({
  packages: z.array(sandboxSkillPackageSchema),
});
export type SandboxSkillPackageListResponse = z.infer<
  typeof sandboxSkillPackageListResponseSchema
>;

// === 项目级技能启停 ===

/**
 * 项目级启停按真实项目 id 生效，不复用旧工作区身份。
 * 解析不到项目时服务端返回 `projectId=null`，界面不显示项目分档。
 */
export const codeUiSkillProjectToggleRequestSchema =
  codeUiSkillsRequestSchema.extend({
    projectId: z.uuid(),
    skillId: z.uuid(),
    enabled: z.boolean(),
  });
export type CodeUiSkillProjectToggleRequest = z.infer<
  typeof codeUiSkillProjectToggleRequestSchema
>;

export const skillProjectSkillStateSchema = z.object({
  skillId: z.uuid(),
  enabled: z.boolean(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type SkillProjectSkillState = z.infer<
  typeof skillProjectSkillStateSchema
>;

export const skillProjectSettingsResponseSchema = z.object({
  /** null 表示项目不存在或不属于当前实例；界面据此不显示项目分档。 */
  projectId: z.uuid().nullable(),
  projectName: z.string().nullable(),
  skills: z.array(skillProjectSkillStateSchema),
});
export type SkillProjectSettingsResponse = z.infer<
  typeof skillProjectSettingsResponseSchema
>;

// === 外部技能目录扫描与导入 ===

/**
 * 只读扫描白名单目录里的技能包（含 `SKILL.md` 的目录）。
 * `roots` 是用户显式选择的绝对目录；服务端一律 `realpath` 后再校验，
 * 不信任前端传来的路径。
 */
export const externalSkillScanRequestSchema = z.object({
  roots: z.array(z.string().trim().min(1).max(4096)).min(1).max(20),
});
export type ExternalSkillScanRequest = z.infer<
  typeof externalSkillScanRequestSchema
>;

export const externalSkillCandidateSchema = z.object({
  /** 规范化（realpath）后的源根目录 */
  rootPath: z.string().min(1),
  /** 相对源根目录的技能包路径，`/` 分隔 */
  relativePath: z.string().min(1),
  /** 源目录名，导入后作为 slug 来源 */
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  /** 技能包全文摘要，用于同源变更判定 */
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
  /** 同一来源与摘要已导入 */
  imported: z.boolean(),
  /** 同一来源存在但摘要不同，导入会返回冲突 */
  changed: z.boolean(),
});
export type ExternalSkillCandidate = z.infer<
  typeof externalSkillCandidateSchema
>;

export const externalSkillScanDiagnosticSchema = z.object({
  rootPath: z.string(),
  reason: z.string(),
});
export type ExternalSkillScanDiagnostic = z.infer<
  typeof externalSkillScanDiagnosticSchema
>;

export const externalSkillScanResponseSchema = z.object({
  candidates: z.array(externalSkillCandidateSchema),
  diagnostics: z.array(externalSkillScanDiagnosticSchema),
});
export type ExternalSkillScanResponse = z.infer<
  typeof externalSkillScanResponseSchema
>;

export const externalSkillImportRequestSchema = z.object({
  /** 扫描结果里的规范化源根目录 */
  rootPath: z.string().trim().min(1).max(4096),
  /** 扫描结果里的技能包相对路径 */
  relativePath: z.string().trim().min(1).max(1024),
});
export type ExternalSkillImportRequest = z.infer<
  typeof externalSkillImportRequestSchema
>;

export const externalSkillImportResponseSchema = z.object({
  skillId: z.uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  /** 同源同摘要重放时为 true */
  replayed: z.boolean(),
});
export type ExternalSkillImportResponse = z.infer<
  typeof externalSkillImportResponseSchema
>;

/** 复制到通用技能目录；`skillId` 接受实例技能库或项目内已安装技能。 */
export const codeUiSkillCopyRequestSchema = codeUiSkillsRequestSchema.extend({
  skillId: z.uuid(),
});
export type CodeUiSkillCopyRequest = z.infer<
  typeof codeUiSkillCopyRequestSchema
>;

export const codeUiSkillCopyResponseSchema = z.object({
  newPath: z.string(),
});
export type CodeUiSkillCopyResponse = z.infer<
  typeof codeUiSkillCopyResponseSchema
>;

export const codeUiSkillRemoveFromCommonRequestSchema =
  codeUiSkillCopyRequestSchema;
export type CodeUiSkillRemoveFromCommonRequest = z.infer<
  typeof codeUiSkillRemoveFromCommonRequestSchema
>;

// === Response Schemas ===

export const skillListResponseSchema = z.object({
  skills: z.array(skillListItemSchema),
});
export type SkillListResponse = z.infer<typeof skillListResponseSchema>;

export const skillDetailResponseSchema = z.object({
  skill: skillDetailSchema,
});
export type SkillDetailResponse = z.infer<typeof skillDetailResponseSchema>;

export const instanceSkillListResponseSchema = z.object({
  skills: z.array(skillListItemSchema),
});
export type InstanceSkillListResponse = z.infer<
  typeof instanceSkillListResponseSchema
>;

export const skillFilesResponseSchema = z.object({
  files: z.array(skillFileEntrySchema),
});
export type SkillFilesResponse = z.infer<typeof skillFilesResponseSchema>;

// === Marketplace Schemas ===

export const marketplaceSkillSchema = z.object({
  packageName: z.string(),
  name: z.string(),
  description: z.string(),
  author: z.string(),
  version: z.string(),
  downloads: z.number(),
  keywords: z.array(z.string()),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
});
export type MarketplaceSkill = z.infer<typeof marketplaceSkillSchema>;

export const marketplaceSearchResponseSchema = z.object({
  skills: z.array(marketplaceSkillSchema),
  total: z.number(),
});
export type MarketplaceSearchResponse = z.infer<
  typeof marketplaceSearchResponseSchema
>;

export const marketplaceDetailSchema = marketplaceSkillSchema.extend({
  readme: z.string(),
  versions: z.array(z.string()),
  tarballUrl: z.string(),
});
export type MarketplaceDetail = z.infer<typeof marketplaceDetailSchema>;

export const marketplaceInstallRequestSchema = z.object({
  packageName: z.string().min(1),
});
export type MarketplaceInstallRequest = z.infer<
  typeof marketplaceInstallRequestSchema
>;
