/**
 * SAG2 本地知识库插件的跨端 HTTP 契约（M2）。
 *
 * 唯一属主是这里的 zod schema；服务端 `features/knowledge/types.ts` 是内部
 * 实现类型，字段名保持一致但不复制契约。`docs/插件/SAG2知识库插件规划.md` §4.2
 * 是路由清单，OpenAPI 由 `apps/server/src/openapi/registry.ts` 引用本文件生成。
 */

import { z } from "zod";

/** CLI 状态：`available` 复用本机已装 / `missing` 需下载或引导 / `unsupported_platform` 无原生二进制。 */
export const knowledgeCliStateSchema = z.enum([
  "available",
  "missing",
  "unsupported_platform",
]);

export const knowledgeStatusResponseSchema = z.object({
  installed: z.boolean(),
  enabled: z.boolean(),
  active: z.boolean(),
  cli: knowledgeCliStateSchema,
  cliVersion: z.string(),
  reason: z.string().nullable(),
});

export const knowledgeRootSchema = z.object({
  path: z.string(),
  name: z.string(),
  status: z.string(),
  count: z.number().int().nonnegative(),
  error: z.string().nullable(),
});

export const knowledgeRootsResponseSchema = z.object({
  roots: z.array(knowledgeRootSchema),
});

export const knowledgeAddRootRequestSchema = z.object({
  path: z.string().min(1),
  /** 省略则沿用插件钉死的文档 + 代码扩展名；显式传入时必须非空。 */
  types: z.array(z.string().min(1)).min(1).optional(),
});

export const knowledgeRemoveRootRequestSchema = z.object({
  path: z.string().min(1),
});

export const knowledgeRootMutationResponseSchema = z.object({
  path: z.string(),
  indexStatus: z.string().optional(),
  cliAuthorized: z.boolean().optional(),
});

/** 归一化后的证据对象（按上游 `SearchResult` 字段，无 offset/source_id）。 */
export const knowledgeEvidenceSchema = z.object({
  path: z.string(),
  absolutePath: z.string(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  heading: z.string().optional(),
  content: z.string().optional(),
  matchedLines: z.array(z.number().int().nonnegative()).optional(),
});

export const knowledgeSearchRequestSchema = z.object({
  /** 上游硬限 1–2000 字符，超长会被 `exit(2)`。 */
  query: z.string().min(1).max(2000),
  path: z.string().min(1).optional(),
  maxResults: z.number().int().min(1).max(100).optional(),
});

export const knowledgeSearchResponseSchema = z.object({
  scope: z.string(),
  results: z.array(knowledgeEvidenceSchema),
  truncated: z.boolean(),
});

export const knowledgeReadQuerySchema = z.object({
  path: z.string().min(1),
  startLine: z.coerce.number().int().nonnegative().optional(),
  endLine: z.coerce.number().int().nonnegative().optional(),
});

export const knowledgeReadResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
  truncated: z.boolean(),
});

export const knowledgeInitResponseSchema = z.object({
  ok: z.boolean(),
  credential: z.enum(["reused", "injected", "missing"]),
  cli: knowledgeCliStateSchema,
  reason: z.string().nullable(),
});

export type KnowledgeStatusResponse = z.infer<
  typeof knowledgeStatusResponseSchema
>;
export type KnowledgeRootsResponse = z.infer<
  typeof knowledgeRootsResponseSchema
>;
export type KnowledgeAddRootRequest = z.infer<
  typeof knowledgeAddRootRequestSchema
>;
export type KnowledgeRemoveRootRequest = z.infer<
  typeof knowledgeRemoveRootRequestSchema
>;
export type KnowledgeRootMutationResponse = z.infer<
  typeof knowledgeRootMutationResponseSchema
>;
export type KnowledgeSearchRequest = z.infer<
  typeof knowledgeSearchRequestSchema
>;
export type KnowledgeSearchResponse = z.infer<
  typeof knowledgeSearchResponseSchema
>;
export type KnowledgeReadResponse = z.infer<typeof knowledgeReadResponseSchema>;
export type KnowledgeInitResponse = z.infer<typeof knowledgeInitResponseSchema>;
