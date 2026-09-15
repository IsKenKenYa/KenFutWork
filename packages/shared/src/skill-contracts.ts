import { z } from "zod";

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
  createdBy: z.string().nullable(),
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

export const workspaceSkillToggleRequestSchema = z.object({
  enabled: z.boolean(),
});
export type WorkspaceSkillToggleRequest = z.infer<
  typeof workspaceSkillToggleRequestSchema
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
export const sandboxSkillImportRequestSchema = z.object({
  canvasId: z.string().min(1),
  path: z.string().min(1),
});
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

// === Response Schemas ===

export const skillListResponseSchema = z.object({
  skills: z.array(skillListItemSchema),
});
export type SkillListResponse = z.infer<typeof skillListResponseSchema>;

export const skillDetailResponseSchema = z.object({
  skill: skillDetailSchema,
});
export type SkillDetailResponse = z.infer<typeof skillDetailResponseSchema>;

export const workspaceSkillListResponseSchema = z.object({
  skills: z.array(skillListItemSchema),
});
export type WorkspaceSkillListResponse = z.infer<
  typeof workspaceSkillListResponseSchema
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
