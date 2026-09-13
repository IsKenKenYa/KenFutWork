import { z } from "zod";

/**
 * 首页示例库 / 发现库契约（Design 模式首页的灵感内容）。
 *
 * 这两块内容来自 `home_example_examples` / `home_discovery_cases` 两份**静态产品种子**
 * （全局内容，无 `workspace_id`），素材是**相对对象引用**（如
 * `project-assets/home-seeds/examples/design/e1-1.webp`），由服务端经 blob 缝解析成可
 * 直接访问的 URL 后再下发——前端不需要知道存储形态（本地 FS / MinIO / 对象存储皆可）。
 */

export const homeExampleInputMentionSchema = z.object({
  /** 可读名（展示在卡片上，如「Nano Banana」「Cat」）。 */
  name: z.string(),
  /** `image` = 用户提供的输入图；`tool` = 用到的工具图标。 */
  type: z.string(),
  /** 已解析的图标/输入图 URL（解析失败为 null，不阻断整份响应）。 */
  imgSrc: z.string().nullable(),
});

export const homeExampleSchema = z.object({
  categoryKey: z.string(),
  id: z.string(),
  /** 已解析的示例产出图（按 sort 顺序，最多 3 张）。 */
  imageUrls: z.array(z.string()),
  inputMentions: z.array(homeExampleInputMentionSchema),
  /** 点卡片时带进画布的提示词。 */
  prompt: z.string(),
  title: z.string(),
});

export const homeDiscoveryCaseSchema = z.object({
  authorAvatarUrl: z.string().nullable(),
  authorName: z.string(),
  categoryKey: z.string(),
  coverUrl: z.string().nullable(),
  id: z.string(),
  likeCount: z.number(),
  /** 点卡片时带进画布的提示词（原版发现库的「同款灵感」入口）。 */
  seedPrompt: z.string(),
  title: z.string(),
  viewCount: z.number(),
});

export const homeLibraryCategorySchema = z.object({
  /** 展示用强调色（可选，来自种子的 `accent`）。 */
  accent: z.string().nullable(),
  key: z.string(),
  label: z.string(),
});

export const homeLibraryResponseSchema = z.object({
  categories: z.array(homeLibraryCategorySchema),
  discoveryCases: z.array(homeDiscoveryCaseSchema),
  examples: z.array(homeExampleSchema),
});

export type HomeExampleInputMention = z.infer<
  typeof homeExampleInputMentionSchema
>;
export type HomeExample = z.infer<typeof homeExampleSchema>;
export type HomeDiscoveryCase = z.infer<typeof homeDiscoveryCaseSchema>;
export type HomeLibraryCategory = z.infer<typeof homeLibraryCategorySchema>;
export type HomeLibraryResponse = z.infer<typeof homeLibraryResponseSchema>;
