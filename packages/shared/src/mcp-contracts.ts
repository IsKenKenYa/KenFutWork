import { z } from "zod";

/**
 * MCP server 管理契约（`/api/mcp/servers*`）。
 *
 * 密钥纪律：请求可携带 `env`（含值），**响应只回 `envKeys`**——
 * 与 BYOK 同口径，Key 类值只写不读、永不回显前端。
 */

export const mcpServerSourceSchema = z.enum(["env", "managed"]);
export type McpServerSource = z.infer<typeof mcpServerSourceSchema>;

export const mcpServerStatusSchema = z.enum(["connected", "error", "disabled"]);
export type McpServerStatusValue = z.infer<typeof mcpServerStatusSchema>;

export const mcpServerViewSchema = z.object({
  /** 库内配置才有 id；来源为 env 的条目为 null（只读）。 */
  id: z.string().nullable(),
  name: z.string().min(1),
  source: mcpServerSourceSchema,
  enabled: z.boolean(),
  status: mcpServerStatusSchema,
  command: z.string().min(1),
  args: z.array(z.string()),
  /** 仅键名，值不外发。 */
  envKeys: z.array(z.string()),
  toolCount: z.number(),
  error: z.string().nullable(),
});
export type McpServerView = z.infer<typeof mcpServerViewSchema>;

export const mcpServerListResponseSchema = z.object({
  servers: z.array(mcpServerViewSchema),
});
export type McpServerListResponse = z.infer<typeof mcpServerListResponseSchema>;

const mcpEnvSchema = z.record(z.string(), z.string());

export const mcpServerCreateRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, "名称只允许字母数字与 - _"),
  command: z.string().trim().min(1).max(500),
  args: z.array(z.string().max(500)).max(50).default([]),
  env: mcpEnvSchema.default({}),
  enabled: z.boolean().default(true),
});
export type McpServerCreateRequest = z.infer<
  typeof mcpServerCreateRequestSchema
>;

export const mcpServerUpdateRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, "名称只允许字母数字与 - _")
    .optional(),
  command: z.string().trim().min(1).max(500).optional(),
  args: z.array(z.string().max(500)).max(50).optional(),
  env: mcpEnvSchema.optional(),
  enabled: z.boolean().optional(),
});
export type McpServerUpdateRequest = z.infer<
  typeof mcpServerUpdateRequestSchema
>;

export const mcpServerResponseSchema = z.object({
  server: mcpServerViewSchema,
});
export type McpServerResponse = z.infer<typeof mcpServerResponseSchema>;
